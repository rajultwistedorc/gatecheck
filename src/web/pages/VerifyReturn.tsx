import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { VisitorResult } from "../../shared/types";
import { useConfig } from "../App";
import { ApiError, api } from "../api";
import { VisitorMessage, VisitorResultView, VisitorShell } from "../components/Visitor";

/**
 * Flow C, same device. After consent, Samsung Wallet sends the browser to
 * /verify/return/<gate>/<session>?response_code=<code>. The code is exchanged once, on the
 * server. If the exchange is still pending, or the code was already used, the page falls
 * back to following the attempt, which the server is polling anyway.
 */
export function VerifyReturn() {
  const config = useConfig();
  const { gateId = "", sessionId = "" } = useParams();
  const [result, setResult] = useState<VisitorResult | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    const fail = (e: unknown) => {
      if (e instanceof ApiError && e.status === 410) setGone(e.message);
    };
    const follow = () => api.visitorStatus(gateId, sessionId).then((s) => s.result && setResult(s.result), fail);

    if (!exchanged.current) {
      exchanged.current = true;
      const code = new URLSearchParams(window.location.search).get("response_code");
      // The code is a credential: take it out of the address bar and history straight away.
      window.history.replaceState(null, "", window.location.pathname);
      if (code) void api.resume(gateId, sessionId, code).then((s) => s.result && setResult(s.result), fail);
      else void follow();
    }

    const timer = setInterval(() => void follow(), 2000);
    return () => clearInterval(timer);
  }, [gateId, sessionId]);

  return (
    <VisitorShell>
      {result ? (
        <VisitorResultView result={result} mock={config.mockMode} />
      ) : gone ? (
        <VisitorMessage title="This code is no longer valid">
          <p>{gone}</p>
        </VisitorMessage>
      ) : (
        <div className="visitor__waiting" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>Finishing verification…</p>
        </div>
      )}
    </VisitorShell>
  );
}
