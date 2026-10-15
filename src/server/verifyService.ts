import { REASONS } from "../shared/reasons";
import type {
  AbortReason,
  Decision,
  FlowId,
  GateSessionView,
  GateState,
  ReasonCode,
  StartResponse,
  VisitorSessionInfo,
  VisitorStatus,
} from "../shared/types";
import type { CloudSdkAdapter } from "./cloud/adapter";
import { CloudSdkError } from "./cloud/errors";
import { MockCloudSdkAdapter } from "./cloud/mockAdapter";
import { describeShape, type VerificationResult } from "./cloud/parse";
import type { AppConfig } from "./config";
import type { EntryLog, ShapeLog } from "./entryLog";
import type { Logger } from "./logger";
import { decide, errorDecision, type RuleContext } from "./rules/engine";
import { summariseGate, type ResolvedGate, type Ticket } from "./rules/gates";
import { isTerminal, type GateSession, type SessionStore } from "./sessions";

/** An error with an HTTP status and a message that is safe to show to whoever called. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const POLL_INTERVAL_MS = 2000; // "Poll every ~2 seconds" (API reference, Flow C)
const MAX_POLL_FAILURES = 3;
/** Cloud SDK requests one attempt may create: the first, plus switching wallet or one retry. */
const MAX_STARTS_PER_SESSION = 3;
/** A finished attempt is dropped from memory after this long, along with any name or photo. */
const RESULT_RETENTION_MS = 5 * 60_000;

const CODE_GONE = "This code is no longer valid. Please scan the new code at the gate.";

export interface VerifyServiceDeps {
  config: AppConfig;
  adapter: CloudSdkAdapter;
  gates: ResolvedGate[];
  tickets: Ticket[];
  sessions: SessionStore;
  log: EntryLog;
  shapes: ShapeLog;
  logger: Logger;
  now?: () => number;
}

/**
 * Runs one gate attempt end to end: creates the Cloud SDK request for the visitor's
 * wallet, verifies what comes back, applies the gate's rules, writes the log row, and
 * pushes the decision to the staff screen.
 */
export class VerifyService {
  private readonly gates: Map<string, ResolvedGate>;
  private readonly now: () => number;

  constructor(private readonly deps: VerifyServiceDeps) {
    this.gates = new Map(deps.gates.map((g) => [g.id, g]));
    this.now = deps.now ?? Date.now;
  }

  // ---- Staff side ------------------------------------------------------------

  listGates(): ResolvedGate[] {
    return [...this.gates.values()];
  }

  gateState(gateId: string): GateState {
    const gate = this.requireGate(gateId);
    const session = this.deps.sessions.current(gateId);
    return { gate: summariseGate(gate), session: session ? this.view(session) : null, serverTime: this.now() };
  }

  /** Starts a fresh attempt: a new session id, and so a new QR code. */
  createSession(gateId: string): GateState {
    const gate = this.requireGate(gateId);
    if (!gate.available) throw new ApiError(409, "GATE_UNAVAILABLE", gate.unavailableReason ?? "This gate is not available.");
    const previous = this.deps.sessions.current(gateId);
    // An attempt that was under way is recorded rather than silently dropped.
    if (previous && !isTerminal(previous.status) && previous.status !== "waiting") {
      this.finish(gate, previous, errorDecision("STAFF_RESET", previous.flow, this.context()));
    }
    if (previous) this.stopPolling(previous);
    this.deps.sessions.create(gateId, this.now(), this.deps.config.sessionTtlSeconds * 1000);
    this.deps.sessions.publish(gateId);
    return this.gateState(gateId);
  }

  // ---- Visitor side ----------------------------------------------------------

  /** Called when the visitor's phone opens /verify. Marks the code as scanned. */
  visitorInfo(gateId: string, sessionId: string): VisitorSessionInfo {
    const { gate, session } = this.requireSession(gateId, sessionId);
    if (session.status === "waiting") this.markScanned(session);
    return {
      gate: { id: gate.id, name: gate.name, profile: gate.profile },
      status: session.status,
      expiresAt: session.expiresAt,
      serverTime: this.now(),
      result: this.visitorResult(session),
    };
  }

  status(gateId: string, sessionId: string): VisitorStatus {
    return this.visitorStatus(this.requireSession(gateId, sessionId).session);
  }

  /** Creates the Cloud SDK request for the chosen flow and returns what the browser needs. */
  async start(gateId: string, sessionId: string, flow: FlowId): Promise<StartResponse> {
    const { gate, session } = this.requireActive(gateId, sessionId);
    const profileId = gate.profileId;
    if (!gate.available || !profileId) {
      throw new ApiError(409, "GATE_UNAVAILABLE", gate.unavailableReason ?? "This gate is not available.");
    }
    if (session.completing) throw new ApiError(409, "ALREADY_SUBMITTED", "A wallet response is already being checked.");
    if (session.starts >= MAX_STARTS_PER_SESSION) {
      throw new ApiError(429, "TOO_MANY_STARTS", "Too many attempts with this code. Please scan the new code at the gate.");
    }
    session.starts += 1;
    if (session.status === "waiting") this.markScanned(session);
    this.stopPolling(session);

    const { adapter, config } = this.deps;
    try {
      let response: StartResponse;
      let cloudSessionId: string;
      if (flow === "dc-mdoc") {
        const started = await adapter.startDcMdoc(profileId);
        cloudSessionId = started.sessionId;
        // TODO(live): the integration guide passes dcRequest.deviceRequest; the official
        // sample app passes the whole dcRequest object. DC_MDOC_REQUEST_SHAPE picks one.
        const data = config.mdocRequestShape === "dcRequest" ? started.dcRequest : started.dcRequest.deviceRequest;
        response = { flow, request: { protocol: "org-iso-mdoc", data } };
      } else if (flow === "dc-openid4vp") {
        const started = await adapter.startDcOpenId4Vp(profileId);
        cloudSessionId = started.sessionId;
        // TODO(live): guide says "openid4vp"; the sample app uses "openid4vp-v1-unsigned".
        response = { flow, request: { protocol: config.openid4vpProtocol, data: started.payload } };
      } else {
        const started = await adapter.startAnnexB(profileId, this.returnUrl(gateId, sessionId));
        cloudSessionId = started.sessionId;
        response = { flow, walletUri: started.walletUri };
      }

      // The attempt may have ended (timeout, staff reset) while the request was in flight.
      if (isTerminal(session.status) || this.deps.sessions.current(gateId) !== session) {
        throw new ApiError(410, "SESSION_EXPIRED", CODE_GONE);
      }
      session.flow = flow;
      session.cloud = { flow, sessionId: cloudSessionId };
      session.status = "in_progress";
      this.deps.sessions.publish(gateId);
      if (flow === "annex-b") this.startPolling(gate, session, profileId, cloudSessionId);
      return response;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      session.flow ??= flow;
      const reason = this.finishWithError(gate, session, err);
      throw new ApiError(502, reason, REASONS[reason].visitor);
    }
  }

  /** Flows A and B: verifies the wallet response the browser received and decides. */
  async complete(gateId: string, sessionId: string, data: string): Promise<VisitorStatus> {
    const { gate, session } = this.requireActive(gateId, sessionId);
    const cloud = session.cloud;
    if (!cloud || cloud.flow === "annex-b" || !gate.profileId) {
      throw new ApiError(409, "NOT_STARTED", "No wallet request is open for this code.");
    }
    if (session.completing) throw new ApiError(409, "ALREADY_SUBMITTED", "A wallet response is already being checked.");

    session.completing = true;
    try {
      const result =
        cloud.flow === "dc-mdoc"
          ? await this.deps.adapter.verifyDcMdoc(gate.profileId, cloud.sessionId, data)
          : await this.deps.adapter.validateDcOpenId4Vp(gate.profileId, cloud.sessionId, data);
      this.finishWithResult(gate, session, result);
    } catch (err) {
      this.finishWithError(gate, session, err);
    } finally {
      session.completing = false;
    }
    return this.visitorStatus(session);
  }

  /** The browser could not get a wallet response at all: the visitor cancelled, or no wallet opened. */
  abort(gateId: string, sessionId: string, reason: AbortReason): VisitorStatus {
    const { gate, session } = this.requireSession(gateId, sessionId);
    if (!isTerminal(session.status) && !session.completing) {
      const decision =
        reason === "cancelled"
          ? decide(gate.rules, { status: "cancelled", message: "Cancelled in the browser" }, session.flow, this.context())
          : errorDecision("WALLET_UNAVAILABLE", session.flow, this.context());
      this.finish(gate, session, decision);
    }
    return this.visitorStatus(session);
  }

  /** Flow C, same device: the wallet sent the browser back with a single-use response_code. */
  async resume(gateId: string, sessionId: string, responseCode: string): Promise<VisitorStatus> {
    const { gate, session } = this.requireSession(gateId, sessionId);
    if (isTerminal(session.status) || session.cloud?.flow !== "annex-b") return this.visitorStatus(session);
    try {
      const result = await this.deps.adapter.resumeAnnexB(responseCode);
      // 202 here means "still processing": polling, which is already running, delivers it.
      if (result.status !== "pending") this.finishWithResult(gate, session, result);
    } catch (err) {
      // 404 = the code was already exchanged. Polling still delivers the result.
      if (!(err instanceof CloudSdkError && err.kind === "not_found")) this.finishWithError(gate, session, err);
    }
    return this.visitorStatus(session);
  }

  // ---- Mock wallet (MOCK_MODE only) ------------------------------------------

  /** The simulated wallet answers an Annex B request, as a real wallet would post to the Cloud SDK. */
  mockWalletResponse(gateId: string, sessionId: string, data: string): void {
    const { session } = this.requireActive(gateId, sessionId);
    const adapter = this.deps.adapter;
    if (!(adapter instanceof MockCloudSdkAdapter) || session.cloud?.flow !== "annex-b") {
      throw new ApiError(409, "NOT_STARTED", "No mock wallet request is open for this code.");
    }
    if (!adapter.simulateWalletResponse(session.cloud.sessionId, data)) {
      throw new ApiError(400, "INVALID_REQUEST", "Unknown mock wallet choice.");
    }
  }

  /** Fast-forwards an attempt to its deadline so the timeout screen can be demonstrated. */
  mockExpire(gateId: string, sessionId: string): void {
    const { session } = this.requireActive(gateId, sessionId);
    session.expiresAt = this.now();
    this.sweep();
  }

  // ---- Housekeeping ----------------------------------------------------------

  /** Times out attempts past their deadline and drops finished ones from memory. Runs every second. */
  sweep(): void {
    const now = this.now();
    for (const session of this.deps.sessions.all()) {
      const gate = this.gates.get(session.gateId);
      if (!gate) continue;
      if (isTerminal(session.status)) {
        const endedAt = session.completedAt ?? session.expiresAt;
        if (now - endedAt > RESULT_RETENTION_MS) {
          this.deps.sessions.remove(session.gateId);
          this.deps.sessions.publish(session.gateId);
        }
        continue;
      }
      if (now < session.expiresAt || session.completing) continue;
      if (session.status === "waiting") {
        // Nobody scanned it: not an attempt, so nothing is logged. The screen shows a new code.
        session.status = "expired";
        this.deps.sessions.publish(session.gateId);
      } else {
        this.finish(gate, session, errorDecision("TIMEOUT", session.flow, this.context()), "timeout");
      }
    }
  }

  stop(): void {
    for (const session of this.deps.sessions.all()) this.stopPolling(session);
  }

  // ---- Internals -------------------------------------------------------------

  private requireGate(gateId: string): ResolvedGate {
    const gate = this.gates.get(gateId);
    if (!gate) throw new ApiError(404, "GATE_NOT_FOUND", "Unknown gate.");
    return gate;
  }

  private requireSession(gateId: string, sessionId: string): { gate: ResolvedGate; session: GateSession } {
    const gate = this.requireGate(gateId);
    const session = this.deps.sessions.find(gateId, sessionId);
    if (!session) throw new ApiError(410, "SESSION_EXPIRED", CODE_GONE);
    return { gate, session };
  }

  private requireActive(gateId: string, sessionId: string): { gate: ResolvedGate; session: GateSession } {
    const found = this.requireSession(gateId, sessionId);
    if (isTerminal(found.session.status)) throw new ApiError(410, "SESSION_EXPIRED", CODE_GONE);
    return found;
  }

  private markScanned(session: GateSession): void {
    const now = this.now();
    session.status = "scanned";
    session.scannedAt = now;
    // The visitor gets the full window from the moment they scan, not from when the code appeared.
    session.expiresAt = now + this.deps.config.sessionTtlSeconds * 1000;
    this.deps.sessions.publish(session.gateId);
  }

  /** Flow C needs an https return URL on the registered domain. A path, not a query, so the appended ?response_code= cannot collide. */
  private returnUrl(gateId: string, sessionId: string): string | undefined {
    const origin = this.deps.config.credence.registeredOrigin;
    return origin ? `${origin}/verify/return/${encodeURIComponent(gateId)}/${encodeURIComponent(sessionId)}` : undefined;
  }

  private context(): RuleContext {
    return {
      tickets: this.deps.tickets,
      now: new Date(this.now()),
      timeZone: this.deps.config.venueTimeZone,
      mock: this.deps.adapter.mode === "mock",
    };
  }

  private finishWithResult(gate: ResolvedGate, session: GateSession, result: VerificationResult): void {
    if (session.flow && (result.status === "verified" || result.status === "failed")) {
      // Key names only, never values: this is how we learn what a profile actually returns.
      const shape = describeShape(result);
      this.deps.shapes.add({ ts: this.now(), gateId: gate.id, profile: gate.profile, flow: session.flow, mode: this.deps.adapter.mode, ...shape });
      this.deps.logger.info("verification response shape", {
        gate: gate.id,
        profile: gate.profile,
        flow: session.flow,
        verified: shape.verified,
        layout: shape.layout,
        identityKeys: shape.identityKeys,
        authenticationKeys: shape.authenticationKeys,
      });
    }
    this.finish(gate, session, decide(gate.rules, result, session.flow, this.context()));
  }

  private finishWithError(gate: ResolvedGate, session: GateSession, err: unknown): ReasonCode {
    let reason: ReasonCode = "INTERNAL_ERROR";
    if (err instanceof CloudSdkError) {
      reason = err.reasonCode;
      this.deps.logger.warn("cloud sdk call failed", {
        gate: gate.id,
        flow: session.flow,
        // Path only. Never the query string, headers or body.
        path: err.endpoint ?? undefined,
        kind: err.kind,
        code: err.code,
        httpStatus: err.httpStatus,
        retryAfterSec: err.retryAfterSec,
      });
    } else {
      this.deps.logger.error("unexpected error during verification", {
        gate: gate.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    const detail = err instanceof CloudSdkError ? `${err.code}${err.retryAfterSec ? `, retry in ${err.retryAfterSec}s` : ""}` : undefined;
    this.finish(gate, session, errorDecision(reason, session.flow, this.context(), detail));
    return reason;
  }

  /** Ends the attempt exactly once: stores the decision, writes the log row, updates the staff screen. */
  private finish(gate: ResolvedGate, session: GateSession, decision: Decision, status: "complete" | "timeout" = "complete"): void {
    if (isTerminal(session.status)) return;
    const now = this.now();
    this.stopPolling(session);
    session.status = status;
    session.decision = decision;
    session.completedAt = now;
    const latencyMs = session.scannedAt === null ? null : now - session.scannedAt;
    this.deps.log.insert({
      ts: now,
      gateId: gate.id,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      flow: session.flow,
      mode: this.deps.adapter.mode,
      latencyMs,
    });
    this.deps.logger.info("attempt finished", {
      gate: gate.id,
      outcome: decision.outcome,
      reason: decision.reasonCode,
      flow: session.flow,
      latencyMs,
    });
    this.deps.sessions.publish(gate.id);
  }

  /**
   * Flow C is polled from the server, not the visitor's browser: the browser tab goes to
   * the background while the visitor is in the wallet app, and its timers may not run.
   */
  private startPolling(gate: ResolvedGate, session: GateSession, profileId: string, cloudSessionId: string): void {
    let failures = 0;
    const stale = () => isTerminal(session.status) || session.cloud?.sessionId !== cloudSessionId;
    const schedule = (delayMs: number) => {
      session.pollTimer = setTimeout(() => void tick(), delayMs);
      session.pollTimer.unref();
    };
    const tick = async () => {
      session.pollTimer = null;
      if (stale()) return;
      let delay = POLL_INTERVAL_MS;
      try {
        const result = await this.deps.adapter.pollAnnexB(profileId, cloudSessionId);
        failures = 0;
        if (stale()) return;
        if (result.status !== "pending") {
          this.finishWithResult(gate, session, result);
          return;
        }
      } catch (err) {
        if (stale()) return;
        failures += 1;
        const transient = err instanceof CloudSdkError && ["network", "upstream", "rate_limit"].includes(err.kind);
        if (!transient || failures >= MAX_POLL_FAILURES) {
          this.finishWithError(gate, session, err);
          return;
        }
        if (err instanceof CloudSdkError && err.retryAfterSec) delay = Math.max(delay, err.retryAfterSec * 1000);
      }
      schedule(delay);
    };
    schedule(POLL_INTERVAL_MS);
  }

  private stopPolling(session: GateSession): void {
    if (session.pollTimer) clearTimeout(session.pollTimer);
    session.pollTimer = null;
  }

  private view(session: GateSession): GateSessionView {
    return {
      id: session.id,
      verifyPath: `/verify?gate=${encodeURIComponent(session.gateId)}&session=${encodeURIComponent(session.id)}`,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      flow: session.flow,
      decision: session.decision,
    };
  }

  private visitorResult(session: GateSession) {
    if (session.status === "expired") return { outcome: "error" as const, message: CODE_GONE };
    const decision = session.decision;
    return decision ? { outcome: decision.outcome, message: REASONS[decision.reasonCode].visitor } : null;
  }

  private visitorStatus(session: GateSession): VisitorStatus {
    return { status: session.status, result: this.visitorResult(session) };
  }
}
