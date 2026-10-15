import type { ReasonCode } from "../../shared/types";

export type CloudErrorKind =
  | "auth" // license or token rejected
  | "domain" // Origin / returnUrl does not match the registered domain
  | "profile" // profile missing or unsupported
  | "quota" // monthly plan limit
  | "rate_limit" // per-IP rate limit
  | "upstream" // 5xx from the Cloud SDK
  | "network" // could not reach the Cloud SDK at all
  | "not_found" // unknown session or response_code
  | "bad_request" // other 4xx
  | "bad_response"; // 2xx with a body we cannot interpret

const KIND_BY_CODE: Record<string, CloudErrorKind> = {
  INVALID_LICENSE_KEY: "auth",
  LICENSE_EXPIRED_OR_REVOKED: "auth",
  MISSING_TOKEN: "auth",
  MISSING_AUTH_CONTEXT: "auth",
  INVALID_TOKEN: "auth",
  TOKEN_EXPIRED: "auth",
  REFRESH_TOKEN_EXPIRED: "auth",
  DOMAIN_MISMATCH: "domain",
  PROFILE_NOT_FOUND: "profile",
  PROFILE_NOT_SUPPORTED: "profile",
  PLAN_LIMIT_EXCEEDED: "quota",
  RATE_LIMIT_EXCEEDED: "rate_limit",
  INTERNAL_ERROR: "upstream",
  UPSTREAM_ERROR: "upstream",
  READER_AUTH_UNAVAILABLE: "upstream",
  INVALID_REQUEST: "bad_request",
};

const REASON_BY_KIND: Record<CloudErrorKind, ReasonCode> = {
  auth: "SDK_AUTH_ERROR",
  domain: "SDK_DOMAIN_MISMATCH",
  profile: "SDK_PROFILE_ERROR",
  quota: "SDK_QUOTA_EXCEEDED",
  rate_limit: "SDK_RATE_LIMITED",
  upstream: "SDK_UNAVAILABLE",
  network: "SDK_UNAVAILABLE",
  not_found: "SDK_BAD_RESPONSE",
  bad_request: "SDK_BAD_RESPONSE",
  bad_response: "SDK_BAD_RESPONSE",
};

export class CloudSdkError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    /** HTTP status, or null when no response was received. */
    readonly httpStatus: number | null,
    /** Cloud SDK error code when it sent one (e.g. DOMAIN_MISMATCH), else HTTP_<status>. */
    readonly code: string,
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "CloudSdkError";
  }

  /** Path of the Cloud SDK endpoint the error came from, when known. Never includes the query string. */
  endpoint: string | null = null;

  get reasonCode(): ReasonCode {
    return REASON_BY_KIND[this.kind];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * Maps a non-success Cloud SDK response to a typed error.
 *
 * Bodies come in two shapes: { error: "CODE", message: "..." } from the auth layer, and
 * { error: "human readable text" } from the flow controllers.
 */
export function cloudErrorFromResponse(status: number, body: unknown, retryAfterHeader: string | null): CloudSdkError {
  const errorField = isRecord(body) && typeof body.error === "string" ? body.error : "";
  const messageField = isRecord(body) && typeof body.message === "string" ? body.message : "";
  const isCode = /^[A-Z][A-Z0-9_]+$/.test(errorField);
  const code = isCode ? errorField : `HTTP_${status}`;
  const text = (messageField || (isCode ? "" : errorField) || `Cloud SDK returned HTTP ${status}`).slice(0, 240);
  const retryAfter = parseRetryAfter(retryAfterHeader);

  let kind: CloudErrorKind | undefined = isCode ? KIND_BY_CODE[errorField] : undefined;
  if (!kind) {
    if (status === 429) kind = "rate_limit";
    else if (status >= 500) kind = "upstream";
    else if (status === 401) kind = "auth";
    else if (status === 403) kind = "domain";
    else if (status === 404) kind = "not_found";
    else if (/unsupported profile|unknown document type/i.test(errorField)) kind = "profile";
    else kind = "bad_request";
  }
  return new CloudSdkError(kind, status, code, text, retryAfter);
}

/**
 * Notes which endpoint an error came from, for the log. Only the path is kept: the query
 * string of the resume endpoint carries a response_code, which is a credential.
 */
export function withEndpoint<T>(err: T, path: string): T {
  if (err instanceof CloudSdkError && err.endpoint === null) err.endpoint = path.split("?")[0] ?? path;
  return err;
}

export function networkError(cause: unknown): CloudSdkError {
  const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
  return new CloudSdkError(
    "network",
    null,
    timedOut ? "TIMEOUT" : "NETWORK_ERROR",
    timedOut ? "The Cloud SDK did not answer in time." : "The Cloud SDK could not be reached.",
  );
}

export function badResponse(message: string, httpStatus: number | null = 200): CloudSdkError {
  return new CloudSdkError("bad_response", httpStatus, "BAD_RESPONSE", message);
}
