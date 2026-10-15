import { readFileSync } from "node:fs";
import { z } from "zod";
import type { GateSummary, ProfileKey, RuleSummary } from "../../shared/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Identifies a person either by document number, or by full name plus birth date. */
const personRef = z
  .object({
    documentNumber: z.string().min(1).max(40).optional(),
    familyName: z.string().min(1).max(80).optional(),
    givenName: z.string().min(1).max(80).optional(),
    birthDate: z.string().regex(DATE_RE).optional(),
  })
  .refine((p) => Boolean(p.documentNumber) || Boolean(p.familyName && p.givenName && p.birthDate), {
    message: "needs documentNumber, or familyName + givenName + birthDate",
  });

const ruleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ticket") }),
  z.object({ type: z.literal("age"), minAge: z.number().int().min(1).max(120) }),
  z.object({
    type: z.literal("allowlist"),
    entries: z.array(personRef.and(z.object({ label: z.string().max(60).optional() }))).min(1),
  }),
]);

const profileKey = z.enum(["age-check", "id-check"]);

const gateSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(""),
  profile: profileKey,
  rules: z.array(ruleSchema).min(1),
  /** Used when `profile` is not configured: a different profile, rule set and on-screen notice. */
  fallback: z
    .object({
      profile: profileKey,
      notice: z.string().min(1).max(60),
      description: z.string().max(200).optional(),
      rules: z.array(ruleSchema).min(1),
    })
    .optional(),
});

const gatesFileSchema = z.object({ gates: z.array(gateSchema).min(1) });

const ticketsFileSchema = z.object({
  tickets: z.array(personRef.and(z.object({ ticketId: z.string().min(1).max(40), tier: z.string().min(1).max(60) }))),
});

export type Rule = z.infer<typeof ruleSchema>;
export type PersonRef = z.infer<typeof personRef>;
export type GateConfig = z.infer<typeof gateSchema>;
export type Ticket = z.infer<typeof ticketsFileSchema>["tickets"][number];

export interface ResolvedGate {
  id: string;
  name: string;
  description: string;
  profile: ProfileKey;
  /** Null only when the gate is unavailable. */
  profileId: string | null;
  rules: Rule[];
  notice: string | null;
  available: boolean;
  unavailableReason: string | null;
}

const PROFILE_ENV: Record<ProfileKey, string> = {
  "age-check": "CREDENCE_PROFILE_AGE_CHECK",
  "id-check": "CREDENCE_PROFILE_ID_CHECK",
};

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseGatesFile(raw: unknown): GateConfig[] {
  const parsed = gatesFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid gates config: ${describe(parsed.error)}`);
  const ids = new Set<string>();
  for (const gate of parsed.data.gates) {
    if (ids.has(gate.id)) throw new Error(`Invalid gates config: duplicate gate id "${gate.id}"`);
    ids.add(gate.id);
  }
  return parsed.data.gates;
}

export function parseTicketsFile(raw: unknown): Ticket[] {
  const parsed = ticketsFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid tickets config: ${describe(parsed.error)}`);
  return parsed.data.tickets;
}

export function loadGatesFile(path: string): GateConfig[] {
  return parseGatesFile(readJson(path, "gates config"));
}

export function loadTicketsFile(path: string): Ticket[] {
  return parseTicketsFile(readJson(path, "tickets config"));
}

/**
 * Binds each gate to a concrete profile id.
 *
 * Live: a gate uses its own profile when that profile is configured, otherwise its
 * fallback (with the fallback's rules and notice). A gate with neither is unavailable
 * rather than silently weakened.
 *
 * Mock: every profile exists, so every gate runs its primary rules.
 */
export function resolveGates(
  gates: GateConfig[],
  profiles: Record<ProfileKey, string | null>,
  mockMode: boolean,
): ResolvedGate[] {
  return gates.map((gate): ResolvedGate => {
    const base = { id: gate.id, name: gate.name, description: gate.description };
    const primary = profiles[gate.profile] ?? (mockMode ? `mock-${gate.profile}` : null);
    if (primary) {
      return { ...base, profile: gate.profile, profileId: primary, rules: gate.rules, notice: null, available: true, unavailableReason: null };
    }
    const fallbackId = gate.fallback ? profiles[gate.fallback.profile] : null;
    if (gate.fallback && fallbackId) {
      return {
        ...base,
        description: gate.fallback.description ?? gate.description,
        profile: gate.fallback.profile,
        profileId: fallbackId,
        rules: gate.fallback.rules,
        notice: gate.fallback.notice,
        available: true,
        unavailableReason: null,
      };
    }
    return {
      ...base,
      profile: gate.profile,
      profileId: null,
      rules: gate.rules,
      notice: null,
      available: false,
      unavailableReason: `This gate needs the ${gate.profile} profile. Set ${PROFILE_ENV[gate.profile]} to enable it.`,
    };
  });
}

function summariseRule(rule: Rule): RuleSummary {
  switch (rule.type) {
    case "ticket":
      return { type: "ticket", label: "Valid ticket" };
    case "age":
      return { type: "age", minAge: rule.minAge, label: `Age ${rule.minAge}+` };
    case "allowlist":
      return { type: "allowlist", label: "On the allow-list" };
  }
}

/** The client-facing view of a gate. Leaves out allow-list entries and profile ids. */
export function summariseGate(gate: ResolvedGate): GateSummary {
  return {
    id: gate.id,
    name: gate.name,
    description: gate.description,
    profile: gate.profile,
    rules: gate.rules.map(summariseRule),
    notice: gate.notice,
    available: gate.available,
    unavailableReason: gate.unavailableReason,
  };
}
