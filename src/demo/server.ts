import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLoginFlow, FlowEngine, FlowError, hashPassword, InMemoryUserDirectory, verifyPassword } from "../index.js";

/*
 * Demo server. Run `npm run demo`, open http://localhost:3000.
 *
 *   ada@example.com   / correct horse   (password only)
 *   grace@example.com / battery staple  (password + emailed code, printed to this console)
 */

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY = 16 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
// The page is plain HTML, so it is read from the source tree rather than the build output.
const PAGE = join(here, "..", "..", "..", "src", "demo", "public", "index.html");

const users = new InMemoryUserDirectory()
  .add({ id: "u1", email: "ada@example.com", passwordHash: await hashPassword("correct horse"), mfaEnabled: false })
  .add({ id: "u2", email: "grace@example.com", passwordHash: await hashPassword("battery staple"), mfaEnabled: true });

const engine = new FlowEngine().register(
  createLoginFlow({
    users,
    verifyPassword,
    dummyPasswordHash: await hashPassword("not-a-real-password"),
    sendCode: async (user, code) => console.log(`[demo mail] code for ${user.email}: ${code}`),
  }),
);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(PAGE);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    const startMatch = url.pathname.match(/^\/api\/flows\/([\w-]+)\/start$/);
    if (req.method === "POST" && startMatch) {
      const step = await engine.start(startMatch[1]!);
      return send(res, 200, step.view);
    }

    const submitMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const body = await readJson(req);
      const input = typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {};
      const step = await engine.submit(submitMatch[1]!, String(body.nodeId ?? ""), input);
      if (step.view.type === "complete" && step.view.status === "success") {
        // A real app would create a login session here (e.g. set an HttpOnly cookie) from step.result.
        console.log("[demo] signed in:", step.result);
      }
      return send(res, 200, step.view);
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof FlowError) {
      const status = err.code === "SESSION_NOT_FOUND" || err.code === "FLOW_COMPLETE" ? 410 : err.code === "UNKNOWN_FLOW" ? 404 : 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? "Something went wrong." : err.message, code: err.code });
    }
    if (err instanceof SyntaxError || (err instanceof Error && /Body too large|Expected a JSON object/.test(err.message))) {
      return send(res, 400, { error: "Bad request" });
    }
    console.error(err);
    send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, () => {
  console.log(`Auth flow demo on http://localhost:${PORT}`);
  console.log("  ada@example.com / correct horse   (no MFA)");
  console.log("  grace@example.com / battery staple (MFA, code printed here)");
});
