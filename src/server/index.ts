import type { CloudSdkAdapter } from "./cloud/adapter";
import { LiveCloudSdkAdapter } from "./cloud/liveAdapter";
import { MockCloudSdkAdapter } from "./cloud/mockAdapter";
import { createApp } from "./app";
import { ConfigError, describeLiveCredentials, loadConfig, loadEnvFile, type AppConfig } from "./config";
import { EntryLog, ShapeLog } from "./entryLog";
import { createLogger } from "./logger";
import { loadGatesFile, loadTicketsFile, resolveGates } from "./rules/gates";
import { SessionStore } from "./sessions";
import { StaffAuth } from "./staffAuth";
import { VerifyService } from "./verifyService";

const logger = createLogger();

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function buildAdapter(config: AppConfig): CloudSdkAdapter {
  if (config.mockMode) return new MockCloudSdkAdapter();
  const origin = config.credence.registeredOrigin;
  // loadConfig guarantees this in live mode; the check keeps the types honest.
  if (!origin) fail("REGISTERED_ORIGIN is required when MOCK_MODE=false.");
  return new LiveCloudSdkAdapter({
    baseUrl: config.credence.baseUrl,
    licenseKey: config.credence.licenseKey,
    registeredOrigin: origin,
  });
}

function main(): void {
  loadEnvFile();
  // `--mock` forces mock mode whatever .env says, so the UI can be run without credentials.
  if (process.argv.includes("--mock")) process.env.MOCK_MODE = "true";

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

  let gates;
  let tickets;
  try {
    gates = resolveGates(loadGatesFile(config.gatesConfigPath), config.credence.profiles, config.mockMode);
    tickets = loadTicketsFile(config.ticketsConfigPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const adapter = buildAdapter(config);
  const log = new EntryLog(config.dbPath);
  const shapes = new ShapeLog();
  const sessions = new SessionStore();
  const staffAuth = new StaffAuth(config.staffPasscode);
  const service = new VerifyService({ config, adapter, gates, tickets, sessions, log, shapes, logger });
  const app = createApp({ config, service, sessions, log, shapes, adapter, staffAuth, logger });

  const purge = (trigger: string) => {
    const removed = log.purge(config.logRetentionDays, Date.now());
    if (removed > 0) logger.info("entry log purged", { removed, retentionDays: config.logRetentionDays, trigger });
  };
  purge("startup");
  const purgeTimer = setInterval(() => purge("schedule"), config.purgeIntervalMinutes * 60_000);
  const sweepTimer = setInterval(() => service.sweep(), 1000);

  const server = app.listen(config.port, () => {
    logger.info(config.mockMode ? "GateCheck started in MOCK MODE: results are simulated" : "GateCheck started in LIVE mode", {
      port: config.port,
      origin: config.credence.registeredOrigin ?? `http://localhost:${config.port}`,
      retentionDays: config.logRetentionDays,
    });
    for (const gate of gates) {
      logger.info("gate", {
        id: gate.id,
        profile: gate.profile,
        rules: gate.rules.map((r) => (r.type === "age" ? `age${r.minAge}` : r.type)),
        status: gate.available ? (gate.notice ?? "ready") : "unavailable",
      });
    }
    if (!config.mockMode) {
      // Lengths and yes/no answers only, never a value: see describeLiveCredentials.
      logger.info("live credentials check", describeLiveCredentials(config));
    }
    if (!config.mockMode && !staffAuth.required) {
      logger.warn("STAFF_PASSCODE is not set: the staff screens and admin page are open to anyone who can reach this host");
    }
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(purgeTimer);
    clearInterval(sweepTimer);
    service.stop();
    server.close(() => {
      log.close();
      process.exit(0);
    });
    // Open SSE streams keep the server from closing on its own.
    server.closeAllConnections();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
