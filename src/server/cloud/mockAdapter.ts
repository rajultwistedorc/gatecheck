import { randomUUID } from "node:crypto";
import type { MockOptions, MockScenario, MockShape } from "../../shared/types";
import type { AnnexBStart, CloudSdkAdapter, DcMdocStart, DcOpenId4VpStart } from "./adapter";
import { CloudSdkError } from "./errors";
import {
  parseAnnexBResponse,
  parseDcVerifyResponse,
  parseOpenId4VpValidateResponse,
  type PollResult,
  type VerificationResult,
} from "./parse";
import type { TokenStatus } from "./tokenManager";

// A stand-in for the Cloud SDK. It builds *raw response bodies* in the documented wire
// shapes and runs them through the same parsers as the live adapter, so everything
// downstream (rules, screens, log) sees exactly what it would see in live mode.
//
// The simulated wallet "response" is a plain string: mock:<scenario>:<persona>:<shape>.

interface Persona {
  id: string;
  given: string;
  family: string;
  /** Fixed birth date, or an age in years (the date is derived so the persona never ages). */
  birth: { date: string } | { ageYears: number };
  documentNumber: string | null;
  note: string;
  tint: string;
}

export const MOCK_PERSONAS: Persona[] = [
  {
    id: "alex",
    given: "Alex",
    family: "Rivera",
    birth: { date: "1988-03-22" },
    documentNumber: "D1000001",
    note: "Over 21. Has a ticket. On the VIP list.",
    tint: "#9db4d6",
  },
  {
    id: "maya",
    given: "Maya",
    family: "Chen",
    birth: { ageYears: 19 },
    documentNumber: "D1000002",
    note: "Age 19. Has a ticket. Not on the VIP list.",
    tint: "#d6b49d",
  },
  {
    id: "sam",
    given: "Sam",
    family: "Okafor",
    birth: { date: "1995-11-02" },
    documentNumber: "D1000003",
    note: "Over 21. No ticket. Not on the VIP list.",
    tint: "#a8d1b0",
  },
  {
    id: "jordan",
    given: "Jordan",
    family: "Park",
    birth: { date: "1992-08-30" },
    documentNumber: null,
    note: "Over 21. Ticket matched by name and birth date (shares no document number).",
    tint: "#c9a8d6",
  },
];

export const MOCK_OPTIONS: MockOptions = {
  personas: MOCK_PERSONAS.map((p) => ({ id: p.id, name: `${p.given} ${p.family}`, note: p.note })),
  scenarios: [
    { id: "success", label: "Share ID", note: "Valid credential, verified" },
    { id: "expired", label: "Expired ID", note: "Validity period has ended" },
    { id: "untrusted", label: "Untrusted issuer", note: "Issuer not in the trusted list" },
    { id: "failed", label: "Tampered ID", note: "Signature check fails" },
    { id: "cancelled", label: "Decline", note: "Visitor cancels in the wallet" },
  ],
  shapes: [
    { id: "full", label: "Full ID", note: "Name, photo and birth date" },
    { id: "age-only", label: "Age-only profile", note: "Only an age-over claim. No name or photo." },
  ],
};

const SCENARIOS: readonly MockScenario[] = ["success", "failed", "expired", "untrusted", "cancelled"];

// Field names follow the sample app's AuthenticationDetails type. The *values* of
// msoValidity and certValidationError are invented: the docs do not specify them.
const AUTH_OK = {
  authenticationResult: "SUCCESS",
  issuerRecognized: true,
  issuerSignedAuthenticated: true,
  deviceSignedAuthenticated: true,
  dataIntegrity: true,
  msoValidity: "VALID",
  issuerSubjectInfo: "CN=GateCheck Mock IACA, O=Mock DMV, C=US",
  certValidationError: "[]",
};

const FAILURES: Record<"expired" | "untrusted" | "failed", { auth: Record<string, unknown>; text: string }> = {
  expired: {
    auth: { ...AUTH_OK, authenticationResult: "FAILED", msoValidity: "EXPIRED" },
    text: "Document validity period has expired.",
  },
  untrusted: {
    auth: {
      ...AUTH_OK,
      authenticationResult: "FAILED",
      issuerRecognized: false,
      issuerSubjectInfo: "CN=Unknown Issuer CA",
      certValidationError: "[Issuer certificate is not in the trusted list]",
    },
    text: "Issuer certificate is not in the trusted list.",
  },
  failed: {
    auth: { ...AUTH_OK, authenticationResult: "FAILED", deviceSignedAuthenticated: false, dataIntegrity: false },
    text: "Device signature verification failed.",
  },
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function birthDate(p: Persona, now: Date): string {
  if ("date" in p.birth) return p.birth.date;
  // 100 days past the birthday, so the persona is unambiguously that age in any timezone.
  return isoDate(new Date(Date.UTC(now.getUTCFullYear() - p.birth.ageYears, now.getUTCMonth(), now.getUTCDate() - 100)));
}

function ageOn(birth: string, now: Date): number {
  const [y, m, d] = birth.split("-").map(Number) as [number, number, number];
  const beforeBirthday = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  return now.getUTCFullYear() - y - (beforeBirthday ? 1 : 0);
}

/** A placeholder portrait, stamped MOCK so it can never pass for a real one. */
function portrait(p: Persona): string {
  const initials = `${p.given[0]}${p.family[0]}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300" viewBox="0 0 240 300">` +
    `<rect width="240" height="300" fill="${p.tint}"/>` +
    `<circle cx="120" cy="112" r="50" fill="#ffffff" fill-opacity=".55"/>` +
    `<path d="M28 300c0-62 41-104 92-104s92 42 92 104z" fill="#ffffff" fill-opacity=".55"/>` +
    `<text x="120" y="128" font-family="sans-serif" font-size="40" font-weight="700" text-anchor="middle" fill="#1e293b">${initials}</text>` +
    `<rect y="262" width="240" height="38" fill="#111827"/>` +
    `<text x="120" y="287" font-family="sans-serif" font-size="17" font-weight="700" letter-spacing="3" text-anchor="middle" fill="#fde047">MOCK PHOTO</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function identity(p: Persona, shape: MockShape, now: Date): Record<string, unknown> {
  const birth = birthDate(p, now);
  // What an age-check profile is expected to release: an age-over claim and nothing else.
  if (shape === "age-only") return { age_over_21: ageOn(birth, now) >= 21 };
  const claims: Record<string, unknown> = {
    family_name: p.family,
    given_name: p.given,
    birth_date: birth,
    issue_date: isoDate(new Date(Date.UTC(now.getUTCFullYear() - 2, 0, 15))),
    expiry_date: isoDate(new Date(Date.UTC(now.getUTCFullYear() + 3, 0, 15))),
    issuing_country: "US",
    issuing_authority: "Mock DMV",
    portrait: portrait(p),
  };
  if (p.documentNumber) claims.document_number = p.documentNumber;
  return claims;
}

interface WalletChoice {
  scenario: MockScenario;
  persona: Persona;
  shape: MockShape;
}

export function parseMockWalletData(data: string): WalletChoice | null {
  const [prefix, scenario, personaId, shape] = data.split(":");
  if (prefix !== "mock" || !SCENARIOS.includes(scenario as MockScenario)) return null;
  const persona = MOCK_PERSONAS.find((p) => p.id === personaId) ?? MOCK_PERSONAS[0]!;
  return { scenario: scenario as MockScenario, persona, shape: shape === "age-only" ? "age-only" : "full" };
}

interface MockSession {
  flow: "dc-mdoc" | "dc-openid4vp" | "annex-b";
  walletData: string | null;
}

export class MockCloudSdkAdapter implements CloudSdkAdapter {
  readonly mode = "mock" as const;
  private readonly sessions = new Map<string, MockSession>();

  constructor(private readonly options: { latencyMs?: number; now?: () => number } = {}) {}

  async startDcMdoc(): Promise<DcMdocStart> {
    await this.delay();
    const sessionId = this.open("dc-mdoc");
    return { sessionId, dcRequest: { deviceRequest: "bW9jay1kZXZpY2UtcmVxdWVzdA", encryptionInfo: "bW9jay1lbmNyeXB0aW9uLWluZm8" } };
  }

  async verifyDcMdoc(_profileId: string, sessionId: string, data: string): Promise<VerificationResult> {
    await this.delay();
    const choice = this.consume(sessionId, "dc-mdoc", data);
    return parseDcVerifyResponse(this.dcBody(choice));
  }

  async startDcOpenId4Vp(): Promise<DcOpenId4VpStart> {
    await this.delay();
    const sessionId = this.open("dc-openid4vp");
    return {
      sessionId,
      payload: {
        response_type: "vp_token",
        response_mode: "dc_api.jwt",
        nonce: sessionId,
        dcql_query: {
          credentials: [{ id: "cred1", format: "mso_mdoc", meta: { doctype_value: "org.iso.18013.5.1.mDL" }, claims: [] }],
        },
      },
    };
  }

  async validateDcOpenId4Vp(_profileId: string, sessionId: string, data: string): Promise<VerificationResult> {
    await this.delay();
    const choice = this.consume(sessionId, "dc-openid4vp", data);
    // This endpoint reports a failed credential as HTTP 400, not 200 with res=false.
    if (choice.scenario === "expired" || choice.scenario === "untrusted" || choice.scenario === "failed") {
      const body = { error: `Validation failed: ${FAILURES[choice.scenario].text}` };
      return parseOpenId4VpValidateResponse(400, body)!;
    }
    return parseOpenId4VpValidateResponse(200, this.dcBody(choice))!;
  }

  async startAnnexB(): Promise<AnnexBStart> {
    await this.delay();
    const sessionId = this.open("annex-b");
    const requestUri = `https://mock.invalid/openid4vp/v1/mdoc/request/${sessionId}`;
    return {
      sessionId,
      requestUri,
      walletUri: `mdoc-openid4vp://?client_id=gatecheck-mock&request_uri=${encodeURIComponent(requestUri)}`,
    };
  }

  async pollAnnexB(_profileId: string, sessionId: string): Promise<PollResult> {
    await this.delay();
    const session = this.sessions.get(sessionId);
    if (!session || session.flow !== "annex-b") {
      throw new CloudSdkError("not_found", 404, "HTTP_404", "Session not found");
    }
    if (session.walletData === null) return parseAnnexBResponse(202, { status: "pending" });
    const choice = parseMockWalletData(session.walletData);
    if (!choice) throw new CloudSdkError("upstream", 500, "INTERNAL_ERROR", "Internal error: unreadable wallet response");
    this.sessions.delete(sessionId);
    return parseAnnexBResponse(200, this.annexBBody(choice));
  }

  async resumeAnnexB(responseCode: string): Promise<PollResult> {
    const sessionId = responseCode.replace(/^mock-rc-/, "");
    if (!this.sessions.has(sessionId)) {
      throw new CloudSdkError("not_found", 404, "HTTP_404", "No session found for response_code");
    }
    return this.pollAnnexB("", sessionId);
  }

  tokenStatus(): Record<string, TokenStatus> {
    return {};
  }

  /** Mock only: the simulated wallet answers an Annex B session, as the real wallet would post to the Cloud SDK. */
  simulateWalletResponse(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.flow !== "annex-b" || !parseMockWalletData(data)) return false;
    session.walletData = data;
    return true;
  }

  private open(flow: MockSession["flow"]): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { flow, walletData: null });
    return sessionId;
  }

  private consume(sessionId: string, flow: MockSession["flow"], data: string): WalletChoice {
    const session = this.sessions.get(sessionId);
    if (!session || session.flow !== flow) {
      throw new CloudSdkError("bad_request", 400, "HTTP_400", "Unknown or already used session");
    }
    this.sessions.delete(sessionId);
    const choice = parseMockWalletData(data);
    if (!choice) throw new CloudSdkError("upstream", 500, "INTERNAL_ERROR", "Wallet response could not be decoded");
    return choice;
  }

  /** Flows A/B body: { res, resDetails } with resDetails as a JSON string, or the cancelled shape. */
  private dcBody(choice: WalletChoice): unknown {
    if (choice.scenario === "cancelled") {
      return { cancelled: true, message: "Verification was cancelled by the user." };
    }
    if (choice.scenario === "success") {
      const details = { identity: identity(choice.persona, choice.shape, this.now()), authentication: AUTH_OK };
      return { res: true, resDetails: JSON.stringify(details) };
    }
    return { res: false, resDetails: JSON.stringify({ identity: {}, authentication: FAILURES[choice.scenario].auth }) };
  }

  /** Flow C body: { success, identity, error } with identity as a JSON string. */
  private annexBBody(choice: WalletChoice): unknown {
    if (choice.scenario === "cancelled") return { success: false, identity: null, error: "User denied consent." };
    if (choice.scenario === "success") {
      const details = { identity: identity(choice.persona, choice.shape, this.now()), authentication: AUTH_OK };
      return { success: true, identity: JSON.stringify(details), error: null };
    }
    return { success: false, identity: null, error: FAILURES[choice.scenario].text };
  }

  private now(): Date {
    return new Date(this.options.now ? this.options.now() : Date.now());
  }

  private delay(): Promise<void> {
    const ms = this.options.latencyMs ?? 250;
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }
}
