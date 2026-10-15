import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, Secret, describeLiveCredentials, loadConfig } from "../src/server/config";
import { createLogger, scrub } from "../src/server/logger";
import { loadGatesFile, loadTicketsFile, parseGatesFile, resolveGates, summariseGate } from "../src/server/rules/gates";

const KEY = "CS_0123456789abcdef0123456789abcdef";
const AGE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const live = {
  MOCK_MODE: "false",
  CREDENCE_LICENSE_KEY: KEY,
  CREDENCE_PROFILE_AGE_CHECK: AGE,
  REGISTERED_ORIGIN: "https://gate.example.com",
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe("loadConfig", () => {
  it("defaults to live mode, so a missing MOCK_MODE can never silently fake results", () => {
    expect(problems({})).not.toEqual([]);
    expect(loadConfig(live).mockMode).toBe(false);
  });

  it("fails fast in live mode, naming every missing value", () => {
    const found = problems({ MOCK_MODE: "false" });
    expect(found).toHaveLength(3);
    expect(found.join("\n")).toMatch(/CREDENCE_LICENSE_KEY is required/);
    expect(found.join("\n")).toMatch(/CREDENCE_PROFILE_AGE_CHECK is required/);
    expect(found.join("\n")).toMatch(/REGISTERED_ORIGIN is required/);
  });

  it("explains the problem without echoing the license key", () => {
    const err = (() => {
      try {
        loadConfig({ ...live, REGISTERED_ORIGIN: "" });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected a ConfigError");
    })();
    expect(err.message).toContain("REGISTERED_ORIGIN is required");
    expect(err.message).toContain(".env");
    expect(err.message).not.toContain(KEY);
  });

  it("loads a complete live config, with the ID-check profile optional", () => {
    const config = loadConfig(live);
    expect(config.credence.profiles).toEqual({ "age-check": AGE, "id-check": null });
    expect(config.credence.baseUrl).toBe("https://credenceid.com/cloudsdk/playground");
    expect(config.credence.licenseKey.reveal()).toBe(KEY);
    expect(loadConfig({ ...live, CREDENCE_PROFILE_ID_CHECK: ID.toUpperCase() }).credence.profiles["id-check"]).toBe(ID);
  });

  it("accepts a license key in either the documented CS- form or the CS_ form", () => {
    expect(problems({ ...live, CREDENCE_LICENSE_KEY: "CS-12345678-1234-1234-1234-123456789abc" })).toEqual([]);
    expect(problems({ ...live, CREDENCE_LICENSE_KEY: KEY })).toEqual([]);
  });

  it("needs no credentials in mock mode", () => {
    const config = loadConfig({ MOCK_MODE: "true" });
    expect(config.mockMode).toBe(true);
    expect(config.credence.registeredOrigin).toBeNull();
  });

  it("normalises the registered origin and rejects anything that is not a bare https origin", () => {
    expect(loadConfig({ ...live, REGISTERED_ORIGIN: "https://Gate.Example.com/" }).credence.registeredOrigin).toBe("https://gate.example.com");
    expect(problems({ ...live, REGISTERED_ORIGIN: "http://gate.example.com" })[0]).toMatch(/must start with https/);
    expect(problems({ ...live, REGISTERED_ORIGIN: "https://gate.example.com/verify" })[0]).toMatch(/origin only/);
    expect(problems({ ...live, REGISTERED_ORIGIN: "gate.example.com" })[0]).toMatch(/not a valid URL/);
  });

  it("validates the other settings", () => {
    expect(problems({ ...live, CREDENCE_PROFILE_AGE_CHECK: "not-a-uuid" })[0]).toMatch(/must be a profile UUID/);
    expect(problems({ ...live, PORT: "70000" })[0]).toMatch(/PORT/);
    expect(problems({ ...live, MOCK_MODE: "maybe" })[0]).toMatch(/MOCK_MODE must be true or false/);
    expect(problems({ ...live, VENUE_TIMEZONE: "Mars/Olympus" })[0]).toMatch(/VENUE_TIMEZONE/);
    expect(problems({ ...live, DC_MDOC_REQUEST_SHAPE: "everything" })[0]).toMatch(/DC_MDOC_REQUEST_SHAPE/);
    expect(problems({ ...live, CREDENCE_BASE_URL: "http://insecure.example.com" })[0]).toMatch(/CREDENCE_BASE_URL/);
  });

  it("strips a trailing slash from the base URL", () => {
    expect(loadConfig({ ...live, CREDENCE_BASE_URL: "https://credenceid.com/cloudsdk/playground/" }).credence.baseUrl).toBe(
      "https://credenceid.com/cloudsdk/playground",
    );
  });
});

describe("describeLiveCredentials (startup log)", () => {
  const facts = (env: Record<string, string>) => describeLiveCredentials(loadConfig(env), env);

  it("reports the shape of a clean configuration", () => {
    expect(facts(live)).toEqual({
      keyLength: KEY.length,
      keyOuterQuote: false,
      keyOuterWhitespace: false,
      profileAgeCheckUuid: true,
      profileIdCheck: "not set",
      origin: "https://gate.example.com",
      originNormalised: false,
    });
    expect(facts({ ...live, CREDENCE_PROFILE_ID_CHECK: ID })).toMatchObject({ profileIdCheck: "valid" });
  });

  it("flags a key pasted with quotes around it, and counts the quotes in the length", () => {
    for (const quoted of [`"${KEY}"`, `'${KEY}'`, `"${KEY}`, `${KEY}'`]) {
      const found = facts({ ...live, CREDENCE_LICENSE_KEY: quoted });
      expect(found).toMatchObject({ keyOuterQuote: true, keyOuterWhitespace: false, keyLength: quoted.length });
    }
  });

  it("flags whitespace or a line break around the key, which is trimmed before use", () => {
    for (const padded of [` ${KEY}`, `${KEY} `, `${KEY}\n`, `\t${KEY}\r\n`]) {
      expect(facts({ ...live, CREDENCE_LICENSE_KEY: padded })).toMatchObject({ keyOuterWhitespace: true, keyOuterQuote: false, keyLength: KEY.length });
    }
    // Both problems at once: the quotes survive the trim, so the key that is sent is wrong.
    expect(facts({ ...live, CREDENCE_LICENSE_KEY: ` "${KEY}" ` })).toMatchObject({ keyOuterWhitespace: true, keyOuterQuote: true, keyLength: KEY.length + 2 });
  });

  it("reports the exact origin that is sent, and whether the configured value was altered to get it", () => {
    expect(facts({ ...live, REGISTERED_ORIGIN: "https://Gate.Example.com/" })).toMatchObject({ origin: "https://gate.example.com", originNormalised: true });
    expect(facts({ ...live, REGISTERED_ORIGIN: " https://gate.example.com " })).toMatchObject({ origin: "https://gate.example.com", originNormalised: true });
    expect(facts({ ...live, REGISTERED_ORIGIN: "https://gatecheck-rajul.onrender.com" })).toMatchObject({
      origin: "https://gatecheck-rajul.onrender.com",
      originNormalised: false,
    });
  });

  it("never contains the key, or any part of it, even when written through the logger", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    for (const key of [KEY, `"${KEY}"`, ` ${KEY}\n`]) {
      const env = { ...live, CREDENCE_LICENSE_KEY: key };
      const found = facts(env);
      logger.info("live credentials check", found);
      // Only numbers, booleans and the two known strings come back.
      expect(Object.values(found).filter((v) => typeof v === "string")).toEqual(["not set", "https://gate.example.com"]);
    }
    const everything = lines.join("\n");
    expect(lines).toHaveLength(3);
    expect(everything).toContain(`keyLength=${KEY.length}`);
    expect(everything).toContain("origin=https://gate.example.com");
    expect(everything).not.toContain(KEY);
    // No run of the key longer than a few characters appears anywhere in the output.
    for (let i = 0; i + 6 <= KEY.length; i++) expect(everything).not.toContain(KEY.slice(i, i + 6));
  });
});

describe("Secret", () => {
  it("cannot leak through logging, JSON, inspection or string building", () => {
    const config = loadConfig({ ...live, STAFF_PASSCODE: "open-sesame" });
    const everything = [JSON.stringify(config), inspect(config, { depth: 10 }), `${config.credence.licenseKey}`, String(config.staffPasscode)].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("open-sesame");
    expect(everything).toContain("[redacted]");
    expect(new Secret("").isSet).toBe(false);
  });
});

describe("logger", () => {
  it("scrubs tokens, keys and response codes even if one reaches a log line", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.info("oops", {
      a: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
      b: "rt_550e8400-e29b-41d4-a716-446655440000",
      c: KEY,
      d: "CS-12345678-1234-1234-1234-123456789abc",
      e: "/resume?response_code=abc123",
      keys: ["age_over_21", "portrait"],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/eyJ|rt_550e|0123456789abcdef|12345678-1234|abc123/);
    expect(lines[0]).toContain("keys=[age_over_21,portrait]");
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("gate=beer-garden outcome=allowed reason=ENTRY_ALLOWED latencyMs=4200")).toBe(
      "gate=beer-garden outcome=allowed reason=ENTRY_ALLOWED latencyMs=4200",
    );
  });
});

describe("gate config and profiles", () => {
  const gates = loadGatesFile("./config/gates.json");

  it("ships valid gate and ticket files", () => {
    expect(gates.map((g) => g.id)).toEqual(["general-entry", "beer-garden", "concession", "vip"]);
    expect(loadTicketsFile("./config/tickets.json").length).toBeGreaterThan(0);
  });

  it("maps the age-restricted gates to the age-check profile with an age 21 rule", () => {
    const resolved = resolveGates(gates, { "age-check": AGE, "id-check": null }, false);
    for (const id of ["beer-garden", "concession"]) {
      const gate = resolved.find((g) => g.id === id);
      expect(gate).toMatchObject({ profile: "age-check", profileId: AGE, available: true, notice: null, rules: [{ type: "age", minAge: 21 }] });
    }
  });

  it("falls general entry back to the age-check profile, labelled 'Age check only', when there is no ID-check profile", () => {
    const resolved = resolveGates(gates, { "age-check": AGE, "id-check": null }, false);
    const general = resolved.find((g) => g.id === "general-entry");
    expect(general).toMatchObject({ profile: "age-check", profileId: AGE, available: true, notice: "Age check only", rules: [{ type: "age", minAge: 21 }] });
    expect(summariseGate(general!)).toMatchObject({ notice: "Age check only", rules: [{ type: "age", label: "Age 21+" }] });
    // The card must not promise a ticket check the gate is not doing.
    expect(general?.description).toMatch(/checks age only/);
    expect(general?.description).not.toMatch(/matched to a ticket/);
  });

  it("uses the ID-check profile and the ticket rule for general entry once it is configured", () => {
    const general = resolveGates(gates, { "age-check": AGE, "id-check": ID }, false).find((g) => g.id === "general-entry");
    expect(general).toMatchObject({ profile: "id-check", profileId: ID, notice: null, rules: [{ type: "ticket" }] });
  });

  it("disables a gate that needs a missing profile and has no fallback, rather than weakening it", () => {
    const vip = resolveGates(gates, { "age-check": AGE, "id-check": null }, false).find((g) => g.id === "vip");
    expect(vip).toMatchObject({ available: false, profileId: null });
    expect(vip?.unavailableReason).toContain("CREDENCE_PROFILE_ID_CHECK");
  });

  it("makes every gate available with its primary rules in mock mode", () => {
    const resolved = resolveGates(gates, { "age-check": null, "id-check": null }, true);
    expect(resolved.every((g) => g.available && g.notice === null && g.profileId?.startsWith("mock-"))).toBe(true);
    expect(resolved.find((g) => g.id === "general-entry")?.rules).toEqual([{ type: "ticket" }]);
  });

  it("does not send allow-list entries or profile ids to the browser", () => {
    const vip = resolveGates(gates, { "age-check": AGE, "id-check": ID }, false).find((g) => g.id === "vip");
    const summary = JSON.stringify(summariseGate(vip!));
    expect(summary).not.toMatch(/D1000001|Park|1992|aaaaaaaa/);
  });

  it("rejects invalid gate files with a readable message", () => {
    expect(() => parseGatesFile({ gates: [] })).toThrowError(/Invalid gates config/);
    expect(() => parseGatesFile({ gates: [{ id: "Bad Id", name: "x", profile: "age-check", rules: [{ type: "age", minAge: 21 }] }] })).toThrowError(/gates\.0\.id/);
    expect(() => parseGatesFile({ gates: [{ id: "a", name: "x", profile: "age-check", rules: [{ type: "allowlist", entries: [{ familyName: "Only" }] }] }] })).toThrowError(
      /needs documentNumber/,
    );
    const gate = { id: "a", name: "x", profile: "age-check", rules: [{ type: "age", minAge: 21 }] };
    expect(() => parseGatesFile({ gates: [gate, gate] })).toThrowError(/duplicate gate id "a"/);
  });
});
