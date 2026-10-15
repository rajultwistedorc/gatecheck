// API contract shared by the server and the web app. Types only, no runtime code.

/** A: DC API + ISO mdoc (Apple Wallet). B: DC API + OpenID4VP (Google Wallet). C: OpenID4VP Annex B (Samsung Wallet). */
export type FlowId = "dc-mdoc" | "dc-openid4vp" | "annex-b";

/** Which Credence reader profile a gate verifies against. */
export type ProfileKey = "age-check" | "id-check";

export type Outcome = "allowed" | "denied" | "declined" | "error";

/**
 * waiting     QR shown, nobody has scanned it
 * scanned     visitor opened /verify
 * in_progress a Cloud SDK request exists, waiting for the wallet
 * complete    a decision was made (see decision.outcome)
 * timeout     visitor scanned but never finished
 * expired     QR ran out unscanned; the screen rotates to a new one
 */
export type SessionStatus = "waiting" | "scanned" | "in_progress" | "complete" | "timeout" | "expired";

export type ReasonCode =
  // allowed
  | "ENTRY_ALLOWED"
  // denied: credential did not verify
  | "CREDENTIAL_EXPIRED"
  | "ISSUER_UNTRUSTED"
  | "CREDENTIAL_INVALID"
  // denied: credential verified, a gate rule said no
  | "TICKET_NOT_FOUND"
  | "UNDER_AGE"
  | "AGE_UNAVAILABLE"
  | "NOT_ON_ALLOWLIST"
  | "ATTRIBUTES_MISSING"
  // declined
  | "VISITOR_DECLINED"
  // error
  | "TIMEOUT"
  | "STAFF_RESET"
  | "WALLET_UNAVAILABLE"
  | "SDK_AUTH_ERROR"
  | "SDK_DOMAIN_MISMATCH"
  | "SDK_PROFILE_ERROR"
  | "SDK_QUOTA_EXCEEDED"
  | "SDK_RATE_LIMITED"
  | "SDK_UNAVAILABLE"
  | "SDK_BAD_RESPONSE"
  | "INTERNAL_ERROR";

export type RuleSummary =
  | { type: "ticket"; label: string }
  | { type: "age"; minAge: number; label: string }
  | { type: "allowlist"; label: string };

export interface GateSummary {
  id: string;
  name: string;
  description: string;
  profile: ProfileKey;
  rules: RuleSummary[];
  /** Set when the gate is running on its fallback profile, e.g. "Age check only". */
  notice: string | null;
  /** False when the profile the gate needs is not configured and it has no fallback. */
  available: boolean;
  unavailableReason: string | null;
}

export interface DecisionCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

/** What the staff screen renders. Shown live, held in memory briefly, never written to the log. */
export interface Decision {
  outcome: Outcome;
  reasonCode: ReasonCode;
  /** Big line on the result screen, e.g. "ENTRY ALLOWED" or "AGE 21+ VERIFIED". */
  headline: string;
  /** Short staff-facing explanation, e.g. "Under 21". */
  reason: string;
  checks: DecisionCheck[];
  /** Present only when the credential actually returned a name and/or portrait. */
  holder: { name?: string; portrait?: string } | null;
  /** True when the credential verified but shared neither a name nor a portrait. */
  noPersonalData: boolean;
  fields: { label: string; value: string }[];
  flow: FlowId | null;
  mock: boolean;
  decidedAt: number;
}

export interface GateSessionView {
  id: string;
  /** Path + query for the visitor page. The client prefixes the public origin. */
  verifyPath: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  flow: FlowId | null;
  decision: Decision | null;
}

export interface GateState {
  gate: GateSummary;
  session: GateSessionView | null;
  serverTime: number;
}

export interface PublicConfig {
  mockMode: boolean;
  /** Registered origin in live mode; null in mock mode (the client uses its own origin). */
  publicOrigin: string | null;
  /** Mock mode only: this machine's address on the local network, so a QR shown on localhost works from a phone. */
  lanAddress: string | null;
  sessionTtlSeconds: number;
  resultDisplaySeconds: number;
  staffAuthRequired: boolean;
  logRetentionDays: number;
  profiles: { key: ProfileKey; configured: boolean }[];
}

// ---- Visitor (/verify) ------------------------------------------------------

export interface VisitorSessionInfo {
  gate: { id: string; name: string; profile: ProfileKey };
  status: SessionStatus;
  expiresAt: number;
  serverTime: number;
  result: VisitorResult | null;
}

/** What the visitor's phone is told. Never includes identity attributes. */
export interface VisitorResult {
  outcome: Outcome;
  message: string;
}

export type StartResponse =
  | { flow: "dc-mdoc" | "dc-openid4vp"; request: { protocol: string; data: unknown } }
  | { flow: "annex-b"; walletUri: string };

export interface VisitorStatus {
  status: SessionStatus;
  result: VisitorResult | null;
}

/** Why the browser gave up before any wallet response existed. */
export type AbortReason = "cancelled" | "unavailable";

// ---- Mock wallet ------------------------------------------------------------

export type MockScenario = "success" | "failed" | "expired" | "untrusted" | "cancelled";

/** What the simulated profile releases: a full ID, or only an age-over claim. */
export type MockShape = "full" | "age-only";

export interface MockOptions {
  personas: { id: string; name: string; note: string }[];
  scenarios: { id: MockScenario; label: string; note: string }[];
  shapes: { id: MockShape; label: string; note: string }[];
}

// ---- Admin ------------------------------------------------------------------

/** One attempt. Deliberately no name, birth date, portrait or document number. */
export interface LogRow {
  id: number;
  ts: number;
  gateId: string;
  outcome: Outcome;
  reasonCode: ReasonCode;
  flow: FlowId | null;
  mode: "live" | "mock";
  /** Milliseconds from the visitor opening /verify to the decision. */
  latencyMs: number | null;
}

export interface LogQueryResult {
  rows: LogRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface MinuteBucket {
  /** Epoch ms at the start of the minute. */
  minute: number;
  allowed: number;
  denied: number;
  declined: number;
  error: number;
}

export interface StatsResult {
  windowMinutes: number;
  from: number;
  to: number;
  totals: Record<Outcome, number>;
  perMinute: MinuteBucket[];
  reasons: { reasonCode: ReasonCode; outcome: Outcome; count: number }[];
  avgPerMinute: number;
  peakPerMinute: number;
  medianLatencyMs: number | null;
}

/** Key names seen in a verification response. Never values. */
export interface ShapeObservation {
  ts: number;
  gateId: string;
  profile: ProfileKey;
  flow: FlowId;
  mode: "live" | "mock";
  verified: boolean;
  layout: "nested" | "flat" | "none";
  identityKeys: string[];
  authenticationKeys: string[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
