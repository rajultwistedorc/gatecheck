import type { Secret } from "../config";
import type { AnnexBStart, CloudSdkAdapter, DcMdocStart, DcOpenId4VpStart } from "./adapter";
import { CloudSdkError, badResponse, cloudErrorFromResponse, networkError, withEndpoint } from "./errors";
import {
  parseAnnexBResponse,
  parseDcVerifyResponse,
  parseOpenId4VpValidateResponse,
  type PollResult,
  type VerificationResult,
} from "./parse";
import { TokenManager, parseTokenResponse, type TokenResponse, type TokenStatus } from "./tokenManager";

export interface LiveAdapterOptions {
  baseUrl: string;
  licenseKey: Secret;
  /** Sent as the Origin header. Required on /v1/setup, and must match wherever it is sent. */
  registeredOrigin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Replaced in tests so back-off does not slow them down. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SetupProbe {
  httpStatus: number | null;
  ok: boolean;
  profileName?: string;
  customerName?: string;
  expiresIn?: number;
  errorCode?: string;
}

interface HttpResult {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

interface SendOptions {
  json?: unknown;
  bearer?: string;
}

const BACKOFF_MS = 400;

/**
 * Body for POSTs that carry no fields. The API reference describes these bodies as empty
 * and its curl examples send none, but the official sample app posts `{}` with
 * Content-Type: application/json. This follows the sample.
 */
const EMPTY_JSON_BODY: Record<string, never> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LiveCloudSdkAdapter implements CloudSdkAdapter {
  readonly mode = "live" as const;
  private readonly managers = new Map<string, TokenManager>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LiveAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---- Flow A ---------------------------------------------------------------

  async startDcMdoc(profileId: string): Promise<DcMdocStart> {
    // Documented as 201 Created; 200 is accepted too.
    const { body } = await this.authed(profileId, "POST", "/v1/getDocRequest", EMPTY_JSON_BODY, [200, 201], true);
    if (
      !isRecord(body) ||
      typeof body.sessionId !== "string" ||
      !isRecord(body.dcRequest) ||
      typeof body.dcRequest.deviceRequest !== "string"
    ) {
      throw withEndpoint(badResponse("getDocRequest response was missing sessionId or dcRequest.deviceRequest."), "/v1/getDocRequest");
    }
    return {
      sessionId: body.sessionId,
      dcRequest: {
        deviceRequest: body.dcRequest.deviceRequest,
        encryptionInfo: typeof body.dcRequest.encryptionInfo === "string" ? body.dcRequest.encryptionInfo : "",
      },
    };
  }

  async verifyDcMdoc(profileId: string, sessionId: string, data: string): Promise<VerificationResult> {
    const { body } = await this.authed(profileId, "POST", "/v1/verifyDocRequest", { sessionId, data }, [200], false);
    return this.read("/v1/verifyDocRequest", () => parseDcVerifyResponse(body));
  }

  // ---- Flow B ---------------------------------------------------------------

  async startDcOpenId4Vp(profileId: string): Promise<DcOpenId4VpStart> {
    const { body } = await this.authed(profileId, "POST", "/dcapi/openid4vp/v1/initiate", EMPTY_JSON_BODY, [200], true);
    if (!isRecord(body) || typeof body.sessionId !== "string" || !isRecord(body.payload)) {
      throw withEndpoint(badResponse("OpenID4VP initiate response was missing sessionId or payload."), "/dcapi/openid4vp/v1/initiate");
    }
    return { sessionId: body.sessionId, payload: body.payload };
  }

  async validateDcOpenId4Vp(profileId: string, sessionId: string, data: string): Promise<VerificationResult> {
    // 400 is accepted here because that is how this endpoint reports a failed credential.
    const res = await this.authed(profileId, "POST", "/dcapi/openid4vp/v1/validate", { sessionId, data }, [200, 400], false);
    const path = "/dcapi/openid4vp/v1/validate";
    const result = this.read(path, () => parseOpenId4VpValidateResponse(res.status, res.body));
    if (!result) throw withEndpoint(cloudErrorFromResponse(res.status, res.body, res.retryAfter), path);
    return result;
  }

  // ---- Flow C ---------------------------------------------------------------

  async startAnnexB(profileId: string, returnUrl?: string): Promise<AnnexBStart> {
    const json = returnUrl ? { returnUrl } : EMPTY_JSON_BODY;
    const { body } = await this.authed(profileId, "POST", "/openid4vp/v1/mdoc/initiate", json, [200], true);
    if (!isRecord(body) || typeof body.sessionId !== "string" || typeof body.walletUri !== "string") {
      throw withEndpoint(badResponse("Annex B initiate response was missing sessionId or walletUri."), "/openid4vp/v1/mdoc/initiate");
    }
    return {
      sessionId: body.sessionId,
      walletUri: body.walletUri,
      requestUri: typeof body.requestUri === "string" ? body.requestUri : "",
    };
  }

  async pollAnnexB(profileId: string, sessionId: string): Promise<PollResult> {
    const res = await this.authed(profileId, "POST", "/openid4vp/v1/mdoc/result", { sessionId }, [200, 202], true);
    return this.read("/openid4vp/v1/mdoc/result", () => parseAnnexBResponse(res.status, res.body));
  }

  async resumeAnnexB(responseCode: string): Promise<PollResult> {
    // No bearer token: the single-use response_code is the credential.
    const path = `/openid4vp/v1/mdoc/resume?response_code=${encodeURIComponent(responseCode)}`;
    const res = await this.request("GET", path, {}, [200, 202], false);
    return this.read(path, () => parseAnnexBResponse(res.status, res.body));
  }

  // ---- Tokens ---------------------------------------------------------------

  tokenStatus(): Record<string, TokenStatus> {
    const out: Record<string, TokenStatus> = {};
    for (const [profileId, manager] of this.managers) out[profileId] = manager.status();
    return out;
  }

  /**
   * One POST /v1/setup with no retries, for the smoke test. Returns only fields that are
   * safe to print: the tokens in the response are dropped here and never leave this method.
   */
  async probeSetup(profileId: string): Promise<SetupProbe> {
    let res: HttpResult;
    try {
      res = await this.send("POST", "/v1/setup", { json: this.setupBody(profileId) });
    } catch (err) {
      return { httpStatus: null, ok: false, errorCode: err instanceof CloudSdkError ? err.code : "NETWORK_ERROR" };
    }
    if (res.status !== 200) {
      return { httpStatus: res.status, ok: false, errorCode: cloudErrorFromResponse(res.status, res.body, res.retryAfter).code };
    }
    try {
      const tokens = parseTokenResponse(res.body);
      return {
        httpStatus: 200,
        ok: true,
        profileName: tokens.profileName ?? "",
        customerName: tokens.customerName ?? "",
        expiresIn: tokens.expiresIn,
      };
    } catch {
      return { httpStatus: 200, ok: false, errorCode: "BAD_RESPONSE" };
    }
  }

  /** One token manager per profile: a token is only valid for the profile it was issued for. */
  private tokens(profileId: string): TokenManager {
    let manager = this.managers.get(profileId);
    if (!manager) {
      manager = new TokenManager(
        {
          setup: async () => {
            const res = await this.request("POST", "/v1/setup", { json: this.setupBody(profileId) }, [200], true);
            return this.read("/v1/setup", () => parseTokenResponse(res.body));
          },
          // Never retried on a network error: the refresh token is single-use.
          refresh: async (refreshToken): Promise<TokenResponse> => {
            const res = await this.request("POST", "/v1/refresh", { json: { refreshToken } }, [200], false);
            return this.read("/v1/refresh", () => parseTokenResponse(res.body));
          },
        },
        this.options.now,
      );
      this.managers.set(profileId, manager);
    }
    return manager;
  }

  /** Interprets a response body, noting the endpoint on anything it throws. */
  private read<T>(path: string, interpret: () => T): T {
    try {
      return interpret();
    } catch (err) {
      throw withEndpoint(err, path);
    }
  }

  private setupBody(profileId: string): { licenseKey: string; profileId: string } {
    return { licenseKey: this.options.licenseKey.reveal(), profileId };
  }

  /** A call that carries the profile's access token, refreshing once if the API rejects it. */
  private async authed(
    profileId: string,
    method: "GET" | "POST",
    path: string,
    json: unknown,
    accept: readonly number[],
    retryNetwork: boolean,
  ): Promise<HttpResult> {
    const tokens = this.tokens(profileId);
    for (let attempt = 0; ; attempt++) {
      const bearer = await tokens.getAccessToken();
      try {
        return await this.request(method, path, { json, bearer }, accept, retryNetwork);
      } catch (err) {
        const tokenRejected =
          err instanceof CloudSdkError &&
          err.httpStatus === 401 &&
          (err.code === "TOKEN_EXPIRED" || err.code === "INVALID_TOKEN");
        if (attempt === 0 && tokenRejected) {
          tokens.invalidate(bearer);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Sends a request and applies the retry guidance from the API reference:
   * 500 "retry once with backoff", 502 "retry with backoff". 429 is never retried here;
   * the caller sees Retry-After. Anything not in `accept` becomes a CloudSdkError.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    options: SendOptions,
    accept: readonly number[],
    retryNetwork: boolean,
  ): Promise<HttpResult> {
    let serverRetries = 0;
    let networkRetried = false;
    for (;;) {
      let res: HttpResult;
      try {
        res = await this.send(method, path, options);
      } catch (err) {
        if (retryNetwork && !networkRetried) {
          networkRetried = true;
          await this.sleep(BACKOFF_MS);
          continue;
        }
        throw withEndpoint(err, path);
      }
      if (accept.includes(res.status)) return res;

      const allowed = res.status === 500 ? 1 : res.status === 502 ? 2 : 0;
      if (serverRetries < allowed) {
        serverRetries += 1;
        await this.sleep(BACKOFF_MS * 2 ** (serverRetries - 1));
        continue;
      }
      throw withEndpoint(cloudErrorFromResponse(res.status, res.body, res.retryAfter), path);
    }
  }

  private async send(method: "GET" | "POST", path: string, options: SendOptions): Promise<HttpResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: this.options.registeredOrigin,
    };
    if (options.json !== undefined) headers["Content-Type"] = "application/json";
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.options.baseUrl + path, {
        method,
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      text = await response.text();
    } catch (err) {
      throw networkError(err);
    }

    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
  }
}
