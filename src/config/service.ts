import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig, ConfigProblem, RawConfig } from "./schema.js";
import { EMAIL_KEYS, FIELD_KEYS, FIELDS, parseBool, parseConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string, public readonly problems: ConfigProblem[]) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Merges variable sources into one map with lower-case names, so app_name and APP_NAME are the same setting.
 * Later sources win: pass the .env file first and the real environment last.
 */
export function mergeEnv(...sources: Record<string, string | undefined>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

/** Looks a setting up by name, ignoring case. */
export function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const lower = key.toLowerCase();
  if (env[lower] !== undefined) return env[lower];
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower && v !== undefined) return v;
  return undefined;
}

export interface FieldView {
  key: string;
  kind: string;
  group: string;
  label: string;
  help: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  required: boolean;
  when: { key: string; in: (string | boolean)[] }[];
  secret: boolean;
  /** The raw text value. Never sent for secrets. */
  value?: string;
  /** For secrets: whether a value is stored. */
  isSet?: boolean;
  default?: string;
}

/**
 * Holds the current app settings.
 *
 * app_config=false (default): settings are read from environment variables once at startup and are read-only.
 * app_config=true: environment variables are ignored. Settings live in a JSON file and are edited in the Settings Bar.
 */
export class ConfigService {
  readonly editable: boolean;
  private raw: RawConfig = {};
  private parsed!: { config: AppConfig; problems: ConfigProblem[] };
  private listeners: (() => void)[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: { env: Record<string, string | undefined>; file: string; defaultAppUrl: string }) {
    const flag = readEnv(opts.env, "app_config");
    const parsedFlag = flag === undefined ? false : parseBool(flag);
    if (parsedFlag === undefined) throw new ConfigError("app_config must be true or false.", [{ key: "app_config", level: "error", message: "app_config must be true or false." }]);
    this.editable = parsedFlag;
  }

  get source(): "env" | "settings" {
    return this.editable ? "settings" : "env";
  }

  async load(): Promise<void> {
    if (this.editable) {
      try {
        const stored = JSON.parse(await readFile(this.opts.file, "utf8")) as { values?: Record<string, unknown> };
        this.raw = toRaw(stored.values ?? {});
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        this.raw = {};
      }
    } else {
      this.raw = {};
      for (const f of FIELDS) {
        const value = readEnv(this.opts.env, f.key);
        if (value !== undefined) this.raw[f.key] = value;
      }
    }
    this.parsed = parseConfig(this.raw, { appUrl: this.opts.defaultAppUrl });
  }

  get config(): AppConfig {
    return this.parsed.config;
  }

  get problems(): ConfigProblem[] {
    return this.parsed.problems;
  }

  get errors(): ConfigProblem[] {
    return this.parsed.problems.filter((p) => p.level === "error");
  }

  /** Email can be sent: it is on and none of its settings have errors. */
  get emailReady(): boolean {
    return this.config.enable_email && !this.errors.some((p) => p.key && EMAIL_KEYS.has(p.key));
  }

  /** Testing mode check for sign-in and for existing sessions. */
  isAllowed(email: string): boolean {
    const c = this.config;
    if (!c.enable_app_testing) return true;
    const e = email.trim().toLowerCase();
    return c.app_testing_allowlist.some((entry) => (entry.startsWith("@") ? e.endsWith(entry) : e === entry));
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Everything the Settings Bar needs. Secret values are replaced by isSet. */
  describe(): { editable: boolean; source: "env" | "settings"; fields: FieldView[]; problems: ConfigProblem[] } {
    const fields = FIELDS.map((f): FieldView => {
      const value = this.raw[f.key];
      return {
        key: f.key,
        kind: f.kind,
        group: f.group,
        label: f.label,
        help: f.help,
        ...(f.options && { options: f.options }),
        ...(f.min !== undefined && { min: f.min }),
        ...(f.max !== undefined && { max: f.max }),
        ...(f.default !== undefined && { default: f.default }),
        required: f.required === true,
        when: (f.when ?? []).map((c) => ({ key: c.key, in: c.in })),
        secret: f.secret === true,
        ...(f.secret ? { isSet: !!value } : { value: value ?? "" }),
      };
    });
    return { editable: this.editable, source: this.source, fields, problems: this.problems };
  }

  /**
   * Saves new values from the Settings Bar. Only allowed when app_config is on.
   * Secrets: undefined or "" keeps the stored value, null removes it.
   * Rejects the whole update (nothing saved) if any setting has an error.
   */
  async update(input: Record<string, unknown>): Promise<ConfigProblem[]> {
    if (!this.editable) throw new ConfigError("Settings come from environment variables. Set app_config=true to edit them here.", []);
    const next: RawConfig = { ...this.raw };
    for (const [key, value] of Object.entries(input)) {
      if (!FIELD_KEYS.has(key)) continue;
      const spec = FIELDS.find((f) => f.key === key)!;
      if (spec.secret) {
        if (value === null) delete next[key];
        else if (typeof value === "string" && value !== "") next[key] = value;
        continue;
      }
      if (value === null || value === undefined) delete next[key];
      else if (Array.isArray(value)) next[key] = value.map(String).join("\n");
      else next[key] = String(value);
    }
    const parsed = parseConfig(next, { appUrl: this.opts.defaultAppUrl });
    if (parsed.problems.some((p) => p.level === "error")) throw new ConfigError("Some settings need fixing.", parsed.problems);

    // Values for settings that no longer apply are kept, so switching email off and on loses nothing.
    this.raw = next;
    this.parsed = parsed;
    await this.save();
    for (const fn of this.listeners) fn();
    return this.parsed.problems;
  }

  private save(): Promise<void> {
    const text = JSON.stringify({ values: this.raw, updatedAt: Date.now() }, null, 2);
    const file = this.opts.file;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        // Holds SMTP passwords and API keys: owner-only permissions.
        await writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return this.writing;
  }
}

function toRaw(values: Record<string, unknown>): RawConfig {
  const raw: RawConfig = {};
  for (const [k, v] of Object.entries(values)) if (FIELD_KEYS.has(k) && v !== null && v !== undefined) raw[k] = String(v);
  return raw;
}
