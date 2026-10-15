import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudSdkError } from "../src/server/cloud/errors";
import { LiveCloudSdkAdapter } from "../src/server/cloud/liveAdapter";
import { Secret } from "../src/server/config";

// These tests run the real adapter (real fetch, real headers) against a local HTTP server
// that plays the Cloud SDK. Nothing here touches the network.

const LICENSE = "CS_test-license-key-0000000000";
const ORIGIN = "https://gate.example.com";
const AGE = "11111111-1111-1111-1111-111111111111";
const ID = "22222222-2222-2222-2222-222222222222";

interface Recorded {
  method: string;
  path: string;
  origin: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Handler = (req: Recorded) => Reply;

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let handlers: Map<string, Handler | Reply[]>;
let tokenCounter: number;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

/** Registers a handler, or a queue of replies consumed in order (the last one repeats). */
function on(route: string, handler: Handler | Reply[]): void {
  handlers.set(route, handler);
}

function calls(route: string): Recorded[] {
  return requests.filter((r) => `${r.method} ${r.path.split("?")[0]}` === route);
}

function adapter(): LiveCloudSdkAdapter {
  return new LiveCloudSdkAdapter({
    baseUrl,
    licenseKey: new Secret(LICENSE),
    registeredOrigin: ORIGIN,
    sleep: async () => {},
    timeoutMs: 2000,
  });
}

beforeEach(async () => {
  requests = [];
  handlers = new Map();
  tokenCounter = 0;
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const recorded: Recorded = {
      method: req.method ?? "",
      path: req.url ?? "",
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(recorded);
    const handler = handlers.get(`${recorded.method} ${recorded.path.split("?")[0]}`);
    let reply: Reply = { status: 404, body: { error: "no handler" } };
    if (typeof handler === "function") reply = handler(recorded);
    else if (handler) reply = handler.length > 1 ? handler.shift()! : handler[0]!;
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cloudsdk`;

  on("POST /cloudsdk/v1/setup", (req) => {
    tokenCounter += 1;
    const profile = (req.body as { profileId: string }).profileId;
    return {
      status: 200,
      body: {
        accessToken: `access-${profile.slice(0, 1)}-${tokenCounter}`,
        refreshToken: `rt_${tokenCounter}`,
        expiresIn: 900,
        tokenType: "Bearer",
        customerName: "Acme Venues",
        profileName: profile === AGE ? "Age Check Profile" : "ID Check Profile",
      },
    };
  });
  on("POST /cloudsdk/v1/refresh", () => {
    tokenCounter += 1;
    return { status: 200, body: { accessToken: `access-r-${tokenCounter}`, refreshToken: `rt_${tokenCounter}`, expiresIn: 900, tokenType: "Bearer" } };
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const DOC_REQUEST = { sessionId: "sess-1", dcRequest: { deviceRequest: "omdkb2M", encryptionInfo: "omVub25jZQ" } };

describe("LiveCloudSdkAdapter: setup and tokens", () => {
  it("sends the license key, profile id and Origin to /v1/setup, then a bearer token to the flow endpoint", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: DOC_REQUEST }]);
    const started = await adapter().startDcMdoc(AGE);

    expect(started).toEqual(DOC_REQUEST);
    const [setup] = calls("POST /cloudsdk/v1/setup");
    expect(setup).toMatchObject({ origin: ORIGIN, contentType: "application/json", body: { licenseKey: LICENSE, profileId: AGE } });
    expect(setup?.authorization).toBeUndefined();

    const [docRequest] = calls("POST /cloudsdk/v1/getDocRequest");
    expect(docRequest).toMatchObject({ origin: ORIGIN, authorization: "Bearer access-1-1", contentType: "application/json" });
    // The reference calls the body "empty"; the official sample app posts {} as JSON, and so does this.
    expect(docRequest?.body).toEqual({});
  });

  it("does not call /v1/setup per request", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: DOC_REQUEST }]);
    const a = adapter();
    await a.startDcMdoc(AGE);
    await a.startDcMdoc(AGE);
    await a.startDcMdoc(AGE);
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(1);
    expect(calls("POST /cloudsdk/v1/getDocRequest")).toHaveLength(3);
  });

  it("keeps a separate token per profile: switching profile means its own /v1/setup", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: DOC_REQUEST }]);
    const a = adapter();
    await a.startDcMdoc(AGE);
    await a.startDcMdoc(ID);
    await a.startDcMdoc(AGE);

    expect(calls("POST /cloudsdk/v1/setup").map((r) => (r.body as { profileId: string }).profileId)).toEqual([AGE, ID]);
    expect(calls("POST /cloudsdk/v1/getDocRequest").map((r) => r.authorization)).toEqual([
      "Bearer access-1-1",
      "Bearer access-2-2",
      "Bearer access-1-1",
    ]);
    const status = a.tokenStatus();
    expect(status[AGE]).toMatchObject({ cached: true, profileName: "Age Check Profile" });
    expect(status[ID]).toMatchObject({ cached: true, profileName: "ID Check Profile" });
  });

  it("refreshes once and retries when the API says the access token expired", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [
      { status: 401, body: { error: "TOKEN_EXPIRED", message: "expired" } },
      { status: 201, body: DOC_REQUEST },
    ]);
    await adapter().startDcMdoc(AGE);
    expect(calls("POST /cloudsdk/v1/refresh")).toHaveLength(1);
    expect(calls("POST /cloudsdk/v1/refresh")[0]?.body).toEqual({ refreshToken: "rt_1" });
    expect(calls("POST /cloudsdk/v1/getDocRequest").map((r) => r.authorization)).toEqual(["Bearer access-1-1", "Bearer access-r-2"]);
  });

  it("gives up after one refresh if the token is still rejected", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 401, body: { error: "TOKEN_EXPIRED" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ kind: "auth", code: "TOKEN_EXPIRED" });
    expect(calls("POST /cloudsdk/v1/getDocRequest")).toHaveLength(2);
  });
});

describe("LiveCloudSdkAdapter: error mapping and retries", () => {
  it.each([
    [401, "INVALID_LICENSE_KEY", "auth", "SDK_AUTH_ERROR"],
    [401, "LICENSE_EXPIRED_OR_REVOKED", "auth", "SDK_AUTH_ERROR"],
    [403, "DOMAIN_MISMATCH", "domain", "SDK_DOMAIN_MISMATCH"],
    [403, "PROFILE_NOT_FOUND", "profile", "SDK_PROFILE_ERROR"],
    [429, "PLAN_LIMIT_EXCEEDED", "quota", "SDK_QUOTA_EXCEEDED"],
  ] as const)("maps /v1/setup %i %s to %s", async (status, code, kind, reasonCode) => {
    on("POST /cloudsdk/v1/setup", [{ status, body: { error: code, message: "nope" } }]);
    const err = await adapter().startDcMdoc(AGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudSdkError);
    expect(err).toMatchObject({ kind, code, httpStatus: status, reasonCode });
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(1);
  });

  it("surfaces Retry-After on a 429 and does not retry", async () => {
    on("POST /cloudsdk/v1/setup", [{ status: 429, body: { error: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "42" } }]);
    const a = adapter();
    await expect(a.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "rate_limit", retryAfterSec: 42 });
    // A second attempt is refused locally instead of hitting the API again.
    await expect(a.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(1);
  });

  it("retries a 500 once", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [
      { status: 500, body: { error: "INTERNAL_ERROR" } },
      { status: 201, body: DOC_REQUEST },
    ]);
    await expect(adapter().startDcMdoc(AGE)).resolves.toEqual(DOC_REQUEST);
    expect(calls("POST /cloudsdk/v1/getDocRequest")).toHaveLength(2);
  });

  it("stops after one retry when the 500 persists", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 500, body: { error: "INTERNAL_ERROR" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ kind: "upstream", httpStatus: 500 });
    expect(calls("POST /cloudsdk/v1/getDocRequest")).toHaveLength(2);
  });

  it("retries a 502 twice", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 502, body: { error: "UPSTREAM_ERROR" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ kind: "upstream", code: "UPSTREAM_ERROR" });
    expect(calls("POST /cloudsdk/v1/getDocRequest")).toHaveLength(3);
  });

  it("reports an unreachable Cloud SDK as a network error", async () => {
    const dead = new LiveCloudSdkAdapter({
      baseUrl: "http://127.0.0.1:1/cloudsdk",
      licenseKey: new Secret(LICENSE),
      registeredOrigin: ORIGIN,
      sleep: async () => {},
      timeoutMs: 1000,
    });
    await expect(dead.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "network", httpStatus: null, reasonCode: "SDK_UNAVAILABLE" });
  });

  it("rejects a 2xx body that is missing required fields", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: { sessionId: "s" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("never puts the license key in an error", async () => {
    on("POST /cloudsdk/v1/setup", [{ status: 401, body: { error: "INVALID_LICENSE_KEY", message: "License key not recognized" } }]);
    const err = (await adapter().startDcMdoc(AGE).catch((e: unknown) => e)) as CloudSdkError;
    expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain(LICENSE);
  });
});

describe("LiveCloudSdkAdapter: flows", () => {
  it("Flow A: posts sessionId + data to /v1/verifyDocRequest and parses resDetails", async () => {
    on("POST /cloudsdk/v1/verifyDocRequest", [
      { status: 200, body: { res: true, resDetails: JSON.stringify({ identity: { age_over_21: true }, authentication: { dataIntegrity: true } }) } },
    ]);
    const result = await adapter().verifyDcMdoc(AGE, "sess-1", "wallet-bytes");
    expect(calls("POST /cloudsdk/v1/verifyDocRequest")[0]?.body).toEqual({ sessionId: "sess-1", data: "wallet-bytes" });
    expect(result).toMatchObject({ status: "verified", identity: { age_over_21: true } });
  });

  it("Flow A: HTTP 200 can still be a cancellation or a failure", async () => {
    on("POST /cloudsdk/v1/verifyDocRequest", [
      { status: 200, body: { cancelled: true, message: "Verification was cancelled by the user." } },
      { status: 200, body: { res: false, resDetails: "Issuer certificate is not trusted" } },
    ]);
    const a = adapter();
    expect((await a.verifyDcMdoc(AGE, "s", "d")).status).toBe("cancelled");
    expect(await a.verifyDcMdoc(AGE, "s", "d")).toMatchObject({ status: "failed", failure: "untrusted" });
  });

  it("Flow B: returns the payload untouched and validates the wallet response", async () => {
    const payload = { response_type: "vp_token", response_mode: "dc_api.jwt", nonce: "n-1", dcql_query: { credentials: [{ id: "cred1" }] } };
    on("POST /cloudsdk/dcapi/openid4vp/v1/initiate", [{ status: 200, body: { sessionId: "n-1", payload } }]);
    on("POST /cloudsdk/dcapi/openid4vp/v1/validate", [{ status: 200, body: { res: true, resDetails: '{"identity":{"given_name":"Jane"},"authentication":{}}' } }]);
    const a = adapter();
    expect(await a.startDcOpenId4Vp(ID)).toEqual({ sessionId: "n-1", payload });
    // "Always send the Origin header explicitly."
    const [initiate] = calls("POST /cloudsdk/dcapi/openid4vp/v1/initiate");
    expect(initiate).toMatchObject({ origin: ORIGIN, contentType: "application/json" });
    expect(initiate?.body).toEqual({});
    expect(await a.validateDcOpenId4Vp(ID, "n-1", "eyJhbGciOiJFQ0RILUVTIn0.x.y.z.w")).toMatchObject({ status: "verified" });
  });

  it("Flow B: a 400 'Validation failed' is a failed credential; any other 400 is an error", async () => {
    on("POST /cloudsdk/dcapi/openid4vp/v1/validate", [
      { status: 400, body: { error: "Validation failed: MSO has expired" } },
      { status: 400, body: { error: "Unsupported profile configuration. Contact your administrator." } },
    ]);
    const a = adapter();
    expect(await a.validateDcOpenId4Vp(ID, "n", "jwe")).toMatchObject({ status: "failed", failure: "expired" });
    await expect(a.validateDcOpenId4Vp(ID, "n", "jwe")).rejects.toMatchObject({ kind: "profile", httpStatus: 400 });
  });

  it("Flow C: passes returnUrl, treats 202 as pending and 200 as the result", async () => {
    on("POST /cloudsdk/openid4vp/v1/mdoc/initiate", [
      { status: 200, body: { sessionId: "ab-1", walletUri: "mdoc-openid4vp://?client_id=x&request_uri=y", requestUri: "https://x/y" } },
    ]);
    on("POST /cloudsdk/openid4vp/v1/mdoc/result", [
      { status: 202, body: { status: "pending" } },
      { status: 200, body: { success: false, identity: null, error: "User denied consent." } },
    ]);
    const a = adapter();
    const started = await a.startAnnexB(AGE, "https://gate.example.com/verify/return/beer-garden/abc");
    expect(started.walletUri).toMatch(/^mdoc-openid4vp:/);
    expect(calls("POST /cloudsdk/openid4vp/v1/mdoc/initiate")[0]?.body).toEqual({ returnUrl: "https://gate.example.com/verify/return/beer-garden/abc" });

    expect(await a.pollAnnexB(AGE, "ab-1")).toEqual({ status: "pending" });
    expect(await a.pollAnnexB(AGE, "ab-1")).toEqual({ status: "cancelled", message: "User denied consent." });
    expect(calls("POST /cloudsdk/openid4vp/v1/mdoc/result")[0]?.body).toEqual({ sessionId: "ab-1" });
  });

  it("Flow C: sends {} as JSON when there is no returnUrl, as the sample app does", async () => {
    on("POST /cloudsdk/openid4vp/v1/mdoc/initiate", [{ status: 200, body: { sessionId: "ab-1", walletUri: "mdoc-openid4vp://x" } }]);
    await adapter().startAnnexB(AGE);
    const [initiate] = calls("POST /cloudsdk/openid4vp/v1/mdoc/initiate");
    expect(initiate?.contentType).toBe("application/json");
    expect(initiate?.body).toEqual({});
  });

  it("Flow C: resume sends the response_code and no bearer token", async () => {
    on("GET /cloudsdk/openid4vp/v1/mdoc/resume", [{ status: 200, body: { success: true, identity: '{"age_over_21":true}', error: null } }]);
    const result = await adapter().resumeAnnexB("code with/odd&chars");
    expect(result).toMatchObject({ status: "verified", layout: "flat", identity: { age_over_21: true } });
    const [resume] = calls("GET /cloudsdk/openid4vp/v1/mdoc/resume");
    expect(resume?.path).toBe("/cloudsdk/openid4vp/v1/mdoc/resume?response_code=code%20with%2Fodd%26chars");
    expect(resume?.authorization).toBeUndefined();
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(0);
  });

  it("Flow C: an unknown or used response_code is a not_found error", async () => {
    on("GET /cloudsdk/openid4vp/v1/mdoc/resume", [{ status: 404, body: { error: "No session found for response_code" } }]);
    await expect(adapter().resumeAnnexB("used")).rejects.toMatchObject({ kind: "not_found", httpStatus: 404 });
  });
});

describe("LiveCloudSdkAdapter: body-less POSTs", () => {
  /** Answers the way a service does when it requires a JSON body on every POST. */
  const strict =
    (ok: Reply) =>
    (req: Recorded): Reply =>
      req.body === undefined || req.contentType !== "application/json"
        ? { status: 400, body: { error: "INVALID_REQUEST", message: "Request body is missing" } }
        : ok;

  it("starts every flow against a service that rejects a POST with no JSON body", async () => {
    on("POST /cloudsdk/v1/getDocRequest", strict({ status: 201, body: DOC_REQUEST }));
    on("POST /cloudsdk/dcapi/openid4vp/v1/initiate", strict({ status: 200, body: { sessionId: "n-1", payload: { nonce: "n-1" } } }));
    on("POST /cloudsdk/openid4vp/v1/mdoc/initiate", strict({ status: 200, body: { sessionId: "ab-1", walletUri: "mdoc-openid4vp://x" } }));
    const a = adapter();
    await expect(a.startDcMdoc(AGE)).resolves.toEqual(DOC_REQUEST);
    await expect(a.startDcOpenId4Vp(AGE)).resolves.toMatchObject({ sessionId: "n-1" });
    await expect(a.startAnnexB(AGE)).resolves.toMatchObject({ sessionId: "ab-1" });
    await expect(a.startAnnexB(AGE, "https://gate.example.com/verify/return/g/s")).resolves.toMatchObject({ sessionId: "ab-1" });
  });

  it("sends a JSON Content-Type and a body on every POST, and neither on the resume GET", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: DOC_REQUEST }]);
    on("POST /cloudsdk/v1/verifyDocRequest", [{ status: 200, body: { cancelled: true, message: "x" } }]);
    on("POST /cloudsdk/openid4vp/v1/mdoc/result", [{ status: 202, body: { status: "pending" } }]);
    on("GET /cloudsdk/openid4vp/v1/mdoc/resume", [{ status: 202, body: { error: "Validation not yet complete" } }]);
    const a = adapter();
    await a.startDcMdoc(AGE);
    await a.verifyDcMdoc(AGE, "s", "d");
    await a.pollAnnexB(AGE, "s");
    await a.resumeAnnexB("code");
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.path)).toEqual(["/cloudsdk/v1/setup", "/cloudsdk/v1/getDocRequest", "/cloudsdk/v1/verifyDocRequest", "/cloudsdk/openid4vp/v1/mdoc/result"]);
    expect(posts.every((r) => r.contentType === "application/json" && r.body !== undefined)).toBe(true);
    const get = requests.find((r) => r.method === "GET");
    expect(get?.contentType).toBeUndefined();
    expect(get?.body).toBeUndefined();
  });
});

describe("LiveCloudSdkAdapter: errors name the endpoint that failed", () => {
  it("tells the same error code apart by endpoint", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 400, body: { error: "INVALID_REQUEST", message: "bad" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ code: "INVALID_REQUEST", httpStatus: 400, endpoint: "/v1/getDocRequest" });

    on("POST /cloudsdk/v1/setup", [{ status: 400, body: { error: "INVALID_REQUEST", message: "bad" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ code: "INVALID_REQUEST", httpStatus: 400, endpoint: "/v1/setup" });
  });

  it("covers refresh, unreadable 2xx bodies and network failures", async () => {
    on("POST /cloudsdk/v1/getDocRequest", [{ status: 401, body: { error: "TOKEN_EXPIRED" } }]);
    on("POST /cloudsdk/v1/refresh", [{ status: 403, body: { error: "DOMAIN_MISMATCH" } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ code: "DOMAIN_MISMATCH", endpoint: "/v1/refresh" });

    on("POST /cloudsdk/v1/getDocRequest", [{ status: 201, body: { unexpected: true } }]);
    await expect(adapter().startDcMdoc(AGE)).rejects.toMatchObject({ kind: "bad_response", endpoint: "/v1/getDocRequest" });

    on("POST /cloudsdk/v1/verifyDocRequest", [{ status: 200, body: { neither: "shape" } }]);
    await expect(adapter().verifyDcMdoc(AGE, "s", "d")).rejects.toMatchObject({ kind: "bad_response", endpoint: "/v1/verifyDocRequest" });

    const dead = new LiveCloudSdkAdapter({
      baseUrl: "http://127.0.0.1:1/cloudsdk",
      licenseKey: new Secret(LICENSE),
      registeredOrigin: ORIGIN,
      sleep: async () => {},
      timeoutMs: 1000,
    });
    await expect(dead.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "network", endpoint: "/v1/setup" });
  });

  it("never includes the query string, which carries the response_code", async () => {
    on("GET /cloudsdk/openid4vp/v1/mdoc/resume", [{ status: 404, body: { error: "No session found for response_code" } }]);
    const err = (await adapter().resumeAnnexB("secret-code-123").catch((e: unknown) => e)) as CloudSdkError;
    expect(err.endpoint).toBe("/openid4vp/v1/mdoc/resume");
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain("secret-code-123");
  });

  it("keeps the endpoint on the local cool-down error after a 429", async () => {
    on("POST /cloudsdk/v1/setup", [{ status: 429, body: { error: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "30" } }]);
    const a = adapter();
    await expect(a.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "rate_limit", endpoint: "/v1/setup" });
    await expect(a.startDcMdoc(AGE)).rejects.toMatchObject({ kind: "rate_limit", endpoint: "/v1/setup" });
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(1);
  });
});

describe("LiveCloudSdkAdapter.probeSetup (smoke test)", () => {
  it("returns only printable fields on success: no tokens", async () => {
    const probe = await adapter().probeSetup(AGE);
    expect(probe).toEqual({ httpStatus: 200, ok: true, profileName: "Age Check Profile", customerName: "Acme Venues", expiresIn: 900 });
    expect(JSON.stringify(probe)).not.toMatch(/access-|rt_|CS_/);
  });

  it("returns the error code on failure, with a single request", async () => {
    on("POST /cloudsdk/v1/setup", [{ status: 403, body: { error: "DOMAIN_MISMATCH", message: "Origin does not match" } }]);
    expect(await adapter().probeSetup(AGE)).toEqual({ httpStatus: 403, ok: false, errorCode: "DOMAIN_MISMATCH" });

    on("POST /cloudsdk/v1/setup", [{ status: 500, body: { error: "INTERNAL_ERROR" } }]);
    expect(await adapter().probeSetup(AGE)).toEqual({ httpStatus: 500, ok: false, errorCode: "INTERNAL_ERROR" });
    expect(calls("POST /cloudsdk/v1/setup")).toHaveLength(2);
  });
});
