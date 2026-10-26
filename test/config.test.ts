import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config/schema.js";
import type { RawConfig } from "../src/config/schema.js";
import { ConfigError, ConfigService, mergeEnv } from "../src/config/service.js";
import { Mailer, codeEmail } from "../src/email/mailer.js";
import type { SmtpLike } from "../src/email/mailer.js";
import { compileDoc, FlowEngine, hashPassword, InMemoryUserDirectory, newStarter, newStep, verifyPassword } from "../src/index.js";
import type { BuilderDoc, ScreenView } from "../src/index.js";

const DEF = { appUrl: "http://localhost:3000" };
const parse = (raw: RawConfig) => parseConfig(raw, DEF);
const errorKeys = (raw: RawConfig) => parse(raw).problems.filter((p) => p.level === "error").map((p) => p.key);
const warnKeys = (raw: RawConfig) => parse(raw).problems.filter((p) => p.level === "warning").map((p) => p.key);

const SMTP: RawConfig = {
  enable_email: "true",
  email_type: "smtp",
  email_smtp_server: "https://smtp.gmail.com",
  email_smtp_tlsorssl: "tls",
  email_smtp_port: "587",
  email_smtp_username: "example@gmail.com",
  email_smtp_password: "app-password",
};

/* ---------- parsing and validation ---------- */

test("defaults are valid and email is off", () => {
  const { config, problems } = parse({});
  assert.deepEqual(problems.filter((p) => p.level === "error"), []);
  assert.equal(config.app_name, "Auth Flow");
  assert.equal(config.app_url, "http://localhost:3000");
  assert.equal(config.enable_email, false);
  assert.equal(config.enable_app_testing, false);
});

test("email settings are only required once email is on", () => {
  assert.deepEqual(errorKeys({ email_smtp_port: "not a number" }), [], "ignored while email is off");
  assert.deepEqual(errorKeys({ enable_email: "true" }).sort(), ["email_from", "email_type"]);
});

test("a full SMTP setup parses, and the From address falls back to the username", () => {
  const { config, problems } = parse({ ...SMTP, email_smtp_server: "HTTPS://SMTP.Gmail.COM", email_smtp_tlsorssl: "TLS" });
  assert.deepEqual(problems, []);
  assert.equal(config.email_smtp_server, "smtp.gmail.com");
  assert.equal(config.email_smtp_tlsorssl, "tls");
  assert.equal(config.email_smtp_port, 587);
  assert.equal(config.email_from, "example@gmail.com");
});

test("SMTP server needs its scheme and nothing but a host", () => {
  assert.ok(errorKeys({ ...SMTP, email_smtp_server: "smtp.gmail.com" }).includes("email_smtp_server"));
  assert.ok(errorKeys({ ...SMTP, email_smtp_server: "https://smtp.gmail.com:587" }).includes("email_smtp_server"));
  assert.ok(errorKeys({ ...SMTP, email_smtp_server: "https://smtp.gmail.com/path" }).includes("email_smtp_server"));
  assert.deepEqual(errorKeys({ ...SMTP, email_smtp_server: "smtps://mail.example.com" }), []);
});

test("SMTP field checks: port range, tls or ssl, mismatched port warnings", () => {
  assert.ok(errorKeys({ ...SMTP, email_smtp_port: "70000" }).includes("email_smtp_port"));
  assert.ok(errorKeys({ ...SMTP, email_smtp_tlsorssl: "starttls" }).includes("email_smtp_tlsorssl"));
  assert.ok(warnKeys({ ...SMTP, email_smtp_tlsorssl: "ssl", email_smtp_port: "587" }).includes("email_smtp_port"));
  assert.ok(warnKeys({ ...SMTP, email_smtp_tlsorssl: "tls", email_smtp_port: "465" }).includes("email_smtp_port"));
});

test("username and password are required only with authentication", () => {
  const noAuth = { ...SMTP, email_smtp_useauth: "false", email_smtp_username: "", email_smtp_password: "", email_from: "no-reply@example.com" };
  assert.deepEqual(errorKeys(noAuth), []);
  assert.deepEqual(errorKeys({ ...SMTP, email_smtp_password: "" }), ["email_smtp_password"]);
  // Non-email usernames exist (SendGrid uses "apikey"), so that is a warning.
  const apikey = { ...SMTP, email_smtp_username: "apikey", email_from: "no-reply@example.com" };
  assert.deepEqual(errorKeys(apikey), []);
  assert.ok(warnKeys(apikey).includes("email_smtp_username"));
});

test("API settings: generic needs a URL, named providers have defaults, https only", () => {
  const api: RawConfig = { enable_email: "true", email_type: "api", email_from: "no-reply@example.com", email_api_key: "k" };
  assert.deepEqual(errorKeys(api), ["email_api_url"]);
  assert.deepEqual(errorKeys({ ...api, email_api_provider: "resend" }), []);
  assert.ok(errorKeys({ ...api, email_api_url: "http://mail.example.com" }).includes("email_api_url"));
  assert.deepEqual(errorKeys({ ...api, email_api_url: "http://localhost:9000/send" }), []);
  assert.deepEqual(errorKeys({ ...api, email_api_key: "", email_api_provider: "resend" }), ["email_api_key"]);
});

test("fallback types need both transports configured", () => {
  const keys = errorKeys({ ...SMTP, email_type: "smtp-api" });
  assert.ok(keys.includes("email_api_key"));
  assert.ok(keys.includes("email_api_url"));
});

test("console email is refused on a public App URL", () => {
  const consoleMail = { enable_email: "true", email_type: "console", email_from: "a@example.com" };
  assert.deepEqual(errorKeys(consoleMail), []);
  assert.ok(errorKeys({ ...consoleMail, app_url: "https://auth.example.com" }).includes("email_type"));
});

test("app URL must be an origin; http on a public host warns", () => {
  assert.ok(errorKeys({ app_url: "https://auth.example.com/app" }).includes("app_url"));
  assert.ok(errorKeys({ app_url: "ftp://x" }).includes("app_url"));
  assert.equal(parse({ app_url: "https://auth.example.com/" }).config.app_url, "https://auth.example.com");
  assert.ok(warnKeys({ app_url: "http://auth.example.com", app_seed_demo_users: "false" }).includes("app_url"));
  assert.ok(warnKeys({ app_url: "https://auth.example.com" }).includes("app_seed_demo_users"));
});

test("booleans accept common spellings and reject others", () => {
  assert.equal(parse({ enable_app_testing: "YES", app_testing_allowlist: "a@b.co" }).config.enable_app_testing, true);
  assert.ok(errorKeys({ enable_email: "maybe" }).includes("enable_email"));
});

test("testing mode needs testers, and accepts emails and @domains", () => {
  assert.deepEqual(errorKeys({ enable_app_testing: "true" }), ["app_testing_allowlist"]);
  const { config } = parse({ enable_app_testing: "true", app_testing_allowlist: "Ann@Example.com, @team.io\nbob@x.org" });
  assert.deepEqual(config.app_testing_allowlist, ["ann@example.com", "@team.io", "bob@x.org"]);
  assert.ok(errorKeys({ enable_app_testing: "true", app_testing_allowlist: "not-an-email" }).includes("app_testing_allowlist"));
});

/* ---------- the service: env vs Settings Bar ---------- */

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "cfg-")), "app-config.json");
}

test("env mode reads lower or upper case names and cannot be edited", async () => {
  const svc = new ConfigService({ env: { app_name: "Lower", ENABLE_APP_TESTING: "true", APP_TESTING_ALLOWLIST: "@acme.com" }, file: await tmpFile(), defaultAppUrl: DEF.appUrl });
  await svc.load();
  assert.equal(svc.editable, false);
  assert.equal(svc.config.app_name, "Lower");
  assert.equal(svc.isAllowed("Jo@ACME.com"), true);
  assert.equal(svc.isAllowed("jo@other.com"), false);
  await assert.rejects(svc.update({ app_name: "x" }), ConfigError);
});

test("app_config=true ignores environment variables and saves edits to a private file", async () => {
  const file = await tmpFile();
  const svc = new ConfigService({ env: { app_config: "true", app_name: "From env" }, file, defaultAppUrl: DEF.appUrl });
  await svc.load();
  assert.equal(svc.editable, true);
  assert.equal(svc.config.app_name, "Auth Flow", "env value ignored");

  await svc.update({ app_name: "From settings", ...SMTP });
  assert.equal(svc.config.app_name, "From settings");
  assert.equal(svc.emailReady, true);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Secrets are never described, and an empty value keeps the stored one.
  const described = svc.describe().fields.find((f) => f.key === "email_smtp_password")!;
  assert.equal(described.value, undefined);
  assert.equal(described.isSet, true);
  await svc.update({ email_smtp_password: "" });
  assert.equal(svc.config.email_smtp_password, "app-password");

  // An invalid update is rejected as a whole.
  await assert.rejects(svc.update({ email_smtp_port: "0", app_name: "Changed" }), (e: unknown) => e instanceof ConfigError && e.problems.some((p) => p.key === "email_smtp_port"));
  assert.equal(svc.config.app_name, "From settings");

  // null removes a secret (and here makes the config invalid, so it is refused).
  await assert.rejects(svc.update({ email_smtp_password: null }), ConfigError);

  // A fresh service reads the saved file.
  const again = new ConfigService({ env: { app_config: "true" }, file, defaultAppUrl: DEF.appUrl });
  await again.load();
  assert.equal(again.config.app_name, "From settings");
  assert.match(await readFile(file, "utf8"), /"email_smtp_port": "587"/);
});

test("mergeEnv: names ignore case and later sources win", () => {
  const merged = mergeEnv({ app_name: "from .env", EMAIL_TYPE: "smtp" }, { APP_NAME: "real env" });
  assert.deepEqual(merged, { app_name: "real env", email_type: "smtp" });
});

test("a bad app_config value is an error", () => {
  assert.throws(() => new ConfigService({ env: { app_config: "sometimes" }, file: "x", defaultAppUrl: DEF.appUrl }), ConfigError);
});

/* ---------- mailer ---------- */

function mailerWith(raw: RawConfig, opts: { smtpFails?: boolean; apiStatus?: number } = {}) {
  const { config, problems } = parse(raw);
  const errors = problems.filter((p) => p.level === "error");
  const calls: { smtpOptions?: Record<string, unknown>; smtpMessage?: Record<string, unknown>; fetch?: { url: string; init: RequestInit } }[] = [];
  const logs: string[] = [];
  const mailer = new Mailer({
    settings: () => ({ config, ready: config.enable_email && errors.length === 0, problems: errors.map((p) => p.message) }),
    createSmtp: (o): SmtpLike => {
      calls.push({ smtpOptions: o });
      return {
        sendMail: async (m) => {
          calls.push({ smtpMessage: m });
          if (opts.smtpFails) throw Object.assign(new Error("Invalid login: 535 bad credentials"), { code: "EAUTH" });
        },
      };
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ fetch: { url, init } });
      return new Response("{}", { status: opts.apiStatus ?? 200 });
    }) as unknown as typeof fetch,
    log: (l) => logs.push(l),
  });
  return { mailer, calls, logs };
}

const mail = codeEmail("Acme", "user@example.com", "123456", 5);

test("SMTP options follow tls/ssl and authentication settings", async () => {
  const tls = mailerWith(SMTP);
  assert.deepEqual(await tls.mailer.send(mail), { via: "smtp" });
  const o = tls.calls[0]!.smtpOptions!;
  assert.deepEqual([o.host, o.port, o.secure, o.requireTLS], ["smtp.gmail.com", 587, false, true]);
  assert.deepEqual(o.auth, { user: "example@gmail.com", pass: "app-password" });
  assert.deepEqual(tls.calls[1]!.smtpMessage!.from, { name: "Auth Flow", address: "example@gmail.com" });

  const ssl = mailerWith({ ...SMTP, email_smtp_tlsorssl: "ssl", email_smtp_port: "465", email_smtp_useauth: "false", email_from: "a@b.co" });
  await ssl.mailer.send(mail);
  const o2 = ssl.calls[0]!.smtpOptions!;
  assert.deepEqual([o2.secure, o2.requireTLS, o2.auth], [true, false, undefined]);
});

test("smtp-api falls back to the API when SMTP fails, and errors never include secrets", async () => {
  const both = { ...SMTP, email_type: "smtp-api", email_api_provider: "resend", email_api_key: "re_secret" };
  const { mailer, calls, logs } = mailerWith(both, { smtpFails: true });
  assert.deepEqual(await mailer.send(mail), { via: "api" });
  const f = calls.find((c) => c.fetch)!.fetch!;
  assert.equal(f.url, "https://api.resend.com/emails");
  assert.equal((f.init.headers as Record<string, string>).authorization, "Bearer re_secret");
  assert.equal(f.init.redirect, "error");
  assert.match(logs.join("\n"), /smtp failed: smtp.gmail.com:587 the server rejected the username or password/);
  assert.doesNotMatch(logs.join("\n"), /app-password|re_secret/);

  const failing = mailerWith(both, { smtpFails: true, apiStatus: 401 });
  await assert.rejects(failing.mailer.send(mail), (e: Error) => /SMTP: .*API: api.resend.com answered 401/.test(e.message) && !/re_secret|app-password/.test(e.message));
});

test("API formats: SendGrid and Postmark shapes", async () => {
  const base = { enable_email: "true", email_type: "api", email_from: "no-reply@acme.com", email_api_key: "k1" };
  const sg = mailerWith({ ...base, email_api_provider: "sendgrid" });
  await sg.mailer.send(mail);
  const sgCall = sg.calls[0]!.fetch!;
  assert.equal(sgCall.url, "https://api.sendgrid.com/v3/mail/send");
  assert.deepEqual(JSON.parse(String(sgCall.init.body)).personalizations, [{ to: [{ email: "user@example.com" }] }]);

  const pm = mailerWith({ ...base, email_api_provider: "postmark" });
  await pm.mailer.send(mail);
  const pmCall = pm.calls[0]!.fetch!;
  assert.equal(pmCall.url, "https://api.postmarkapp.com/email");
  assert.equal((pmCall.init.headers as Record<string, string>)["x-postmark-server-token"], "k1");
  assert.equal(JSON.parse(String(pmCall.init.body)).To, "user@example.com");

  const gen = mailerWith({ ...base, email_api_url: "https://mail.acme.com/send" });
  await gen.mailer.send(mail);
  assert.equal(gen.calls[0]!.fetch!.url, "https://mail.acme.com/send");
});

test("mailer refuses when email is off or misconfigured", async () => {
  await assert.rejects(mailerWith({}).mailer.send(mail), /turned off/);
  await assert.rejects(mailerWith({ enable_email: "true" }).mailer.send(mail), /settings have errors/);
});

test("code email escapes the app name in HTML", () => {
  const m = codeEmail("<b>Evil</b>", "a@b.co", "000111", 1);
  assert.doesNotMatch(m.html, /<b>Evil/);
  assert.match(m.text, /expires in 1 minute\./);
});

/* ---------- flows under settings ---------- */

function flow(types: Parameters<typeof newStep>[1][]): BuilderDoc {
  return { id: "f", name: "F", starter: newStarter(), steps: types.map((t, i) => newStep(`s${i}`, t)), notes: [], updatedAt: 1 };
}

async function run(d: BuilderDoc, extra: { isAllowed?: (e: string) => boolean; sendFails?: boolean; emailEnabled?: boolean }) {
  const users = new InMemoryUserDirectory().add({ id: "u1", email: "ada@example.com", passwordHash: await hashPassword("pw-pw-pw-pw"), mfaEnabled: false });
  const compiled = compileDoc(d, {
    users,
    verifyPassword,
    hashPassword,
    dummyPasswordHash: await hashPassword("x"),
    sendCode: async () => {
      if (extra.sendFails) throw new Error("SMTP down");
    },
    webauthn: { rpID: "localhost", rpName: "t", origin: "http://localhost:3000" },
    ...(extra.isAllowed && { isAllowed: extra.isAllowed }),
    ...(extra.emailEnabled !== undefined && { emailEnabled: () => extra.emailEnabled! }),
  });
  return compiled;
}

test("testing mode turns non-testers away at the Starter node", async () => {
  const compiled = await run(flow(["password", "authenticate"]), { isAllowed: (e) => e.endsWith("@acme.com") });
  assert.ok(compiled.ok);
  const engine = new FlowEngine().register(compiled.flow);
  const first = (await engine.start(compiled.flow.id)).view as ScreenView;
  const blocked = await engine.submit(first.sessionId, "start", { email: "ada@example.com" });
  assert.equal(blocked.view.nodeId, "start:blocked");
  const first2 = (await engine.start(compiled.flow.id)).view as ScreenView;
  const ok = await engine.submit(first2.sessionId, "start", { email: "tester@acme.com" });
  assert.equal(ok.view.type, "screen");
});

test("a failed email send keeps the user on the code screen with a message", async () => {
  const compiled = await run(flow(["email-code", "authenticate"]), { sendFails: true });
  assert.ok(compiled.ok);
  const engine = new FlowEngine().register(compiled.flow);
  const first = (await engine.start(compiled.flow.id)).view as ScreenView;
  const code = (await engine.submit(first.sessionId, "start", { email: "ada@example.com" })).view as ScreenView;
  assert.equal(code.nodeId, "s0:verify");
  assert.match(String(code.data!.notice), /couldn't send the email/);
});

test("flows with Verification Email do not compile while email is off", async () => {
  const compiled = await run(flow(["email-code", "authenticate"]), { emailEnabled: false });
  assert.equal(compiled.ok, false);
  assert.match(compiled.problems.map((p) => p.message).join(), /Email is turned off/);
});
