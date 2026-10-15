import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { GateState, GateSummary } from "../../shared/types";
import { useConfig } from "../App";
import { ApiError, api } from "../api";
import { Logo } from "../components/Icons";
import { ResultScreen } from "../components/ResultScreen";
import { formatCountdown, formatTime, useNow } from "../hooks";

/** Timeouts carry no decision to read, so they clear faster than a real result. */
const TIMEOUT_DISPLAY_SECONDS = 6;

export function Gate() {
  const { gateId = "" } = useParams();
  const config = useConfig();
  const [state, setState] = useState<GateState | null>(null);
  const [connected, setConnected] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [heldSession, setHeldSession] = useState<string | null>(null);
  const requesting = useRef(false);
  const now = useNow(250, clockOffset);

  // Live updates: the server pushes the gate's whole state whenever the attempt changes.
  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    api.gates().then(
      (gates: GateSummary[]) => {
        if (cancelled) return;
        if (!gates.some((g) => g.id === gateId)) {
          setMissing(true);
          return;
        }
        source = new EventSource(api.eventsUrl(gateId));
        source.onmessage = (event) => {
          const next = JSON.parse(event.data as string) as GateState;
          setState(next);
          setClockOffset(next.serverTime - Date.now());
          setConnected(true);
        };
        // EventSource reconnects by itself; this only drives the indicator.
        source.onerror = () => setConnected(false);
      },
      (e: unknown) => !cancelled && setProblem(e instanceof ApiError ? e.message : "Could not load this gate."),
    );
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [gateId]);

  const newSession = useCallback(async () => {
    if (requesting.current) return;
    requesting.current = true;
    try {
      // Apply the reply directly rather than waiting for the push, so this cannot fire twice.
      setState(await api.createSession(gateId));
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Could not create a new code.");
    } finally {
      requesting.current = false;
    }
  }, [gateId]);

  const session = state?.session ?? null;
  const available = state?.gate.available ?? false;
  const finished = session !== null && (session.status === "complete" || session.status === "timeout") && session.decision !== null;
  const held = session !== null && heldSession === session.id;
  const displaySeconds = session?.status === "timeout" ? TIMEOUT_DISPLAY_SECONDS : config.resultDisplaySeconds;
  const advanceAt = finished && session.decision ? session.decision.decidedAt + displaySeconds * 1000 : null;

  // A fresh code whenever there is none, the last one ran out unscanned, or a result has been shown long enough.
  useEffect(() => {
    if (!state || !available || !connected) return;
    if (!session || session.status === "expired") void newSession();
    else if (advanceAt !== null && !held && now >= advanceAt) void newSession();
  }, [state, available, connected, session, advanceAt, held, now, newSession]);

  if (missing) {
    return (
      <main className="centered">
        <div className="notice-card">
          <h1>Unknown gate</h1>
          <p>
            There is no gate called “{gateId}”. <Link to="/">See all gates</Link>
          </p>
        </div>
      </main>
    );
  }

  const gate = state?.gate;
  // Mock mode on this computer: a QR that said "localhost" would point a phone at itself,
  // so it encodes this machine's network address instead.
  const onLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const lanOrigin =
    config.mockMode && onLocalhost && config.lanAddress
      ? `${window.location.protocol}//${config.lanAddress}${window.location.port ? `:${window.location.port}` : ""}`
      : null;
  const origin = config.publicOrigin ?? lanOrigin ?? window.location.origin;
  const verifyUrl = session ? origin + session.verifyPath : "";
  const wrongOrigin = config.publicOrigin !== null && config.publicOrigin !== window.location.origin;

  return (
    <div className="gate">
      <header className="gate__header">
        <Link to="/" className="gate__home" aria-label="All gates">
          <Logo />
        </Link>
        <div className="gate__title">
          <h1>{gate?.name ?? "Loading…"}</h1>
          <div className="chips">
            {gate?.rules.map((r) => (
              <span className="chip" key={r.label}>
                {r.label}
              </span>
            ))}
            {gate?.notice && <span className="chip chip--notice">{gate.notice}</span>}
          </div>
        </div>
        <div className="gate__status">
          <span className={`conn ${connected ? "conn--on" : "conn--off"}`}>
            <span className="conn__dot" aria-hidden="true" />
            {connected ? "Connected" : "Reconnecting…"}
          </span>
          <time className="gate__clock">{formatTime(now)}</time>
        </div>
      </header>

      {wrongOrigin && (
        <p className="gate__warning">
          This screen is open on {window.location.origin}, but the origin registered with Credence is {config.publicOrigin}. The QR code points to the
          registered origin; open the gate screen there too.
        </p>
      )}
      {problem && <p className="gate__warning">{problem}</p>}

      <main className="gate__main">
        {!state ? (
          <div className="gate__pending">
            <div className="spinner spinner--lg" role="status" aria-label="Loading" />
          </div>
        ) : !available ? (
          <div className="gate__pending">
            <h2>Gate unavailable</h2>
            <p>{gate?.unavailableReason}</p>
          </div>
        ) : finished && session.decision ? (
          <ResultScreen
            decision={session.decision}
            status={session.status}
            secondsLeft={advanceAt === null ? 0 : Math.ceil((advanceAt - now) / 1000)}
            held={held}
            onHold={() => setHeldSession(held ? null : session.id)}
            onNext={() => void newSession()}
          />
        ) : session && session.status === "waiting" ? (
          <div className="gate__scan">
            <div className="qr-card">
              <QRCodeSVG value={verifyUrl} size={360} level="M" marginSize={2} className="qr-card__code" title="QR code for this attempt" />
              <div className="qr-card__timer">
                <div
                  className="qr-card__bar"
                  style={{ width: `${Math.max(0, Math.min(100, ((session.expiresAt - now) / (session.expiresAt - session.createdAt)) * 100))}%` }}
                />
              </div>
              <p className="qr-card__caption">New code in {formatCountdown(session.expiresAt - now)}</p>
            </div>
            <div className="gate__instructions">
              <h2>Scan to verify</h2>
              <ol>
                <li>Open your phone’s camera and point it at the code.</li>
                <li>Tap the link, then approve the request in your wallet.</li>
                <li>Wait for this screen to turn green.</li>
              </ol>
              <p className="gate__wallets">Apple Wallet · Google Wallet · Samsung Wallet</p>
              {config.mockMode && (
                <a className="btn btn--mock" href={session.verifyPath} target="_blank" rel="noreferrer">
                  Mock mode: open the visitor page ↗
                </a>
              )}
              {config.mockMode && (
                <p className="gate__phone-hint">
                  {onLocalhost && !lanOrigin
                    ? "This code points to localhost, which a phone cannot reach. Connect this computer to a network and reload."
                    : `To scan with a phone, put it on the same Wi-Fi as this computer. The code opens ${origin}`}
                </p>
              )}
            </div>
          </div>
        ) : session ? (
          <div className="gate__pending" aria-live="polite">
            <div className="spinner spinner--lg" aria-hidden="true" />
            <h2>{session.status === "scanned" ? "Visitor connected" : "Waiting for the wallet"}</h2>
            <p>{session.status === "scanned" ? "Their phone is preparing the request." : "The visitor is approving the request on their phone."}</p>
            <p className="gate__countdown">Times out in {formatCountdown(session.expiresAt - now)}</p>
            <button className="btn" onClick={() => void newSession()}>
              Cancel and show a new code
            </button>
          </div>
        ) : (
          <div className="gate__pending">
            <div className="spinner spinner--lg" role="status" aria-label="Preparing a code" />
          </div>
        )}
      </main>
    </div>
  );
}
