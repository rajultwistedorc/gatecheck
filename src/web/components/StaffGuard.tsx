import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, type StaffSession } from "../api";

/** Shows the passcode form when STAFF_PASSCODE is set and this browser has not signed in. */
export function StaffGuard({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.staffSession().then(
      (s) => !cancelled && setSession(s),
      () => !cancelled && setError("Could not reach the server."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (session?.authenticated) return <>{children}</>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await api.staffLogin(passcode));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return <main className="centered">{error ? <p className="form-error">{error}</p> : <div className="spinner" role="status" aria-label="Loading" />}</main>;
  }

  return (
    <main className="centered">
      <form className="notice-card" onSubmit={submit}>
        <h1>Staff sign-in</h1>
        <p>Enter the staff passcode to open the gate screens and the admin page.</p>
        <label className="field">
          <span>Passcode</span>
          <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn--primary" disabled={busy || passcode === ""}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
