import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BuilderInputError,
  checkDoc,
  compileDoc,
  createLoginFlow,
  FlowDocStore,
  FlowEngine,
  FlowError,
  hashPassword,
  InMemoryUserDirectory,
  newDoc,
  sanitizeDoc,
  STEP_CONFIG,
  STEP_TYPES,
  verifyPassword,
} from "../index.js";
import type { BuilderDoc } from "../index.js";
import { label } from "../builder/document.js";

/*
 * Demo server. Run `npm run demo`, then open:
 *   http://localhost:3000/          the whiteboard (flow builder)
 *   http://localhost:3000/run?flow= run a whiteboard flow
 *   http://localhost:3000/login     the hand-written login flow
 *
 * Demo accounts:
 *   ada@example.com   / correct horse   (no MFA)
 *   grace@example.com / battery staple  (MFA in the hand-written flow)
 * Email codes are printed to this console.
 */

const PORT = Number(process.env.PORT ?? 3000);
// Local only by default: the builder API has no login of its own.
const HOST = process.env.HOST ?? "127.0.0.1";
const ORIGIN = process.env.ORIGIN ?? `http://localhost:${PORT}`;
const RP_ID = process.env.RP_ID ?? new URL(ORIGIN).hostname;
const MAX_BODY = 64 * 1024;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const publicDir = join(root, "src", "demo", "public");
const dataFile = process.env.FLOWS_FILE ?? join(root, "data", "flows.json");
const webauthnBrowser = join(root, "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");

const users = new InMemoryUserDirectory()
  .add({ id: "u1", email: "ada@example.com", passwordHash: await hashPassword("correct horse"), mfaEnabled: false })
  .add({ id: "u2", email: "grace@example.com", passwordHash: await hashPassword("battery staple"), mfaEnabled: true });

const sendCode = async (user: { email: string }, code: string) => console.log(`[demo mail] code for ${user.email}: ${code}`);
const dummyPasswordHash = await hashPassword("not-a-real-password");

const engine = new FlowEngine().register(createLoginFlow({ users, verifyPassword, dummyPasswordHash, sendCode }));
const builderDeps = { users, verifyPassword, dummyPasswordHash, sendCode, webauthn: { rpID: RP_ID, rpName: "Auth Flow Demo", origin: ORIGIN } };

const docs = new FlowDocStore(dataFile);
await docs.load();
if (docs.list().length === 0) await seed();

async function seed(): Promise<void> {
  const enroll: BuilderDoc = {
    ...newDoc("Password, then add a passkey"),
    starter: { identifier: "email" },
    steps: [
      { id: "pw", type: "password", config: { maxAttempts: 5 } },
      { id: "pk", type: "passkey", config: {} },
      { id: "auth", type: "authenticate", config: {} },
    ],
    notes: [{ id: "n1", text: "Run this first. It signs you in with a password and creates a passkey.", x: 24, y: 24 }],
  };
  const mockup: BuilderDoc = {
    ...newDoc("Sign in with a passkey"),
    starter: { identifier: "email" },
    steps: [
      { id: "age", type: "age-check", config: { minAge: 18 } },
      { id: "pk", type: "passkey", config: {} },
      { id: "auth", type: "authenticate", config: {} },
    ],
    notes: [],
    updatedAt: Date.now() + 1,
  };
  await docs.put(enroll);
  await docs.put(mockup);
}

/* ---------- http helpers ---------- */

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, path: string, type: string): Promise<void> {
  const body = await readFile(path);
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new BadRequest("Invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadRequest("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

class BadRequest extends Error {}

/** Rejects cross-site writes: the builder API has no login, so only same-origin pages may change it. */
function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) throw new BadRequest("Cross-origin request refused.");
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new BadRequest("Expected application/json.");
}

function docResponse(doc: BuilderDoc) {
  return { doc, problems: checkDoc(doc) };
}

/* ---------- routes ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET") {
      if (path === "/") return await sendFile(res, join(publicDir, "builder.html"), "text/html; charset=utf-8");
      if (path === "/run" || path === "/login") return await sendFile(res, join(publicDir, "index.html"), "text/html; charset=utf-8");
      if (path === "/vendor/webauthn.js") return await sendFile(res, webauthnBrowser, "text/javascript; charset=utf-8");
    }

    if (path.startsWith("/api/") && req.method !== "GET") assertSameOrigin(req);

    /* builder */
    if (path === "/api/builder/meta" && req.method === "GET") {
      return send(res, 200, { types: STEP_TYPES.map((type) => ({ type, label: label(type), config: STEP_CONFIG[type] })) });
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

    const flowMatch = path.match(/^\/api\/builder\/flows\/([A-Za-z0-9_-]{1,64})(\/run)?$/);
    if (flowMatch) {
      const id = flowMatch[1]!;
      const existing = docs.get(id);
      if (!existing) return send(res, 404, { error: "Flow not found." });

      if (!flowMatch[2]) {
        if (req.method === "GET") return send(res, 200, docResponse(existing));
        if (req.method === "PUT") {
          const doc = sanitizeDoc(await readJson(req), id);
          await docs.put(doc);
          return send(res, 200, docResponse(doc));
        }
        if (req.method === "DELETE") {
          await docs.delete(id);
          return send(res, 200, { ok: true });
        }
      } else if (req.method === "POST") {
        // Each saved version compiles to its own engine flow, so edits never break a run that is in progress.
        const flowId = `builder:${existing.id}:${existing.updatedAt}`;
        if (!engine.has(flowId)) {
          const compiled = compileDoc(existing, builderDeps, flowId);
          if (!compiled.ok) return send(res, 422, { error: "This flow has errors. Fix them on the whiteboard first.", problems: compiled.problems });
          engine.register(compiled.flow);
        }
        const step = await engine.start(flowId);
        return send(res, 200, step.view);
      }
    }

    /* runtime */
    if (path === "/api/flows/login/start" && req.method === "POST") {
      return send(res, 200, (await engine.start("login")).view);
    }
    const submitMatch = path.match(/^\/api\/sessions\/([\w-]+)\/submit$/);
    if (submitMatch && req.method === "POST") {
      const body = await readJson(req);
      const input = typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {};
      const step = await engine.submit(submitMatch[1]!, String(body.nodeId ?? ""), input);
      if (step.view.type === "complete" && step.view.status === "success") {
        // A real app would create a login session here (e.g. an HttpOnly cookie) from step.result.
        console.log("[demo] signed in:", step.result);
      }
      return send(res, 200, step.view);
    }

    send(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof BadRequest || err instanceof BuilderInputError) return send(res, 400, { error: err.message });
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
  console.log(`Whiteboard:  ${ORIGIN}/`);
  console.log(`Login demo:  ${ORIGIN}/login`);
  console.log("Accounts: ada@example.com / correct horse, grace@example.com / battery staple");
  if (RP_ID !== "localhost" && !ORIGIN.startsWith("https://")) console.warn("Passkeys need HTTPS unless you use localhost.");
});
