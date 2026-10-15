// Pure parsers for Cloud SDK verification responses. Used by both the live and the mock
// adapter, so mock mode exercises exactly the code that real responses go through.

import type { DecisionCheck } from "../../shared/types";
import { badResponse } from "./errors";

export type Claims = Record<string, unknown>;
export type FailureKind = "expired" | "untrusted" | "invalid";
/** nested = { identity, authentication } (sample app); flat = claims at the top level (API reference example). */
export type Layout = "nested" | "flat" | "none";

export type VerificationResult =
  | { status: "verified"; identity: Claims; authentication: Claims; layout: "nested" | "flat" }
  | { status: "failed"; failure: FailureKind; detail: string; identity: Claims; authentication: Claims; layout: Layout }
  | { status: "cancelled"; message: string }
  | { status: "timed_out"; message: string };

export type PollResult = VerificationResult | { status: "pending" };

function isRecord(value: unknown): value is Claims {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NO_DETAILS = { identity: {}, authentication: {}, layout: "none" } as const;

/**
 * Parses `resDetails` (Flows A/B) or `identity` (Flow C). Both are JSON *strings*.
 *
 * The API reference shows the claims flat at the top level in one example and as
 * { identity, authentication } in another; the sample app expects the nested form and an
 * optional documents[] array. All three are accepted.
 */
export function parseDetails(raw: unknown): { identity: Claims; authentication: Claims; layout: Layout } {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return NO_DETAILS;
    }
  }
  if (!isRecord(value)) return NO_DETAILS;

  let source = value;
  if (!isRecord(source.identity) && !isRecord(source.authentication) && Array.isArray(source.documents)) {
    const first: unknown = source.documents[0];
    if (isRecord(first)) source = first;
  }
  if (isRecord(source.identity) || isRecord(source.authentication)) {
    return {
      identity: isRecord(source.identity) ? source.identity : {},
      authentication: isRecord(source.authentication) ? source.authentication : {},
      layout: "nested",
    };
  }
  return { identity: value, authentication: {}, layout: "flat" };
}

function isSet(value: unknown): boolean {
  if (typeof value !== "string") return value !== null && value !== undefined;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "[]" && trimmed !== "null";
}

const SIGNATURE_FLAGS = [
  "issuerSignedAuthenticated",
  "deviceSignedAuthenticated",
  "dataIntegrity",
  "issuerAuthValid",
  "deviceAuthValid",
] as const;

/**
 * Decides why a credential failed.
 *
 * TODO(live): the API reference only says a failed result carries "a human-readable error
 * description" and does not list the strings. The flag names come from the sample app's
 * types. Confirm both against real failures (see GET /api/admin/debug/shapes) and tighten.
 */
export function classifyFailure(text: string, authentication: Claims): { failure: FailureKind; detail: string } {
  const validity = typeof authentication.msoValidity === "string" ? authentication.msoValidity : "";
  if (/expir/i.test(validity)) return { failure: "expired", detail: "The credential's validity period has ended." };
  if (authentication.issuerRecognized === false || isSet(authentication.certValidationError)) {
    return { failure: "untrusted", detail: "The issuer's certificate is not in the trusted list." };
  }
  const failedFlag = SIGNATURE_FLAGS.find((flag) => authentication[flag] === false);
  if (failedFlag) return { failure: "invalid", detail: `${humanise(failedFlag)} check failed.` };

  const detail = text.trim().slice(0, 200);
  if (/expir/i.test(detail)) return { failure: "expired", detail };
  if (/untrust|not\s+trusted|trust(ed)?\s+(list|chain|anchor)|iaca|issuer.*(unknown|not\s+recogni[sz]ed)|certificate/i.test(detail)) {
    return { failure: "untrusted", detail };
  }
  return { failure: "invalid", detail: detail || "The credential did not pass verification." };
}

/**
 * Flows A and B, HTTP 200. Cancellation is its own shape and is checked before `res`.
 */
export function parseDcVerifyResponse(body: unknown): VerificationResult {
  if (!isRecord(body)) throw badResponse("Verification response was not a JSON object.");
  if (body.cancelled === true) {
    return {
      status: "cancelled",
      message: typeof body.message === "string" ? body.message : "Verification was cancelled by the user.",
    };
  }
  if (typeof body.res !== "boolean") throw badResponse("Verification response had no boolean `res`.");

  const details = parseDetails(body.resDetails);
  if (body.res) {
    if (details.layout === "none") throw badResponse("`res` was true but `resDetails` was not a JSON object.");
    return { status: "verified", identity: details.identity, authentication: details.authentication, layout: details.layout };
  }
  // When res is false, resDetails is documented as a plain description, not JSON.
  const text = details.layout === "none" && typeof body.resDetails === "string" ? body.resDetails : "";
  return { status: "failed", ...classifyFailure(text, details.authentication), ...details };
}

/**
 * Flow B validate. Unlike Flow A, a credential that fails verification comes back as
 * HTTP 400 { error: "Validation failed: <message>" } rather than 200 with res=false.
 * Returns null when the response is not a verification outcome (the caller throws).
 */
export function parseOpenId4VpValidateResponse(status: number, body: unknown): VerificationResult | null {
  if (status === 200) return parseDcVerifyResponse(body);
  if (status === 400 && isRecord(body) && typeof body.error === "string") {
    const match = /^Validation failed:?\s*(.*)$/is.exec(body.error);
    if (match) return { status: "failed", ...classifyFailure(match[1] ?? "", {}), ...NO_DETAILS };
  }
  return null;
}

/**
 * Flow C result / resume. 202 = pending. 200 = finished, where `success: false` covers
 * both "the visitor said no" and "the credential failed"; only the error text tells them apart.
 */
export function parseAnnexBResponse(status: number, body: unknown): PollResult {
  if (status === 202) return { status: "pending" };
  if (!isRecord(body) || typeof body.success !== "boolean") {
    throw badResponse("Annex B result had no boolean `success`.", status);
  }
  if (body.success) {
    const details = parseDetails(body.identity);
    if (details.layout === "none") throw badResponse("`success` was true but `identity` was not a JSON object.");
    return { status: "verified", identity: details.identity, authentication: details.authentication, layout: details.layout };
  }
  const error = typeof body.error === "string" ? body.error : "";
  // "User denied consent." and "Session timed out." are the two examples the API reference gives.
  if (/denied consent|cancel|declin/i.test(error)) return { status: "cancelled", message: error };
  if (/timed?\s*out/i.test(error)) return { status: "timed_out", message: error };
  return { status: "failed", ...classifyFailure(error, {}), ...NO_DETAILS };
}

export function humanise(key: string): string {
  const words = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Turns whatever boolean checks the response actually contains into rows for the staff screen. */
export function summariseAuthentication(authentication: Claims): DecisionCheck[] {
  const checks: DecisionCheck[] = [];
  for (const [key, value] of Object.entries(authentication)) {
    if (typeof value === "boolean") checks.push({ label: humanise(key), passed: value });
  }
  const validity = authentication.msoValidity;
  if (typeof validity === "string" && validity.trim() !== "") {
    checks.push({ label: "Validity period", passed: !/expir|invalid|not/i.test(validity), detail: validity.slice(0, 60) });
  }
  return checks;
}

/** Key names only. Safe to log: never includes a claim value. */
export function describeShape(result: VerificationResult): {
  verified: boolean;
  layout: Layout;
  identityKeys: string[];
  authenticationKeys: string[];
} {
  if (result.status !== "verified" && result.status !== "failed") {
    return { verified: false, layout: "none", identityKeys: [], authenticationKeys: [] };
  }
  return {
    verified: result.status === "verified",
    layout: result.layout,
    identityKeys: Object.keys(result.identity).sort(),
    authenticationKeys: Object.keys(result.authentication).sort(),
  };
}
