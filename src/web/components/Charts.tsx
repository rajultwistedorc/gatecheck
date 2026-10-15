import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { OUTCOME_LABEL, REASONS } from "../../shared/reasons";
import type { MinuteBucket, Outcome, StatsResult } from "../../shared/types";
import { formatTime } from "../hooks";
import { OutcomeDot } from "./Icons";

const OUTCOMES: Outcome[] = ["allowed", "denied", "declined", "error"];
const MINUTE = 60_000;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function total(b: MinuteBucket): number {
  return b.allowed + b.denied + b.declined + b.error;
}

/** Whole-number axis ticks: counts of people are never fractional. */
function yTicks(peak: number): number[] {
  const top = Math.max(4, peak);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => top / s <= 5) ?? 1000;
  const max = Math.ceil(top / step) * step;
  return Array.from({ length: max / step + 1 }, (_, i) => i * step);
}

/** A column with a rounded data-end and a square foot on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Attempts per minute. One series, so one colour and no legend: the card title names it.
 * Hovering (or arrow keys, when focused) shows the minute's count and its outcome split;
 * the same numbers are available without hovering in the table underneath.
 */
export function ThroughputChart({ buckets }: { buckets: MinuteBucket[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const margin = { top: 12, right: 12, bottom: 26, left: 34 };
  const height = 220;
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const n = buckets.length;
  const band = n > 0 ? plotW / n : 0;
  const barW = Math.min(24, Math.max(1, band - 2));
  const ticks = yTicks(Math.max(0, ...buckets.map(total)));
  const yMax = ticks[ticks.length - 1] ?? 4;
  const y = (v: number) => margin.top + plotH - (v / yMax) * plotH;
  const labelEvery = n <= 15 ? 5 : n <= 60 ? 10 : n <= 240 ? 30 : 120;
  const empty = buckets.every((b) => total(b) === 0);
  const hovered = hover === null ? null : (buckets[hover] ?? null);
  const hoverCenter = margin.left + (hover ?? 0) * band + band / 2;
  const tooltipLeft = hoverCenter > width / 2;

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const from = hover ?? n - 1;
    setHover(Math.max(0, Math.min(n - 1, from + (event.key === "ArrowLeft" ? -1 : 1))));
  };

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Attempts per minute. Use the left and right arrow keys to read each minute."
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? "chart__baseline" : "chart__grid"} />
              <text x={margin.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart__tick">
                {t}
              </text>
            </g>
          ))}

          {buckets.map((b, i) => {
            const value = total(b);
            const x = margin.left + i * band + (band - barW) / 2;
            const showLabel = Math.round(b.minute / MINUTE) % labelEvery === 0;
            return (
              <g key={b.minute}>
                {hover === i && <rect x={margin.left + i * band} y={margin.top} width={band} height={plotH} className="chart__cursor" />}
                {value > 0 && <path d={columnPath(x, y(value), barW, y(0) - y(value))} className={`chart__bar ${hover === i ? "is-hover" : ""}`} />}
                {showLabel && (
                  <text x={margin.left + i * band + band / 2} y={height - 8} textAnchor="middle" className="chart__tick">
                    {formatTime(b.minute, false)}
                  </text>
                )}
                {/* The hit target is the whole column slot, not just the painted bar. */}
                <rect
                  x={margin.left + i * band}
                  y={margin.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerMove={() => setHover(i)}
                />
              </g>
            );
          })}

          {empty && (
            <text x={margin.left + plotW / 2} y={margin.top + plotH / 2} textAnchor="middle" className="chart__empty">
              No attempts in this window
            </text>
          )}
        </svg>
      )}

      {hovered && hover !== null && (
        // Sits beside the hovered column, on whichever side has room, so it never covers the bar.
        <div
          className={`chart__tooltip ${tooltipLeft ? "chart__tooltip--left" : ""}`}
          style={{ left: tooltipLeft ? hoverCenter - band / 2 - 10 : hoverCenter + band / 2 + 10, top: margin.top }}
          role="status"
        >
          <span className="chart__tooltip-lead">
            <strong>{total(hovered)}</strong> {total(hovered) === 1 ? "attempt" : "attempts"}
          </span>
          <span className="chart__tooltip-time">{formatTime(hovered.minute, false)}</span>
          {OUTCOMES.filter((o) => hovered[o] > 0).map((o) => (
            <span key={o} className="chart__tooltip-row">
              <OutcomeDot outcome={o} />
              <strong>{hovered[o]}</strong> {OUTCOME_LABEL[o].toLowerCase()}
            </span>
          ))}
        </div>
      )}

      <details className="chart__table">
        <summary>Show as table</summary>
        {empty ? (
          <p>No attempts in this window.</p>
        ) : (
          <div className="table-scroll">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Minute</th>
                  <th className="num">Total</th>
                  {OUTCOMES.map((o) => (
                    <th key={o} className="num">
                      {OUTCOME_LABEL[o]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets
                  .filter((b) => total(b) > 0)
                  .map((b) => (
                    <tr key={b.minute}>
                      <td>{formatTime(b.minute, false)}</td>
                      <td className="num">{total(b)}</td>
                      {OUTCOMES.map((o) => (
                        <td key={o} className="num">
                          {b[o]}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

interface ReasonsProps {
  reasons: StatsResult["reasons"];
  selected: string;
  onSelect: (reasonCode: string) => void;
}

/**
 * Why attempts did not end in entry. Reasons are nominal categories, so every bar wears
 * the same colour and the count sits at the tip; the outcome class is a text tag, not a hue.
 * Selecting a bar filters the table below to that reason.
 */
export function ReasonsChart({ reasons, selected, onSelect }: ReasonsProps) {
  if (reasons.length === 0) return <p className="chart__none">No failed, declined or errored attempts in this window.</p>;
  const max = Math.max(...reasons.map((r) => r.count));
  return (
    <ul className="reasons">
      {reasons.map((r) => (
        <li key={`${r.reasonCode}-${r.outcome}`}>
          <button
            className={`reasons__row ${selected === r.reasonCode ? "is-selected" : ""}`}
            aria-pressed={selected === r.reasonCode}
            onClick={() => onSelect(selected === r.reasonCode ? "" : r.reasonCode)}
            title={`${REASONS[r.reasonCode]?.staff ?? r.reasonCode} Click to filter the table.`}
          >
            <span className="reasons__label">
              {REASONS[r.reasonCode]?.label ?? r.reasonCode}
              <span className="reasons__tag">
                <OutcomeDot outcome={r.outcome} />
                {OUTCOME_LABEL[r.outcome]}
              </span>
            </span>
            <span className="reasons__track">
              <span className="reasons__bar" style={{ width: `${(r.count / max) * 100}%` }} />
              <span className="reasons__value">{r.count}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {sub && <span className="stat__sub">{sub}</span>}
    </div>
  );
}
