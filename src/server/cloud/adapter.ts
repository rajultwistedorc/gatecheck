import type { PollResult, VerificationResult } from "./parse";
import type { TokenStatus } from "./tokenManager";

export interface DcMdocStart {
  sessionId: string;
  dcRequest: { deviceRequest: string; encryptionInfo: string };
}

export interface DcOpenId4VpStart {
  sessionId: string;
  /** OpenID4VP authorization request. Passed to the browser unchanged. */
  payload: Record<string, unknown>;
}

export interface AnnexBStart {
  sessionId: string;
  walletUri: string;
  requestUri: string;
}

/**
 * The one seam between GateCheck and the Cloud SDK. The live adapter (HTTP) and the mock
 * adapter (in-memory) both implement it, and nothing else in the app knows which is in use.
 *
 * Every call names the reader profile, because an access token is bound to the profile it
 * was issued for.
 */
export interface CloudSdkAdapter {
  readonly mode: "live" | "mock";

  // Flow A: Digital Credentials API + ISO mdoc
  startDcMdoc(profileId: string): Promise<DcMdocStart>;
  verifyDcMdoc(profileId: string, sessionId: string, data: string): Promise<VerificationResult>;

  // Flow B: Digital Credentials API + OpenID4VP
  startDcOpenId4Vp(profileId: string): Promise<DcOpenId4VpStart>;
  validateDcOpenId4Vp(profileId: string, sessionId: string, data: string): Promise<VerificationResult>;

  // Flow C: OpenID4VP Annex B
  startAnnexB(profileId: string, returnUrl?: string): Promise<AnnexBStart>;
  pollAnnexB(profileId: string, sessionId: string): Promise<PollResult>;
  /** Exchanges the single-use response_code from the wallet redirect. Needs no access token. */
  resumeAnnexB(responseCode: string): Promise<PollResult>;

  /** Token cache state per profile id, for /health. Contains no secrets. */
  tokenStatus(): Record<string, TokenStatus>;
}
