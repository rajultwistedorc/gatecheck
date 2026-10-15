import { createContext, useContext, useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import type { PublicConfig } from "../shared/types";
import { ApiError, api } from "./api";
import { ModeBanner } from "./components/ModeBanner";
import { StaffGuard } from "./components/StaffGuard";
import { Admin } from "./pages/Admin";
import { Gate } from "./pages/Gate";
import { Home } from "./pages/Home";
import { Verify } from "./pages/Verify";
import { VerifyReturn } from "./pages/VerifyReturn";

const ConfigContext = createContext<PublicConfig | null>(null);

export function useConfig(): PublicConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig used outside the app shell");
  return config;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.config().then(
        (c) => !cancelled && setConfig(c),
        (e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : "Could not load GateCheck."),
      );
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) {
    return (
      <main className="centered">
        {error ? (
          <div className="notice-card">
            <h1>GateCheck is not reachable</h1>
            <p>{error}</p>
            <button className="btn" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="spinner" role="status" aria-label="Loading" />
        )}
      </main>
    );
  }

  return (
    <ConfigContext.Provider value={config}>
      {/* Always on screen, on every page, so a mock result can never pass for a real one. */}
      <ModeBanner mock={config.mockMode} />
      <Routes>
        <Route path="/verify" element={<Verify />} />
        <Route path="/verify/return/:gateId/:sessionId" element={<VerifyReturn />} />
        <Route
          path="/"
          element={
            <StaffGuard>
              <Home />
            </StaffGuard>
          }
        />
        <Route
          path="/gate/:gateId"
          element={
            <StaffGuard>
              <Gate />
            </StaffGuard>
          }
        />
        <Route
          path="/admin"
          element={
            <StaffGuard>
              <Admin />
            </StaffGuard>
          }
        />
        <Route
          path="*"
          element={
            <main className="centered">
              <div className="notice-card">
                <h1>Page not found</h1>
                <p>
                  <Link to="/">Back to GateCheck</Link>
                </p>
              </div>
            </main>
          }
        />
      </Routes>
    </ConfigContext.Provider>
  );
}
