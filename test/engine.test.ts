import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowDefinitionError, FlowEngine, FlowError, MemorySessionStore, RETRY } from "../src/index.js";
import type { FlowDefinition, ScreenView } from "../src/index.js";

function screen(step: { view: unknown }): ScreenView {
  const view = step.view as ScreenView;
  assert.equal(view.type, "screen");
  return view;
}

const twoStep: FlowDefinition = {
  id: "two-step",
  start: "name",
  nodes: [
    {
      id: "name",
      kind: "screen",
      title: "Name",
      fields: [{ name: "name", label: "Name", type: "text", required: true, minLength: 2 }],
      handle: ({ name }) => (name === "bad" ? { outcome: RETRY, error: "nope" } : { outcome: "next", context: { name } }),
    },
    { id: "route", kind: "logic", run: (ctx) => ({ outcome: ctx.name === "admin" ? "deny" : "allow" }) },
    { id: "done", kind: "terminal", status: "success", title: "Done", result: (ctx) => ({ name: ctx.name }) },
    { id: "denied", kind: "terminal", status: "failure", title: "Denied" },
  ],
  transitions: { name: { next: "route" }, route: { allow: "done", deny: "denied" } },
};

test("runs screen -> logic -> terminal and returns the terminal result", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  assert.equal(first.nodeId, "name");
  assert.deepEqual(first.fields.map((f) => f.name), ["name"]);

  const end = await engine.submit(first.sessionId, "name", { name: "  ada  " });
  assert.equal(end.view.type, "complete");
  assert.equal(end.view.type === "complete" && end.view.status, "success");
  assert.deepEqual(end.result, { name: "ada" });
});

test("logic node picks the branch", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  const end = await engine.submit(first.sessionId, "name", { name: "admin" });
  assert.equal(end.view.nodeId, "denied");
});

test("field validation keeps the user on the screen with field errors", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  const again = screen(await engine.submit(first.sessionId, "name", { name: "a" }));
  assert.equal(again.nodeId, "name");
  assert.match(again.fieldErrors!.name!, /at least 2/);

  const missing = screen(await engine.submit(first.sessionId, "name", {}));
  assert.match(missing.fieldErrors!.name!, /required/);
});

test("handler retry shows an error on the same screen", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  const again = screen(await engine.submit(first.sessionId, "name", { name: "bad" }));
  assert.equal(again.error, "nope");
});

test("stale node id does not apply input", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  const stale = screen(await engine.submit(first.sessionId, "something-else", { name: "ada" }));
  assert.equal(stale.nodeId, "name");
  assert.match(stale.error!, /out of date/);
});

test("finished sessions cannot be reused", async () => {
  const engine = new FlowEngine().register(twoStep);
  const first = screen(await engine.start("two-step"));
  await engine.submit(first.sessionId, "name", { name: "ada" });
  await assert.rejects(engine.submit(first.sessionId, "name", { name: "ada" }), (e: unknown) => e instanceof FlowError && e.code === "SESSION_NOT_FOUND");
});

test("unknown fields are dropped before reaching the handler", async () => {
  let seen: Record<string, string> = {};
  const flow: FlowDefinition = {
    ...twoStep,
    id: "spy",
    nodes: twoStep.nodes.map((n) =>
      n.id === "name" && n.kind === "screen"
        ? { ...n, handle: (input) => ((seen = input), { outcome: "next", context: input }) }
        : n,
    ),
  };
  const engine = new FlowEngine().register(flow);
  const first = screen(await engine.start("spy"));
  await engine.submit(first.sessionId, "name", { name: "ada", isAdmin: "true" });
  assert.deepEqual(seen, { name: "ada" });
});

test("expired sessions are rejected", async () => {
  let clock = 1_000;
  const store = new MemorySessionStore(100, () => clock);
  const engine = new FlowEngine({ store }).register(twoStep);
  const first = screen(await engine.start("two-step"));
  // Engine stamps updatedAt with Date.now(); move the store clock far past it.
  clock = Date.now() + 1_000;
  await assert.rejects(engine.submit(first.sessionId, "name", { name: "ada" }), /expired/);
});

test("concurrent submits on one session run one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const flow: FlowDefinition = {
    id: "slow",
    start: "s",
    nodes: [
      {
        id: "s",
        kind: "screen",
        title: "S",
        fields: [{ name: "x", label: "X", type: "text" }],
        handle: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          return { outcome: RETRY, error: "again" };
        },
      },
      { id: "t", kind: "terminal", status: "success", title: "T" },
    ],
    transitions: { s: { go: "t" } },
  };
  const engine = new FlowEngine().register(flow);
  const first = screen(await engine.start("slow"));
  await Promise.all([1, 2, 3].map(() => engine.submit(first.sessionId, "s", { x: "1" })));
  assert.equal(maxActive, 1);
});

test("logic loops are caught", async () => {
  const flow: FlowDefinition = {
    id: "loop",
    start: "a",
    nodes: [
      { id: "a", kind: "logic", run: () => ({ outcome: "go" }) },
      { id: "b", kind: "logic", run: () => ({ outcome: "go" }) },
      { id: "t", kind: "terminal", status: "success", title: "T" },
    ],
    transitions: { a: { go: "b", never: "t" }, b: { go: "a" } },
  };
  const engine = new FlowEngine({ maxAutoSteps: 10 }).register(flow);
  await assert.rejects(engine.start("loop"), (e: unknown) => e instanceof FlowError && e.code === "BROKEN_FLOW");
});

test("invalid definitions are rejected at register time", () => {
  const bad: FlowDefinition = {
    id: "bad",
    start: "missing",
    nodes: [
      { id: "a", kind: "logic", run: () => ({ outcome: "x" }) },
      { id: "a", kind: "terminal", status: "success", title: "dup" },
      { id: "orphan", kind: "terminal", status: "failure", title: "o" },
    ],
    transitions: { a: { x: "nowhere" } },
  };
  assert.throws(
    () => new FlowEngine().register(bad),
    (e: unknown) => {
      assert.ok(e instanceof FlowDefinitionError);
      const text = e.problems.join("\n");
      assert.match(text, /duplicate node id "a"/);
      assert.match(text, /start node "missing"/);
      assert.match(text, /unknown node "nowhere"/);
      return true;
    },
  );
});
