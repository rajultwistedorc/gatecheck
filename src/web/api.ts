import type {
  AbortReason,
  ApiErrorBody,
  FlowId,
  GateState,
  GateSummary,
  LogQueryResult,
  MockOptions,
  PublicConfig,
  ShapeObservation,
  StartResponse,
  StatsResult,
  VisitorSessionInfo,
  VisitorStatus,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection.");
  }
  if (!response.ok) {
    let error: Partial<ApiErrorBody> = {};
    try {
      error = (await response.json()) as Partial<ApiErrorBody>;
    } catch {
      // Not JSON: fall through to the generic message.
    }
    throw new ApiError(response.status, error.error ?? `HTTP_${response.status}`, error.message ?? "Something went wrong.");
  }
  return (await response.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface StaffSession {
  required: boolean;
  authenticated: boolean;
}

export interface LogParams {
  gate?: string;
  outcome?: string;
  reason?: string;
  mode?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export const api = {
  config: () => request<PublicConfig>("/api/config"),

  staffSession: () => request<StaffSession>("/api/staff/session"),
  staffLogin: (passcode: string) => request<StaffSession>("/api/staff/login", { passcode }),
  staffLogout: () => request<StaffSession>("/api/staff/logout", {}),

  gates: () => request<GateSummary[]>("/api/gates"),
  createSession: (gateId: string) => request<GateState>(`/api/gates/${encodeURIComponent(gateId)}/sessions`, {}),
  eventsUrl: (gateId: string) => `/api/gates/${encodeURIComponent(gateId)}/events`,

  visitorSession: (gate: string, session: string) => request<VisitorSessionInfo>(`/api/verify/session${qs({ gate, session })}`),
  visitorStatus: (gate: string, session: string) => request<VisitorStatus>(`/api/verify/status${qs({ gate, session })}`),
  start: (gate: string, session: string, flow: FlowId) => request<StartResponse>("/api/verify/start", { gate, session, flow }),
  complete: (gate: string, session: string, data: string) => request<VisitorStatus>("/api/verify/complete", { gate, session, data }),
  abort: (gate: string, session: string, reason: AbortReason) => request<VisitorStatus>("/api/verify/abort", { gate, session, reason }),
  resume: (gate: string, session: string, responseCode: string) =>
    request<VisitorStatus>("/api/verify/resume", { gate, session, responseCode }),

  mockOptions: () => request<MockOptions>("/api/mock/options"),
  mockWallet: (gate: string, session: string, data: string) => request<{ ok: true }>("/api/mock/wallet", { gate, session, data }),
  mockExpire: (gate: string, session: string) => request<{ ok: true }>("/api/mock/expire", { gate, session }),

  log: (params: LogParams) => request<LogQueryResult>(`/api/admin/log${qs({ ...params })}`),
  logCsvUrl: (params: LogParams) => `/api/admin/log.csv${qs({ ...params, limit: undefined, offset: undefined })}`,
  stats: (params: { gate?: string; mode?: string; minutes: number }) => request<StatsResult>(`/api/admin/stats${qs(params)}`),
  purge: () => request<{ removed: number; retentionDays: number }>("/api/admin/purge", {}),
  shapes: () => request<{ note: string; observations: ShapeObservation[] }>("/api/admin/debug/shapes"),
};
