import { useState } from "react";
import type { MockOptions, MockScenario, MockShape } from "../../shared/types";

interface Props {
  options: MockOptions;
  walletName: string;
  defaultShape: MockShape;
  /** The simulated wallet answered. `data` stands in for the encrypted wallet response. */
  onChoose: (data: string) => void;
  /** The visitor closed the browser's prompt without answering. */
  onDismiss: () => void;
  /** The visitor walked away. */
  onTimeout: () => void;
}

/**
 * Stands in for the wallet's consent sheet in mock mode. It picks who is presenting,
 * what the profile releases, and how the presentation ends.
 */
export function MockWallet({ options, walletName, defaultShape, onChoose, onDismiss, onTimeout }: Props) {
  const [persona, setPersona] = useState(options.personas[0]?.id ?? "");
  const [shape, setShape] = useState<MockShape>(defaultShape);
  const choose = (scenario: MockScenario) => onChoose(`mock:${scenario}:${persona}:${shape}`);
  const share = options.scenarios.find((s) => s.id === "success");
  const others = options.scenarios.filter((s) => s.id !== "success");

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Simulated ${walletName}`}>
        <header className="sheet__header">
          <h2>{walletName}</h2>
          <span className="sheet__tag">SIMULATED</span>
        </header>

        <fieldset className="sheet__group">
          <legend>Who is presenting</legend>
          {options.personas.map((p) => (
            <label key={p.id} className={`option ${persona === p.id ? "is-selected" : ""}`}>
              <input type="radio" name="persona" value={p.id} checked={persona === p.id} onChange={() => setPersona(p.id)} />
              <span>
                <strong>{p.name}</strong>
                <small>{p.note}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="sheet__group">
          <legend>What the profile releases</legend>
          <div className="segmented">
            {options.shapes.map((s) => (
              <label key={s.id} className={shape === s.id ? "is-selected" : ""} title={s.note}>
                <input type="radio" name="shape" value={s.id} checked={shape === s.id} onChange={() => setShape(s.id)} />
                {s.label}
              </label>
            ))}
          </div>
          <p className="sheet__hint">{options.shapes.find((s) => s.id === shape)?.note}</p>
        </fieldset>

        <button className="btn btn--primary btn--block" onClick={() => choose("success")}>
          {share?.label ?? "Share ID"}
        </button>

        <div className="sheet__grid">
          {others.map((s) => (
            <button key={s.id} className="btn btn--block" onClick={() => choose(s.id)} title={s.note}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="sheet__links">
          <button className="link" onClick={onDismiss}>
            Dismiss the prompt
          </button>
          <button className="link" onClick={onTimeout}>
            Walk away (time out)
          </button>
        </div>
      </div>
    </div>
  );
}
