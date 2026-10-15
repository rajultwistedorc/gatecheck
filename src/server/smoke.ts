// npm run smoke
//
// Calls POST {CREDENCE_BASE_URL}/v1/setup once per configured profile, with
// Origin: REGISTERED_ORIGIN, and prints only: HTTP status, profileName, customerName,
// expiresIn, or the error code. Tokens and the license key are never printed: the adapter
// method used here does not return them.
//
// Each run costs one /v1/setup call per profile (limit: 30 per minute per IP).

import type { ProfileKey } from "../shared/types";
import { LiveCloudSdkAdapter } from "./cloud/liveAdapter";
import { ConfigError, loadConfig, loadEnvFile } from "./config";

const HINTS: Record<string, string> = {
  DOMAIN_MISMATCH: "REGISTERED_ORIGIN is not the origin registered for this license.",
  INVALID_LICENSE_KEY: "The license key was not recognised.",
  LICENSE_EXPIRED_OR_REVOKED: "The license has expired or been revoked.",
  PROFILE_NOT_FOUND: "That profile id does not belong to this license.",
  PLAN_LIMIT_EXCEEDED: "The monthly verification quota is used up.",
  RATE_LIMIT_EXCEEDED: "Too many /v1/setup calls from this IP. Wait a minute.",
  INVALID_REQUEST: "The request was rejected as malformed (check REGISTERED_ORIGIN).",
  NETWORK_ERROR: "Could not reach the Cloud SDK. Check the network and CREDENCE_BASE_URL.",
  TIMEOUT: "The Cloud SDK did not answer in time.",
};

async function main(): Promise<number> {
  loadEnvFile();
  let config;
  try {
    // The smoke test is always a live call, whatever MOCK_MODE says.
    config = loadConfig({ ...process.env, MOCK_MODE: "false" });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message.replace("GateCheck cannot start.", "Smoke test cannot run."));
      return 1;
    }
    throw err;
  }
  const origin = config.credence.registeredOrigin;
  if (!origin) return 1;

  const adapter = new LiveCloudSdkAdapter({
    baseUrl: config.credence.baseUrl,
    licenseKey: config.credence.licenseKey,
    registeredOrigin: origin,
  });

  console.log(`POST ${config.credence.baseUrl}/v1/setup`);
  console.log(`Origin: ${origin}\n`);

  let failures = 0;
  for (const key of ["age-check", "id-check"] as ProfileKey[]) {
    const profileId = config.credence.profiles[key];
    const label = key.padEnd(10);
    if (!profileId) {
      console.log(`${label} not configured, skipped`);
      continue;
    }
    const probe = await adapter.probeSetup(profileId);
    const status = probe.httpStatus === null ? "no response" : `HTTP ${probe.httpStatus}`;
    if (probe.ok) {
      console.log(
        `${label} ${status}  profileName=${JSON.stringify(probe.profileName)}  customerName=${JSON.stringify(probe.customerName)}  expiresIn=${probe.expiresIn}`,
      );
    } else {
      failures += 1;
      const code = probe.errorCode ?? "UNKNOWN";
      console.log(`${label} ${status}  error=${code}${HINTS[code] ? `  (${HINTS[code]})` : ""}`);
    }
  }
  console.log(failures === 0 ? "\nSmoke test passed." : `\nSmoke test failed for ${failures} profile(s).`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Smoke test crashed: ${err instanceof Error ? err.name : "unknown error"}`);
    process.exit(1);
  },
);
