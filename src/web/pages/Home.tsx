import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GateSummary } from "../../shared/types";
import { useConfig } from "../App";
import { ApiError, api } from "../api";
import { Logo } from "../components/Icons";

const PROFILE_LABEL = { "age-check": "Age-check profile", "id-check": "ID-check profile" } as const;

export function Home() {
  const config = useConfig();
  const [gates, setGates] = useState<GateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.gates().then(
      (g) => !cancelled && setGates(g),
      (e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : "Could not load the gates."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <header className="page__header">
        <Logo />
        <nav>
          <Link className="btn" to="/admin">
            Entry log and stats
          </Link>
        </nav>
      </header>

      <section className="page__intro">
        <h1>Gates</h1>
        <p>
          Open a gate screen on the tablet at that entrance. Visitors scan its QR code with their own phone and approve the request in their wallet; the
          decision appears on the gate screen.
        </p>
        <p className="page__profiles">
          {config.profiles.map((p) => (
            <span key={p.key} className={`chip ${p.configured ? "" : "chip--muted"}`}>
              {PROFILE_LABEL[p.key]}: {p.configured ? (config.mockMode ? "simulated" : "configured") : "not configured"}
            </span>
          ))}
        </p>
      </section>

      {error && <p className="form-error">{error}</p>}

      <ul className="gate-grid">
        {gates?.map((gate) => (
          <li key={gate.id} className={`gate-card ${gate.available ? "" : "gate-card--off"}`}>
            <div className="gate-card__head">
              <h2>{gate.name}</h2>
              <span className="gate-card__id">/gate/{gate.id}</span>
            </div>
            <p>{gate.description}</p>
            <div className="chips">
              {gate.rules.map((r) => (
                <span className="chip" key={r.label}>
                  {r.label}
                </span>
              ))}
              <span className="chip chip--muted">{PROFILE_LABEL[gate.profile]}</span>
              {gate.notice && <span className="chip chip--notice">{gate.notice}</span>}
            </div>
            {gate.available ? (
              <Link className="btn btn--primary" to={`/gate/${gate.id}`}>
                Open gate screen
              </Link>
            ) : (
              <p className="gate-card__reason">{gate.unavailableReason}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
