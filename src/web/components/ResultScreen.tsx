import { FLOW_LABEL } from "../../shared/platform";
import type { Decision, SessionStatus } from "../../shared/types";
import { AlertIcon, CheckIcon, ClockIcon, CrossIcon, HandIcon } from "./Icons";

type Tone = "allowed" | "denied" | "declined" | "error" | "timeout";

function toneOf(decision: Decision, status: SessionStatus): Tone {
  if (status === "timeout" || decision.reasonCode === "TIMEOUT") return "timeout";
  return decision.outcome;
}

function ToneIcon({ tone }: { tone: Tone }) {
  const size = 72;
  switch (tone) {
    case "allowed":
      return <CheckIcon size={size} weight={3.2} />;
    case "denied":
      return <CrossIcon size={size} weight={3.2} />;
    case "declined":
      return <HandIcon size={size} />;
    case "timeout":
      return <ClockIcon size={size} />;
    case "error":
      return <AlertIcon size={size} />;
  }
}

const FOOTNOTE: Record<Tone, string> = {
  allowed: "",
  denied: "Do not admit. Offer a manual check if the visitor disputes this.",
  declined: "Nothing was shared. Offer a manual check or a new code.",
  error: "This is not a denial. Check this visitor manually.",
  timeout: "No decision was made. Offer a new code.",
};

interface Props {
  decision: Decision;
  status: SessionStatus;
  secondsLeft: number;
  held: boolean;
  onHold: () => void;
  onNext: () => void;
}

/**
 * The full-screen result. Each state has its own colour, icon and headline, so it reads
 * from across a gate and never depends on colour alone.
 */
export function ResultScreen({ decision, status, secondsLeft, held, onHold, onNext }: Props) {
  const tone = toneOf(decision, status);
  const holder = decision.holder;
  // An allowed result with no holder is the age-only case: say plainly that nothing personal arrived.
  const ageOnly = tone === "allowed" && decision.noPersonalData;

  return (
    <section className={`result result--${tone}`} aria-live="assertive">
      {decision.mock && <div className="result__stamp">MOCK RESULT</div>}

      <div className="result__body">
        {holder?.portrait && <img className="result__portrait" src={holder.portrait} alt="Portrait from the credential" />}

        <div className="result__main">
          <div className="result__headline">
            <span className="result__icon">
              <ToneIcon tone={tone} />
            </span>
            <h1>{decision.headline}</h1>
          </div>

          {holder?.name && <p className="result__name">{holder.name}</p>}

          {tone !== "allowed" && <p className="result__reason">{decision.reason}</p>}

          {ageOnly && (
            <p className="result__privacy">
              No name or photo was shared. This credential proved the age requirement and nothing else.
            </p>
          )}
          {tone === "allowed" && !ageOnly && holder && !holder.portrait && <p className="result__privacy">No photo was shared by this credential.</p>}
          {tone === "allowed" && !ageOnly && holder && !holder.name && <p className="result__privacy">No name was shared by this credential.</p>}

          {decision.fields.length > 0 && (
            <dl className="result__fields">
              {decision.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {decision.checks.length > 0 && (
            <ul className="result__checks">
              {decision.checks.map((c) => (
                <li key={c.label} className={c.passed ? "is-pass" : "is-fail"}>
                  <span className="result__check-icon">{c.passed ? <CheckIcon size={18} /> : <CrossIcon size={18} />}</span>
                  <span className="result__check-label">{c.label}</span>
                  {c.detail && <span className="result__check-detail">{c.detail}</span>}
                </li>
              ))}
            </ul>
          )}

          {FOOTNOTE[tone] && <p className="result__footnote">{FOOTNOTE[tone]}</p>}
        </div>
      </div>

      <footer className="result__footer">
        <span className="result__meta">
          {decision.reasonCode}
          {decision.flow ? ` · ${FLOW_LABEL[decision.flow].split(":")[0]}` : ""}
        </span>
        <div className="result__actions">
          <button className="btn btn--ghost-on-color" onClick={onHold} aria-pressed={held}>
            {held ? "Resume" : "Hold"}
          </button>
          <button className="btn btn--on-color" onClick={onNext}>
            Next visitor{!held && secondsLeft > 0 ? ` (${secondsLeft})` : ""}
          </button>
        </div>
      </footer>
    </section>
  );
}
