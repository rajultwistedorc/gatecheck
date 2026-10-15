import type { Outcome, ReasonCode } from "./types";

interface ReasonInfo {
  outcome: Outcome;
  /** Short label for charts and tables. */
  label: string;
  /** What the staff screen says. */
  staff: string;
  /** What the visitor's phone says. No detail that helps someone probe the rules. */
  visitor: string;
}

export const REASONS: Record<ReasonCode, ReasonInfo> = {
  ENTRY_ALLOWED: {
    outcome: "allowed",
    label: "Entry allowed",
    staff: "All checks passed.",
    visitor: "You're verified. Staff will wave you through.",
  },
  CREDENTIAL_EXPIRED: {
    outcome: "denied",
    label: "Credential expired",
    staff: "The ID in the wallet has expired.",
    visitor: "Your ID could not be accepted because it has expired.",
  },
  ISSUER_UNTRUSTED: {
    outcome: "denied",
    label: "Issuer not trusted",
    staff: "The ID was not issued by a trusted authority.",
    visitor: "Your ID could not be accepted. Please see a member of staff.",
  },
  CREDENTIAL_INVALID: {
    outcome: "denied",
    label: "Credential failed checks",
    staff: "The ID failed its cryptographic checks.",
    visitor: "Your ID could not be verified. Please see a member of staff.",
  },
  TICKET_NOT_FOUND: {
    outcome: "denied",
    label: "No matching ticket",
    staff: "ID is valid, but no ticket matches this person.",
    visitor: "We could not find a ticket for this ID. Please see a member of staff.",
  },
  UNDER_AGE: {
    outcome: "denied",
    label: "Under age",
    staff: "ID is valid, but the holder is under the age limit.",
    visitor: "This area has an age limit that your ID does not meet.",
  },
  AGE_UNAVAILABLE: {
    outcome: "denied",
    label: "Age not shared",
    staff: "ID is valid, but it shared neither an age-over claim nor a birth date.",
    visitor: "Your ID did not share the age information this area needs.",
  },
  NOT_ON_ALLOWLIST: {
    outcome: "denied",
    label: "Not on allow-list",
    staff: "ID is valid, but the holder is not on the list for this gate.",
    visitor: "You are not on the list for this entrance.",
  },
  ATTRIBUTES_MISSING: {
    outcome: "denied",
    label: "Required details not shared",
    staff: "ID is valid, but it did not share the details this gate checks.",
    visitor: "Your ID did not share the details this entrance needs.",
  },
  VISITOR_DECLINED: {
    outcome: "declined",
    label: "Visitor declined",
    staff: "The visitor cancelled or declined to share their ID.",
    visitor: "You cancelled the request. Nothing was shared.",
  },
  TIMEOUT: {
    outcome: "error",
    label: "Timed out",
    staff: "The visitor scanned the code but did not finish in time.",
    visitor: "This request timed out. Please scan the new code at the gate.",
  },
  STAFF_RESET: {
    outcome: "error",
    label: "Reset by staff",
    staff: "The attempt was replaced by a new code before it finished.",
    visitor: "This code was replaced. Please scan the new code at the gate.",
  },
  WALLET_UNAVAILABLE: {
    outcome: "error",
    label: "Wallet could not open",
    staff: "The visitor's phone could not open a wallet.",
    visitor: "Your phone could not open a wallet for this request.",
  },
  SDK_AUTH_ERROR: {
    outcome: "error",
    label: "Service credentials rejected",
    staff: "The verification service rejected this site's license.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  SDK_DOMAIN_MISMATCH: {
    outcome: "error",
    label: "Domain not registered",
    staff: "This site's domain does not match the one registered with the verification service.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  SDK_PROFILE_ERROR: {
    outcome: "error",
    label: "Profile problem",
    staff: "The verification profile for this gate is missing or unsupported.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  SDK_QUOTA_EXCEEDED: {
    outcome: "error",
    label: "Monthly quota used up",
    staff: "The monthly verification quota is used up.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  SDK_RATE_LIMITED: {
    outcome: "error",
    label: "Rate limited",
    staff: "Too many requests to the verification service. Wait a moment and try again.",
    visitor: "Verification is busy. Please try again in a moment.",
  },
  SDK_UNAVAILABLE: {
    outcome: "error",
    label: "Service unreachable",
    staff: "The verification service could not be reached.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  SDK_BAD_RESPONSE: {
    outcome: "error",
    label: "Unexpected service response",
    staff: "The verification service returned something unexpected.",
    visitor: "Verification is unavailable right now. Please see a member of staff.",
  },
  INTERNAL_ERROR: {
    outcome: "error",
    label: "Internal error",
    staff: "Something went wrong inside GateCheck.",
    visitor: "Something went wrong. Please see a member of staff.",
  },
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  allowed: "Allowed",
  denied: "Denied",
  declined: "Declined",
  error: "Error",
};
