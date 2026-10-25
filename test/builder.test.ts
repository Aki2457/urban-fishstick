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
  sanitizeDoc,
  verifyPassword,
} from "../src/index.js";
import type { BuilderDoc, BuilderStep, FlowStep, ScreenView, StepType } from "../src/index.js";

function doc(types: StepType[], starter = true): BuilderDoc {
  const configs: Partial<Record<StepType, Record<string, number>>> = {
    "age-check": { minAge: 18 },
    password: { maxAttempts: 3 },
    "email-code": { codeMinutes: 5 },
  };
  const steps: BuilderStep[] = types.map((type, i) => ({ id: `s${i}`, type, config: configs[type] ?? {} }));
  return { id: "d1", name: "Test flow", starter: starter ? { identifier: "email" } : null, steps, notes: [], updatedAt: 1 };
}

function screen(step: FlowStep): ScreenView {
  assert.equal(step.view.type, "screen", `expected a screen, got ${JSON.stringify(step.view)}`);
  return step.view as ScreenView;
}

const NOW = Date.UTC(2026, 9, 25);

async function setup(d: BuilderDoc) {
  const users = new InMemoryUserDirectory().add({
    id: "u1",
    email: "ada@example.com",
    passwordHash: await hashPassword("correct horse"),
    mfaEnabled: false,
  });
  const sent: string[] = [];
  const compiled = compileDoc(d, {
    users,
    verifyPassword,
    dummyPasswordHash: await hashPassword("dummy"),
    sendCode: async (_u, code) => void sent.push(code),
    webauthn: { rpID: "localhost", rpName: "Test", origin: "http://localhost:3000" },
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

test("passkey with no way to enroll is a warning, not an error", () => {
  const d = doc(["age-check", "passkey", "authenticate"]);
  assert.deepEqual(errors(d), []);
  assert.match(warnings(d).join(), /cannot sign in here/);
  assert.deepEqual(warnings(doc(["password", "passkey", "authenticate"])), []);
});

test("sanitizeDoc drops junk, clamps settings and rejects bad input", () => {
  const clean = sanitizeDoc(
    {
      name: "  Mine  ",
      starter: { identifier: "email", extra: 1 },
      steps: [{ id: "a1", type: "age-check", config: { minAge: 900, evil: "x" } }],
      notes: [{ id: "n1", text: "hi", x: -5, y: 1e9 }],
      admin: true,
    },
    "doc1",
  );
  assert.equal(clean.name, "Mine");
  assert.deepEqual(clean.steps[0]!.config, { minAge: 120 });
  assert.deepEqual([clean.notes[0]!.x, clean.notes[0]!.y], [0, 20000]);
  assert.ok(!("admin" in clean));

  assert.throws(() => sanitizeDoc({ steps: [{ id: "x", type: "root-shell" }] }, "d"), BuilderInputError);
  assert.throws(() => sanitizeDoc({ steps: [{ id: "../../etc", type: "deny" }] }, "d"), BuilderInputError);
  assert.throws(() => sanitizeDoc({ steps: [{ id: "a", type: "deny" }, { id: "a", type: "deny" }] }, "d"), /Duplicate/);
});

test("invalid docs do not compile", async () => {
  const users = new InMemoryUserDirectory();
  const result = compileDoc(doc(["authenticate"]), {
    users,
    verifyPassword,
    dummyPasswordHash: "x",
    sendCode: async () => {},
    webauthn: { rpID: "localhost", rpName: "t", origin: "http://localhost" },
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

test("starter -> age check -> password -> authenticate", async () => {
  const { engine, first } = await setup(doc(["age-check", "password", "authenticate"]));
  assert.equal(first.nodeId, "start");
  const age = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  assert.equal(age.fields[0]!.type, "date");
  const pw = screen(await engine.submit(age.sessionId, "s0", { dob: "1990-01-01" }));
  const done = await engine.submit(pw.sessionId, "s1", { password: "correct horse" });
  assert.equal(done.view.type === "complete" && done.view.status, "success");
  assert.deepEqual(done.result!.factors, ["password"]);
});

test("under-age users are denied", async () => {
  const { engine, first } = await setup(doc(["age-check", "password", "authenticate"]));
  const age = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  const end = await engine.submit(age.sessionId, "s0", { dob: "2015-06-01" });
  assert.equal(end.view.type === "complete" && end.view.status, "failure");
  assert.match((end.view as { message: string }).message, /at least 18/);
});

test("password attempts setting ends the flow", async () => {
  const { engine, first } = await setup(doc(["password", "authenticate"]));
  const pw = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  screen(await engine.submit(pw.sessionId, "s0", { password: "x" }));
  screen(await engine.submit(pw.sessionId, "s0", { password: "x" }));
  const end = await engine.submit(pw.sessionId, "s0", { password: "x" });
  assert.equal(end.view.nodeId, "s0:fail");
});

test("unknown emails cannot pass any factor", async () => {
  const { engine, first } = await setup(doc(["email-code", "authenticate"]));
  const code = screen(await engine.submit(first.sessionId, "start", { email: "nobody@example.com" }));
  assert.equal(code.nodeId, "s0:verify");
  const wrong = screen(await engine.submit(code.sessionId, "s0:verify", { code: "123456" }));
  assert.match(wrong.error!, /not correct/);
});

test("verification email step sends a code and accepts it", async () => {
  const { engine, first, sent } = await setup(doc(["email-code", "authenticate"]));
  const code = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  assert.equal(sent.length, 1);
  const done = await engine.submit(code.sessionId, "s0:verify", { code: sent[0] });
  assert.deepEqual(done.result!.factors, ["email"]);
});

test("Log Out / Deny ends the flow with failure", async () => {
  const { engine, first } = await setup(doc(["password", "deny"]));
  const pw = screen(await engine.submit(first.sessionId, "start", { email: "ada@example.com" }));
  const end = await engine.submit(pw.sessionId, "s0", { password: "correct horse" });
  assert.equal(end.view.type === "complete" && end.view.status, "failure");
  assert.equal(end.result, undefined);
});

test("passkey step offers enrollment after a password, and stops users without one otherwise", async () => {
  const enroll = await setup(doc(["password", "passkey", "authenticate"]));
  const pw = screen(await enroll.engine.submit(enroll.first.sessionId, "start", { email: "ada@example.com" }));
  const pk = screen(await enroll.engine.submit(pw.sessionId, "s0", { password: "correct horse" }));
  assert.equal(pk.nodeId, "s1:verify");
  const passkey = pk.data!.passkey as { mode: string; options: { challenge: string; rp: { id: string } } };
  assert.equal(passkey.mode, "register");
  assert.equal(passkey.options.rp.id, "localhost");

  const bad = screen(await enroll.engine.submit(pk.sessionId, "s1:verify", { credential: "{}" }));
  assert.match(bad.error!, /could not/);
  const fresh = bad.data!.passkey as { options: { challenge: string } };
  assert.notEqual(fresh.options.challenge, passkey.options.challenge);

  const direct = await setup(doc(["age-check", "passkey", "authenticate"]));
  const age = screen(await direct.engine.submit(direct.first.sessionId, "start", { email: "ada@example.com" }));
  const end = await direct.engine.submit(age.sessionId, "s0", { dob: "1990-01-01" });
  assert.equal(end.view.nodeId, "s1:missing");
});
