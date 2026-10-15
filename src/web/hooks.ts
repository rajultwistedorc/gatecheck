import { useEffect, useState } from "react";

/** Re-renders on an interval and returns the current time, shifted onto the server's clock. */
export function useNow(intervalMs: number, offsetMs = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now + offsetMs;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatTime(ts: number, withSeconds = true): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: withSeconds ? "2-digit" : undefined, hour12: false });
}
