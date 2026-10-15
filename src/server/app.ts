import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { GateState, ProfileKey, PublicConfig } from "../shared/types";
import type { CloudSdkAdapter } from "./cloud/adapter";
import { MOCK_OPTIONS } from "./cloud/mockAdapter";
import type { AppConfig } from "./config";
import type { EntryLog, ShapeLog } from "./entryLog";
import { detectLanAddress } from "./lan";
import type { Logger } from "./logger";
import { summariseGate } from "./rules/gates";
import type { SessionStore } from "./sessions";
import type { StaffAuth } from "./staffAuth";
import { ApiError, type VerifyService } from "./verifyService";

export interface AppDeps {
  config: AppConfig;
  service: VerifyService;
  sessions: SessionStore;
  log: EntryLog;
  shapes: ShapeLog;
  adapter: CloudSdkAdapter;
  staffAuth: StaffAuth;
  logger: Logger;
  /** Directory of the built web app. Served when it exists. */
  webDir?: string;
  startedAt?: number;
}

// ---- Request schemas ----------------------------------------------------------

const gateId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const sessionRef = z.object({ gate: gateId, session: sessionId });
const outcome = z.enum(["allowed", "denied", "declined", "error"]);
const mode = z.enum(["live", "mock"]);

const startBody = sessionRef.extend({ flow: z.enum(["dc-mdoc", "dc-openid4vp", "annex-b"]) });
// A wallet response with a portrait runs to tens of kilobytes; the cap is generous.
const completeBody = sessionRef.extend({ data: z.string().min(1).max(1_500_000) });
const abortBody = sessionRef.extend({ reason: z.enum(["cancelled", "unavailable"]) });
const resumeBody = sessionRef.extend({ responseCode: z.string().min(1).max(512) });
const mockWalletBody = sessionRef.extend({ data: z.string().regex(/^mock:[a-z-]+:[a-z]+:[a-z-]+$/).max(80) });
const loginBody = z.object({ passcode: z.string().min(1).max(200) });

const logFilter = z.object({
  gate: gateId.optional(),
  outcome: outcome.optional(),
  reason: z.string().regex(/^[A-Z][A-Z_]{2,39}$/).optional(),
  mode: mode.optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});
const logQuery = logFilter.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const statsQuery = z.object({
  gate: gateId.optional(),
  mode: mode.optional(),
  minutes: z.coerce.number().int().min(5).max(1440).default(60),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "INVALID_REQUEST", "The request was not valid.");
  return result.data;
}

/** Query string with empty values dropped, so "?gate=" means "no gate filter". */
function query(req: Request): Record<string, unknown> {
  return Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== ""));
}

function limiter(perMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "Too many requests. Please wait a moment." },
  });
}

export function createApp(deps: AppDeps): express.Express {
  const { config, service, sessions, log, shapes, adapter, staffAuth, logger } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "script-src": ["'self'"],
          "connect-src": ["'self'"],
          // The portrait arrives as a data: URI and is only ever rendered, never stored.
          "img-src": ["'self'", "data:"],
          // Left to the host: forcing it breaks plain-http testing on a LAN in mock mode.
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  // Request log: method, path, status, duration. Never the query string or the body.
  app.use("/api", (req, res, next) => {
    const started = Date.now();
    // Captured now: Express restores req.url once this middleware returns.
    const path = req.baseUrl + req.path;
    res.setHeader("Cache-Control", "no-store");
    res.on("finish", () => {
      const fields = { method: req.method, path, status: res.statusCode, ms: Date.now() - started };
      // The visitor page polls this every two seconds; keep it out of the normal log.
      if (path === "/api/verify/status") logger.debug("request", fields);
      else logger.info("request", fields);
    });
    next();
  });

  // ---- Health and public config ----------------------------------------------

  app.get("/health", (_req, res) => {
    const profileKeyOf = (id: string): string =>
      (Object.entries(config.credence.profiles).find(([, value]) => value === id)?.[0] as ProfileKey | undefined) ?? "unknown";
    let db: "ok" | "error" = "ok";
    let logRows = 0;
    try {
      logRows = log.count();
    } catch {
      db = "error";
    }
    res.status(db === "ok" ? 200 : 503).json({
      status: db === "ok" ? "ok" : "degraded",
      mode: adapter.mode,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      db,
      logRows,
      gates: service.listGates().map((g) => ({ id: g.id, profile: g.profile, available: g.available })),
      staffScreens: sessions.subscriberCount(),
      // Reports only whether a token is cached. /health never calls the Cloud SDK.
      tokens: Object.entries(adapter.tokenStatus()).map(([id, status]) => ({
        profile: profileKeyOf(id),
        cached: status.cached,
        accessExpiresInSec: status.accessExpiresInSec,
      })),
    });
  });

  app.get("/api/config", async (_req, res) => {
    const body: PublicConfig = {
      mockMode: config.mockMode,
      publicOrigin: config.mockMode ? null : config.credence.registeredOrigin,
      // Looked up per request so it follows the machine onto a different network.
      lanAddress: config.mockMode ? await detectLanAddress() : null,
      sessionTtlSeconds: config.sessionTtlSeconds,
      resultDisplaySeconds: config.resultDisplaySeconds,
      staffAuthRequired: staffAuth.required,
      logRetentionDays: config.logRetentionDays,
      profiles: (["age-check", "id-check"] as const).map((key) => ({
        key,
        configured: config.mockMode || config.credence.profiles[key] !== null,
      })),
    };
    res.json(body);
  });

  // ---- Staff sign-in -----------------------------------------------------------

  app.get("/api/staff/session", (req, res) => {
    res.json({ required: staffAuth.required, authenticated: staffAuth.isAuthenticated(req) });
  });

  app.post("/api/staff/login", limiter(10), (req, res) => {
    const { passcode } = parse(loginBody, req.body);
    const token = staffAuth.login(passcode);
    if (!token) throw new ApiError(401, "INVALID_PASSCODE", "That passcode is not correct.");
    staffAuth.setCookie(req, res, token);
    res.json({ required: true, authenticated: true });
  });

  app.post("/api/staff/logout", (req, res) => {
    staffAuth.logout(req, res);
    res.json({ required: staffAuth.required, authenticated: !staffAuth.required });
  });

  // ---- Staff: gates --------------------------------------------------------------

  const staff = express.Router();
  staff.use(staffAuth.requireStaff);

  staff.get("/gates", (_req, res) => {
    res.json(service.listGates().map(summariseGate));
  });

  staff.post("/gates/:gateId/sessions", limiter(120), (req, res) => {
    res.json(service.createSession(parse(gateId, req.params.gateId)));
  });

  // Server-sent events: every change to the gate's attempt is pushed as the full state.
  staff.get("/gates/:gateId/events", (req, res) => {
    const id = parse(gateId, req.params.gateId);
    const send = () => {
      const state: GateState = service.gateState(id);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    service.gateState(id); // 404s before the stream opens if the gate is unknown
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    send();
    const unsubscribe = sessions.subscribe(id, send);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // ---- Staff: admin ---------------------------------------------------------------

  staff.get("/admin/log", (req, res) => {
    const q = parse(logQuery, query(req));
    res.json(log.query({ gateId: q.gate, outcome: q.outcome, reasonCode: q.reason, mode: q.mode, from: q.from, to: q.to }, q.limit, q.offset));
  });

  staff.get("/admin/log.csv", (req, res) => {
    const q = parse(logFilter, query(req));
    const csv = log.toCsv({ gateId: q.gate, outcome: q.outcome, reasonCode: q.reason, mode: q.mode, from: q.from, to: q.to });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gatecheck-entry-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  staff.get("/admin/stats", (req, res) => {
    const q = parse(statsQuery, query(req));
    res.json(log.stats({ gateId: q.gate, mode: q.mode }, q.minutes, Date.now()));
  });

  staff.post("/admin/purge", limiter(10), (_req, res) => {
    const removed = log.purge(config.logRetentionDays, Date.now());
    logger.info("entry log purged", { removed, retentionDays: config.logRetentionDays, trigger: "manual" });
    res.json({ removed, retentionDays: config.logRetentionDays });
  });

  // Key names of recent verification responses. Never values. In live mode this stays
  // closed until a staff passcode exists, so it cannot be left open by accident.
  staff.get("/admin/debug/shapes", (_req, res) => {
    if (!config.mockMode && !staffAuth.required) {
      throw new ApiError(403, "DEBUG_DISABLED", "Set STAFF_PASSCODE to enable the debug endpoint in live mode.");
    }
    res.json({ note: "Key names only. Values are never recorded.", observations: shapes.list() });
  });

  // ---- Visitor: /verify ------------------------------------------------------------

  const visitor = express.Router();
  visitor.use(limiter(600));

  visitor.get("/session", (req, res) => {
    const q = parse(sessionRef, query(req));
    res.json(service.visitorInfo(q.gate, q.session));
  });

  visitor.get("/status", (req, res) => {
    const q = parse(sessionRef, query(req));
    res.json(service.status(q.gate, q.session));
  });

  // The only visitor route that creates a Cloud SDK request, so it gets the tightest limit.
  visitor.post("/start", limiter(90), async (req, res) => {
    const body = parse(startBody, req.body);
    res.json(await service.start(body.gate, body.session, body.flow));
  });

  visitor.post("/complete", async (req, res) => {
    const body = parse(completeBody, req.body);
    res.json(await service.complete(body.gate, body.session, body.data));
  });

  visitor.post("/abort", (req, res) => {
    const body = parse(abortBody, req.body);
    res.json(service.abort(body.gate, body.session, body.reason));
  });

  visitor.post("/resume", async (req, res) => {
    const body = parse(resumeBody, req.body);
    res.json(await service.resume(body.gate, body.session, body.responseCode));
  });

  app.use("/api/verify", visitor);

  // ---- Mock wallet (only mounted in mock mode) ----------------------------------------

  if (config.mockMode) {
    const mock = express.Router();
    mock.get("/options", (_req, res) => {
      res.json(MOCK_OPTIONS);
    });
    mock.post("/wallet", (req, res) => {
      const body = parse(mockWalletBody, req.body);
      service.mockWalletResponse(body.gate, body.session, body.data);
      res.json({ ok: true });
    });
    mock.post("/expire", (req, res) => {
      const body = parse(sessionRef, req.body);
      service.mockExpire(body.gate, body.session);
      res.json({ ok: true });
    });
    app.use("/api/mock", mock);
  }

  app.use("/api", staff);

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "NOT_FOUND", message: "Unknown API route." });
  });

  // ---- Web app ---------------------------------------------------------------------

  const webDir = deps.webDir ?? resolve(process.cwd(), "dist/web");
  const indexHtml = resolve(webDir, "index.html");
  if (existsSync(indexHtml)) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path === "/health") {
        next();
        return;
      }
      // /verify URLs carry the session id, so the shell is never cached.
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(indexHtml);
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "PAYLOAD_TOO_LARGE", message: "The request was too large." });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "The request body was not valid JSON." });
      return;
    }
    logger.error("unhandled error", { error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown" });
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Something went wrong." });
  };
  app.use(onError);

  return app;
}
