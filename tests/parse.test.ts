import { describe, expect, it } from "vitest";
import { CloudSdkError, cloudErrorFromResponse } from "../src/server/cloud/errors";
import {
  classifyFailure,
  describeShape,
  parseAnnexBResponse,
  parseDcVerifyResponse,
  parseDetails,
  parseOpenId4VpValidateResponse,
  summariseAuthentication,
} from "../src/server/cloud/parse";

const nested = JSON.stringify({
  identity: { family_name: "Smith", given_name: "Jane", birth_date: "1990-01-15" },
  authentication: { authenticationResult: "SUCCESS", issuerRecognized: true },
});

describe("parseDetails", () => {
  it("parses the nested { identity, authentication } JSON string used by the sample app", () => {
    const details = parseDetails(nested);
    expect(details.layout).toBe("nested");
    expect(details.identity).toEqual({ family_name: "Smith", given_name: "Jane", birth_date: "1990-01-15" });
    expect(details.authentication).toEqual({ authenticationResult: "SUCCESS", issuerRecognized: true });
  });

  it("parses the flat claims JSON string shown in the API reference", () => {
    const details = parseDetails('{"family_name":"Smith","given_name":"Jane","birth_date":"1990-01-15"}');
    expect(details.layout).toBe("flat");
    expect(details.identity.given_name).toBe("Jane");
    expect(details.authentication).toEqual({});
  });

  it("uses the first document of a multi-document presentation", () => {
    const details = parseDetails(JSON.stringify({ documents: [{ docType: "mDL", identity: { age_over_21: true }, authentication: { dataIntegrity: true } }] }));
    expect(details).toEqual({ layout: "nested", identity: { age_over_21: true }, authentication: { dataIntegrity: true } });
  });

  it("handles an age-only credential: a single claim and nothing else", () => {
    const details = parseDetails(JSON.stringify({ identity: { age_over_21: true }, authentication: {} }));
    expect(Object.keys(details.identity)).toEqual(["age_over_21"]);
  });

  it.each(["not json at all", "", "42", '"a string"', "[1,2]", null, undefined, 7])("returns no details for %j", (raw) => {
    expect(parseDetails(raw)).toEqual({ identity: {}, authentication: {}, layout: "none" });
  });
});

describe("parseDcVerifyResponse (Flows A and B)", () => {
  it("returns verified claims when res is true", () => {
    const result = parseDcVerifyResponse({ res: true, resDetails: nested });
    expect(result).toMatchObject({ status: "verified", layout: "nested", identity: { given_name: "Jane" } });
  });

  it("checks `cancelled` before `res`: it is a separate response shape, not a failure", () => {
    expect(parseDcVerifyResponse({ cancelled: true, message: "Verification was cancelled by the user." })).toEqual({
      status: "cancelled",
      message: "Verification was cancelled by the user.",
    });
    // Even if a body carried both, cancellation wins.
    expect(parseDcVerifyResponse({ cancelled: true, res: true, resDetails: nested }).status).toBe("cancelled");
  });

  it("treats HTTP 200 with res=false as a failed verification, with a plain-text reason", () => {
    const result = parseDcVerifyResponse({ res: false, resDetails: "Document has expired" });
    expect(result).toMatchObject({ status: "failed", failure: "expired", detail: "Document has expired", layout: "none" });
  });

  it("reads the authentication flags when a failure carries JSON details", () => {
    const resDetails = JSON.stringify({ identity: {}, authentication: { issuerRecognized: false, msoValidity: "VALID" } });
    expect(parseDcVerifyResponse({ res: false, resDetails })).toMatchObject({ status: "failed", failure: "untrusted" });
  });

  it("rejects a body it cannot interpret instead of guessing", () => {
    expect(() => parseDcVerifyResponse("nope")).toThrowError(CloudSdkError);
    expect(() => parseDcVerifyResponse({})).toThrowError(/no boolean `res`/);
    expect(() => parseDcVerifyResponse({ res: "true", resDetails: nested })).toThrowError(CloudSdkError);
    // res=true must come with claims we can read.
    expect(() => parseDcVerifyResponse({ res: true, resDetails: "oops" })).toThrowError(/not a JSON object/);
  });
});

describe("parseOpenId4VpValidateResponse (Flow B)", () => {
  it("parses a 200 like Flow A", () => {
    expect(parseOpenId4VpValidateResponse(200, { res: true, resDetails: nested })?.status).toBe("verified");
    expect(parseOpenId4VpValidateResponse(200, { cancelled: true, message: "x" })?.status).toBe("cancelled");
  });

  it('maps HTTP 400 "Validation failed: ..." to a failed verification', () => {
    const result = parseOpenId4VpValidateResponse(400, { error: "Validation failed: Issuer certificate is not in the trusted list." });
    expect(result).toMatchObject({ status: "failed", failure: "untrusted", detail: "Issuer certificate is not in the trusted list." });
  });

  it("returns null for other errors so the caller raises them", () => {
    expect(parseOpenId4VpValidateResponse(400, { error: "Unsupported profile configuration. Contact your administrator." })).toBeNull();
    expect(parseOpenId4VpValidateResponse(401, { error: "TOKEN_EXPIRED" })).toBeNull();
    expect(parseOpenId4VpValidateResponse(500, null)).toBeNull();
  });
});

describe("parseAnnexBResponse (Flow C)", () => {
  it("treats 202 as pending whatever the body", () => {
    expect(parseAnnexBResponse(202, { status: "pending" })).toEqual({ status: "pending" });
    expect(parseAnnexBResponse(202, { error: "Validation not yet complete" })).toEqual({ status: "pending" });
  });

  it("parses `identity` as a JSON string on success", () => {
    const result = parseAnnexBResponse(200, { success: true, identity: nested, error: null });
    expect(result).toMatchObject({ status: "verified", identity: { family_name: "Smith" } });
  });

  it('maps "User denied consent." to cancelled, not to a failed credential', () => {
    expect(parseAnnexBResponse(200, { success: false, identity: null, error: "User denied consent." })).toEqual({
      status: "cancelled",
      message: "User denied consent.",
    });
  });

  it('maps "Session timed out." to a timeout', () => {
    expect(parseAnnexBResponse(200, { success: false, identity: null, error: "Session timed out." }).status).toBe("timed_out");
  });

  it("maps any other success=false to a failed credential", () => {
    expect(parseAnnexBResponse(200, { success: false, identity: null, error: "Document validity period has expired." })).toMatchObject({
      status: "failed",
      failure: "expired",
    });
    expect(parseAnnexBResponse(200, { success: false, identity: null, error: null })).toMatchObject({ status: "failed", failure: "invalid" });
  });

  it("rejects malformed bodies", () => {
    expect(() => parseAnnexBResponse(200, { identity: nested })).toThrowError(CloudSdkError);
    expect(() => parseAnnexBResponse(200, { success: true, identity: null })).toThrowError(CloudSdkError);
  });
});

describe("classifyFailure", () => {
  it("prefers the authentication flags over the text", () => {
    expect(classifyFailure("something vague", { msoValidity: "EXPIRED" }).failure).toBe("expired");
    expect(classifyFailure("", { issuerRecognized: false }).failure).toBe("untrusted");
    expect(classifyFailure("", { certValidationError: "[PKIX path building failed]" }).failure).toBe("untrusted");
    expect(classifyFailure("", { certValidationError: "[]", deviceSignedAuthenticated: false })).toEqual({
      failure: "invalid",
      detail: "Device signed authenticated check failed.",
    });
  });

  it("falls back to keywords in the text, and to 'invalid' when nothing matches", () => {
    expect(classifyFailure("MSO expired on 2024-01-01", {}).failure).toBe("expired");
    expect(classifyFailure("Issuer not in trusted list.", {}).failure).toBe("untrusted");
    expect(classifyFailure("Device signature verification failed.", {}).failure).toBe("invalid");
    expect(classifyFailure("", {})).toEqual({ failure: "invalid", detail: "The credential did not pass verification." });
  });
});

describe("summariseAuthentication", () => {
  it("builds check rows only from booleans that are actually present", () => {
    expect(summariseAuthentication({})).toEqual([]);
    expect(summariseAuthentication({ issuerRecognized: true, dataIntegrity: false, issuerSubjectInfo: "CN=X", msoValidity: "EXPIRED" })).toEqual([
      { label: "Issuer recognized", passed: true },
      { label: "Data integrity", passed: false },
      { label: "Validity period", passed: false, detail: "EXPIRED" },
    ]);
  });
});

describe("describeShape", () => {
  it("reports key names only, never values", () => {
    const shape = describeShape(parseDcVerifyResponse({ res: true, resDetails: nested }));
    expect(shape).toEqual({
      verified: true,
      layout: "nested",
      identityKeys: ["birth_date", "family_name", "given_name"],
      authenticationKeys: ["authenticationResult", "issuerRecognized"],
    });
    expect(JSON.stringify(shape)).not.toMatch(/Smith|Jane|1990/);
  });

  it("is empty for a cancellation", () => {
    expect(describeShape({ status: "cancelled", message: "x" })).toEqual({ verified: false, layout: "none", identityKeys: [], authenticationKeys: [] });
  });
});

describe("cloudErrorFromResponse", () => {
  it.each([
    [401, { error: "INVALID_LICENSE_KEY", message: "x" }, "auth", "SDK_AUTH_ERROR"],
    [401, { error: "TOKEN_EXPIRED" }, "auth", "SDK_AUTH_ERROR"],
    [403, { error: "DOMAIN_MISMATCH", message: "x" }, "domain", "SDK_DOMAIN_MISMATCH"],
    [403, { error: "PROFILE_NOT_FOUND" }, "profile", "SDK_PROFILE_ERROR"],
    [422, { error: "PROFILE_NOT_SUPPORTED" }, "profile", "SDK_PROFILE_ERROR"],
    [400, { error: "Unsupported profile configuration. Contact your administrator." }, "profile", "SDK_PROFILE_ERROR"],
    [429, { error: "PLAN_LIMIT_EXCEEDED" }, "quota", "SDK_QUOTA_EXCEEDED"],
    [429, { error: "RATE_LIMIT_EXCEEDED" }, "rate_limit", "SDK_RATE_LIMITED"],
    [429, { error: "Rate limit exceeded" }, "rate_limit", "SDK_RATE_LIMITED"],
    [500, { error: "INTERNAL_ERROR" }, "upstream", "SDK_UNAVAILABLE"],
    [502, { error: "UPSTREAM_ERROR" }, "upstream", "SDK_UNAVAILABLE"],
    [503, { error: "READER_AUTH_UNAVAILABLE" }, "upstream", "SDK_UNAVAILABLE"],
    [504, null, "upstream", "SDK_UNAVAILABLE"],
    [404, { error: "Session not found: abc" }, "not_found", "SDK_BAD_RESPONSE"],
    [400, { error: "INVALID_REQUEST" }, "bad_request", "SDK_BAD_RESPONSE"],
  ] as const)("maps HTTP %i %j to %s", (status, body, kind, reasonCode) => {
    const err = cloudErrorFromResponse(status, body, null);
    expect(err.kind).toBe(kind);
    expect(err.reasonCode).toBe(reasonCode);
    expect(err.httpStatus).toBe(status);
  });

  it("keeps the Cloud SDK code, or synthesises one from the status", () => {
    expect(cloudErrorFromResponse(403, { error: "DOMAIN_MISMATCH" }, null).code).toBe("DOMAIN_MISMATCH");
    expect(cloudErrorFromResponse(404, { error: "Session not found: abc" }, null).code).toBe("HTTP_404");
  });

  it("reads Retry-After as seconds", () => {
    expect(cloudErrorFromResponse(429, { error: "RATE_LIMIT_EXCEEDED" }, "17").retryAfterSec).toBe(17);
    expect(cloudErrorFromResponse(429, { error: "RATE_LIMIT_EXCEEDED" }, null).retryAfterSec).toBeNull();
  });
});
