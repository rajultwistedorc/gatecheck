import { existsSync } from "node:fs";
import type { ProfileKey } from "../shared/types";

/** Wraps a secret so it cannot leak through logging, JSON or string interpolation. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  get isSet(): boolean {
    return this.#value.length > 0;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

export interface AppConfig {
  mockMode: boolean;
  isProduction: boolean;
  port: number;
  trustProxy: number;
  credence: {
    baseUrl: string;
    licenseKey: Secret;
    /** Normalised https origin, or null in mock mode when it is not set. */
    registeredOrigin: string | null;
    profiles: Record<ProfileKey, string | null>;
  };
  staffPasscode: Secret;
  sessionTtlSeconds: number;
  resultDisplaySeconds: number;
  venueTimeZone: string;
  dbPath: string;
  logRetentionDays: number;
  purgeIntervalMinutes: number;
  mdocRequestShape: "deviceRequest" | "dcRequest";
  openid4vpProtocol: string;
  gatesConfigPath: string;
  ticketsConfigPath: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      "GateCheck cannot start. Fix these in .env (see .env.example):\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "ConfigError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BASE_URL = "https://credenceid.com/cloudsdk/playground";

/** Loads .env into process.env if the file exists. Variables already set win. */
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function bool(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = str(env, name).toLowerCase();
  if (raw === "") return fallback;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  problems.push(`${name} must be true or false.`);
  return fallback;
}

function int(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = str(env, name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

/** Returns the normalised origin, or pushes a problem and returns null. */
function httpsOrigin(env: Env, name: string, problems: string[]): string | null {
  const raw = str(env, name);
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL. Expected something like https://gate.example.com`);
    return null;
  }
  if (url.protocol !== "https:") {
    problems.push(`${name} must start with https://`);
    return null;
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    problems.push(`${name} must be an origin only (scheme + host), with no path or query.`);
    return null;
  }
  return url.origin;
}

function profileId(env: Env, name: string, problems: string[]): string | null {
  const raw = str(env, name);
  if (raw === "") return null;
  if (!UUID_RE.test(raw)) {
    problems.push(`${name} must be a profile UUID (8-4-4-4-12 hex characters).`);
    return null;
  }
  return raw.toLowerCase();
}

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];
  const mockMode = bool(env, "MOCK_MODE", false, problems);

  let baseUrl = str(env, "CREDENCE_BASE_URL") || DEFAULT_BASE_URL;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !mockMode) problems.push("CREDENCE_BASE_URL must start with https://");
    baseUrl = baseUrl.replace(/\/+$/, "");
  } catch {
    problems.push("CREDENCE_BASE_URL is not a valid URL.");
  }

  // The docs describe keys as "CS-" + UUID segments, but issued keys can differ in
  // separator and length, so the format is not validated here. /v1/setup is the judge.
  const licenseKey = new Secret(str(env, "CREDENCE_LICENSE_KEY"));
  const registeredOrigin = httpsOrigin(env, "REGISTERED_ORIGIN", problems);
  const profiles: Record<ProfileKey, string | null> = {
    "age-check": profileId(env, "CREDENCE_PROFILE_AGE_CHECK", problems),
    "id-check": profileId(env, "CREDENCE_PROFILE_ID_CHECK", problems),
  };

  if (!mockMode) {
    if (!licenseKey.isSet) problems.push("CREDENCE_LICENSE_KEY is required when MOCK_MODE=false.");
    if (!profiles["age-check"] && str(env, "CREDENCE_PROFILE_AGE_CHECK") === "") {
      problems.push("CREDENCE_PROFILE_AGE_CHECK is required when MOCK_MODE=false.");
    }
    if (!registeredOrigin && str(env, "REGISTERED_ORIGIN") === "") {
      problems.push(
        "REGISTERED_ORIGIN is required when MOCK_MODE=false. Use the exact https origin registered with Credence.",
      );
    }
  }

  const mdocShape = str(env, "DC_MDOC_REQUEST_SHAPE") || "deviceRequest";
  if (mdocShape !== "deviceRequest" && mdocShape !== "dcRequest") {
    problems.push('DC_MDOC_REQUEST_SHAPE must be "deviceRequest" or "dcRequest".');
  }
  const openid4vpProtocol = str(env, "DC_OPENID4VP_PROTOCOL") || "openid4vp";
  if (!/^[a-z0-9-]{3,40}$/.test(openid4vpProtocol)) {
    problems.push("DC_OPENID4VP_PROTOCOL must be a protocol identifier such as openid4vp.");
  }

  const venueTimeZone = str(env, "VENUE_TIMEZONE") || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: venueTimeZone });
  } catch {
    problems.push("VENUE_TIMEZONE must be an IANA timezone such as America/New_York.");
  }

  const config: AppConfig = {
    mockMode,
    isProduction: str(env, "NODE_ENV") === "production",
    port: int(env, "PORT", 8787, 1, 65535, problems),
    trustProxy: int(env, "TRUST_PROXY", 0, 0, 10, problems),
    credence: { baseUrl, licenseKey, registeredOrigin, profiles },
    staffPasscode: new Secret(str(env, "STAFF_PASSCODE")),
    sessionTtlSeconds: int(env, "SESSION_TTL_SECONDS", 120, 15, 900, problems),
    resultDisplaySeconds: int(env, "RESULT_DISPLAY_SECONDS", 12, 3, 120, problems),
    venueTimeZone,
    dbPath: str(env, "DB_PATH") || "./data/gatecheck.sqlite",
    logRetentionDays: int(env, "LOG_RETENTION_DAYS", 30, 1, 3650, problems),
    purgeIntervalMinutes: int(env, "PURGE_INTERVAL_MINUTES", 60, 1, 1440, problems),
    mdocRequestShape: mdocShape === "dcRequest" ? "dcRequest" : "deviceRequest",
    openid4vpProtocol,
    gatesConfigPath: str(env, "GATES_CONFIG_PATH") || "./config/gates.json",
    ticketsConfigPath: str(env, "TICKETS_CONFIG_PATH") || "./config/tickets.json",
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

const OUTER_QUOTE_RE = /^["'`]|["'`]$/;

export type LiveCredentialFacts = {
  /** Length of the license key as it is sent, after surrounding whitespace is trimmed. */
  keyLength: number;
  /** The key as sent starts or ends with a quote character, typically quotes pasted into a host's dashboard. */
  keyOuterQuote: boolean;
  /** The configured value had whitespace or a line break at either end. It is trimmed before use. */
  keyOuterWhitespace: boolean;
  profileAgeCheckUuid: boolean;
  profileIdCheck: "valid" | "invalid" | "not set";
  /** Exactly what is sent in the Origin header. Not a secret. */
  origin: string;
  /** The configured value had to be changed to get there (letter case, trailing slash, whitespace). */
  originNormalised: boolean;
};

/**
 * Facts about the live credentials for the startup log: enough to spot a quoted,
 * truncated or padded value pasted into a host's settings, without revealing anything.
 * Only lengths and yes/no answers are returned for the key, never any part of it.
 */
export function describeLiveCredentials(config: AppConfig, env: Env = process.env): LiveCredentialFacts {
  const rawKey = env.CREDENCE_LICENSE_KEY ?? "";
  const key = config.credence.licenseKey.reveal();
  const idCheck = str(env, "CREDENCE_PROFILE_ID_CHECK");
  const origin = config.credence.registeredOrigin ?? "";
  return {
    keyLength: key.length,
    keyOuterQuote: OUTER_QUOTE_RE.test(key),
    keyOuterWhitespace: rawKey !== rawKey.trim(),
    profileAgeCheckUuid: UUID_RE.test(str(env, "CREDENCE_PROFILE_AGE_CHECK")),
    profileIdCheck: idCheck === "" ? "not set" : UUID_RE.test(idCheck) ? "valid" : "invalid",
    origin,
    originNormalised: (env.REGISTERED_ORIGIN ?? "") !== origin,
  };
}
