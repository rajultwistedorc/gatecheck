// The rule layer. Pure: given a gate's rules and a verification result, it produces the
// decision the staff screen shows. A valid signature is necessary but never sufficient.
//
// Nothing here assumes a claim exists. An age-check profile may release a single
// age_over_NN boolean and nothing else, and every branch has to cope with that.

import { REASONS } from "../../shared/reasons";
import type { Decision, DecisionCheck, FlowId, ReasonCode } from "../../shared/types";
import { summariseAuthentication, type Claims, type FailureKind, type VerificationResult } from "../cloud/parse";
import type { PersonRef, Rule, Ticket } from "./gates";

export interface RuleContext {
  tickets: Ticket[];
  now: Date;
  /** IANA timezone that decides "today" when age is computed from a birth date. */
  timeZone: string;
  mock: boolean;
}

interface RuleOutcome {
  check: DecisionCheck;
  /** Set when the rule denies entry. */
  denyReason?: ReasonCode;
  fields?: { label: string; value: string }[];
  /** Set by a passed age rule. */
  ageVerified?: number;
}

const FAILURE_REASON: Record<FailureKind, ReasonCode> = {
  expired: "CREDENTIAL_EXPIRED",
  untrusted: "ISSUER_UNTRUSTED",
  invalid: "CREDENTIAL_INVALID",
};

const MAX_PORTRAIT_CHARS = 700_000;

// ---- Reading claims ----------------------------------------------------------

function text(claims: Claims, key: string): string | null {
  const value = claims[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

/** Accepts "1990-01-15" and full ISO timestamps; returns the calendar date parts. */
export function parseBirthDate(raw: unknown): { y: number; m: number; d: number } | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export function todayIn(timeZone: string, now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/** Whole years completed. Someone born on 29 February has their birthday on 1 March in common years. */
export function ageInYears(birth: { y: number; m: number; d: number }, today: { y: number; m: number; d: number }): number {
  const hadBirthday = today.m > birth.m || (today.m === birth.m && today.d >= birth.d);
  return today.y - birth.y - (hadBirthday ? 0 : 1);
}

export type AgeResult =
  | { known: true; over: boolean; source: "age-over claim" | "birth date" | "age in years" }
  | { known: false };

/**
 * Is the holder at least `minAge`?
 *
 * 1. An age_over_NN boolean, when the profile returned one. age_over_21 answers a 21 limit
 *    directly; beyond that, age_over_25=true proves "over 21" and age_over_18=false
 *    disproves it, while age_over_18=true and age_over_25=false say nothing either way.
 * 2. birth_date, compared with today's date at the venue.
 * 3. age_in_years.
 * Otherwise unknown, which the gate treats as a denial (AGE_UNAVAILABLE).
 *
 * The Cloud SDK docs do not say which of these a profile returns, so none is assumed.
 */
export function evaluateAge(identity: Claims, minAge: number, ctx: Pick<RuleContext, "now" | "timeZone">): AgeResult {
  for (const [key, value] of Object.entries(identity)) {
    const match = /^age_over_(\d{1,3})$/.exec(key);
    const flag = bool(value);
    if (!match || flag === null) continue;
    const threshold = Number(match[1]);
    if (flag && threshold >= minAge) return { known: true, over: true, source: "age-over claim" };
    if (!flag && threshold <= minAge) return { known: true, over: false, source: "age-over claim" };
  }

  const birth = parseBirthDate(identity.birth_date);
  if (birth) {
    const age = ageInYears(birth, todayIn(ctx.timeZone, ctx.now));
    if (age >= 0 && age < 150) return { known: true, over: age >= minAge, source: "birth date" };
  }

  const years = typeof identity.age_in_years === "number" ? identity.age_in_years : Number.NaN;
  if (Number.isFinite(years) && years >= 0 && years < 150) {
    return { known: true, over: years >= minAge, source: "age in years" };
  }
  return { known: false };
}

function normaliseName(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normaliseDocument(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Finds a ticket or allow-list entry for the holder: by document number when the
 * credential shared one, otherwise by family name + given name + birth date.
 * "unidentifiable" means the credential shared neither, so no lookup was possible.
 */
export function findPerson<T extends PersonRef>(identity: Claims, entries: readonly T[]): T | "unidentifiable" | null {
  const documentNumber = text(identity, "document_number");
  const family = text(identity, "family_name");
  const given = text(identity, "given_name");
  const birth = parseBirthDate(identity.birth_date);
  const hasNameAndBirth = Boolean(family && given && birth);
  if (!documentNumber && !hasNameAndBirth) return "unidentifiable";

  if (documentNumber) {
    const wanted = normaliseDocument(documentNumber);
    const byDocument = entries.find((e) => e.documentNumber && normaliseDocument(e.documentNumber) === wanted);
    if (byDocument) return byDocument;
  }
  if (family && given && birth) {
    const birthIso = `${birth.y}-${String(birth.m).padStart(2, "0")}-${String(birth.d).padStart(2, "0")}`;
    const byName = entries.find(
      (e) =>
        e.familyName &&
        e.givenName &&
        e.birthDate === birthIso &&
        normaliseName(e.familyName) === normaliseName(family) &&
        normaliseName(e.givenName) === normaliseName(given),
    );
    if (byName) return byName;
  }
  return null;
}

/** Returns a data: URI safe to put in an <img>, or null. The portrait is display-only. */
export function portraitDataUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 100 || raw.length > MAX_PORTRAIT_CHARS) return null;
  const value = raw.trim();
  if (value.startsWith("data:")) {
    return /^data:image\/(jpeg|png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
  }
  if (!/^[A-Za-z0-9+/=_\s-]+$/.test(value)) return null;
  // The sample app treats the portrait as base64 JPEG; accept base64url as well.
  const base64 = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const mime = base64.startsWith("iVBO") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${base64}`;
}

// ---- Rules -------------------------------------------------------------------

function applyRule(rule: Rule, identity: Claims, ctx: RuleContext): RuleOutcome {
  switch (rule.type) {
    case "age": {
      const label = `Age ${rule.minAge}+`;
      const age = evaluateAge(identity, rule.minAge, ctx);
      if (!age.known) {
        return {
          check: { label, passed: false, detail: "No age-over claim or birth date was shared" },
          denyReason: "AGE_UNAVAILABLE",
        };
      }
      if (!age.over) return { check: { label, passed: false, detail: `From ${age.source}` }, denyReason: "UNDER_AGE" };
      return { check: { label, passed: true, detail: `From ${age.source}` }, ageVerified: rule.minAge };
    }
    case "ticket": {
      const ticket = findPerson(identity, ctx.tickets);
      if (ticket === "unidentifiable") {
        return {
          check: { label: "Ticket", passed: false, detail: "No document number or name and birth date was shared" },
          denyReason: "ATTRIBUTES_MISSING",
        };
      }
      if (!ticket) return { check: { label: "Ticket", passed: false, detail: "No match" }, denyReason: "TICKET_NOT_FOUND" };
      return {
        check: { label: "Ticket", passed: true, detail: ticket.tier },
        fields: [{ label: "Ticket", value: `${ticket.tier} (${ticket.ticketId})` }],
      };
    }
    case "allowlist": {
      const entry = findPerson(identity, rule.entries);
      if (entry === "unidentifiable") {
        return {
          check: { label: "Allow-list", passed: false, detail: "No document number or name and birth date was shared" },
          denyReason: "ATTRIBUTES_MISSING",
        };
      }
      if (!entry) return { check: { label: "Allow-list", passed: false, detail: "Not listed" }, denyReason: "NOT_ON_ALLOWLIST" };
      return {
        check: { label: "Allow-list", passed: true, detail: entry.label },
        fields: entry.label ? [{ label: "Listed as", value: entry.label }] : [],
      };
    }
  }
}

function base(flow: FlowId | null, ctx: Pick<RuleContext, "now" | "mock">) {
  return { holder: null, noPersonalData: false, fields: [], flow, mock: ctx.mock, decidedAt: ctx.now.getTime() };
}

/** A decision for something that went wrong before or outside verification. */
export function errorDecision(
  reasonCode: ReasonCode,
  flow: FlowId | null,
  ctx: Pick<RuleContext, "now" | "mock">,
  detail?: string,
): Decision {
  const info = REASONS[reasonCode];
  return {
    ...base(flow, ctx),
    outcome: info.outcome,
    reasonCode,
    headline: reasonCode === "TIMEOUT" ? "TIMED OUT" : "COULD NOT VERIFY",
    reason: info.staff,
    checks: detail ? [{ label: "Detail", passed: false, detail }] : [],
  };
}

export function decide(rules: readonly Rule[], result: VerificationResult, flow: FlowId | null, ctx: RuleContext): Decision {
  if (result.status === "cancelled") {
    return {
      ...base(flow, ctx),
      outcome: "declined",
      reasonCode: "VISITOR_DECLINED",
      headline: "VISITOR DECLINED",
      reason: REASONS.VISITOR_DECLINED.staff,
      checks: [],
    };
  }
  if (result.status === "timed_out") return errorDecision("TIMEOUT", flow, ctx);

  if (result.status === "failed") {
    const reasonCode = FAILURE_REASON[result.failure];
    return {
      ...base(flow, ctx),
      outcome: "denied",
      reasonCode,
      headline: "ENTRY DENIED",
      reason: REASONS[reasonCode].staff,
      checks: [
        { label: "Credential verified", passed: false, detail: result.detail },
        // Only the checks that did not pass: on a failure those are the ones staff need.
        ...summariseAuthentication(result.authentication).filter((c) => !c.passed),
      ],
    };
  }

  const outcomes = rules.map((rule) => applyRule(rule, result.identity, ctx));
  const denied = outcomes.find((o) => o.denyReason);
  const name = [text(result.identity, "given_name"), text(result.identity, "family_name")].filter(Boolean).join(" ");
  const portrait = portraitDataUri(result.identity.portrait);
  const holder = name || portrait ? { ...(name ? { name } : {}), ...(portrait ? { portrait } : {}) } : null;
  const checks: DecisionCheck[] = [{ label: "Credential verified", passed: true }, ...outcomes.map((o) => o.check)];
  const shared = { ...base(flow, ctx), holder, noPersonalData: holder === null, checks };

  if (denied?.denyReason) {
    return { ...shared, outcome: "denied", reasonCode: denied.denyReason, headline: "ENTRY DENIED", reason: REASONS[denied.denyReason].staff };
  }

  // With an age-only credential there is nobody to name, so the screen states the one
  // thing that was proven.
  const ages = outcomes.flatMap((o) => (o.ageVerified === undefined ? [] : [o.ageVerified]));
  const headline = holder === null && ages.length > 0 ? `AGE ${Math.max(...ages)}+ VERIFIED` : "ENTRY ALLOWED";
  return {
    ...shared,
    outcome: "allowed",
    reasonCode: "ENTRY_ALLOWED",
    headline,
    reason: REASONS.ENTRY_ALLOWED.staff,
    fields: outcomes.flatMap((o) => o.fields ?? []),
  };
}
