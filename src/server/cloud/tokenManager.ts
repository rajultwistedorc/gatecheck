import { CloudSdkError, badResponse } from "./errors";

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds (900 today). */
  expiresIn: number;
  customerName?: string;
  profileName?: string;
}

export interface TokenApi {
  /** POST /v1/setup for this manager's profile. */
  setup(): Promise<TokenResponse>;
  /** POST /v1/refresh. Consumes the token it is given. */
  refresh(refreshToken: string): Promise<TokenResponse>;
}

export interface TokenStatus {
  cached: boolean;
  accessExpiresInSec: number | null;
  customerName: string | null;
  profileName: string | null;
}

/** Refresh when the access token has less than this left: covers clock skew and in-flight requests. */
export const ACCESS_MARGIN_MS = 60_000;
/** Refresh tokens live 7 days, and the window slides forward on every refresh. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_SEC = 30;

interface Session {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  customerName: string | null;
  profileName: string | null;
}

export function parseTokenResponse(body: unknown): TokenResponse {
  const b = body as Record<string, unknown> | null;
  if (
    typeof b !== "object" ||
    b === null ||
    typeof b.accessToken !== "string" ||
    b.accessToken === "" ||
    typeof b.refreshToken !== "string" ||
    b.refreshToken === "" ||
    typeof b.expiresIn !== "number" ||
    !(b.expiresIn > 0)
  ) {
    throw badResponse("Token response was missing accessToken, refreshToken or expiresIn.");
  }
  return {
    accessToken: b.accessToken,
    refreshToken: b.refreshToken,
    expiresIn: b.expiresIn,
    customerName: typeof b.customerName === "string" ? b.customerName : undefined,
    profileName: typeof b.profileName === "string" ? b.profileName : undefined,
  };
}

/**
 * Server-side token cache for one reader profile.
 *
 * - reuses the access token while it has more than 60s left
 * - otherwise refreshes, storing the rotated refresh token
 * - falls back to /v1/setup when there is no session or the refresh token is dead
 * - runs at most one renewal at a time: refresh tokens are single-use, so two concurrent
 *   refreshes would invalidate each other
 * - after a 429, fails fast until Retry-After has passed instead of hammering the API
 */
export class TokenManager {
  private session: Session | null = null;
  private inflight: Promise<string> | null = null;
  private blocked: { until: number; error: CloudSdkError } | null = null;

  constructor(
    private readonly api: TokenApi,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    const s = this.session;
    if (s && s.accessExpiresAt - this.now() > ACCESS_MARGIN_MS) return s.accessToken;
    this.inflight ??= this.renew().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Call when the API rejects an access token we believed was valid. The next call refreshes. */
  invalidate(accessToken?: string): void {
    if (this.session && (accessToken === undefined || this.session.accessToken === accessToken)) {
      this.session.accessExpiresAt = 0;
    }
  }

  status(): TokenStatus {
    const s = this.session;
    if (!s) return { cached: false, accessExpiresInSec: null, customerName: null, profileName: null };
    return {
      cached: true,
      accessExpiresInSec: Math.max(0, Math.floor((s.accessExpiresAt - this.now()) / 1000)),
      customerName: s.customerName,
      profileName: s.profileName,
    };
  }

  private async renew(): Promise<string> {
    const now = this.now();
    if (this.blocked) {
      if (now < this.blocked.until) {
        const { error, until } = this.blocked;
        const blocked = new CloudSdkError(error.kind, error.httpStatus, error.code, error.message, Math.ceil((until - now) / 1000));
        blocked.endpoint = error.endpoint;
        throw blocked;
      }
      this.blocked = null;
    }

    const s = this.session;
    if (s && s.refreshExpiresAt - now > ACCESS_MARGIN_MS) {
      try {
        return this.store(await this.api.refresh(s.refreshToken), s);
      } catch (err) {
        this.noteLimit(err);
        // A 401 means the refresh token is gone (expired, or rotated by a call whose
        // response we never received). /v1/setup is the only way forward.
        if (!(err instanceof CloudSdkError) || err.httpStatus !== 401) throw err;
        this.session = null;
      }
    }

    try {
      return this.store(await this.api.setup(), null);
    } catch (err) {
      this.noteLimit(err);
      throw err;
    }
  }

  private store(tokens: TokenResponse, previous: Session | null): string {
    const now = this.now();
    this.session = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: now + tokens.expiresIn * 1000,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      // /v1/refresh does not return these, so carry them over from /v1/setup.
      customerName: tokens.customerName ?? previous?.customerName ?? null,
      profileName: tokens.profileName ?? previous?.profileName ?? null,
    };
    return tokens.accessToken;
  }

  private noteLimit(err: unknown): void {
    if (err instanceof CloudSdkError && (err.kind === "rate_limit" || err.kind === "quota")) {
      const seconds = err.retryAfterSec ?? DEFAULT_COOLDOWN_SEC;
      this.blocked = { until: this.now() + seconds * 1000, error: err };
    }
  }
}
