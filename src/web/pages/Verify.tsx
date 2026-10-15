import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FLOW_LABEL, WALLET_NAME, chooseFlow, parseUserAgent, type FlowChoice } from "../../shared/platform";
import type { FlowId, MockOptions, StartResponse, VisitorResult, VisitorSessionInfo } from "../../shared/types";
import { classifyWalletError, extractWalletData } from "../../shared/walletData";
import { useConfig } from "../App";
import { ApiError, api } from "../api";
import { MockWallet } from "../components/MockWallet";
import { VisitorMessage, VisitorResultView, VisitorShell } from "../components/Visitor";
import { formatCountdown, useNow } from "../hooks";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FLOWS: FlowId[] = ["dc-mdoc", "dc-openid4vp", "annex-b"];
const SIMULATED_DEVICE: Record<FlowId, string> = {
  "dc-mdoc": "iPhone · Safari",
  "dc-openid4vp": "Android · Chrome",
  "annex-b": "Samsung",
};

type Busy = null | "preparing" | "wallet" | "verifying" | "waiting";

/** Works out which flow this browser can run. The model hint tells Samsung phones apart on Chrome. */
async function detect(): Promise<FlowChoice> {
  let model: string | undefined;
  try {
    const hints = await Promise.race([
      navigator.userAgentData?.getHighEntropyValues(["model"]),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 400)),
    ]);
    model = hints?.model;
  } catch {
    // Client hints are optional; the user agent string alone still works.
  }
  return chooseFlow(parseUserAgent(navigator.userAgent, { model }), {
    credentialsGet: typeof navigator.credentials?.get === "function",
    digitalCredential: "DigitalCredential" in window,
  });
}

export function Verify() {
  const config = useConfig();
  const [params] = useSearchParams();
  const gate = params.get("gate") ?? "";
  const session = params.get("session") ?? "";

  const [info, setInfo] = useState<VisitorSessionInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [choice, setChoice] = useState<FlowChoice | null>(null);
  const [flow, setFlow] = useState<FlowId | null>(null);
  const [start, setStart] = useState<StartResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<VisitorResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mockOptions, setMockOptions] = useState<MockOptions | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [copied, setCopied] = useState(false);
  const startSeq = useRef(0);
  const preparedFlow = useRef<FlowId | null>(null);
  const gestureRetries = useRef(0);
  const now = useNow(1000, clockOffset);

  /** Asks the server where the attempt stands. Used after anything goes wrong. */
  const refresh = useCallback(
    async (fallback?: string) => {
      try {
        const status = await api.visitorStatus(gate, session);
        if (status.result) setResult(status.result);
        else if (fallback) setNote(fallback);
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) setGone(e.message);
        else if (fallback) setNote(fallback);
      }
    },
    [gate, session],
  );

  // 1. Open the attempt and work out which wallet flow this browser can run.
  useEffect(() => {
    if (!ID_RE.test(gate) || !ID_RE.test(session)) {
      setGone("This link is incomplete. Please scan the code at the gate again.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const opened = await api.visitorSession(gate, session);
        if (cancelled) return;
        setInfo(opened);
        setClockOffset(opened.serverTime - Date.now());
        if (opened.result) {
          setResult(opened.result);
          return;
        }
        const detected = await detect();
        if (cancelled) return;
        setChoice(detected);
        if (config.mockMode) {
          // In mock mode any device can play any platform; start from the detected one.
          setFlow(detected.supported ? detected.flow : "dc-mdoc");
          setMockOptions(await api.mockOptions());
        } else if (detected.supported) {
          setFlow(detected.flow);
        }
      } catch (e) {
        if (!cancelled) setGone(e instanceof ApiError ? e.message : "Something went wrong. Please scan the code again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, session, config.mockMode]);

  /** Creates the wallet request for a flow. Guarded by a sequence number so a stale reply is ignored. */
  const prepare = useCallback(
    async (target: FlowId): Promise<StartResponse | null> => {
      const seq = ++startSeq.current;
      setStart(null);
      setNote(null);
      setBusy("preparing");
      try {
        const started = await api.start(gate, session, target);
        if (seq !== startSeq.current) return null;
        setStart(started);
        setBusy(null);
        return started;
      } catch (e) {
        if (seq !== startSeq.current) return null;
        setBusy(null);
        // The server normally ends the attempt with a mapped error; show that.
        await refresh(e instanceof ApiError ? e.message : "Could not start. Please try again.");
        return null;
      }
    },
    [gate, session, refresh],
  );

  // 2. Live mode: fetch the request as soon as the flow is known, *before* the visitor taps.
  //    navigator.credentials.get() must run inside the tap's own task (iOS Safari enforces
  //    this), so the tap handler cannot wait for a network round-trip first. This is the
  //    sample app's prefetch pattern, moved from pointerdown to page load.
  useEffect(() => {
    if (config.mockMode || !flow || result || gone || preparedFlow.current === flow) return;
    preparedFlow.current = flow;
    void prepare(flow);
  }, [config.mockMode, flow, result, gone, prepare]);

  // 3. Follow the attempt. This is how a Flow C result, a timeout, or a staff reset reaches the phone.
  useEffect(() => {
    if (!info || result || gone) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, 2000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [info, result, gone, refresh]);

  const walletFailed = async (err: unknown) => {
    const kind = classifyWalletError(err);
    if (kind === "retry" && gestureRetries.current < 1) {
      // The request was never used, so the same one can be presented again.
      gestureRetries.current += 1;
      setBusy(null);
      setNote("Your phone did not register that tap. Please tap the button again.");
      return;
    }
    setBusy("verifying");
    try {
      const status = await api.abort(gate, session, kind === "cancelled" ? "cancelled" : "unavailable");
      setResult(status.result);
    } catch {
      await refresh("Could not reach the server. Check your connection.");
    }
    setBusy(null);
  };

  const submit = async (data: string) => {
    setBusy("verifying");
    try {
      const status = await api.complete(gate, session, data);
      setResult(status.result);
    } catch (e) {
      await refresh(e instanceof ApiError ? e.message : "Could not send the result. Please tap the button to try again.");
    }
    setBusy(null);
  };

  /** Flows A and B, live. */
  const openWallet = () => {
    if (!start || start.flow === "annex-b") return;
    const request = start.request;
    setNote(null);
    let pending: Promise<Credential | null>;
    try {
      // No await may come before this call. See effect 2.
      pending = navigator.credentials.get({ digital: { requests: [request] }, mediation: "required" });
    } catch (err) {
      void walletFailed(err);
      return;
    }
    setBusy("wallet");
    pending.then(
      (credential) => {
        const data = extractWalletData(request.protocol, (credential as DigitalCredential | null)?.data);
        if (data === null) void walletFailed(new Error("The wallet returned no data."));
        else void submit(data);
      },
      (err: unknown) => void walletFailed(err),
    );
  };

  /** Mock mode: nothing is prefetched, so switching simulated device costs no request. */
  const openMockWallet = async () => {
    if (!flow) return;
    if (await prepare(flow)) setSheetOpen(true);
  };

  const mockChoose = async (data: string) => {
    setSheetOpen(false);
    if (start?.flow === "annex-b") {
      // Flow C: the wallet answers the Cloud SDK, and the server's polling picks it up.
      setBusy("waiting");
      try {
        await api.mockWallet(gate, session, data);
      } catch (e) {
        setBusy(null);
        await refresh(e instanceof ApiError ? e.message : "Could not reach the server.");
      }
    } else {
      await submit(data);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setNote("Could not copy. Press and hold the address bar to copy the link.");
    }
  };

  // ---- Render ------------------------------------------------------------------

  if (gone) {
    return (
      <VisitorShell>
        <VisitorMessage title="This code is no longer valid">
          <p>{gone}</p>
        </VisitorMessage>
      </VisitorShell>
    );
  }
  if (!info) {
    return (
      <VisitorShell>
        <div className="visitor__loading">
          <div className="spinner" role="status" aria-label="Loading" />
        </div>
      </VisitorShell>
    );
  }
  if (result) {
    return (
      <VisitorShell gateName={info.gate.name}>
        <VisitorResultView result={result} mock={config.mockMode} />
      </VisitorShell>
    );
  }

  const wallet = flow ? WALLET_NAME[flow] : "your wallet";
  const working = busy === "wallet" || busy === "verifying" || busy === "waiting";
  const alternatives = config.mockMode ? [] : (choice?.alternatives ?? []).filter((alt) => alt !== flow);
  const unsupported = !config.mockMode && !flow && choice && !choice.supported ? choice : null;

  return (
    <VisitorShell gateName={info.gate.name}>
      {unsupported ? (
        <VisitorMessage title={unsupported.title}>
          <p>{unsupported.message}</p>
          <button className="btn btn--block" onClick={() => void copyLink()}>
            {copied ? "Link copied" : "Copy this link"}
          </button>
        </VisitorMessage>
      ) : (
        <div className="visitor__step">
          <h1>Verify at {info.gate.name}</h1>
          <p>
            Your wallet will show exactly what this gate is asking for. Nothing is shared until you approve it there.
          </p>

          {config.mockMode && (
            <fieldset className="mock-box">
              <legend>Mock controls</legend>
              <span className="mock-box__label">Simulate device</span>
              <div className="segmented">
                {FLOWS.map((f) => (
                  <label key={f} className={flow === f ? "is-selected" : ""}>
                    <input type="radio" name="device" checked={flow === f} disabled={working} onChange={() => setFlow(f)} />
                    {SIMULATED_DEVICE[f]}
                  </label>
                ))}
              </div>
              {flow && <p className="mock-box__flow">{FLOW_LABEL[flow]}</p>}
            </fieldset>
          )}

          {busy === "waiting" ? (
            <div className="visitor__waiting" role="status">
              <div className="spinner" aria-hidden="true" />
              <p>Waiting for {wallet}…</p>
            </div>
          ) : config.mockMode ? (
            <button className="btn btn--primary btn--block btn--xl" disabled={!flow || busy !== null} onClick={() => void openMockWallet()}>
              {busy === "preparing" ? "Preparing…" : busy === "verifying" ? "Checking…" : `Continue with ${wallet}`}
            </button>
          ) : start?.flow === "annex-b" ? (
            // A real link, opened by the visitor's own tap: browsers block scripted navigation to app schemes.
            <a className="btn btn--primary btn--block btn--xl" href={start.walletUri} onClick={() => setBusy("waiting")}>
              Open {wallet}
            </a>
          ) : (
            // If preparing failed without ending the attempt (a network blip), the same button retries it.
            <button
              className="btn btn--primary btn--block btn--xl"
              disabled={busy !== null || !flow}
              onClick={start ? openWallet : () => flow && void prepare(flow)}
            >
              {busy === "wallet"
                ? `Waiting for ${wallet}…`
                : busy === "verifying"
                  ? "Checking…"
                  : busy === "preparing"
                    ? "Preparing…"
                    : start
                      ? `Continue with ${wallet}`
                      : "Try again"}
            </button>
          )}

          {busy === "waiting" && !config.mockMode && start?.flow === "annex-b" && (
            <a className="link" href={start.walletUri}>
              Open {wallet} again
            </a>
          )}

          {note && (
            <p className="visitor__note" role="alert">
              {note}
            </p>
          )}

          <p className="visitor__expiry">This code expires in {formatCountdown(info.expiresAt - now)}</p>
        </div>
      )}

      {alternatives.length > 0 && !working && (
        <div className="visitor__alternatives">
          {alternatives.map((alt) => (
            <button key={alt} className="link" onClick={() => setFlow(alt)}>
              Use {WALLET_NAME[alt]} instead
            </button>
          ))}
        </div>
      )}

      {sheetOpen && mockOptions && flow && (
        <MockWallet
          options={mockOptions}
          walletName={WALLET_NAME[flow]}
          defaultShape={info.gate.profile === "age-check" ? "age-only" : "full"}
          onChoose={(data) => void mockChoose(data)}
          onDismiss={() => {
            setSheetOpen(false);
            void walletFailed(new DOMException("Dismissed", "NotAllowedError"));
          }}
          onTimeout={() => {
            setSheetOpen(false);
            setBusy("waiting");
            void api.mockExpire(gate, session).then(() => refresh());
          }}
        />
      )}
    </VisitorShell>
  );
}
