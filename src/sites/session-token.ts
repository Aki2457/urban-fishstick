import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SiteSession {
  /** user id */
  u: string;
  /** site slug the session is valid for */
  s: string;
  /** expiry, ms since epoch */
  exp: number;
}

/**
 * Signed, stateless session tokens for published sites: base64url(payload).base64url(HMAC-SHA256).
 * They survive restarts. Signing out clears the cookie; a copied token stays valid until it expires.
 */
export class SessionSigner {
  constructor(private readonly secret: Buffer) {
    if (secret.length < 32) throw new Error("Session secret must be at least 32 bytes.");
  }

  /** Loads the secret from `file`, creating it with owner-only permissions on first run. */
  static async fromFile(file: string): Promise<SessionSigner> {
    try {
      return new SessionSigner(Buffer.from((await readFile(file, "utf8")).trim(), "base64url"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const secret = randomBytes(32);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, secret.toString("base64url"), { mode: 0o600, flag: "wx" });
    return new SessionSigner(secret);
  }

  sign(session: SiteSession): string {
    const body = Buffer.from(JSON.stringify(session)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string | undefined, slug: string, now = Date.now()): SiteSession | undefined {
    if (!token) return undefined;
    const [body, mac] = token.split(".");
    if (!body || !mac) return undefined;
    const expected = Buffer.from(this.mac(body), "base64url");
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const session = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SiteSession;
      if (typeof session.u !== "string" || session.s !== slug || typeof session.exp !== "number" || session.exp <= now) return undefined;
      return session;
    } catch {
      return undefined;
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
