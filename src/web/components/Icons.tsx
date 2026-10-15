import type { Outcome } from "../../shared/types";

const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function CheckIcon({ size = 24, weight = 3 }: { size?: number; weight?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={weight} {...common}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CrossIcon({ size = 24, weight = 3 }: { size?: number; weight?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={weight} {...common}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function HandIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.6} {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function AlertIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.6} {...common}>
      <path d="M12 4.5l8.5 14.5h-17z" />
      <path d="M12 10.5v4M12 17.2v.1" />
    </svg>
  );
}

export function ClockIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.6} {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="var(--brand)" />
        <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>GateCheck</span>
    </span>
  );
}

/** Outcome marker for tables and legends: a shape as well as a colour, plus the label beside it. */
export function OutcomeDot({ outcome }: { outcome: Outcome }) {
  return <span className={`outcome-dot outcome-dot--${outcome}`} aria-hidden="true" />;
}
