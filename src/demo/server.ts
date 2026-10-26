import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BuilderInputError,
  checkDoc,
  compileDoc,
  createLoginFlow,
  FileUserDirectory,
  FlowDocStore,
  FlowEngine,
  FlowError,
  hashPassword,
  label,
  newDoc,
  newStarter,
  newStep,
  parseCookies,
  RateLimiter,
  renderSitePages,
  sanitizeDoc,
  SessionSigner,
  SiteStore,
  SLUG_RE,
  STARTER_SETTINGS,
  STEP_SETTINGS,
  STEP_TYPES,
  verifyPassword,
} from "../index.js";
import type { BuilderDoc, FlowStep, SiteRecord } from "../index.js";
import { ConfigError, ConfigService, mergeEnv, readEnv } from "../config/service.js";
import { codeEmail, EmailError, Mailer, testEmail } from "../email/mailer.js";

/*
 * Demo server. Run `npm run demo`, then open:
 *   http://localhost:3000/          the whiteboard (flow builder)
 *   http://localhost:3000/run?flow= run a whiteboard flow
 *   http://localhost:3000/login     the hand-written login flow
 *   http://localhost:3000/s/<slug>/ a published site
 *
 * Settings: see .env.example. PORT, HOST and DATA_DIR are always read from the environment,
 * because they are needed before the settings file can be found. Everything else comes from
 * environment variables, or from the Settings Bar when app_config=true.
 */

// A .env file in the working directory is read first. Variables set in the real environment win over it.
// Names are not case sensitive: app_name and APP_NAME are the same setting.
const env = mergeEnv(existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {}, process.env);

const PORT = Number(readEnv(env, "PORT") ?? 3000);
// Local only by default: the builder API has no login of its own.
const HOST = readEnv(env, "HOST") ?? "127.0.0.1";
const MAX_JSON = 16 * 1024;
const MAX_BUILDER_JSON = 4 * 1024 * 1024;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const publicDir = join(root, "src", "demo", "public");
const dataDir = readEnv(env, "DATA_DIR") ?? join(root, "data");
const modules = join(root, "node_modules");

/* ---------- settings ---------- */

const settings = await (async () => {
  try {
    const service = new ConfigService({ env, file: join(dataDir, "app-config.json"), defaultAppUrl: `http://localhost:${PORT}` });
    await service.load();
    return service;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Settings error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
})();

// Environment variables are checked once at startup: stop with a clear list rather than run half-configured.
// With app_config=true the server starts anyway, so the Settings Bar can be used to fix things.
if (!settings.editable && settings.errors.length > 0) {
  console.error("Settings errors (from environment variables):");
  for (const p of settings.errors) console.error(`  ${p.key}: ${p.message}`);
  console.error("Fix them, or set app_config=true to manage settings in the Settings Bar.");
  process.exit(1);
}
for (const p of settings.problems.filter((x) => x.level === "warning")) console.warn(`Settings warning: ${p.key}: ${p.message}`);

const appUrl = () => settings.config.app_url;
const secureCookies = () => appUrl().startsWith("https://");
const features = () => ({ emailEnabled: settings.config.enable_email, emailReady: settings.emailReady });

const mailer = new Mailer({
  settings: () => ({
    config: settings.config,
    ready: settings.emailReady,
    problems: settings.errors.filter((p) => p.key?.startsWith("email")).map((p) => p.message),
  }),
});

const STATIC: Record<string, { file: string; type: string }> = {
  "/assets/flow-client.js": { file: join(publicDir, "flow-client.js"), type: "text/javascript; charset=utf-8" },
  "/assets/flow-client.css": { file: join(publicDir, "flow-client.css"), type: "text/css; charset=utf-8" },
  "/vendor/webauthn.js": { file: join(modules, "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js"), type: "text/javascript; charset=utf-8" },
  "/vendor/marked.js": { file: join(modules, "marked", "lib", "marked.umd.js"), type: "text/javascript; charset=utf-8" },
  "/vendor/purify.js": { file: join(modules, "dompurify", "dist", "purify.min.js"), type: "text/javascript; charset=utf-8" },
};

/* ---------- state ---------- */

const users = new FileUserDirectory(join(dataDir, "users.json"));
await users.load();
if (users.all().length === 0 && settings.config.app_seed_demo_users) {
  // Known passwords: fine on localhost, never on a public server. Set app_seed_demo_users=false there.
  users.add({ id: "u1", email: "ada@example.com", passwordHash: await hashPassword("correct horse"), mfaEnabled: false });
  users.add({ id: "u2", email: "grace@example.com", passwordHash: await hashPassword("battery staple"), mfaEnabled: true });
  await users.save();
}

const dummyPasswordHash = await hashPassword("not-a-real-password");
const isAllowed = (email: string) => settings.isAllowed(email);

// The hand-written /login demo keeps printing its MFA codes to the console. Whiteboard flows use real email.
const demoSendCode = async (to: { email: string }, code: string) => console.log(`[demo /login] code for ${to.email}: ${code}`);
const engine = new FlowEngine().register(createLoginFlow({ users, verifyPassword, dummyPasswordHash, sendCode: demoSendCode, isAllowed }));

const builderDeps = {
  users,
  verifyPassword,
  hashPassword,
  dummyPasswordHash,
  isAllowed,
  emailEnabled: () => settings.config.enable_email,
  sendCode: async (to: { email: string }, code: string, info: { ttlMinutes: number }) => {
    await mailer.send(codeEmail(settings.config.app_name, to.email, code, info.ttlMinutes));
  },
  // A getter, so passkeys always use the current App URL and name.
  get webauthn() {
    return { rpID: new URL(appUrl()).hostname, rpName: settings.config.app_name, origin: appUrl() };
  },
};

const docs = new FlowDocStore(join(dataDir, "flows.json"));
await docs.load();
if (docs.list().length === 0) await seed();

const sites = new SiteStore(join(dataDir, "sites"));
await sites.load();
// Regenerate pages so template changes reach sites published by an older version.
for (const site of sites.list()) await sites.put(site, renderSitePages(site));
const signer = await SessionSigner.fromFile(join(dataDir, "session-secret"));

const flowLimiter = new RateLimiter(60, 60_000);

async function seed(): Promise<void> {
  await docs.put({
    ...newDoc("Password, then add a passkey"),
    starter: newStarter(),
    steps: [newStep("pw", "password"), newStep("pk", "passkey"), newStep("auth", "authenticate")],
    notes: [{ id: "n1", text: "**Run this first.** It signs you in with a password and creates a passkey.", x: 24, y: 24 }],
  });
  await docs.put({
    ...newDoc("Sign in with a passkey"),
    starter: newStarter(),
    steps: [newStep("age", "age-check"), newStep("pk", "passkey"), newStep("auth", "authenticate")],
    updatedAt: Date.now() + 1,
  });
}

/**
 * Compiles a flow document into the engine once per version.
 * The check runs every time, because Settings (e.g. email off) can make a compiled flow unusable.
 */
function ensureFlow(doc: BuilderDoc, flowId: string): { ok: true } | { ok: false; problems: ReturnType<typeof checkDoc> } {
  const problems = checkDoc(doc, features());
  if (problems.some((p) => p.level === "error")) return { ok: false, problems };
  if (engine.has(flowId)) return { ok: true };
  const compiled = compileDoc(doc, builderDeps, flowId);
  if (!compiled.ok) return { ok: false, problems: compiled.problems };
  engine.register(compiled.flow);
  return { ok: true };
}

const siteFlowId = (site: SiteRecord) => `site:${site.slug}:${site.publishedAt}`;
const cookieName = "fs_session";

/* ---------- http helpers ---------- */

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

const PAGE_CSP =
  "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, path: string, type: string, cache = "no-cache"): Promise<void> {
  const body = await readFile(path);
  const isHtml = type.startsWith("text/html");
  res.writeHead(200, { "content-type": type, "cache-control": cache, ...SECURITY_HEADERS, ...(isHtml && { "content-security-policy": PAGE_CSP }) });
  res.end(body);
}

function redirect(res: ServerResponse, to: string, status = 302): void {
  res.writeHead(status, { location: to, "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end();
}

async function readJson(req: IncomingMessage, limit = MAX_JSON): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

/**
 * Rejects cross-site writes. Browsers always send Origin on cross-site POSTs, and the JSON content type forces a preflight.
 * Compared with the Host header rather than app_url, so changing app_url in Settings can't lock you out.
 */
function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed Origin: refused below */
    }
    if (!host || host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused.");
  }
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Expected application/json.");
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function limit(req: IncomingMessage, key: string): void {
  if (!flowLimiter.take(`${clientIp(req)}|${key}`)) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
}

function inputOf(body: Record<string, unknown>): Record<string, unknown> {
  return typeof body.input === "object" && body.input !== null && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
}

function docResponse(doc: BuilderDoc) {
  return { doc, problems: checkDoc(doc, features()) };
}

function siteResponse(site: SiteRecord | undefined, doc: BuilderDoc) {
  if (!site) return { site: null, suggestedSlug: slugify(doc.name) };
  return {
    site: {
      slug: site.slug,
      title: site.title,
      publicMd: site.publicMd,
      membersMd: site.membersMd,
      publishedAt: site.publishedAt,
      url: `${appUrl()}/s/${site.slug}/`,
      outdated: doc.updatedAt > site.flow.updatedAt,
    },
  };
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return SLUG_RE.test(s) ? s : "my-site";
}

/* ---------- builder: publishing ---------- */

async function publish(doc: BuilderDoc, body: Record<string, unknown>): Promise<SiteRecord> {
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) throw new HttpError(400, "The address can use lowercase letters, numbers and dashes (2 to 40 characters).");
  const taken = sites.get(slug);
  if (taken && taken.flowDocId !== doc.id) throw new HttpError(409, `/s/${slug}/ is already used by another flow.`);

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : doc.name;
  const md = (v: unknown, name: string) => {
    const text = typeof v === "string" ? v : "";
    if (text.length > 1_000_000) throw new HttpError(413, `${name} is too large. Use image links instead of pasting large images.`);
    return text;
  };

  const site: SiteRecord = {
    slug,
    flowDocId: doc.id,
    title,
    publicMd: md(body.publicMd, "The public page"),
    membersMd: md(body.membersMd, "The members page"),
    flow: structuredClone(doc),
    publishedAt: Date.now(),
  };
  const ready = ensureFlow(site.flow, siteFlowId(site));
  if (!ready.ok) throw new HttpError(422, "Fix the errors on the whiteboard before publishing.", { problems: ready.problems });

  const previous = sites.forFlow(doc.id);
  await sites.put(site, renderSitePages(site));
  if (previous && previous.slug !== slug) await sites.delete(previous.slug);
  return site;
}

/* ---------- published sites ---------- */

async function handleSite(req: IncomingMessage, res: ServerResponse, slug: string, rest: string): Promise<void> {
  const site = sites.get(slug);
  if (!site) throw new HttpError(404, "This site does not exist or was unpublished.");
  const session = signer.verify(parseCookies(req.headers.cookie)[cookieName], slug);
  const found = session ? await users.findById(session.u) : undefined;
  // Testing mode also applies to people who signed in before it was switched on.
  const user = found && isAllowed(found.email) ? found : undefined;

  if (req.method === "GET" && rest === "/") return sendFile(res, sites.pagePath(slug, "index"), "text/html; charset=utf-8", "no-store");
  if (req.method === "GET" && rest === "/members") {
    if (!user) return redirect(res, `/s/${slug}/`);
    return sendFile(res, sites.pagePath(slug, "members"), "text/html; charset=utf-8", "private, no-store");
  }
  if (req.method === "GET" && rest === "/api/me") {
    return send(res, 200, user ? { signedIn: true, email: user.email } : { signedIn: false });
  }

  if (req.method !== "POST") throw new HttpError(404, "Not found.");
  assertSameOrigin(req);
  const flowId = siteFlowId(site);

  if (rest === "/api/start") {
    limit(req, `site:${slug}`);
    const ready = ensureFlow(site.flow, flowId);
    if (!ready.ok) {
      console.error(`[site ${slug}] sign-in unavailable: ${ready.problems.filter((p) => p.level === "error").map((p) => p.message).join(" ")}`);
      throw new HttpError(503, "Sign-in is unavailable right now. Please try again later.");
    }
    return send(res, 200, (await engine.start(flowId)).view);
  }

  const submit = rest.match(/^\/api\/submit\/([\w-]{1,64})$/);
  if (submit) {
    limit(req, `site:${slug}`);
    const sessionId = submit[1]!;
    const body = await readJson(req);
    // Only sessions started for this site can sign in to this site.
    if ((await engine.sessionFlowId(sessionId)) !== flowId) throw new HttpError(410, "Your sign-in session expired.");
    const step = await engine.submit(sessionId, String(body.nodeId ?? ""), inputOf(body));
    if (step.view.type === "complete" && step.view.status === "success" && step.result?.userId) {
      const hours = Number(step.result.sessionHours ?? 24);
      const token = signer.sign({ u: String(step.result.userId), s: slug, exp: Date.now() + hours * 3_600_000 });
      const cookie = [
        `${cookieName}=${encodeURIComponent(token)}`,
        `Path=/s/${slug}/`,
        `Max-Age=${Math.round(hours * 3600)}`,
        "HttpOnly",
        "SameSite=Lax",
        ...(secureCookies() ? ["Secure"] : []),
      ].join("; ");
      return send(res, 200, { ...step.view, redirect: `/s/${slug}/members` }, { "set-cookie": cookie });
    }
    return send(res, 200, step.view);
  }

  if (rest === "/api/logout") {
    const clear = `${cookieName}=; Path=/s/${slug}/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookies() ? "; Secure" : ""}`;
    return send(res, 200, { ok: true }, { "set-cookie": clear });
  }

  throw new HttpError(404, "Not found.");
}

/* ---------- routes ---------- */

const server = createServer(async (req, res) => {
  // HEAD is answered like GET; Node drops the body for HEAD responses.
  if (req.method === "HEAD") req.method = "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    const siteMatch = path.match(/^\/s\/([a-z0-9-]{1,40})(\/.*)?$/);
    if (siteMatch) {
      if (!siteMatch[2]) return redirect(res, `/s/${siteMatch[1]}/`, 301);
      return await handleSite(req, res, siteMatch[1]!, siteMatch[2]);
    }

    if (req.method === "GET") {
      if (path === "/") return await sendFile(res, join(publicDir, "builder.html"), "text/html; charset=utf-8");
      if (path === "/run" || path === "/login") return await sendFile(res, join(publicDir, "index.html"), "text/html; charset=utf-8");
      const asset = STATIC[path];
      if (asset) return await sendFile(res, asset.file, asset.type);
    }

    if (path.startsWith("/api/") && req.method !== "GET") assertSameOrigin(req);

    /* builder */
    if (path === "/api/builder/meta" && req.method === "GET") {
      return send(res, 200, {
        app: { name: settings.config.app_name, url: appUrl(), testing: settings.config.enable_app_testing },
        features: features(),
        settings: { source: settings.source, errors: settings.errors.length },
        starter: { label: "Starter Node", settings: STARTER_SETTINGS },
        types: STEP_TYPES.map((type) => ({ type, label: label(type), settings: STEP_SETTINGS[type] })),
      });
    }
    if (path === "/api/builder/flows" && req.method === "GET") {
      return send(res, 200, { flows: docs.list().map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt })) });
    }
    if (path === "/api/builder/flows" && req.method === "POST") {
      const body = await readJson(req);
      const doc = newDoc(typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Untitled flow");
      await docs.put(doc);
      return send(res, 201, docResponse(doc));
    }

    const flowMatch = path.match(/^\/api\/builder\/flows\/([A-Za-z0-9_-]{1,64})(\/run|\/site)?$/);
    if (flowMatch) {
      const id = flowMatch[1]!;
      const existing = docs.get(id);
      if (!existing) throw new HttpError(404, "Flow not found.");
      const sub = flowMatch[2];

      if (!sub) {
        if (req.method === "GET") return send(res, 200, docResponse(existing));
        if (req.method === "PUT") {
          const doc = sanitizeDoc(await readJson(req, MAX_BUILDER_JSON), id);
          await docs.put(doc);
          return send(res, 200, docResponse(doc));
        }
        if (req.method === "DELETE") {
          const site = sites.forFlow(id);
          if (site) await sites.delete(site.slug);
          await docs.delete(id);
          return send(res, 200, { ok: true });
        }
      }

      if (sub === "/run" && req.method === "POST") {
        // Each saved version compiles to its own engine flow, so edits never break a run in progress.
        const flowId = `builder:${existing.id}:${existing.updatedAt}`;
        const ready = ensureFlow(existing, flowId);
        if (!ready.ok) throw new HttpError(422, "This flow has errors. Fix them on the whiteboard first.", { problems: ready.problems });
        return send(res, 200, (await engine.start(flowId)).view);
      }

      if (sub === "/site") {
        if (req.method === "GET") return send(res, 200, siteResponse(sites.forFlow(id), existing));
        if (req.method === "PUT") {
          const site = await publish(existing, await readJson(req, MAX_BUILDER_JSON));
          return send(res, 200, siteResponse(site, existing));
        }
        if (req.method === "DELETE") {
          const site = sites.forFlow(id);
          if (site) await sites.delete(site.slug);
          return send(res, 200, siteResponse(undefined, existing));
        }
      }
    }

    /* settings bar */
    if (path === "/api/settings" && req.method === "GET") {
      return send(res, 200, { ...settings.describe(), hostWarning: hostWarning(req) });
    }
    if (path === "/api/settings" && req.method === "PUT") {
      if (!settings.editable) {
        throw new HttpError(409, "Settings come from environment variables. Set app_config=true to edit them here.");
      }
      const body = await readJson(req, 64 * 1024);
      const values = typeof body.values === "object" && body.values !== null && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
      try {
        await settings.update(values);
      } catch (err) {
        if (err instanceof ConfigError) throw new HttpError(422, err.message, { problems: err.problems });
        throw err;
      }
      return send(res, 200, { ...settings.describe(), hostWarning: hostWarning(req) });
    }
    if (path === "/api/settings/test-email" && req.method === "POST") {
      limit(req, "test-email");
      const body = await readJson(req);
      const to = typeof body.to === "string" ? body.to.trim() : "";
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new HttpError(400, "Enter the address to send the test email to.");
      try {
        const { via } = await mailer.send(testEmail(settings.config.app_name, to, String(settings.config.email_type)));
        return send(res, 200, { ok: true, via });
      } catch (err) {
        if (err instanceof EmailError) throw new HttpError(502, err.message);
        throw err;
      }
    }

    /* runtime for /run and /login */
    if (path === "/api/flows/login/start" && req.method === "POST") {
      limit(req, "login");
      return send(res, 200, (await engine.start("login")).view);
    }
    const submitMatch = path.match(/^\/api\/sessions\/([\w-]{1,64})\/submit$/);
    if (submitMatch && req.method === "POST") {
      limit(req, "run");
      const body = await readJson(req);
      const step: FlowStep = await engine.submit(submitMatch[1]!, String(body.nodeId ?? ""), inputOf(body));
      if (step.view.type === "complete" && step.view.status === "success") console.log("[demo] signed in:", step.result);
      return send(res, 200, step.view);
    }

    throw new HttpError(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
    if (err instanceof BuilderInputError) return send(res, 400, { error: err.message });
    if (err instanceof FlowError) {
      const status = err.code === "SESSION_NOT_FOUND" || err.code === "FLOW_COMPLETE" ? 410 : err.code === "UNKNOWN_FLOW" ? 404 : 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? "Something went wrong." : err.message, code: err.code });
    }
    console.error(err);
    send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${settings.config.app_name}`);
  console.log(`  Whiteboard:  ${appUrl()}/`);
  console.log(`  Login demo:  ${appUrl()}/login`);
  console.log(`  Settings:    ${settings.editable ? "Settings Bar (app_config=true, environment variables ignored)" : "environment variables"}`);
  if (settings.config.enable_app_testing) console.log(`  Testing mode: ${settings.config.app_testing_allowlist.length} tester entr${settings.config.app_testing_allowlist.length === 1 ? "y" : "ies"}`);
  if (users.all().some((u) => u.email.endsWith("@example.com"))) {
    console.log("Demo accounts: ada@example.com / correct horse, grace@example.com / battery staple");
  }
  if (!isLocalHost(appUrl()) && !secureCookies()) console.warn("Passkeys and secure cookies need HTTPS unless you use localhost.");
});

function isLocalHost(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

/** Warns when the builder is opened from a different address than app_url, since passkeys and links follow app_url. */
function hostWarning(req: IncomingMessage): string | null {
  const host = req.headers.host;
  const configured = new URL(appUrl()).host;
  return host && host !== configured ? `You opened the builder at ${host}, but App URL is ${appUrl()}. Passkeys and site links use the App URL.` : null;
}
