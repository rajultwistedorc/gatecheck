// Small console logger. Call sites pass only non-sensitive fields; scrub() is a second
// line of defence in case a token, key or wallet payload ever reaches a log line.

type Level = "debug" | "info" | "warn" | "error";
type FieldValue = string | number | boolean | null | undefined | readonly string[];
export type LogFields = Record<string, FieldValue>;

const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,3}/g, // JWT / JWE compact
  /\brt_[A-Za-z0-9-]{8,}/g, // Cloud SDK refresh token
  /\bCS[-_][A-Za-z0-9-]{16,}/g, // Cloud SDK license key
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /response_code=[^&\s"]+/gi,
];

export function scrub(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function format(value: FieldValue): string {
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  if (typeof value === "string") return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(sink: (line: string, level: Level) => void = defaultSink): Logger {
  const write = (level: Level, message: string, fields?: LogFields) => {
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) parts.push(`${key}=${format(value)}`);
      }
    }
    sink(scrub(parts.join(" ")), level);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

function defaultSink(line: string, level: Level): void {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
