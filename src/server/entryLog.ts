import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  FlowId,
  LogQueryResult,
  LogRow,
  MinuteBucket,
  Outcome,
  ReasonCode,
  ShapeObservation,
  StatsResult,
} from "../shared/types";

// The entry log. One row per attempt, holding only: timestamp, gate, outcome, reason code,
// flow, latency, and whether the row came from mock or live mode. There is no column that
// could hold a name, birth date, portrait or document number, by design.

export interface NewLogEntry {
  ts: number;
  gateId: string;
  outcome: Outcome;
  reasonCode: ReasonCode;
  flow: FlowId | null;
  mode: "live" | "mock";
  latencyMs: number | null;
}

export interface LogFilter {
  gateId?: string;
  outcome?: Outcome;
  reasonCode?: string;
  mode?: "live" | "mock";
  from?: number;
  to?: number;
}

interface DbRow {
  id: number;
  ts: number;
  gate_id: string;
  outcome: Outcome;
  reason_code: ReasonCode;
  flow: FlowId | null;
  mode: "live" | "mock";
  latency_ms: number | null;
}

const MINUTE = 60_000;

function toRow(r: DbRow): LogRow {
  return {
    id: r.id,
    ts: r.ts,
    gateId: r.gate_id,
    outcome: r.outcome,
    reasonCode: r.reason_code,
    flow: r.flow,
    mode: r.mode,
    latencyMs: r.latency_ms,
  };
}

function where(filter: LogFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const add = (clause: string, value: string | number | undefined) => {
    if (value === undefined) return;
    clauses.push(clause);
    params.push(value);
  };
  add("gate_id = ?", filter.gateId);
  add("outcome = ?", filter.outcome);
  add("reason_code = ?", filter.reasonCode);
  add("mode = ?", filter.mode);
  add("ts >= ?", filter.from);
  add("ts < ?", filter.to);
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Quotes a CSV cell, and defuses values a spreadsheet would run as a formula. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== "number") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class EntryLog {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        gate_id     TEXT    NOT NULL,
        outcome     TEXT    NOT NULL CHECK (outcome IN ('allowed','denied','declined','error')),
        reason_code TEXT    NOT NULL,
        flow        TEXT,
        mode        TEXT    NOT NULL CHECK (mode IN ('live','mock')),
        latency_ms  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_entry_log_ts ON entry_log (ts);
      CREATE INDEX IF NOT EXISTS idx_entry_log_gate_ts ON entry_log (gate_id, ts);
    `);
  }

  insert(entry: NewLogEntry): number {
    const result = this.db
      .prepare(
        "INSERT INTO entry_log (ts, gate_id, outcome, reason_code, flow, mode, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(entry.ts, entry.gateId, entry.outcome, entry.reasonCode, entry.flow, entry.mode, entry.latencyMs);
    return Number(result.lastInsertRowid);
  }

  query(filter: LogFilter, limit: number, offset: number): LogQueryResult {
    const { sql, params } = where(filter);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM entry_log ${sql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM entry_log ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as DbRow[];
    return { rows: rows.map(toRow), total, limit, offset };
  }

  /** Per-minute throughput, outcome totals and the fail-reason breakdown for a trailing window. */
  stats(filter: Pick<LogFilter, "gateId" | "mode">, windowMinutes: number, now: number): StatsResult {
    const to = Math.floor(now / MINUTE) * MINUTE + MINUTE;
    const from = to - windowMinutes * MINUTE;
    const { sql, params } = where({ ...filter, from, to });

    const buckets = new Map<number, MinuteBucket>();
    for (let minute = from; minute < to; minute += MINUTE) {
      buckets.set(minute, { minute, allowed: 0, denied: 0, declined: 0, error: 0 });
    }
    const totals: Record<Outcome, number> = { allowed: 0, denied: 0, declined: 0, error: 0 };
    const perMinute = this.db
      .prepare(`SELECT (ts / ${MINUTE}) * ${MINUTE} AS minute, outcome, COUNT(*) AS n FROM entry_log ${sql} GROUP BY minute, outcome`)
      .all(...params) as { minute: number; outcome: Outcome; n: number }[];
    for (const row of perMinute) {
      const bucket = buckets.get(row.minute);
      if (bucket) bucket[row.outcome] += row.n;
      totals[row.outcome] += row.n;
    }

    const reasons = this.db
      .prepare(
        `SELECT reason_code AS reasonCode, outcome, COUNT(*) AS count FROM entry_log ${sql} ${sql ? "AND" : "WHERE"} outcome != 'allowed'
         GROUP BY reason_code, outcome ORDER BY count DESC, reason_code`,
      )
      .all(...params) as StatsResult["reasons"];

    const latencies = (
      this.db
        .prepare(`SELECT latency_ms AS v FROM entry_log ${sql} ${sql ? "AND" : "WHERE"} latency_ms IS NOT NULL ORDER BY latency_ms`)
        .all(...params) as { v: number }[]
    ).map((r) => r.v);
    const mid = Math.floor(latencies.length / 2);
    const median =
      latencies.length === 0 ? null : latencies.length % 2 ? latencies[mid]! : Math.round((latencies[mid - 1]! + latencies[mid]!) / 2);

    const series = [...buckets.values()];
    const counts = series.map((b) => b.allowed + b.denied + b.declined + b.error);
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      windowMinutes,
      from,
      to,
      totals,
      perMinute: series,
      reasons,
      avgPerMinute: Math.round((total / windowMinutes) * 100) / 100,
      peakPerMinute: Math.max(0, ...counts),
      medianLatencyMs: median,
    };
  }

  toCsv(filter: LogFilter): string {
    const { sql, params } = where(filter);
    const rows = this.db.prepare(`SELECT * FROM entry_log ${sql} ORDER BY ts DESC, id DESC`).all(...params) as DbRow[];
    const lines = ["id,timestamp,gate_id,outcome,reason_code,flow,mode,latency_ms"];
    for (const r of rows) {
      lines.push(
        [r.id, new Date(r.ts).toISOString(), r.gate_id, r.outcome, r.reason_code, r.flow, r.mode, r.latency_ms]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  /** Deletes rows older than the retention period. Returns how many were removed. */
  purge(retentionDays: number, now: number): number {
    const cutoff = now - retentionDays * 24 * 60 * MINUTE;
    return this.db.prepare("DELETE FROM entry_log WHERE ts < ?").run(cutoff).changes;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM entry_log").get() as { n: number }).n;
  }

  /** Column names of the log table. Used by a test that guards against personal data creeping in. */
  columns(): string[] {
    return (this.db.prepare("PRAGMA table_info(entry_log)").all() as { name: string }[]).map((c) => c.name);
  }

  close(): void {
    this.db.close();
  }
}

/** The last few response shapes (key names only), for the admin debug endpoint. */
export class ShapeLog {
  private readonly items: ShapeObservation[] = [];

  constructor(private readonly capacity = 50) {}

  add(observation: ShapeObservation): void {
    this.items.unshift(observation);
    if (this.items.length > this.capacity) this.items.length = this.capacity;
  }

  list(): ShapeObservation[] {
    return [...this.items];
  }
}
