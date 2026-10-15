import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Decision, FlowId, SessionStatus } from "../shared/types";

/**
 * One attempt at one gate. Lives in memory only: it holds the Cloud SDK session id (which
 * the browser never sees) and, briefly, the decision shown on the staff screen.
 */
export interface GateSession {
  id: string;
  gateId: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  /** When the visitor opened /verify. Latency is measured from here. */
  scannedAt: number | null;
  flow: FlowId | null;
  cloud: { flow: FlowId; sessionId: string } | null;
  /** How many Cloud SDK requests this attempt has created. Capped to protect the quota. */
  starts: number;
  /** True while a wallet response is being verified. Such a session is never timed out. */
  completing: boolean;
  decision: Decision | null;
  completedAt: number | null;
  pollTimer: NodeJS.Timeout | null;
}

export function isTerminal(status: SessionStatus): boolean {
  return status === "complete" || status === "timeout" || status === "expired";
}

function sameId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Holds the current session of each gate and notifies that gate's staff screens on change. */
export class SessionStore {
  private readonly byGate = new Map<string, GateSession>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Replaces the gate's session with a fresh one. Returns the one it replaced, if any. */
  create(gateId: string, now: number, ttlMs: number): { session: GateSession; replaced: GateSession | null } {
    const replaced = this.byGate.get(gateId) ?? null;
    const session: GateSession = {
      id: randomBytes(18).toString("base64url"),
      gateId,
      status: "waiting",
      createdAt: now,
      expiresAt: now + ttlMs,
      scannedAt: null,
      flow: null,
      cloud: null,
      starts: 0,
      completing: false,
      decision: null,
      completedAt: null,
      pollTimer: null,
    };
    this.byGate.set(gateId, session);
    return { session, replaced };
  }

  current(gateId: string): GateSession | null {
    return this.byGate.get(gateId) ?? null;
  }

  /** The gate's current session, but only if the caller knows its id. */
  find(gateId: string, sessionId: string): GateSession | null {
    const session = this.byGate.get(gateId);
    return session && sameId(session.id, sessionId) ? session : null;
  }

  remove(gateId: string): void {
    this.byGate.delete(gateId);
  }

  all(): GateSession[] {
    return [...this.byGate.values()];
  }

  subscribe(gateId: string, listener: () => void): () => void {
    let set = this.listeners.get(gateId);
    if (!set) {
      set = new Set();
      this.listeners.set(gateId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  publish(gateId: string): void {
    for (const listener of this.listeners.get(gateId) ?? []) listener();
  }

  subscriberCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}
