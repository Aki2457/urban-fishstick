import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageOn,
  BuilderInputError,
  checkDoc,
  compileDoc,
  FlowEngine,
  hashPassword,
  InMemoryUserDirectory,
  newStarter,
  newStep,
  RateLimiter,
  renderMarkdown,
  sanitizeDoc,
  SessionSigner,
  verifyPassword,
} from "../src/index.js";
import type { BuilderDoc, FlowStep, ScreenView, StepType } from "../src/index.js";

type StepSpec = StepType | [StepType, Record<string, unknown>];

function doc(specs: StepSpec[], starter = true): BuilderDoc {
  const steps = specs.map((spec, i) => (Array.isArray(spec) ? newStep(`s${i}`, spec[0], spec[1]) : newStep(`s${i}`, spec)));
  return { id: "d1", name: "Test flow", starter: starter ? newStarter() : null, steps, notes: [], updatedAt: 1 };
}

function screen(step: FlowStep): ScreenView {
  assert.equal(step.view.type, "screen", `expected a screen, got ${JSON.stringify(step.view)}`);
  return step.view as ScreenView;
}

const NOW = Date.UTC(2026, 9, 25);
const webauthn = { rpID: "localhost", rpName: "Test", origin: "http://localhost:3000" };

async function setup(d: BuilderDoc) {
  const users = new InMemoryUserDirectory().add({
    id: "u1",
    email: "ada@example.com",
    passwordHash: await hashPassword("correct horse"),
    mfaEnabled: false,
  });
  const sent: { email: string; code: string }[] = [];
  const compiled = compileDoc(d, {
    users,
    verifyPassword,
    hashPassword,
    dummyPasswordHash: await hashPassword("dummy"),
    sendCode: async (to, code) => void sent.push({ email: to.email, code }),
    webauthn,
    now: () => NOW,
  });
  assert.ok(compiled.ok, JSON.stringify(compiled.problems));
  const engine = new FlowEngine().register(compiled.flow);
  const first = screen(await engine.start(compiled.flow.id));
  return { engine, first, sent, users };
}

/* ---------- rules ---------- */

const errors = (d: BuilderDoc) => checkDoc(d).filter((p) => p.level === "error").map((p) => p.message);
const warnings = (d: BuilderDoc) => checkDoc(d).filter((p) => p.level === "warning").map((p) => p.message);

test("a flow needs a starter and a terminal last node", () => {
  assert.match(errors(doc(["password", "authenticate"], false)).join(), /Starter Node/);
  assert.match(errors(doc(["password"])).join(), /must end with/);
  assert.match(errors(doc([])).join(), /Add nodes/);
});

test("Authenticate without a factor before it is an error", () => {
  assert.match(errors(doc(["age-check", "authenticate"])).join(), /needs Enter Password/);
  assert.deepEqual(errors(doc(["password", "authenticate"])), []);
});

test("nodes after a terminal are an error", () => {
  assert.match(errors(doc(["password", "deny", "authenticate"])).join(), /must be the last node/);
});

test("minimum age above maximum age is an error", () => {
  assert.match(errors(doc([["age-check", { minAge: 30, maxAge: 20 }], "password", "authenticate"])).join(), /higher than maximum/);
});

test("passkey warnings follow the Allow creating new passkey setting", () => {
  const noEnroll = doc(["age-check", "passkey", "authenticate"]);
  assert.deepEqual(errors(noEnroll), []);
  assert.match(warnings(noEnroll).join(), /cannot sign in here/);
  assert.deepEqual(warnings(doc(["password", "passkey", "authenticate"])), []);
  assert.match(warnings(doc(["password", ["passkey", { allowCreate: false }], "authenticate"])).join(), /Creating new passkeys is off/);
});

test("sign-up without email verification first is a warning", () => {
  assert.match(warnings(doc([["password", { allowSignup: true }], "authenticate"])).join(), /email they don't own/);
  assert.deepEqual(warnings(doc(["email-code", ["password", { allowSignup: true }], "authenticate"])), []);
});

test("sanitizeDoc coerces settings, fills defaults and rejects bad input", () => {
  const clean = sanitizeDoc(
    {
      name: "  Mine  ",
      starter: { identifier: "email", config: { title: "  Hello  ", evil: 1 } },
      steps: [
        { id: "a1", type: "age-check", config: { minAge: 900, maxAge: "40", evil: "x" } },
        { id: "a2", type: "passkey", config: { allowCreate: "yes" } },
        { id: "a3", type: "deny", config: { message: "x".repeat(500) } },
      ],
      notes: [{ id: "n1", text: "# hi", x: -5, y: 1e9 }],
      admin: true,
    },
    "doc1",
  );
  assert.equal(clean.name, "Mine");
  assert.deepEqual(clean.starter!.config, { title: "Hello", help: "Enter your email to continue." });
  assert.deepEqual(clean.steps[0]!.config, { minAge: 120, maxAge: 40 });
  assert.deepEqual(clean.steps[1]!.config, { allowCreate: true, requireVerification: false }); // non-boolean falls back to default
  assert.equal((clean.steps[2]!.config.message as string).length, 200);
  assert.deepEqual([clean.notes[0]!.x, clean.notes[0]!.y], [0, 20000]);
  assert.ok(!("admin" in clean));

  assert.throws(() => sanitizeDoc({ steps: [{ id: "x", type: "root-shell" }] }, "d"), BuilderInputError);
  assert.throws(() => sanitizeDoc({ steps: [{ id: "../../etc", type: "deny" }] }, "d"), BuilderInputError);
  assert.throws(() => sanitizeDoc({ steps: [{ id: "a", type: "deny" }, { id: "a", type: "deny" }] }, "d"), /Duplicate/);
  assert.throws(() => sanitizeDoc({ steps: [], notes: [{ id: "n", text: "x".repeat(400_001) }] }, "d"), /too long/);
});

test("invalid docs do not compile", async () => {
  const result = compileDoc(doc(["authenticate"]), {
    users: new InMemoryUserDirectory(),
    verifyPassword,
    hashPassword,
    dummyPasswordHash: "x",
    sendCode: async () => {},
    webauthn,
  });
  assert.equal(result.ok, false);
});

test("ageOn handles birthdays and impossible dates", () => {
  const now = new Date(Date.UTC(2026, 9, 25));
  assert.equal(ageOn("2008-10-25", now), 18);
  assert.equal(ageOn("2008-10-26", now), 17);
  assert.equal(ageOn("2026-02-30", now), undefined);
  assert.equal(ageOn("2030-01-01", now), undefined);
  assert.equal(ageOn("25/10/2008", now), undefined);
});

/* ---------- running compiled flows ---------- */

test("starter settings change the first screen", async () => {
  const d = doc(["password", "authenticate"]);
  d.starter!.config = { title: "Welcome to Acme", help: "Use your work email." };
  const { first } = await setup(d);
  assert.equal(first.title, "Welcome to Acme");
  assert.equal(first.description, "Use your work email.");
});

test("starter -> age check -> password -> authenticate", async () => {
  const { engine, first } = await setup(doc(["age-check", "password", ["authenticate", { sessionHours: 12, welcome: "Hi there" }]]));
  assert.equal(first.nodeId, "start");
  const age = screen(await engine.submit(first.sessionId, "start", { email: "ADA@example.com" }));
  assert.equal(age.fields[0]!.type, "date");
  const pw = screen(await engine.submit(age.sessionId, "s0", { dob: "1990-01-01" }));
  const done = await engine.submit(pw.sessionId, "s1:enter", { password: "correct horse" });
  assert.equal(done.view.type === "complete" && done.view.status, "success");
  assert.equal(done.view.type === "complete" && done.view.title, "Hi there");
  assert.deepEqual(done.result!.factors, ["password"]);
  assert.equal(done.result!.sessionHours, 12);
});

test("age check enforces both minimum and maximum age", async () => {
  const flow = doc([["age-check", { minAge: 18, maxAge: 30 }], "password", "authenticate"]);
  for (const [dob, ok] of [["2015-06-01", false], ["1950-06-01", false], ["2000-06-01", true]] as const) {
    const { engine, first } = await setup(flow);
    const age = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
    assert.match(age.description!, /between 18 and 30/);
    const next = await engine.submit(age.sessionId, "s0", { dob });
    assert.equal(next.view.type === "screen", ok, `dob ${dob}`);
  }
});

test("password attempts setting ends the flow", async () => {
  const { engine, first } = await setup(doc([["password", { maxAttempts: 3 }], "authenticate"]));
  const pw = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  screen(await engine.submit(pw.sessionId, "s0:enter", { password: "x" }));
  screen(await engine.submit(pw.sessionId, "s0:enter", { password: "x" }));
  const end = await engine.submit(pw.sessionId, "s0:enter", { password: "x" });
  assert.equal(end.view.nodeId, "s0:fail");
});

test("sign-up: verified email, then create a password, then signed in", async () => {
  const { engine, first, sent, users } = await setup(doc(["email-code", ["password", { allowSignup: true, minLength: 12 }], "authenticate"]));
  const code = screen(await engine.submit(first.sessionId, "start", { email: "New@Example.com" }));
  assert.deepEqual(sent.map((s) => s.email), ["new@example.com"]);
  const create = screen(await engine.submit(code.sessionId, "s0:verify", { code: sent[0]!.code }));
  assert.equal(create.nodeId, "s1:create");

  const short = screen(await engine.submit(create.sessionId, "s1:create", { password: "short", confirm: "short" }));
  assert.match(short.fieldErrors!.password!, /at least 12/);
  const mismatch = screen(await engine.submit(create.sessionId, "s1:create", { password: "long enough pass", confirm: "other" }));
  assert.match(mismatch.fieldErrors!.confirm!, /do not match/);

  const done = await engine.submit(create.sessionId, "s1:create", { password: "long enough pass", confirm: "long enough pass" });
  assert.equal(done.view.type === "complete" && done.view.status, "success");
  assert.equal(done.result!.accountCreated, true);
  const user = await users.findByEmail("new@example.com");
  assert.ok(user && (await verifyPassword("long enough pass", user.passwordHash)));
});

test("without sign-up, unknown emails get no code and cannot pass", async () => {
  const { engine, first, sent } = await setup(doc(["email-code", "authenticate"]));
  const code = screen(await engine.submit(first.sessionId, "start", { email: "nobody@example.com" }));
  assert.equal(code.nodeId, "s0:verify");
  assert.equal(sent.length, 0);
  const wrong = screen(await engine.submit(code.sessionId, "s0:verify", { code: "123456" }));
  assert.match(wrong.error!, /not correct/);
});

test("verification email settings: resends and wrong-code limit", async () => {
  const noResend = await setup(doc([["email-code", { maxResends: 0, maxWrong: 2 }], "authenticate"]));
  const screen1 = screen(await noResend.engine.submit(noResend.first.sessionId, "start", { email: "ada@example.com" }));
  assert.deepEqual(screen1.fields.map((f) => f.name), ["code"]);
  const wrongCode = noResend.sent[0]!.code === "000000" ? "111111" : "000000";
  screen(await noResend.engine.submit(screen1.sessionId, "s0:verify", { code: wrongCode }));
  const end = await noResend.engine.submit(screen1.sessionId, "s0:verify", { code: wrongCode });
  assert.equal(end.view.nodeId, "s0:fail");

  const { engine, first, sent } = await setup(doc(["email-code", "authenticate"]));
  const c = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  const done = await engine.submit(c.sessionId, "s0:verify", { code: sent[0]!.code });
  assert.deepEqual(done.result!.factors, ["email"]);
});

test("Log Out / Deny ends the flow with its message", async () => {
  const { engine, first } = await setup(doc(["password", ["deny", { message: "Members only." }]]));
  const pw = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  const end = await engine.submit(pw.sessionId, "s0:enter", { password: "correct horse" });
  assert.equal(end.view.type === "complete" && end.view.status, "failure");
  assert.equal((end.view as { message: string }).message, "Members only.");
  assert.equal(end.result, undefined);
});

test("passkey settings: enrollment, PIN requirement, and enrollment switched off", async () => {
  const enroll = await setup(doc(["password", ["passkey", { requireVerification: true }], "authenticate"]));
  const pw = screen(await enroll.engine.submit(enroll.first.sessionId, "start", { email: "ada@example.com" }));
  const pk = screen(await enroll.engine.submit(pw.sessionId, "s0:enter", { password: "correct horse" }));
  assert.equal(pk.nodeId, "s1:verify");
  const passkey = pk.data!.passkey as { mode: string; options: { challenge: string; rp: { id: string }; authenticatorSelection: { userVerification: string } } };
  assert.equal(passkey.mode, "register");
  assert.equal(passkey.options.rp.id, "localhost");
  assert.equal(passkey.options.authenticatorSelection.userVerification, "required");

  const bad = screen(await enroll.engine.submit(pk.sessionId, "s1:verify", { credential: "{}" }));
  assert.match(bad.error!, /could not/);
  const fresh = bad.data!.passkey as { options: { challenge: string } };
  assert.notEqual(fresh.options.challenge, passkey.options.challenge);

  const off = await setup(doc(["password", ["passkey", { allowCreate: false }], "authenticate"]));
  const pw2 = screen(await off.engine.submit(off.first.sessionId, "start", { email: "ada@example.com" }));
  const end = await off.engine.submit(pw2.sessionId, "s0:enter", { password: "correct horse" });
  assert.equal(end.view.nodeId, "s1:missing");

  const direct = await setup(doc(["age-check", "passkey", "authenticate"]));
  const age = screen(await direct.engine.submit(direct.first.sessionId, "start", { email: "ada@example.com" }));
  const end2 = await direct.engine.submit(age.sessionId, "s0", { dob: "1990-01-01" });
  assert.equal(end2.view.nodeId, "s1:missing");
});

/* ---------- publishing helpers ---------- */

test("markdown keeps formatting and images but strips scripts", () => {
  const html = renderMarkdown(
    [
      "# Title",
      "**bold** [link](https://example.com) [bad](javascript:alert(1))",
      "![pic](https://example.com/a.png) ![tiny](data:image/png;base64,iVBORw0KGgo=) ![svg](data:image/svg+xml;base64,PHN2Zz4=)",
      "<script>alert(1)</script><img src=x onerror=alert(1)>",
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ].join("\n\n"),
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example.com" rel="noopener noreferrer nofollow" target="_blank"/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script|onerror|javascript:|svg\+xml/);
});

test("session tokens verify, expire, and are bound to one site", () => {
  const signer = new SessionSigner(Buffer.alloc(32, 7));
  const token = signer.sign({ u: "u1", s: "acme", exp: 2_000 });
  assert.deepEqual(signer.verify(token, "acme", 1_000), { u: "u1", s: "acme", exp: 2_000 });
  assert.equal(signer.verify(token, "acme", 3_000), undefined, "expired");
  assert.equal(signer.verify(token, "other", 1_000), undefined, "wrong site");
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "admin", s: "acme", exp: 9e15 })).toString("base64url");
  assert.equal(signer.verify(`${forged}.${mac}`, "acme", 1_000), undefined, "forged payload");
  assert.equal(signer.verify(`${body}.AAAA`, "acme", 1_000), undefined, "bad mac");
  assert.equal(new SessionSigner(Buffer.alloc(32, 8)).verify(token, "acme", 1_000), undefined, "other secret");
});

test("rate limiter allows a burst, then blocks until the window resets", () => {
  let t = 0;
  const rl = new RateLimiter(3, 1000, () => t);
  assert.deepEqual([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")], [true, true, true, false]);
  assert.equal(rl.take("b"), true);
  t = 1001;
  assert.equal(rl.take("a"), true);
});
