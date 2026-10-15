import { describe, expect, it } from "vitest";
import { CloudSdkError } from "../src/server/cloud/errors";
import { REFRESH_TOKEN_TTL_MS, TokenManager, parseTokenResponse, type TokenResponse } from "../src/server/cloud/tokenManager";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A fake /v1/setup + /v1/refresh that rotates refresh tokens the way the real API does. */
function harness() {
  let time = 1_700_000_000_000;
  let counter = 0;
  const calls: string[] = [];
  let failRefresh: CloudSdkError | null = null;
  let failSetup: CloudSdkError | null = null;
  const validRefreshTokens = new Set<string>();

  const issue = (extra: Partial<TokenResponse> = {}): TokenResponse => {
    counter += 1;
    const refreshToken = `rt_${counter}`;
    validRefreshTokens.add(refreshToken);
    return { accessToken: `access-${counter}`, refreshToken, expiresIn: 900, ...extra };
  };

  const manager = new TokenManager(
    {
      setup: async () => {
        calls.push("setup");
        if (failSetup) throw failSetup;
        return issue({ customerName: "Acme Venues", profileName: "Age Check" });
      },
      refresh: async (refreshToken) => {
        calls.push(`refresh:${refreshToken}`);
        if (failRefresh) throw failRefresh;
        if (!validRefreshTokens.delete(refreshToken)) {
          throw new CloudSdkError("auth", 401, "REFRESH_TOKEN_EXPIRED", "expired");
        }
        return issue();
      },
    },
    () => time,
  );

  return {
    manager,
    calls,
    advance: (ms: number) => {
      time += ms;
    },
    failRefreshWith: (err: CloudSdkError | null) => {
      failRefresh = err;
    },
    failSetupWith: (err: CloudSdkError | null) => {
      failSetup = err;
    },
    revokeAllRefreshTokens: () => validRefreshTokens.clear(),
  };
}

describe("TokenManager", () => {
  it("calls /v1/setup once and then reuses the cached access token", async () => {
    const h = harness();
    expect(await h.manager.getAccessToken()).toBe("access-1");
    h.advance(5 * MIN);
    expect(await h.manager.getAccessToken()).toBe("access-1");
    h.advance(8 * MIN);
    expect(await h.manager.getAccessToken()).toBe("access-1");
    expect(h.calls).toEqual(["setup"]);
  });

  it("reuses the token with just over 60s left and refreshes at 60s", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.advance(15 * MIN - 61_000);
    expect(await h.manager.getAccessToken()).toBe("access-1");
    h.advance(1_000);
    expect(await h.manager.getAccessToken()).toBe("access-2");
    expect(h.calls).toEqual(["setup", "refresh:rt_1"]);
  });

  it("stores the rotated refresh token and uses it for the next refresh", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.advance(15 * MIN);
    await h.manager.getAccessToken();
    h.advance(15 * MIN);
    expect(await h.manager.getAccessToken()).toBe("access-3");
    // rt_1 was consumed by the first refresh; reusing it would have been rejected.
    expect(h.calls).toEqual(["setup", "refresh:rt_1", "refresh:rt_2"]);
  });

  it("falls back to /v1/setup when the refresh token is rejected", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.revokeAllRefreshTokens();
    h.advance(15 * MIN);
    expect(await h.manager.getAccessToken()).toBe("access-2");
    expect(h.calls).toEqual(["setup", "refresh:rt_1", "setup"]);
  });

  it("goes straight to /v1/setup once the refresh token is older than 7 days", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.advance(REFRESH_TOKEN_TTL_MS + MIN);
    expect(await h.manager.getAccessToken()).toBe("access-2");
    expect(h.calls).toEqual(["setup", "setup"]);
  });

  it("treats the 7-day window as sliding: each refresh extends it", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.advance(6 * DAY);
    await h.manager.getAccessToken();
    h.advance(6 * DAY); // 12 days after setup, 6 days after the last refresh
    await h.manager.getAccessToken();
    expect(h.calls).toEqual(["setup", "refresh:rt_1", "refresh:rt_2"]);
  });

  it("runs one renewal for concurrent callers", async () => {
    const h = harness();
    const first = await Promise.all([h.manager.getAccessToken(), h.manager.getAccessToken(), h.manager.getAccessToken()]);
    expect(first).toEqual(["access-1", "access-1", "access-1"]);
    h.advance(15 * MIN);
    const second = await Promise.all([h.manager.getAccessToken(), h.manager.getAccessToken()]);
    expect(second).toEqual(["access-2", "access-2"]);
    expect(h.calls).toEqual(["setup", "refresh:rt_1"]);
  });

  it("does not fall back to /v1/setup for errors that setup cannot fix", async () => {
    const h = harness();
    await h.manager.getAccessToken();
    h.failRefreshWith(new CloudSdkError("domain", 403, "DOMAIN_MISMATCH", "wrong origin"));
    h.advance(15 * MIN);
    await expect(h.manager.getAccessToken()).rejects.toMatchObject({ code: "DOMAIN_MISMATCH" });
    expect(h.calls).toEqual(["setup", "refresh:rt_1"]);
  });

  it("stops calling the API after a 429 until Retry-After has passed", async () => {
    const h = harness();
    h.failSetupWith(new CloudSdkError("rate_limit", 429, "RATE_LIMIT_EXCEEDED", "slow down", 20));
    await expect(h.manager.getAccessToken()).rejects.toMatchObject({ kind: "rate_limit", retryAfterSec: 20 });
    h.advance(5_000);
    await expect(h.manager.getAccessToken()).rejects.toMatchObject({ kind: "rate_limit", retryAfterSec: 15 });
    expect(h.calls).toEqual(["setup"]);

    h.failSetupWith(null);
    h.advance(15_000);
    expect(await h.manager.getAccessToken()).toBe("access-1");
    expect(h.calls).toEqual(["setup", "setup"]);
  });

  it("backs off on an exhausted monthly quota too", async () => {
    const h = harness();
    h.failSetupWith(new CloudSdkError("quota", 429, "PLAN_LIMIT_EXCEEDED", "quota"));
    await expect(h.manager.getAccessToken()).rejects.toMatchObject({ kind: "quota" });
    await expect(h.manager.getAccessToken()).rejects.toMatchObject({ kind: "quota" });
    expect(h.calls).toEqual(["setup"]);
  });

  it("refreshes after invalidate(), for a token the API rejected early", async () => {
    const h = harness();
    const token = await h.manager.getAccessToken();
    h.manager.invalidate("some-other-token");
    expect(await h.manager.getAccessToken()).toBe("access-1");
    h.manager.invalidate(token);
    expect(await h.manager.getAccessToken()).toBe("access-2");
    expect(h.calls).toEqual(["setup", "refresh:rt_1"]);
  });

  it("reports status without exposing tokens, and keeps the profile name across refreshes", async () => {
    const h = harness();
    expect(h.manager.status()).toEqual({ cached: false, accessExpiresInSec: null, customerName: null, profileName: null });
    await h.manager.getAccessToken();
    h.advance(15 * MIN);
    await h.manager.getAccessToken(); // /v1/refresh does not return customerName / profileName
    h.advance(MIN);
    const status = h.manager.status();
    expect(status).toEqual({ cached: true, accessExpiresInSec: 840, customerName: "Acme Venues", profileName: "Age Check" });
    expect(JSON.stringify(status)).not.toMatch(/access-|rt_/);
  });
});

describe("parseTokenResponse", () => {
  it("accepts the documented shape", () => {
    expect(
      parseTokenResponse({ accessToken: "a", refreshToken: "rt_x", expiresIn: 900, tokenType: "Bearer", customerName: "", profileName: "P" }),
    ).toEqual({ accessToken: "a", refreshToken: "rt_x", expiresIn: 900, customerName: "", profileName: "P" });
  });

  it.each([null, {}, { accessToken: "a" }, { accessToken: "a", refreshToken: "r", expiresIn: "900" }, { accessToken: "", refreshToken: "r", expiresIn: 900 }])(
    "rejects %j",
    (body) => {
      expect(() => parseTokenResponse(body)).toThrowError(CloudSdkError);
    },
  );
});
