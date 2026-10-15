import type { ReactNode } from "react";
import type { Outcome, VisitorResult } from "../../shared/types";
import { AlertIcon, CheckIcon, CrossIcon, HandIcon, Logo } from "./Icons";

/** The phone-sized card every visitor screen sits in. */
export function VisitorShell({ gateName, children }: { gateName?: string; children: ReactNode }) {
  return (
    <main className="visitor">
      <div className="visitor__card">
        <header className="visitor__header">
          <Logo />
          {gateName && <span className="visitor__gate">{gateName}</span>}
        </header>
        {children}
      </div>
    </main>
  );
}

const TITLE: Record<Outcome, string> = {
  allowed: "You’re verified",
  denied: "Not admitted",
  declined: "Request cancelled",
  error: "Could not verify",
};

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  if (outcome === "allowed") return <CheckIcon size={40} />;
  if (outcome === "denied") return <CrossIcon size={40} />;
  if (outcome === "declined") return <HandIcon size={40} />;
  return <AlertIcon size={40} />;
}

/**
 * What the visitor sees at the end. Deliberately plain: the gate screen is the authority,
 * and this must not look like a pass that could be screenshotted and reused.
 */
export function VisitorResultView({ result, mock }: { result: VisitorResult; mock: boolean }) {
  return (
    <div className={`visitor-result visitor-result--${result.outcome}`} role="status">
      <span className="visitor-result__icon">
        <OutcomeIcon outcome={result.outcome} />
      </span>
      <h1>{TITLE[result.outcome]}</h1>
      <p>{result.message}</p>
      {mock && <p className="visitor-result__mock">MOCK RESULT</p>}
      <p className="visitor-result__hint">
        {result.outcome === "allowed" ? "The result is on the gate screen. You can close this page." : "To try again, scan the new code at the gate."}
      </p>
    </div>
  );
}

export function VisitorMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="visitor-message">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
