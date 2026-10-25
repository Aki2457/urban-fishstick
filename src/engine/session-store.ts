import type { FlowSession, SessionStore } from "./types.js";

/**
 * In-memory session store with a time-to-live. Fine for a single process and for tests.
 * Use a shared store (Redis, a database) when running more than one server instance.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, FlowSession>();

  constructor(private readonly ttlMs = 15 * 60 * 1000, private readonly now: () => number = Date.now) {}

  async get(id: string): Promise<FlowSession | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.now() - session.updatedAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    // Hand out a copy so callers cannot mutate stored state without calling set().
    return structuredClone(session);
  }

  async set(session: FlowSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  /** Drops expired sessions. Call on an interval in long-running processes. */
  sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.sessions.delete(id);
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
