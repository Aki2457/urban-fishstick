import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { UserDirectory, UserRecord } from "./login.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

/** Hashes a password with scrypt. Output format: scrypt$<salt hex>$<hash hex>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Simple in-memory user directory for the demo and tests. Swap for your database. */
export class InMemoryUserDirectory implements UserDirectory {
  private readonly byId = new Map<string, UserRecord>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  add(user: UserRecord): this {
    this.byId.set(user.id, user);
    return this;
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const needle = email.toLowerCase();
    for (const user of this.byId.values()) if (user.email.toLowerCase() === needle) return user;
    return undefined;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.byId.get(id);
  }

  async isLocked(userId: string): Promise<boolean> {
    const entry = this.failures.get(userId);
    return !!entry && entry.lockedUntil > this.now();
  }

  async recordFailure(userId: string): Promise<{ locked: boolean }> {
    const entry = this.failures.get(userId) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = this.now() + this.lockMs;
      entry.count = 0;
    }
    this.failures.set(userId, entry);
    return { locked: entry.lockedUntil > this.now() };
  }

  async recordSuccess(userId: string): Promise<void> {
    this.failures.delete(userId);
  }
}
