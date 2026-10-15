import { describe, expect, it } from "vitest";
import type { VerificationResult } from "../src/server/cloud/parse";
import { ageInYears, decide, errorDecision, evaluateAge, findPerson, parseBirthDate, portraitDataUri, todayIn, type RuleContext } from "../src/server/rules/engine";
import type { Rule, Ticket } from "../src/server/rules/gates";

const NOW = new Date("2026-10-13T18:00:00Z");

const tickets: Ticket[] = [
  { ticketId: "TKT-0001", tier: "General Admission", documentNumber: "D1000001" },
  { ticketId: "TKT-0003", tier: "Balcony", familyName: "Park", givenName: "Jordan", birthDate: "1992-08-30" },
];

const ctx: RuleContext = { tickets, now: NOW, timeZone: "UTC", mock: false };

const PORTRAIT = `data:image/png;base64,${"A".repeat(200)}`;

function verified(identity: Record<string, unknown>, authentication: Record<string, unknown> = {}): VerificationResult {
  return { status: "verified", identity, authentication, layout: "nested" };
}

const AGE_21: Rule[] = [{ type: "age", minAge: 21 }];
const TICKET: Rule[] = [{ type: "ticket" }];
const VIP: Rule[] = [
  {
    type: "allowlist",
    entries: [
      { documentNumber: "D1000001", label: "VIP guest" },
      { familyName: "Park", givenName: "Jordan", birthDate: "1992-08-30", label: "Crew" },
    ],
  },
];

describe("age arithmetic", () => {
  it("counts completed years, flipping on the birthday itself", () => {
    const today = { y: 2026, m: 10, d: 13 };
    expect(ageInYears({ y: 2005, m: 10, d: 13 }, today)).toBe(21);
    expect(ageInYears({ y: 2005, m: 10, d: 14 }, today)).toBe(20);
    expect(ageInYears({ y: 2005, m: 11, d: 1 }, today)).toBe(20);
    expect(ageInYears({ y: 2005, m: 1, d: 31 }, today)).toBe(21);
  });

  it("gives a 29 February birthday its day on 1 March in a common year", () => {
    const leapling = { y: 2004, m: 2, d: 29 };
    expect(ageInYears(leapling, { y: 2025, m: 2, d: 28 })).toBe(20);
    expect(ageInYears(leapling, { y: 2025, m: 3, d: 1 })).toBe(21);
    expect(ageInYears(leapling, { y: 2028, m: 2, d: 29 })).toBe(24);
  });

  it("uses the venue's calendar date, not UTC", () => {
    // 03:30 UTC on the 14th is still the evening of the 13th in New York.
    const late = new Date("2026-10-14T03:30:00Z");
    expect(todayIn("UTC", late)).toEqual({ y: 2026, m: 10, d: 14 });
    expect(todayIn("America/New_York", late)).toEqual({ y: 2026, m: 10, d: 13 });
    const identity = { birth_date: "2005-10-14" };
    expect(evaluateAge(identity, 21, { now: late, timeZone: "UTC" })).toMatchObject({ over: true });
    expect(evaluateAge(identity, 21, { now: late, timeZone: "America/New_York" })).toMatchObject({ over: false });
  });

  it("parses date-only and timestamp birth dates, and rejects junk", () => {
    expect(parseBirthDate("1990-01-15")).toEqual({ y: 1990, m: 1, d: 15 });
    expect(parseBirthDate("1990-01-15T00:00:00Z")).toEqual({ y: 1990, m: 1, d: 15 });
    for (const junk of ["15/01/1990", "1990-13-01", "1990-00-10", "", null, undefined, 19900115]) {
      expect(parseBirthDate(junk)).toBeNull();
    }
  });
});

describe("evaluateAge", () => {
  it("uses an age_over_21 boolean when the profile returned one", () => {
    expect(evaluateAge({ age_over_21: true }, 21, ctx)).toEqual({ known: true, over: true, source: "age-over claim" });
    expect(evaluateAge({ age_over_21: false }, 21, ctx)).toEqual({ known: true, over: false, source: "age-over claim" });
  });

  it("prefers the age-over claim to the birth date when both are present", () => {
    // The claim is what the issuer attested for exactly this question.
    expect(evaluateAge({ age_over_21: false, birth_date: "1980-01-01" }, 21, ctx)).toMatchObject({ over: false, source: "age-over claim" });
  });

  it("infers from a different threshold only when that is logically sound", () => {
    expect(evaluateAge({ age_over_25: true }, 21, ctx)).toMatchObject({ known: true, over: true });
    expect(evaluateAge({ age_over_18: false }, 21, ctx)).toMatchObject({ known: true, over: false });
    // Over 18 says nothing about over 21; not over 25 says nothing either.
    expect(evaluateAge({ age_over_18: true }, 21, ctx)).toEqual({ known: false });
    expect(evaluateAge({ age_over_25: false }, 21, ctx)).toEqual({ known: false });
  });

  it("reads several age-over claims together the way an issuer would set them", () => {
    // A 19-year-old: over 18, not over 21.
    expect(evaluateAge({ age_over_18: true, age_over_21: false }, 21, ctx)).toMatchObject({ known: true, over: false });
    expect(evaluateAge({ age_over_21: false, age_over_18: true }, 21, ctx)).toMatchObject({ known: true, over: false });
    // A 23-year-old: over 21, not over 25.
    expect(evaluateAge({ age_over_25: false, age_over_21: true }, 21, ctx)).toMatchObject({ known: true, over: true });
    // Only claims that do not settle a 21 limit: fall through to the birth date.
    expect(evaluateAge({ age_over_18: true, age_over_25: false, birth_date: "2004-01-01" }, 21, ctx)).toEqual({ known: true, over: true, source: "birth date" });
  });

  it("accepts the claim as a 'true'/'false' string but ignores other values", () => {
    expect(evaluateAge({ age_over_21: "true" }, 21, ctx)).toMatchObject({ over: true });
    expect(evaluateAge({ age_over_21: "yes" }, 21, ctx)).toEqual({ known: false });
    expect(evaluateAge({ age_over_21: 1 }, 21, ctx)).toEqual({ known: false });
  });

  it("falls back to birth_date, then age_in_years", () => {
    expect(evaluateAge({ birth_date: "2005-10-13" }, 21, ctx)).toEqual({ known: true, over: true, source: "birth date" });
    expect(evaluateAge({ birth_date: "2005-10-14" }, 21, ctx)).toEqual({ known: true, over: false, source: "birth date" });
    expect(evaluateAge({ age_in_years: 34 }, 21, ctx)).toEqual({ known: true, over: true, source: "age in years" });
  });

  it("is unknown when the credential shared nothing about age", () => {
    expect(evaluateAge({}, 21, ctx)).toEqual({ known: false });
    expect(evaluateAge({ family_name: "Smith" }, 21, ctx)).toEqual({ known: false });
    expect(evaluateAge({ birth_date: "2999-01-01" }, 21, ctx)).toEqual({ known: false });
  });
});

describe("decide: age gate", () => {
  it("shows AGE 21+ VERIFIED with no personal data for an age-only credential", () => {
    const d = decide(AGE_21, verified({ age_over_21: true }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "allowed", reasonCode: "ENTRY_ALLOWED", headline: "AGE 21+ VERIFIED", holder: null, noPersonalData: true });
    expect(d.checks).toEqual([
      { label: "Credential verified", passed: true },
      { label: "Age 21+", passed: true, detail: "From age-over claim" },
    ]);
  });

  it("shows the holder when the credential did share a name and portrait", () => {
    const d = decide(AGE_21, verified({ given_name: "Alex", family_name: "Rivera", birth_date: "1988-03-22", portrait: PORTRAIT }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "allowed", headline: "ENTRY ALLOWED", noPersonalData: false, holder: { name: "Alex Rivera", portrait: PORTRAIT } });
  });

  it("denies under-age holders with UNDER_AGE", () => {
    expect(decide(AGE_21, verified({ age_over_21: false }), "dc-mdoc", ctx)).toMatchObject({ outcome: "denied", reasonCode: "UNDER_AGE", headline: "ENTRY DENIED" });
    expect(decide(AGE_21, verified({ birth_date: "2007-06-10" }), "dc-mdoc", ctx)).toMatchObject({ outcome: "denied", reasonCode: "UNDER_AGE" });
  });

  it("denies with AGE_UNAVAILABLE when neither an age-over claim nor a birth date came back", () => {
    const d = decide(AGE_21, verified({ given_name: "Alex", family_name: "Rivera" }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode: "AGE_UNAVAILABLE" });
    expect(d.checks.at(-1)).toEqual({ label: "Age 21+", passed: false, detail: "No age-over claim or birth date was shared" });
  });

  it("never puts the birth date on screen", () => {
    const d = decide(AGE_21, verified({ given_name: "Alex", family_name: "Rivera", birth_date: "1988-03-22" }), "dc-mdoc", ctx);
    expect(JSON.stringify(d)).not.toContain("1988");
  });
});

describe("decide: ticket gate", () => {
  it("allows a holder whose document number matches a ticket", () => {
    const d = decide(TICKET, verified({ given_name: "Alex", family_name: "Rivera", document_number: "d100 0001" }), "dc-openid4vp", ctx);
    expect(d).toMatchObject({ outcome: "allowed", headline: "ENTRY ALLOWED", fields: [{ label: "Ticket", value: "General Admission (TKT-0001)" }] });
  });

  it("falls back to name + birth date when no document number was shared", () => {
    const d = decide(TICKET, verified({ given_name: "  jordan ", family_name: "PARK", birth_date: "1992-08-30" }), "annex-b", ctx);
    expect(d).toMatchObject({ outcome: "allowed", fields: [{ label: "Ticket", value: "Balcony (TKT-0003)" }] });
  });

  it("denies a valid credential that has no ticket: validity alone is not entry", () => {
    const d = decide(TICKET, verified({ given_name: "Sam", family_name: "Okafor", birth_date: "1995-11-02", document_number: "D1000003" }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode: "TICKET_NOT_FOUND", holder: { name: "Sam Okafor" } });
    expect(d.checks[0]).toEqual({ label: "Credential verified", passed: true });
  });

  it("denies with ATTRIBUTES_MISSING when an age-only credential reaches a ticket gate", () => {
    const d = decide(TICKET, verified({ age_over_21: true }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode: "ATTRIBUTES_MISSING", noPersonalData: true });
  });

  it("does not match on a name alone", () => {
    const d = decide(TICKET, verified({ given_name: "Jordan", family_name: "Park", birth_date: "1992-08-31" }), "dc-mdoc", ctx);
    expect(d.reasonCode).toBe("TICKET_NOT_FOUND");
  });
});

describe("decide: allow-list gate", () => {
  it("allows listed holders and shows how they are listed", () => {
    const d = decide(VIP, verified({ given_name: "Alex", family_name: "Rivera", document_number: "D1000001" }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "allowed", fields: [{ label: "Listed as", value: "VIP guest" }] });
  });

  it("denies everyone else with NOT_ON_ALLOWLIST", () => {
    const d = decide(VIP, verified({ given_name: "Maya", family_name: "Chen", birth_date: "2007-06-10", document_number: "D1000002" }), "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode: "NOT_ON_ALLOWLIST" });
  });
});

describe("decide: combined rules", () => {
  const rules: Rule[] = [...VIP, ...AGE_21];

  it("requires every rule to pass and reports the first one that fails", () => {
    const listedMinor = verified({ given_name: "Alex", family_name: "Rivera", document_number: "D1000001", birth_date: "2010-01-01" });
    const d = decide(rules, listedMinor, "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode: "UNDER_AGE" });
    expect(d.checks.map((c) => [c.label, c.passed])).toEqual([
      ["Credential verified", true],
      ["Allow-list", true],
      ["Age 21+", false],
    ]);
  });
});

describe("decide: credential did not verify", () => {
  it.each([
    ["expired", "CREDENTIAL_EXPIRED"],
    ["untrusted", "ISSUER_UNTRUSTED"],
    ["invalid", "CREDENTIAL_INVALID"],
  ] as const)("maps a %s credential to %s without running the gate rules", (failure, reasonCode) => {
    const result: VerificationResult = {
      status: "failed",
      failure,
      detail: "why",
      identity: {},
      authentication: { issuerRecognized: failure !== "untrusted", dataIntegrity: true },
      layout: "nested",
    };
    const d = decide(AGE_21, result, "dc-mdoc", ctx);
    expect(d).toMatchObject({ outcome: "denied", reasonCode, headline: "ENTRY DENIED", holder: null });
    expect(d.checks[0]).toEqual({ label: "Credential verified", passed: false, detail: "why" });
    expect(d.checks.some((c) => c.label === "Age 21+")).toBe(false);
  });

  it("lists the authentication checks that failed as the specific reason", () => {
    const result: VerificationResult = {
      status: "failed",
      failure: "untrusted",
      detail: "The issuer's certificate is not in the trusted list.",
      identity: {},
      authentication: { issuerRecognized: false, issuerSignedAuthenticated: true },
      layout: "nested",
    };
    expect(decide(AGE_21, result, "dc-mdoc", ctx).checks).toEqual([
      { label: "Credential verified", passed: false, detail: "The issuer's certificate is not in the trusted list." },
      { label: "Issuer recognized", passed: false },
    ]);
  });
});

describe("decide: no credential", () => {
  it("maps a cancellation to declined (amber), never to denied", () => {
    const d = decide(AGE_21, { status: "cancelled", message: "User denied consent." }, "annex-b", ctx);
    expect(d).toMatchObject({ outcome: "declined", reasonCode: "VISITOR_DECLINED", headline: "VISITOR DECLINED", checks: [] });
  });

  it("maps a wallet-side timeout to an error", () => {
    expect(decide(AGE_21, { status: "timed_out", message: "Session timed out." }, "annex-b", ctx)).toMatchObject({ outcome: "error", reasonCode: "TIMEOUT" });
  });

  it("builds error decisions with the mapped staff text", () => {
    const d = errorDecision("SDK_QUOTA_EXCEEDED", "dc-mdoc", ctx, "PLAN_LIMIT_EXCEEDED");
    expect(d).toMatchObject({ outcome: "error", headline: "COULD NOT VERIFY", reason: "The monthly verification quota is used up." });
    expect(errorDecision("TIMEOUT", null, ctx).headline).toBe("TIMED OUT");
  });

  it("marks mock decisions as mock", () => {
    expect(decide(AGE_21, verified({ age_over_21: true }), "dc-mdoc", { ...ctx, mock: true }).mock).toBe(true);
    expect(decide(AGE_21, verified({ age_over_21: true }), "dc-mdoc", ctx).mock).toBe(false);
  });
});

describe("findPerson", () => {
  it("reports 'unidentifiable' when nothing usable was shared", () => {
    expect(findPerson({}, tickets)).toBe("unidentifiable");
    expect(findPerson({ given_name: "Jordan", family_name: "Park" }, tickets)).toBe("unidentifiable");
  });

  it("ignores case, spacing and accents in names", () => {
    const list = [{ familyName: "Núñez", givenName: "José", birthDate: "1990-05-05" }];
    expect(findPerson({ family_name: "NUNEZ", given_name: "jose", birth_date: "1990-05-05" }, list)).toBe(list[0]);
  });
});

describe("portraitDataUri", () => {
  it("passes image data URIs through and wraps raw base64 as JPEG or PNG", () => {
    expect(portraitDataUri(PORTRAIT)).toBe(PORTRAIT);
    expect(portraitDataUri("/9j/" + "A".repeat(200))).toBe(`data:image/jpeg;base64,/9j/${"A".repeat(200)}`);
    expect(portraitDataUri("iVBO" + "A".repeat(200))).toMatch(/^data:image\/png;base64,iVBO/);
    expect(portraitDataUri("-_" + "A".repeat(200))).toBe(`data:image/jpeg;base64,+/${"A".repeat(200)}`);
  });

  it("rejects anything that is not an inline image", () => {
    expect(portraitDataUri(`https://example.com/${"a".repeat(200)}.jpg`)).toBeNull();
    expect(portraitDataUri(`data:text/html;base64,${"A".repeat(200)}`)).toBeNull();
    expect(portraitDataUri(`javascript:alert(1)//${"A".repeat(200)}`)).toBeNull();
    expect(portraitDataUri("short")).toBeNull();
    expect(portraitDataUri(undefined)).toBeNull();
    expect(portraitDataUri("A".repeat(800_000))).toBeNull();
  });
});
