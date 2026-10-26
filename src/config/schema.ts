/**
 * App settings: what each one is, where it shows in the Settings Bar, when it applies, and how it is checked.
 *
 * Every value arrives as text (from an environment variable or the settings file) and is parsed here.
 * The same rules run for both sources, so a value that is valid in one is valid in the other.
 */

export const EMAIL_TYPES = ["smtp", "api", "api-smtp", "smtp-api", "console"] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];
export const API_PROVIDERS = ["generic", "resend", "sendgrid", "postmark"] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export interface AppConfig {
  app_name: string;
  /** Public origin, e.g. https://auth.example.com. No path. */
  app_url: string;
  app_seed_demo_users: boolean;
  enable_app_testing: boolean;
  /** Lowercased emails, or "@domain" entries that allow a whole domain. */
  app_testing_allowlist: string[];
  enable_email: boolean;
  email_type: EmailType | null;
  email_from: string;
  email_from_name: string;
  /** Hostname only. The URL scheme is checked, then dropped. */
  email_smtp_server: string;
  email_smtp_useauth: boolean;
  email_smtp_tlsorssl: "tls" | "ssl" | null;
  email_smtp_port: number | null;
  email_smtp_username: string;
  email_smtp_password: string;
  email_api_provider: ApiProvider;
  email_api_url: string;
  email_api_key: string;
}

export type FieldKind = "bool" | "string" | "url" | "email" | "password" | "int" | "enum" | "email-list";

/** A field applies only when every condition holds. Used for both validation and showing or hiding it. */
export interface Condition {
  key: keyof AppConfig;
  in: (string | boolean)[];
}

export interface FieldSpec {
  key: keyof AppConfig;
  kind: FieldKind;
  group: "App" | "Testing mode" | "Email" | "SMTP server" | "Email API";
  label: string;
  help: string;
  /** Text form of the default, as it would be written in an environment variable. */
  default?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  secret?: boolean;
  when?: Condition[];
  /** Required whenever the field applies. */
  required?: boolean;
}

const SMTP_TYPES = ["smtp", "api-smtp", "smtp-api"];
const API_TYPES = ["api", "api-smtp", "smtp-api"];
const EMAIL_ON: Condition = { key: "enable_email", in: [true] };
const SMTP_ON: Condition[] = [EMAIL_ON, { key: "email_type", in: SMTP_TYPES }];
const API_ON: Condition[] = [EMAIL_ON, { key: "email_type", in: API_TYPES }];

export const FIELDS: FieldSpec[] = [
  { key: "app_name", kind: "string", group: "App", label: "App name", help: "Shown in emails, on passkey prompts and in the builder.", default: "Auth Flow", required: true },
  {
    key: "app_url",
    kind: "url",
    group: "App",
    label: "App URL",
    help: "The public address people use, e.g. https://auth.example.com. Passkeys, cookies and site links depend on it.",
  },
  {
    key: "app_seed_demo_users",
    kind: "bool",
    group: "App",
    label: "Create demo accounts",
    help: "On first start with no accounts, create ada@example.com and grace@example.com with known passwords. Turn off on a public server.",
    default: "true",
  },
  {
    key: "enable_app_testing",
    kind: "bool",
    group: "Testing mode",
    label: "Testing mode",
    help: "Only people on the testers list can sign in or sign up. Everyone else is turned away, and their existing sessions stop working.",
    default: "false",
  },
  {
    key: "app_testing_allowlist",
    kind: "email-list",
    group: "Testing mode",
    label: "Testers",
    help: "One email per line (or comma separated). Use @example.com to allow a whole domain.",
    when: [{ key: "enable_app_testing", in: [true] }],
    required: true,
  },
  {
    key: "enable_email",
    kind: "bool",
    group: "Email",
    label: "Enable email",
    help: "When off, the Verification Email node is hidden and none of the email settings are needed.",
    default: "false",
  },
  {
    key: "email_type",
    kind: "enum",
    group: "Email",
    label: "How to send email",
    help: "smtp, api, api-smtp (API first, SMTP if it fails), smtp-api (SMTP first, API if it fails), or console (prints to the server log, development only).",
    options: EMAIL_TYPES,
    when: [EMAIL_ON],
    required: true,
  },
  { key: "email_from", kind: "email", group: "Email", label: "From address", help: "The sender address, e.g. no-reply@example.com. Defaults to the SMTP username when that is an email.", when: [EMAIL_ON], required: true },
  { key: "email_from_name", kind: "string", group: "Email", label: "From name", help: "The sender name. Defaults to the app name.", when: [EMAIL_ON] },
  {
    key: "email_smtp_server",
    kind: "url",
    group: "SMTP server",
    label: "SMTP server",
    help: "Server address with its scheme, e.g. https://smtp.gmail.com. smtp:// and smtps:// also work. Not case sensitive. Only the host name is used.",
    when: SMTP_ON,
    required: true,
  },
  { key: "email_smtp_useauth", kind: "bool", group: "SMTP server", label: "Use authentication", help: "Sign in to the SMTP server with a username and password.", default: "true", when: SMTP_ON },
  {
    key: "email_smtp_tlsorssl",
    kind: "enum",
    group: "SMTP server",
    label: "TLS or SSL",
    help: "tls: connect, then upgrade with STARTTLS (usually port 587). ssl: encrypted from the first byte (usually port 465). Unencrypted SMTP is not allowed.",
    options: ["tls", "ssl"],
    when: SMTP_ON,
    required: true,
  },
  { key: "email_smtp_port", kind: "int", group: "SMTP server", label: "Port", help: "Usually 587 for tls and 465 for ssl.", min: 1, max: 65535, when: SMTP_ON, required: true },
  {
    key: "email_smtp_username",
    kind: "string",
    group: "SMTP server",
    label: "Username",
    help: "Usually your email address, e.g. example@gmail.com.",
    when: [...SMTP_ON, { key: "email_smtp_useauth", in: [true] }],
    required: true,
  },
  {
    key: "email_smtp_password",
    kind: "password",
    group: "SMTP server",
    label: "Password",
    help: "For Gmail, use an app password, not your account password.",
    secret: true,
    when: [...SMTP_ON, { key: "email_smtp_useauth", in: [true] }],
    required: true,
  },
  {
    key: "email_api_provider",
    kind: "enum",
    group: "Email API",
    label: "API format",
    help: "generic: POST JSON {from, to, subject, text, html} with a Bearer key. Or the format of Resend, SendGrid or Postmark.",
    options: API_PROVIDERS,
    default: "generic",
    when: API_ON,
  },
  {
    key: "email_api_url",
    kind: "url",
    group: "Email API",
    label: "API base URL",
    help: "Required for generic, where it is the full endpoint. Optional for the others, which default to their official address.",
    when: API_ON,
  },
  { key: "email_api_key", kind: "password", group: "Email API", label: "API key", help: "Sent as a Bearer token (Postmark: as its server token header).", secret: true, when: API_ON, required: true },
];

export const FIELD_KEYS = new Set(FIELDS.map((f) => f.key as string));

export interface ConfigProblem {
  key?: string;
  level: "error" | "warning";
  message: string;
}

export type RawConfig = Record<string, string | undefined>;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function parseBool(text: string): boolean | undefined {
  const t = text.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(t)) return true;
  if (["false", "0", "no", "off", ""].includes(t)) return false;
  return undefined;
}

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** Checks one condition list against values parsed so far. */
export function applies(spec: FieldSpec, values: Partial<Record<keyof AppConfig, unknown>>): boolean {
  return (spec.when ?? []).every((c) => c.in.includes(values[c.key] as string | boolean));
}

/**
 * Parses raw text values into a typed config and reports problems.
 * Fields that do not apply (e.g. SMTP settings while email is off) are not checked and not required.
 */
export function parseConfig(raw: RawConfig, defaults: { appUrl: string }): { config: AppConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const v: Partial<Record<keyof AppConfig, unknown>> = {};
  const err = (key: string, message: string) => problems.push({ key, level: "error", message });
  const warn = (key: string, message: string) => problems.push({ key, level: "warning", message });

  // Fields are listed in dependency order, so conditions only look at fields parsed before them.
  for (const spec of FIELDS) {
    const active = applies(spec, v);
    const given = raw[spec.key];
    const text = given === undefined || given.trim() === "" ? spec.default : given;
    const missing = text === undefined || text.trim() === "";

    if (!active) {
      v[spec.key] = emptyValue(spec, text);
      continue;
    }
    if (missing) {
      if (spec.required) err(spec.key, `${spec.label} is required.`);
      v[spec.key] = emptyValue(spec, undefined);
      continue;
    }

    switch (spec.kind) {
      case "bool": {
        const b = parseBool(text);
        if (b === undefined) err(spec.key, `${spec.label} must be true or false.`);
        v[spec.key] = b ?? false;
        break;
      }
      case "int": {
        const n = Number(text.trim());
        if (!Number.isInteger(n) || n < (spec.min ?? -Infinity) || n > (spec.max ?? Infinity)) {
          err(spec.key, `${spec.label} must be a whole number from ${spec.min} to ${spec.max}.`);
          v[spec.key] = null;
        } else v[spec.key] = n;
        break;
      }
      case "enum": {
        const t = text.trim().toLowerCase();
        if (!spec.options!.includes(t)) {
          err(spec.key, `${spec.label} must be one of: ${spec.options!.join(", ")}.`);
          v[spec.key] = null;
        } else v[spec.key] = t;
        break;
      }
      case "email": {
        const t = text.trim().toLowerCase();
        if (!EMAIL_RE.test(t)) err(spec.key, `${spec.label} must be an email address.`);
        v[spec.key] = t;
        break;
      }
      case "email-list": {
        const items = text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = items.filter((s) => !(EMAIL_RE.test(s) || /^@[^\s@]+\.[^\s@]+$/.test(s)));
        if (bad.length) err(spec.key, `Not an email or @domain: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}`);
        if (items.length === 0 && spec.required) err(spec.key, `${spec.label} is required.`);
        v[spec.key] = [...new Set(items)];
        break;
      }
      case "url":
        v[spec.key] = clean(text);
        break;
      default:
        v[spec.key] = spec.kind === "password" ? text : clean(text).slice(0, 200);
    }
  }

  // ---- checks that need more than one field ----

  // app_url
  const appUrlText = (v.app_url as string) || defaults.appUrl;
  let appUrl = defaults.appUrl;
  try {
    const u = new URL(appUrlText);
    if (u.protocol !== "https:" && u.protocol !== "http:") err("app_url", "App URL must start with https:// (or http:// for localhost).");
    else if (u.pathname !== "/" || u.search || u.hash) err("app_url", "App URL must be just the address, with no path, e.g. https://auth.example.com.");
    else {
      appUrl = u.origin;
      if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) {
        warn("app_url", "Use https:// on a public server. Over http, passkeys do not work and session cookies are not marked Secure.");
      }
    }
  } catch {
    err("app_url", "App URL is not a valid URL.");
  }

  if (v.app_seed_demo_users && !isLocalUrl(appUrl)) {
    warn("app_seed_demo_users", "Demo accounts have publicly known passwords. Turn this off on a public server.");
  }

  const smtp = applies(FIELDS.find((f) => f.key === "email_smtp_server")!, v);
  const api = applies(FIELDS.find((f) => f.key === "email_api_key")!, v);

  // email_smtp_server: scheme required, host kept, no path or port in the URL.
  let smtpHost = "";
  if (smtp && v.email_smtp_server) {
    const text = v.email_smtp_server as string;
    if (!/^(https|smtps?):\/\//i.test(text)) {
      err("email_smtp_server", "SMTP server must include its scheme, e.g. https://smtp.gmail.com.");
    } else {
      try {
        const u = new URL(text.replace(/^(https|smtps?):\/\//i, "https://"));
        if (u.port) err("email_smtp_server", "Put the port in the Port setting, not in the server address.");
        else if (u.pathname !== "/" || u.search || u.username) err("email_smtp_server", "SMTP server must be just the host, e.g. https://smtp.gmail.com.");
        else smtpHost = u.hostname.toLowerCase();
      } catch {
        err("email_smtp_server", "SMTP server is not a valid address.");
      }
    }
  }

  if (smtp && v.email_smtp_tlsorssl && v.email_smtp_port) {
    if (v.email_smtp_tlsorssl === "ssl" && [25, 587].includes(v.email_smtp_port as number)) {
      warn("email_smtp_port", `Port ${v.email_smtp_port} normally uses tls (STARTTLS). With ssl the connection will likely fail.`);
    }
    if (v.email_smtp_tlsorssl === "tls" && v.email_smtp_port === 465) {
      warn("email_smtp_port", "Port 465 normally uses ssl. With tls the connection will likely fail.");
    }
  }

  // Some providers use non-email usernames (SendGrid uses "apikey", Amazon SES uses access keys), so this is a warning.
  if (smtp && v.email_smtp_useauth && v.email_smtp_username && !EMAIL_RE.test(v.email_smtp_username as string)) {
    warn("email_smtp_username", "Username is not an email address. That is fine if your provider uses something else (SendGrid uses \"apikey\").");
  }

  // email_from falls back to the SMTP username when that is an email.
  if (v.enable_email && !v.email_from) {
    const fallback = String(v.email_smtp_username ?? "").toLowerCase();
    if (smtp && EMAIL_RE.test(fallback)) {
      v.email_from = fallback;
      const i = problems.findIndex((p) => p.key === "email_from");
      if (i >= 0) problems.splice(i, 1);
    }
  }

  let apiUrl = "";
  if (api) {
    const provider = (v.email_api_provider as ApiProvider) ?? "generic";
    const text = v.email_api_url as string;
    if (!text) {
      if (provider === "generic") err("email_api_url", "API base URL is required for the generic format.");
    } else {
      try {
        const u = new URL(text);
        if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
          err("email_api_url", "API base URL must use https:// (http:// only for localhost).");
        } else apiUrl = u.href.replace(/\/$/, "");
      } catch {
        err("email_api_url", "API base URL is not a valid URL.");
      }
    }
  }

  if (v.enable_email && v.email_type === "console") {
    (isLocalUrl(appUrl) ? warn : err)(
      "email_type",
      isLocalUrl(appUrl)
        ? "console prints codes to the server log instead of emailing them. Development only."
        : "console prints codes to the server log. It is not allowed when the App URL is a public address.",
    );
  }

  const config: AppConfig = {
    app_name: (v.app_name as string) || "Auth Flow",
    app_url: appUrl,
    app_seed_demo_users: v.app_seed_demo_users === true,
    enable_app_testing: v.enable_app_testing === true,
    app_testing_allowlist: (v.app_testing_allowlist as string[]) ?? [],
    enable_email: v.enable_email === true,
    email_type: (v.email_type as EmailType | null) ?? null,
    email_from: (v.email_from as string) ?? "",
    email_from_name: (v.email_from_name as string) || (v.app_name as string) || "Auth Flow",
    email_smtp_server: smtpHost,
    email_smtp_useauth: v.email_smtp_useauth !== false,
    email_smtp_tlsorssl: (v.email_smtp_tlsorssl as "tls" | "ssl" | null) ?? null,
    email_smtp_port: (v.email_smtp_port as number | null) ?? null,
    email_smtp_username: (v.email_smtp_username as string) ?? "",
    email_smtp_password: (v.email_smtp_password as string) ?? "",
    email_api_provider: (v.email_api_provider as ApiProvider) ?? "generic",
    email_api_url: apiUrl,
    email_api_key: (v.email_api_key as string) ?? "",
  };
  return { config, problems };
}

function emptyValue(spec: FieldSpec, text: string | undefined): unknown {
  if (spec.kind === "bool") return text !== undefined ? parseBool(text) ?? false : false;
  if (spec.kind === "email-list") return [];
  if (spec.kind === "int" || spec.kind === "enum") return text !== undefined && spec.kind === "enum" ? text.trim().toLowerCase() : null;
  return "";
}

/** Keys of email settings. Any error here means email cannot be sent. */
export const EMAIL_KEYS = new Set(FIELDS.filter((f) => f.group === "Email" || f.group === "SMTP server" || f.group === "Email API").map((f) => f.key as string));
