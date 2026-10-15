import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSdkAdapter } from "../src/server/cloud/adapter";
import { CloudSdkError } from "../src/server/cloud/errors";
import { MockCloudSdkAdapter } from "../src/server/cloud/mockAdapter";
import { loadConfig } from "../src/server/config";
import { EntryLog, ShapeLog } from "../src/server/entryLog";
import { silentLogger, type LogFields, type Logger } from "../src/server/logger";
import { loadGatesFile, loadTicketsFile, resolveGates } from "../src/server/rules/gates";
import { SessionStore } from "../src/server/sessions";
import { ApiError, VerifyService } from "../src/server/verifyService";

// The whole gate attempt, driven through the service with the mock Cloud SDK adapter.

const START = Date.UTC(2026, 9, 13, 18, 0, 0);

function build(adapter: CloudSdkAdapter = new MockCloudSdkAdapter({ latencyMs: 0, now: () => START }), logger: Logger = silentLogger) {
  let time = START;
  const config = loadConfig({ MOCK_MODE: "true", SESSION_TTL_SECONDS: "120" });
  const log = new EntryLog(":memory:");
  const shapes = new ShapeLog();
  const sessions = new SessionStore();
  const service = new VerifyService({
    config,
    adapter,
    gates: resolveGates(loadGatesFile("./config/gates.json"), config.credence.profiles, true),
    tickets: loadTicketsFile("./config/tickets.json"),
    sessions,
    log,
    shapes,
    logger,
    now: () => time,
  });
  const open = (gateId: string) => {
    const id = service.createSession(gateId).session!.id;
    service.visitorInfo(gateId, id);
    return id;
  };
  return {
    service,
    log,
    shapes,
    sessions,
    open,
    advance: (ms: number) => {
      time += ms;
    },
    rows: () => log.query({}, 100, 0).rows,
    decision: (gateId: string) => service.gateState(gateId).session?.decision,
  };
}

let h: ReturnType<typeof build>;

beforeEach(() => {
  h = build();
});

afterEach(() => {
  h.service.stop();
  h.log.close();
  vi.useRealTimers();
});

describe("a gate attempt", () => {
  it("moves waiting -> scanned -> in_progress -> complete and logs exactly one row", async () => {
    const state = h.service.createSession("beer-garden");
    const id = state.session!.id;
    expect(state.session).toMatchObject({ status: "waiting", decision: null, verifyPath: `/verify?gate=beer-garden&session=${id}` });

    expect(h.service.visitorInfo("beer-garden", id)).toMatchObject({ status: "scanned", gate: { name: "Beer Garden", profile: "age-check" }, result: null });
    h.advance(1500);
    const started = await h.service.start("beer-garden", id, "dc-mdoc");
    expect(started).toMatchObject({ flow: "dc-mdoc", request: { protocol: "org-iso-mdoc" } });
    expect(h.service.gateState("beer-garden").session).toMatchObject({ status: "in_progress", flow: "dc-mdoc" });

    h.advance(2500);
    const result = await h.service.complete("beer-garden", id, "mock:success:alex:full");
    expect(result).toEqual({ status: "complete", result: { outcome: "allowed", message: "You're verified. Staff will wave you through." } });
    expect(h.rows()).toEqual([
      { id: 1, ts: START + 4000, gateId: "beer-garden", outcome: "allowed", reasonCode: "ENTRY_ALLOWED", flow: "dc-mdoc", mode: "mock", latencyMs: 4000 },
    ]);
  });

  it("gives each attempt a fresh, unguessable session id", () => {
    const first = h.service.createSession("beer-garden").session!.id;
    const second = h.service.createSession("beer-garden").session!.id;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(() => h.service.visitorInfo("beer-garden", first)).toThrowError(ApiError);
  });

  it("shows the staff screen the holder, but tells the visitor's phone nothing personal", async () => {
    const id = h.open("general-entry");
    await h.service.start("general-entry", id, "dc-openid4vp");
    const visitor = await h.service.complete("general-entry", id, "mock:success:alex:full");

    expect(h.decision("general-entry")).toMatchObject({
      outcome: "allowed",
      headline: "ENTRY ALLOWED",
      mock: true,
      holder: { name: "Alex Rivera" },
      fields: [{ label: "Ticket", value: "General Admission (TKT-0001)" }],
    });
    expect(h.decision("general-entry")?.holder?.portrait).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(visitor)).not.toMatch(/Alex|Rivera|D1000001|data:image/);
  });

  it("never writes a name, birth date, document number or portrait to the log or the shape log", async () => {
    for (const [gate, data] of [
      ["general-entry", "mock:success:alex:full"],
      ["vip", "mock:success:jordan:full"],
      ["beer-garden", "mock:success:maya:full"],
    ] as const) {
      const id = h.open(gate);
      await h.service.start(gate, id, "dc-mdoc");
      await h.service.complete(gate, id, data);
    }
    const stored = JSON.stringify(h.rows()) + h.log.toCsv({}) + JSON.stringify(h.shapes.list());
    expect(stored).not.toMatch(/Alex|Rivera|Jordan|Park|Maya|Chen|D100000|1988|1992|data:image|PHN2Zy/);
    // The shape log holds key names: that is its whole point.
    expect(h.shapes.list()[0]).toMatchObject({ gateId: "beer-garden", profile: "age-check", flow: "dc-mdoc", mode: "mock", verified: true, layout: "nested" });
    expect(h.shapes.list()[0]?.identityKeys).toEqual(expect.arrayContaining(["birth_date", "family_name", "given_name", "portrait"]));
  });

  it("shows AGE 21+ VERIFIED and no personal data for the age-only profile", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    await h.service.complete("beer-garden", id, "mock:success:alex:age-only");
    expect(h.decision("beer-garden")).toMatchObject({ outcome: "allowed", headline: "AGE 21+ VERIFIED", holder: null, noPersonalData: true });
    expect(h.shapes.list()[0]?.identityKeys).toEqual(["age_over_21"]);
  });

  it.each([
    ["beer-garden", "mock:success:maya:full", "denied", "UNDER_AGE"],
    ["beer-garden", "mock:success:maya:age-only", "denied", "UNDER_AGE"],
    ["general-entry", "mock:success:sam:full", "denied", "TICKET_NOT_FOUND"],
    ["general-entry", "mock:success:jordan:full", "allowed", "ENTRY_ALLOWED"],
    ["general-entry", "mock:success:alex:age-only", "denied", "ATTRIBUTES_MISSING"],
    ["vip", "mock:success:alex:full", "allowed", "ENTRY_ALLOWED"],
    ["vip", "mock:success:maya:full", "denied", "NOT_ON_ALLOWLIST"],
    ["beer-garden", "mock:expired:alex:full", "denied", "CREDENTIAL_EXPIRED"],
    ["beer-garden", "mock:untrusted:alex:full", "denied", "ISSUER_UNTRUSTED"],
    ["beer-garden", "mock:failed:alex:full", "denied", "CREDENTIAL_INVALID"],
    ["beer-garden", "mock:cancelled:alex:full", "declined", "VISITOR_DECLINED"],
  ] as const)("%s + %s -> %s / %s on every flow", async (gate, data, outcome, reasonCode) => {
    for (const flow of ["dc-mdoc", "dc-openid4vp"] as const) {
      const id = h.open(gate);
      await h.service.start(gate, id, flow);
      await h.service.complete(gate, id, data);
      expect(h.decision(gate)).toMatchObject({ outcome, reasonCode, flow });
    }
    vi.useFakeTimers();
    const id = h.open(gate);
    await h.service.start(gate, id, "annex-b");
    h.service.mockWalletResponse(gate, id, data);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.decision(gate)).toMatchObject({ outcome, reasonCode, flow: "annex-b" });
    expect(h.rows()).toHaveLength(3);
  });

  it("explains a failed credential with the checks that failed", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    await h.service.complete("beer-garden", id, "mock:untrusted:alex:full");
    const checks = h.decision("beer-garden")?.checks ?? [];
    expect(checks[0]).toMatchObject({ label: "Credential verified", passed: false });
    expect(checks).toContainEqual({ label: "Issuer recognized", passed: false });
  });
});

describe("Flow C (Annex B)", () => {
  it("polls from the server every 2 seconds until the wallet answers", async () => {
    vi.useFakeTimers();
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0, now: () => START });
    const poll = vi.spyOn(adapter, "pollAnnexB");
    h = build(adapter);
    const id = h.open("beer-garden");
    const started = await h.service.start("beer-garden", id, "annex-b");
    expect(started).toMatchObject({ flow: "annex-b", walletUri: expect.stringMatching(/^mdoc-openid4vp:\/\//) });

    await vi.advanceTimersByTimeAsync(1999);
    expect(poll).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(4001); // t = 6s: three polls, all 202
    expect(poll).toHaveBeenCalledTimes(3);
    expect(h.service.status("beer-garden", id)).toEqual({ status: "in_progress", result: null });

    h.service.mockWalletResponse("beer-garden", id, "mock:success:alex:age-only");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.service.status("beer-garden", id).result?.outcome).toBe("allowed");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(4); // polling stops once there is a result
  });

  it("stops polling when staff replace the attempt", async () => {
    vi.useFakeTimers();
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    const poll = vi.spyOn(adapter, "pollAnnexB");
    h = build(adapter);
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "annex-b");
    await vi.advanceTimersByTimeAsync(2000);
    h.service.createSession("beer-garden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("gives up after repeated transient failures and tells staff why", async () => {
    vi.useFakeTimers();
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    vi.spyOn(adapter, "pollAnnexB").mockRejectedValue(new CloudSdkError("upstream", 502, "UPSTREAM_ERROR", "down"));
    h = build(adapter);
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "annex-b");
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.service.status("beer-garden", id).status).toBe("in_progress");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.decision("beer-garden")).toMatchObject({ outcome: "error", reasonCode: "SDK_UNAVAILABLE" });
  });

  it("finishes at once when the wallet redirects back with a response_code, and only once", async () => {
    vi.useFakeTimers();
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0, now: () => START });
    const start = vi.spyOn(adapter, "startAnnexB");
    h = build(adapter);
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "annex-b");
    const cloudSessionId = (await start.mock.results[0]!.value).sessionId;

    h.service.mockWalletResponse("beer-garden", id, "mock:success:alex:age-only");
    const resumed = await h.service.resume("beer-garden", id, `mock-rc-${cloudSessionId}`);
    expect(resumed.result?.outcome).toBe("allowed");

    // The poll that was already scheduled, and a replayed code, change nothing.
    await vi.advanceTimersByTimeAsync(6000);
    await h.service.resume("beer-garden", id, `mock-rc-${cloudSessionId}`);
    expect(h.rows()).toHaveLength(1);
  });
});

describe("timeouts and resets", () => {
  it("times out an attempt the visitor started but never finished", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    h.advance(119_000);
    h.service.sweep();
    expect(h.service.status("beer-garden", id).status).toBe("in_progress");

    h.advance(2_000);
    h.service.sweep();
    expect(h.service.gateState("beer-garden").session).toMatchObject({ status: "timeout", decision: { outcome: "error", reasonCode: "TIMEOUT", headline: "TIMED OUT" } });
    expect(h.rows()).toMatchObject([{ outcome: "error", reasonCode: "TIMEOUT", latencyMs: 121_000 }]);
    await expect(h.service.complete("beer-garden", id, "mock:success:alex:full")).rejects.toMatchObject({ status: 410 });
  });

  it("expires an unscanned code silently: no attempt, no log row", () => {
    const id = h.service.createSession("beer-garden").session!.id;
    h.advance(121_000);
    h.service.sweep();
    expect(h.service.gateState("beer-garden").session).toMatchObject({ id, status: "expired", decision: null });
    expect(h.rows()).toEqual([]);
  });

  it("gives the visitor the full window from the moment they scan", () => {
    const id = h.service.createSession("beer-garden").session!.id;
    h.advance(100_000);
    const info = h.service.visitorInfo("beer-garden", id);
    expect(info.expiresAt - info.serverTime).toBe(120_000);
  });

  it("records an in-progress attempt that staff replace with a new code", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    h.service.createSession("beer-garden");
    expect(h.rows()).toMatchObject([{ outcome: "error", reasonCode: "STAFF_RESET" }]);
    await expect(h.service.complete("beer-garden", id, "mock:success:alex:full")).rejects.toMatchObject({ status: 410, code: "SESSION_EXPIRED" });
  });

  it("drops a finished attempt, and the holder with it, from memory after five minutes", async () => {
    const id = h.open("general-entry");
    await h.service.start("general-entry", id, "dc-mdoc");
    await h.service.complete("general-entry", id, "mock:success:alex:full");
    h.advance(4 * 60_000);
    h.service.sweep();
    expect(h.decision("general-entry")?.holder?.name).toBe("Alex Rivera");
    h.advance(61_000);
    h.service.sweep();
    expect(h.service.gateState("general-entry").session).toBeNull();
    expect(h.sessions.all()).toEqual([]);
  });
});

describe("guard rails", () => {
  it("lets a browser-side cancel end the attempt as declined", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    expect(h.service.abort("beer-garden", id, "cancelled").result?.outcome).toBe("declined");
    expect(h.service.abort("beer-garden", id, "cancelled").result?.outcome).toBe("declined");
    expect(h.rows()).toHaveLength(1);
  });

  it("reports a phone with no usable wallet as an error, not a denial", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-openid4vp");
    h.service.abort("beer-garden", id, "unavailable");
    expect(h.decision("beer-garden")).toMatchObject({ outcome: "error", reasonCode: "WALLET_UNAVAILABLE" });
  });

  it("accepts one wallet response per attempt", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    await h.service.complete("beer-garden", id, "mock:success:maya:full");
    await expect(h.service.complete("beer-garden", id, "mock:success:alex:full")).rejects.toMatchObject({ status: 410 });
    expect(h.rows()).toMatchObject([{ outcome: "denied", reasonCode: "UNDER_AGE" }]);
  });

  it("caps Cloud SDK requests per attempt to protect the quota", async () => {
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    await h.service.start("beer-garden", id, "dc-openid4vp");
    await h.service.start("beer-garden", id, "dc-mdoc");
    await expect(h.service.start("beer-garden", id, "dc-mdoc")).rejects.toMatchObject({ status: 429, code: "TOO_MANY_STARTS" });
  });

  it("rejects unknown gates, wrong session ids and out-of-order calls", async () => {
    expect(() => h.service.gateState("nope")).toThrowError(/Unknown gate/);
    const id = h.open("beer-garden");
    expect(() => h.service.status("beer-garden", "x".repeat(24))).toThrowError(ApiError);
    expect(() => h.service.status("vip", id)).toThrowError(ApiError);
    await expect(h.service.complete("beer-garden", id, "mock:success:alex:full")).rejects.toMatchObject({ status: 409, code: "NOT_STARTED" });
  });

  it("turns a Cloud SDK error into a mapped error decision and a safe visitor message", async () => {
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    vi.spyOn(adapter, "startDcMdoc").mockRejectedValue(new CloudSdkError("quota", 429, "PLAN_LIMIT_EXCEEDED", "Monthly verification quota exhausted"));
    h = build(adapter);
    const id = h.open("beer-garden");
    await expect(h.service.start("beer-garden", id, "dc-mdoc")).rejects.toMatchObject({
      status: 502,
      code: "SDK_QUOTA_EXCEEDED",
      message: "Verification is unavailable right now. Please see a member of staff.",
    });
    expect(h.decision("beer-garden")).toMatchObject({
      outcome: "error",
      reasonCode: "SDK_QUOTA_EXCEEDED",
      headline: "COULD NOT VERIFY",
      reason: "The monthly verification quota is used up.",
    });
    expect(h.rows()).toMatchObject([{ outcome: "error", reasonCode: "SDK_QUOTA_EXCEEDED", flow: "dc-mdoc" }]);
  });

  it("names the failing endpoint path in the warning, and nothing from the request", async () => {
    const warnings: { message: string; fields?: LogFields }[] = [];
    const logger: Logger = { ...silentLogger, warn: (message, fields) => void warnings.push({ message, fields }) };
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    const failure = new CloudSdkError("bad_request", 400, "INVALID_REQUEST", "Request body is missing");
    failure.endpoint = "/v1/getDocRequest";
    vi.spyOn(adapter, "startDcMdoc").mockRejectedValue(failure);
    h = build(adapter, logger);
    const id = h.open("beer-garden");
    await expect(h.service.start("beer-garden", id, "dc-mdoc")).rejects.toMatchObject({ code: "SDK_BAD_RESPONSE" });

    expect(warnings).toEqual([
      {
        message: "cloud sdk call failed",
        fields: { gate: "beer-garden", flow: "dc-mdoc", path: "/v1/getDocRequest", kind: "bad_request", code: "INVALID_REQUEST", httpStatus: 400, retryAfterSec: null },
      },
    ]);
    // The visitor's session id is not part of the line either.
    expect(JSON.stringify(warnings)).not.toContain(id);
  });

  it("leaves the path out when the error did not come from an endpoint", async () => {
    const warnings: (LogFields | undefined)[] = [];
    const logger: Logger = { ...silentLogger, warn: (_message, fields) => void warnings.push(fields) };
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    vi.spyOn(adapter, "startDcMdoc").mockRejectedValue(new CloudSdkError("quota", 429, "PLAN_LIMIT_EXCEEDED", "quota"));
    h = build(adapter, logger);
    await expect(h.service.start("beer-garden", h.open("beer-garden"), "dc-mdoc")).rejects.toBeInstanceOf(ApiError);
    expect(warnings[0]?.path).toBeUndefined();
  });

  it("maps a failure during verification the same way", async () => {
    const adapter = new MockCloudSdkAdapter({ latencyMs: 0 });
    vi.spyOn(adapter, "verifyDcMdoc").mockRejectedValue(new CloudSdkError("domain", 403, "DOMAIN_MISMATCH", "Origin mismatch"));
    h = build(adapter);
    const id = h.open("beer-garden");
    await h.service.start("beer-garden", id, "dc-mdoc");
    const result = await h.service.complete("beer-garden", id, "anything");
    expect(result.result?.outcome).toBe("error");
    expect(h.decision("beer-garden")?.reasonCode).toBe("SDK_DOMAIN_MISMATCH");
  });
});

describe("gate availability", () => {
  it("refuses to issue codes for a gate whose profile is not configured", () => {
    const config = loadConfig({ MOCK_MODE: "true" });
    const log = new EntryLog(":memory:");
    const service = new VerifyService({
      config,
      adapter: new MockCloudSdkAdapter({ latencyMs: 0 }),
      // Resolved as in live mode with only the age-check profile.
      gates: resolveGates(loadGatesFile("./config/gates.json"), { "age-check": "11111111-1111-1111-1111-111111111111", "id-check": null }, false),
      tickets: [],
      sessions: new SessionStore(),
      log,
      shapes: new ShapeLog(),
      logger: silentLogger,
    });
    expect(() => service.createSession("vip")).toThrowError(/CREDENCE_PROFILE_ID_CHECK/);
    expect(service.gateState("general-entry").gate).toMatchObject({ notice: "Age check only", available: true });
    expect(service.createSession("general-entry").session?.status).toBe("waiting");
    log.close();
  });
});
