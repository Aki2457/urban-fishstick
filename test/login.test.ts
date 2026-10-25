import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginFlow, FlowEngine, hashPassword, InMemoryUserDirectory, verifyPassword } from "../src/index.js";
import type { FlowStep, ScreenView } from "../src/index.js";

function screen(step: FlowStep): ScreenView {
  assert.equal(step.view.type, "screen", `expected a screen, got ${JSON.stringify(step.view)}`);
  return step.view as ScreenView;
}

async function setup(opts: { maxFailures?: number; now?: () => number } = {}) {
  const users = new InMemoryUserDirectory(opts.maxFailures ?? 3)
    .add({ id: "u1", email: "ada@example.com", passwordHash: await hashPassword("correct horse"), mfaEnabled: false })
    .add({ id: "u2", email: "grace@example.com", passwordHash: await hashPassword("battery staple"), mfaEnabled: true });
  const sent: string[] = [];
  const engine = new FlowEngine().register(
    createLoginFlow({
      users,
      verifyPassword,
      dummyPasswordHash: await hashPassword("dummy"),
      sendCode: async (_user, code) => void sent.push(code),
      ...(opts.now && { now: opts.now }),
    }),
  );
  return { engine, sent };
}

async function toPassword(engine: FlowEngine, email: string) {
  const id = screen(await engine.start("login"));
  return screen(await engine.submit(id.sessionId, "identify", { email }));
}

test("password-only user signs in", async () => {
  const { engine } = await setup();
  const pw = await toPassword(engine, "ADA@example.com");
  assert.equal(pw.nodeId, "password");
  assert.equal(pw.data!.email, "ADA@example.com");
  const done = await engine.submit(pw.sessionId, "password", { password: "correct horse" });
  assert.equal(done.view.type, "complete");
  assert.deepEqual(done.result, { userId: "u1", mfa: false });
});

test("unknown email and wrong password give the same error", async () => {
  const { engine } = await setup();
  const a = await toPassword(engine, "nobody@example.com");
  const b = await toPassword(engine, "ada@example.com");
  const ea = screen(await engine.submit(a.sessionId, "password", { password: "x" }));
  const eb = screen(await engine.submit(b.sessionId, "password", { password: "x" }));
  assert.equal(ea.error, eb.error);
});

test("account locks after repeated failures, even with the right password", async () => {
  const { engine } = await setup({ maxFailures: 3 });
  const pw = await toPassword(engine, "ada@example.com");
  screen(await engine.submit(pw.sessionId, "password", { password: "x" }));
  screen(await engine.submit(pw.sessionId, "password", { password: "x" }));
  const locked = await engine.submit(pw.sessionId, "password", { password: "x" });
  assert.equal(locked.view.nodeId, "locked");

  const again = await toPassword(engine, "ada@example.com");
  const stillLocked = await engine.submit(again.sessionId, "password", { password: "correct horse" });
  assert.equal(stillLocked.view.nodeId, "locked");
});

test("MFA user must enter the emailed code", async () => {
  const { engine, sent } = await setup();
  const pw = await toPassword(engine, "grace@example.com");
  const otp = screen(await engine.submit(pw.sessionId, "password", { password: "battery staple" }));
  assert.equal(otp.nodeId, "verify-code");
  assert.equal(otp.data!.sentTo, "gr***@example.com");
  assert.equal(sent.length, 1);

  const wrongCode = sent[0] === "000000" ? "111111" : "000000";
  const wrong = screen(await engine.submit(otp.sessionId, "verify-code", { code: wrongCode }));
  assert.match(wrong.error!, /not correct/);

  const done = await engine.submit(otp.sessionId, "verify-code", { code: sent[0] });
  assert.deepEqual(done.result, { userId: "u2", mfa: true });
});

test("code never leaves the server in the view", async () => {
  const { engine, sent } = await setup();
  const pw = await toPassword(engine, "grace@example.com");
  const otp = await engine.submit(pw.sessionId, "password", { password: "battery staple" });
  assert.ok(!JSON.stringify(otp).includes(sent[0]!));
});

test("resend issues a new code and the old one stops working", async () => {
  const { engine, sent } = await setup();
  const pw = await toPassword(engine, "grace@example.com");
  const otp = screen(await engine.submit(pw.sessionId, "password", { password: "battery staple" }));
  const resent = screen(await engine.submit(otp.sessionId, "verify-code", { resend: "on" }));
  assert.equal(sent.length, 2);
  assert.match(String(resent.data!.notice), /new code/);

  if (sent[0] !== sent[1]) {
    const old = screen(await engine.submit(otp.sessionId, "verify-code", { code: sent[0] }));
    assert.match(old.error!, /not correct/);
  }
  const done = await engine.submit(otp.sessionId, "verify-code", { code: sent[1] });
  assert.equal(done.view.nodeId, "success");
});

test("too many wrong codes ends the flow", async () => {
  const { engine, sent } = await setup();
  const pw = await toPassword(engine, "grace@example.com");
  const otp = screen(await engine.submit(pw.sessionId, "password", { password: "battery staple" }));
  const wrongCode = sent[0] === "000000" ? "111111" : "000000";
  let step: FlowStep | undefined;
  for (let i = 0; i < 5; i++) step = await engine.submit(otp.sessionId, "verify-code", { code: wrongCode });
  assert.equal(step!.view.nodeId, "mfa-failed");
});

test("expired code is refused", async () => {
  let clock = 1_000_000;
  const { engine, sent } = await setup({ now: () => clock });
  const pw = await toPassword(engine, "grace@example.com");
  const otp = screen(await engine.submit(pw.sessionId, "password", { password: "battery staple" }));
  clock += 6 * 60 * 1000;
  const expired = screen(await engine.submit(otp.sessionId, "verify-code", { code: sent[0] }));
  assert.match(expired.error!, /expired/);
});

test("code format is checked before the handler runs", async () => {
  const { engine } = await setup();
  const pw = await toPassword(engine, "grace@example.com");
  const otp = screen(await engine.submit(pw.sessionId, "password", { password: "battery staple" }));
  const bad = screen(await engine.submit(otp.sessionId, "verify-code", { code: "12ab" }));
  assert.ok(bad.fieldErrors!.code);
});
