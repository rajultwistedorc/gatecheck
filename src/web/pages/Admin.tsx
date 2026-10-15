import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { OUTCOME_LABEL, REASONS } from "../../shared/reasons";
import type { GateSummary, LogQueryResult, Outcome, ShapeObservation, StatsResult } from "../../shared/types";
import { useConfig } from "../App";
import { ApiError, api } from "../api";
import { ReasonsChart, StatTile, ThroughputChart } from "../components/Charts";
import { Logo, OutcomeDot } from "../components/Icons";
import { formatTime } from "../hooks";

const PAGE_SIZE = 25;
const REFRESH_MS = 5000;
const WINDOWS = [
  { minutes: 15, label: "Last 15 minutes" },
  { minutes: 60, label: "Last hour" },
  { minutes: 240, label: "Last 4 hours" },
];
const OUTCOMES: Outcome[] = ["allowed", "denied", "declined", "error"];
const FLOW_SHORT = { "dc-mdoc": "A · DC API mdoc", "dc-openid4vp": "B · DC API OpenID4VP", "annex-b": "C · Annex B" } as const;

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

export function Admin() {
  const config = useConfig();
  const [gates, setGates] = useState<GateSummary[]>([]);
  // Filters that scope everything on the page.
  const [gate, setGate] = useState("");
  const [minutes, setMinutes] = useState(60);
  // In live mode, start on live rows only so simulated attempts never pad the numbers.
  const [mode, setMode] = useState(config.mockMode ? "" : "live");
  // Refinements that apply to the table only.
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(0);

  const [stats, setStats] = useState<StatsResult | null>(null);
  const [log, setLog] = useState<LogQueryResult | null>(null);
  const [shapes, setShapes] = useState<ShapeObservation[] | null>(null);
  const [shapesNote, setShapesNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purge, setPurge] = useState<"idle" | "confirm" | "working" | string>("idle");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const nextStats = await api.stats({ gate, mode, minutes });
      const nextLog = await api.log({ gate, mode, outcome, reason, from: nextStats.from, to: nextStats.to, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      if (mine !== seq.current) return;
      setStats(nextStats);
      setLog(nextLog);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof ApiError ? e.message : "Could not load the log.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [gate, mode, minutes, outcome, reason, page]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api.gates().then(setGates, () => undefined);
    const loadShapes = () =>
      api.shapes().then(
        (s) => setShapes(s.observations),
        (e: unknown) => setShapesNote(e instanceof ApiError ? e.message : "Not available."),
      );
    void loadShapes();
    const timer = setInterval(() => void loadShapes(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // Changing any filter returns the table to its first page.
  const scoped =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(0);
    };

  const runPurge = async () => {
    setPurge("working");
    try {
      const done = await api.purge();
      setPurge(`Removed ${done.removed} ${done.removed === 1 ? "row" : "rows"} older than ${done.retentionDays} days.`);
      void load();
    } catch (e) {
      setPurge(e instanceof ApiError ? e.message : "Purge failed.");
    }
  };

  const totals = stats?.totals;
  const attempts = totals ? totals.allowed + totals.denied + totals.declined + totals.error : 0;
  const share = (n: number) => (attempts === 0 ? "–" : `${Math.round((n / attempts) * 100)}% of attempts`);
  const pages = log ? Math.max(1, Math.ceil(log.total / PAGE_SIZE)) : 1;
  const viewFilters = { gate, mode, outcome, reason, from: stats?.from, to: stats?.to };

  return (
    <div className="page page--wide">
      <header className="page__header">
        <Link to="/" aria-label="All gates">
          <Logo />
        </Link>
        <nav>
          <Link className="btn" to="/">
            Gates
          </Link>
        </nav>
      </header>

      <div className="admin__titlebar">
        <h1>Entry log</h1>
        <span className={`admin__sync ${loading ? "is-loading" : ""}`}>{error ?? `Updates every ${REFRESH_MS / 1000} s`}</span>
      </div>

      {/* One filter row, above everything it scopes. */}
      <div className="filters" role="group" aria-label="Filters for the whole page">
        <label className="field">
          <span>Gate</span>
          <select value={gate} onChange={(e) => scoped(setGate)(e.target.value)}>
            <option value="">All gates</option>
            {gates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Time window</span>
          <select value={minutes} onChange={(e) => scoped(setMinutes)(Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w.minutes} value={w.minutes}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Source</span>
          <select value={mode} onChange={(e) => scoped(setMode)(e.target.value)}>
            <option value="">Live and mock</option>
            <option value="live">Live only</option>
            <option value="mock">Mock only</option>
          </select>
        </label>
      </div>

      {/* While a refresh is in flight the previous numbers stay on screen, slightly dimmed. */}
      <div className={`admin__body ${loading && stats ? "is-refreshing" : ""}`}>
        <section className="stats" aria-label="Summary">
          <StatTile label="Attempts" value={String(attempts)} sub={stats ? `${formatTime(stats.from, false)} to ${formatTime(stats.to, false)}` : undefined} />
          <StatTile label="Allowed" value={String(totals?.allowed ?? 0)} sub={share(totals?.allowed ?? 0)} />
          <StatTile label="Average per minute" value={(stats?.avgPerMinute ?? 0).toFixed(2)} />
          <StatTile label="Peak minute" value={String(stats?.peakPerMinute ?? 0)} sub="attempts" />
          <StatTile label="Median time to decision" value={seconds(stats?.medianLatencyMs ?? null)} sub="from scan to result" />
        </section>

        <div className="admin__charts">
          <section className="card viz-root">
            <h2>Attempts per minute</h2>
            <ThroughputChart buckets={stats?.perMinute ?? []} />
          </section>
          <section className="card viz-root">
            <h2>Why attempts did not end in entry</h2>
            <ReasonsChart reasons={stats?.reasons ?? []} selected={reason} onSelect={scoped(setReason)} />
          </section>
        </div>

        <section className="card">
          <div className="card__head">
            <h2>Attempts</h2>
            <div className="card__tools">
              <label className="field field--inline">
                <span>Outcome</span>
                <select value={outcome} onChange={(e) => scoped(setOutcome)(e.target.value)}>
                  <option value="">Any</option>
                  {OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {OUTCOME_LABEL[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field field--inline">
                <span>Reason</span>
                <select value={reason} onChange={(e) => scoped(setReason)(e.target.value)}>
                  <option value="">Any</option>
                  {Object.entries(REASONS).map(([code, info]) => (
                    <option key={code} value={code}>
                      {info.label}
                    </option>
                  ))}
                </select>
              </label>
              <a className="btn" href={api.logCsvUrl(viewFilters)} download>
                Export this view (CSV)
              </a>
              <a className="btn" href={api.logCsvUrl({})} download>
                Export everything
              </a>
            </div>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Gate</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                  <th>Flow</th>
                  <th>Source</th>
                  <th className="num">Time to decision</th>
                </tr>
              </thead>
              <tbody>
                {log?.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap">{new Date(row.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</td>
                    <td>{gates.find((g) => g.id === row.gateId)?.name ?? row.gateId}</td>
                    <td className="nowrap">
                      <OutcomeDot outcome={row.outcome} /> {OUTCOME_LABEL[row.outcome]}
                    </td>
                    <td>
                      {REASONS[row.reasonCode]?.label ?? row.reasonCode} <code>{row.reasonCode}</code>
                    </td>
                    <td className="nowrap">{row.flow ? FLOW_SHORT[row.flow] : "–"}</td>
                    <td>
                      <span className={`tag tag--${row.mode}`}>{row.mode === "mock" ? "MOCK" : "LIVE"}</span>
                    </td>
                    <td className="num">{seconds(row.latencyMs)}</td>
                  </tr>
                ))}
                {log && log.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="table__empty">
                      No attempts match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <span>
              {log ? `${log.total} ${log.total === 1 ? "attempt" : "attempts"}` : "Loading…"}
              {log && log.total > PAGE_SIZE ? ` · page ${page + 1} of ${pages}` : ""}
            </span>
            <div>
              <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Newer
              </button>
              <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                Older
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>What is stored</h2>
        <p>
          Each attempt stores its time, gate, outcome, reason code, flow, time to decision, and whether it was live or mock. No name, birth date, portrait or
          document number is ever written. Rows older than {config.logRetentionDays} days are deleted automatically.
        </p>
        <div className="purge">
          {purge === "idle" && (
            <button className="btn" onClick={() => setPurge("confirm")}>
              Run the purge now
            </button>
          )}
          {purge === "confirm" && (
            <>
              <span>Delete every row older than {config.logRetentionDays} days?</span>
              <button className="btn btn--danger" onClick={() => void runPurge()}>
                Delete old rows
              </button>
              <button className="btn" onClick={() => setPurge("idle")}>
                Cancel
              </button>
            </>
          )}
          {purge === "working" && <span>Purging…</span>}
          {!["idle", "confirm", "working"].includes(purge) && (
            <>
              <span>{purge}</span>
              <button className="btn" onClick={() => setPurge("idle")}>
                OK
              </button>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Response shapes</h2>
        <p>
          The field names (never the values) that recent verification responses contained. Use this to see what a profile actually returns before relying on
          a field.
        </p>
        {shapes === null ? (
          <p className="chart__none">{shapesNote ?? "Loading…"}</p>
        ) : shapes.length === 0 ? (
          <p className="chart__none">No verification responses yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Gate</th>
                  <th>Profile</th>
                  <th>Flow</th>
                  <th>Result</th>
                  <th>identity keys</th>
                  <th>authentication keys</th>
                </tr>
              </thead>
              <tbody>
                {shapes.map((s, i) => (
                  <tr key={`${s.ts}-${i}`}>
                    <td className="nowrap">{formatTime(s.ts)}</td>
                    <td>{s.gateId}</td>
                    <td className="nowrap">{s.profile}</td>
                    <td className="nowrap">
                      {FLOW_SHORT[s.flow]} <span className={`tag tag--${s.mode}`}>{s.mode === "mock" ? "MOCK" : "LIVE"}</span>
                    </td>
                    <td className="nowrap">
                      {s.verified ? "verified" : "failed"} · {s.layout}
                    </td>
                    <td>{s.identityKeys.length ? s.identityKeys.map((k) => <code key={k}>{k}</code>) : "–"}</td>
                    <td>{s.authenticationKeys.length ? s.authenticationKeys.map((k) => <code key={k}>{k}</code>) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
