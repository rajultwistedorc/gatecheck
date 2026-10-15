export function ModeBanner({ mock }: { mock: boolean }) {
  if (mock) {
    return (
      <div className="mode-banner mode-banner--mock" role="status">
        <span className="mode-banner__tag">MOCK MODE</span>
        <span className="mode-banner__text">Simulated wallet and results. Nothing on this screen is a real verification.</span>
      </div>
    );
  }
  return (
    <div className="mode-banner mode-banner--live" role="status">
      <span className="mode-banner__dot" aria-hidden="true" />
      <span className="mode-banner__tag">LIVE</span>
      <span className="mode-banner__text">Credence ID Cloud SDK</span>
    </div>
  );
}
