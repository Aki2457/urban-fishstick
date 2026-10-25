import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredPasskey, UserRecord } from "./login.js";
import { InMemoryUserDirectory } from "./users.js";

interface StoredUser extends Omit<UserRecord, "passkeys"> {
  passkeys?: (Omit<StoredPasskey, "publicKey"> & { publicKey: string })[];
}

/**
 * User directory saved to a JSON file, so accounts and passkeys survive a restart.
 * Lockout counters stay in memory on purpose: a restart clears them.
 * Fine for a single server. Use a database for anything larger.
 */
export class FileUserDirectory extends InMemoryUserDirectory {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const { passkeys, ...rest } of JSON.parse(raw) as StoredUser[]) {
      const user: UserRecord = { ...rest };
      if (passkeys) user.passkeys = passkeys.map((p) => ({ ...p, publicKey: new Uint8Array(Buffer.from(p.publicKey, "base64url")) }));
      super.add(user);
    }
  }

  override add(user: UserRecord): this {
    super.add(user);
    void this.save();
    return this;
  }

  override async createUser(email: string, passwordHash: string): Promise<UserRecord | undefined> {
    const user = await super.createUser(email, passwordHash);
    if (user) await this.save();
    return user;
  }

  override async addPasskey(userId: string, passkey: StoredPasskey): Promise<void> {
    await super.addPasskey(userId, passkey);
    await this.save();
  }

  override async updatePasskeyCounter(userId: string, credentialId: string, counter: number): Promise<void> {
    await super.updatePasskeyCounter(userId, credentialId, counter);
    await this.save();
  }

  /** Writes are queued so they never overlap, and go through a temp file so a crash cannot leave half a file. */
  save(): Promise<void> {
    const snapshot: StoredUser[] = this.all().map(({ passkeys, ...rest }) => {
      const stored: StoredUser = { ...rest };
      if (passkeys) stored.passkeys = passkeys.map((p) => ({ ...p, publicKey: Buffer.from(p.publicKey).toString("base64url") }));
      return stored;
    });
    const text = JSON.stringify(snapshot, null, 2);
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, text, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      });
    return this.writing;
  }
}
