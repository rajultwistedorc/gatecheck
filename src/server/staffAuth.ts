import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Secret } from "./config";

const COOKIE = "gc_staff";
const SESSION_MS = 12 * 60 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Optional shared-passcode gate for the staff screens and admin API. When STAFF_PASSCODE
 * is empty, everything is open (fine on a laptop, not on a public host).
 */
export class StaffAuth {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly passcode: Secret,
    private readonly now: () => number = Date.now,
  ) {}

  get required(): boolean {
    return this.passcode.isSet;
  }

  /** Returns a session token for a correct passcode, otherwise null. */
  login(candidate: string): string | null {
    if (!this.required) return null;
    // Hash both sides so the comparison is constant-time whatever their lengths.
    if (!timingSafeEqual(digest(candidate), digest(this.passcode.reveal()))) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, this.now() + SESSION_MS);
    return token;
  }

  isAuthenticated(req: Request): boolean {
    if (!this.required) return true;
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt < this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  setCookie(req: Request, res: Response, token: string): void {
    const secure = req.secure ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`,
    );
  }

  logout(req: Request, res: Response): void {
    const token = readCookie(req, COOKIE);
    if (token) this.sessions.delete(token);
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  readonly requireStaff = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isAuthenticated(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "STAFF_AUTH_REQUIRED", message: "Enter the staff passcode to continue." });
  };
}
