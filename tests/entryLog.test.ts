import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntryLog, ShapeLog, type NewLogEntry } from "../src/server/entryLog";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 13, 18, 30, 20);

function entry(overrides: Partial<NewLogEntry> = {}): NewLogEntry {
  return { ts: NOW, gateId: "beer-garden", outcome: "allowed", reasonCode: "ENTRY_ALLOWED", flow: "dc-mdoc", mode: "mock", latencyMs: 4000, ...overrides };
}

let log: EntryLog;

beforeEach(() => {
  log = new EntryLog(":memory:");
});

afterEach(() => {
  log.close();
});

describe("EntryLog", () => {
  it("has no column that could hold a name, birth date, portrait or document number", () => {
    expect(log.columns()).toEqual(["id", "ts", "gate_id", "outcome", "reason_code", "flow", "mode", "latency_ms"]);
  });

  it("stores and returns attempts, newest first", () => {
    log.insert(entry({ ts: NOW - 2000, reasonCode: "UNDER_AGE", outcome: "denied" }));
    log.insert(entry({ ts: NOW }));
    const result = log.query({}, 10, 0);
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.reasonCode)).toEqual(["ENTRY_ALLOWED", "UNDER_AGE"]);
    expect(result.rows[0]).toEqual({ id: 2, ts: NOW, gateId: "beer-garden", outcome: "allowed", reasonCode: "ENTRY_ALLOWED", flow: "dc-mdoc", mode: "mock", latencyMs: 4000 });
  });

  it("filters by gate, outcome, reason, mode and time, and pages", () => {
    log.insert(entry({ gateId: "vip", outcome: "denied", reasonCode: "NOT_ON_ALLOWLIST", ts: NOW - 10 * MIN }));
    log.insert(entry({ gateId: "vip", mode: "live", ts: NOW - 5 * MIN }));
    log.insert(entry({ outcome: "declined", reasonCode: "VISITOR_DECLINED", flow: null, latencyMs: null }));
    log.insert(entry());

    expect(log.query({ gateId: "vip" }, 10, 0).total).toBe(2);
    expect(log.query({ outcome: "declined" }, 10, 0).rows[0]).toMatchObject({ flow: null, latencyMs: null });
    expect(log.query({ reasonCode: "NOT_ON_ALLOWLIST" }, 10, 0).total).toBe(1);
    expect(log.query({ mode: "live" }, 10, 0).total).toBe(1);
    expect(log.query({ from: NOW - 6 * MIN, to: NOW }, 10, 0).total).toBe(1);
    expect(log.query({ gateId: "vip", outcome: "allowed" }, 10, 0).total).toBe(1);

    const page = log.query({}, 2, 2);
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 2 });
    expect(page.rows).toHaveLength(2);
  });

  it("treats filter values as data, not SQL", () => {
    log.insert(entry());
    expect(log.query({ gateId: "x' OR '1'='1" }, 10, 0).total).toBe(0);
    expect(log.count()).toBe(1);
  });

  it("purges rows older than the retention period and keeps the rest", () => {
    log.insert(entry({ ts: NOW - 31 * DAY }));
    log.insert(entry({ ts: NOW - 30 * DAY - 1 }));
    log.insert(entry({ ts: NOW - 30 * DAY + 1000 }));
    log.insert(entry({ ts: NOW }));
    expect(log.purge(30, NOW)).toBe(2);
    expect(log.count()).toBe(2);
    expect(log.purge(30, NOW)).toBe(0);
  });

  it("computes per-minute throughput with empty minutes filled in", () => {
    log.insert(entry({ ts: NOW }));
    log.insert(entry({ ts: NOW - 1000, outcome: "denied", reasonCode: "UNDER_AGE" }));
    log.insert(entry({ ts: NOW - 2 * MIN, outcome: "declined", reasonCode: "VISITOR_DECLINED" }));
    log.insert(entry({ ts: NOW - 30 * MIN })); // outside a 5 minute window

    const stats = log.stats({}, 5, NOW);
    expect(stats.perMinute).toHaveLength(5);
    expect(stats.to - stats.from).toBe(5 * MIN);
    expect(stats.perMinute.map((b) => b.allowed + b.denied + b.declined + b.error)).toEqual([0, 0, 1, 0, 2]);
    expect(stats.perMinute.at(-1)).toMatchObject({ allowed: 1, denied: 1, minute: Date.UTC(2026, 9, 13, 18, 30) });
    expect(stats.totals).toEqual({ allowed: 1, denied: 1, declined: 1, error: 0 });
    expect(stats.peakPerMinute).toBe(2);
    expect(stats.avgPerMinute).toBe(0.6);
  });

  it("breaks failures down by reason and leaves allowed entries out", () => {
    for (let i = 0; i < 3; i++) log.insert(entry({ outcome: "denied", reasonCode: "UNDER_AGE" }));
    log.insert(entry({ outcome: "declined", reasonCode: "VISITOR_DECLINED" }));
    log.insert(entry({ outcome: "error", reasonCode: "TIMEOUT" }));
    log.insert(entry());
    expect(log.stats({}, 60, NOW).reasons).toEqual([
      { reasonCode: "UNDER_AGE", outcome: "denied", count: 3 },
      { reasonCode: "TIMEOUT", outcome: "error", count: 1 },
      { reasonCode: "VISITOR_DECLINED", outcome: "declined", count: 1 },
    ]);
  });

  it("scopes stats to a gate and reports the median latency", () => {
    log.insert(entry({ gateId: "vip", latencyMs: 1000 }));
    log.insert(entry({ gateId: "vip", latencyMs: 9000 }));
    log.insert(entry({ gateId: "vip", latencyMs: 3000 }));
    log.insert(entry({ gateId: "vip", latencyMs: null }));
    log.insert(entry({ gateId: "beer-garden", latencyMs: 60_000 }));
    const stats = log.stats({ gateId: "vip" }, 60, NOW);
    expect(stats.totals.allowed).toBe(4);
    expect(stats.medianLatencyMs).toBe(3000);
    expect(log.stats({ gateId: "nowhere" }, 60, NOW).medianLatencyMs).toBeNull();
  });

  it("exports CSV with a header, ISO timestamps and CRLF line endings", () => {
    log.insert(entry({ outcome: "declined", reasonCode: "VISITOR_DECLINED", flow: null, latencyMs: null }));
    log.insert(entry({ ts: NOW + 1000, gateId: "vip", mode: "live" }));
    expect(log.toCsv({})).toBe(
      "id,timestamp,gate_id,outcome,reason_code,flow,mode,latency_ms\r\n" +
        "2,2026-10-13T18:30:21.000Z,vip,allowed,ENTRY_ALLOWED,dc-mdoc,live,4000\r\n" +
        "1,2026-10-13T18:30:20.000Z,beer-garden,declined,VISITOR_DECLINED,,mock,\r\n",
    );
    expect(log.toCsv({ gateId: "vip" }).trim().split("\r\n")).toHaveLength(2);
  });

  it("quotes CSV cells and defuses spreadsheet formulas", () => {
    log.insert(entry({ gateId: '=HYPERLINK("http://evil","x")' }));
    log.insert(entry({ gateId: "a,b" }));
    const csv = log.toCsv({});
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain('"a,b"');
  });
});

describe("ShapeLog", () => {
  it("keeps the most recent observations, newest first", () => {
    const shapes = new ShapeLog(2);
    for (const gateId of ["a", "b", "c"]) {
      shapes.add({ ts: NOW, gateId, profile: "age-check", flow: "dc-mdoc", mode: "live", verified: true, layout: "nested", identityKeys: ["age_over_21"], authenticationKeys: [] });
    }
    expect(shapes.list().map((s) => s.gateId)).toEqual(["c", "b"]);
  });
});
