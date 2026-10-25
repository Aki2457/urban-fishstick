import { randomUUID } from "node:crypto";
import { MemorySessionStore } from "./session-store.js";
import type {
  FlowContext,
  FlowDefinition,
  FlowNode,
  FlowSession,
  FlowStep,
  FlowView,
  NodeHelpers,
  NodeResult,
  ScreenNode,
  SessionStore,
  TerminalNode,
} from "./types.js";
import { RETRY } from "./types.js";
import { assertValidFlow, cleanAndValidateInput } from "./validation.js";

export class FlowError extends Error {
  constructor(message: string, public readonly code: "UNKNOWN_FLOW" | "SESSION_NOT_FOUND" | "FLOW_COMPLETE" | "BROKEN_FLOW") {
    super(message);
    this.name = "FlowError";
  }
}

export interface FlowEngineOptions {
  store?: SessionStore;
  /** Upper bound on logic nodes run back to back, to catch loops in a flow. */
  maxAutoSteps?: number;
}

/**
 * Runs flows. Typical use from an HTTP handler:
 *
 *   const step = await engine.start("login");          // first screen
 *   const next = await engine.submit(id, nodeId, body); // after each form post
 *
 * The client only ever sees the current screen. The context stays on the server.
 */
export class FlowEngine {
  private readonly flows = new Map<string, { def: FlowDefinition; nodes: Map<string, FlowNode> }>();
  private readonly store: SessionStore;
  private readonly maxAutoSteps: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: FlowEngineOptions = {}) {
    this.store = options.store ?? new MemorySessionStore();
    this.maxAutoSteps = options.maxAutoSteps ?? 50;
  }

  register(flow: FlowDefinition): this {
    assertValidFlow(flow);
    this.flows.set(flow.id, { def: flow, nodes: new Map(flow.nodes.map((n) => [n.id, n])) });
    return this;
  }

  /** Starts a new run and returns the first screen (or a terminal, if the flow decides immediately). */
  async start(flowId: string): Promise<FlowStep> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new FlowError(`Unknown flow "${flowId}"`, "UNKNOWN_FLOW");

    const now = Date.now();
    const session: FlowSession = {
      id: randomUUID(),
      flowId,
      currentNodeId: flow.def.start,
      context: flow.def.initialContext?.() ?? {},
      createdAt: now,
      updatedAt: now,
      completed: false,
    };
    return this.withLock(session.id, () => this.advance(session, flow.def.start, flow));
  }

  /** Returns the current view for a session without changing anything. */
  async current(sessionId: string): Promise<FlowStep> {
    const { session, flow } = await this.load(sessionId);
    const node = this.node(flow.nodes, session.currentNodeId);
    if (node.kind === "logic") throw new FlowError(`Session parked on logic node "${node.id}"`, "BROKEN_FLOW");
    return this.view(session, node);
  }

  /**
   * Submits input for the current screen.
   * `nodeId` is the screen the client was showing. If it is stale (double submit,
   * back button), the client gets the real current screen back with nothing applied.
   */
  async submit(sessionId: string, nodeId: string, rawInput: Record<string, unknown>): Promise<FlowStep> {
    return this.withLock(sessionId, async () => {
      const { session, flow } = await this.load(sessionId);
      if (session.completed) throw new FlowError("This flow has already finished.", "FLOW_COMPLETE");

      const node = this.node(flow.nodes, session.currentNodeId);
      if (node.kind !== "screen") throw new FlowError(`Session parked on non-screen node "${node.id}"`, "BROKEN_FLOW");

      if (nodeId !== node.id) {
        return this.view(session, node, { error: "This step is out of date. Please continue from here." });
      }

      const { input, errors } = cleanAndValidateInput(node.fields, rawInput ?? {});
      if (Object.keys(errors).length > 0) {
        return this.view(session, node, { fieldErrors: errors });
      }

      const result = await node.handle(input, session.context, this.helpers(session));
      return this.applyResult(session, flow, node, result);
    });
  }

  /** Abandons a run. */
  async cancel(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
  }

  /* ---------- internals ---------- */

  private async applyResult(
    session: FlowSession,
    flow: { def: FlowDefinition; nodes: Map<string, FlowNode> },
    node: FlowNode,
    result: NodeResult,
  ): Promise<FlowStep> {
    mergeContext(session.context, result.context);

    if (result.outcome === RETRY) {
      if (node.kind !== "screen") {
        throw new FlowError(`Logic node "${node.id}" returned "${RETRY}"; only screens can retry`, "BROKEN_FLOW");
      }
      await this.save(session);
      return this.view(session, node, { error: result.error, fieldErrors: result.fieldErrors });
    }

    const next = this.next(flow.def, node.id, result.outcome);
    return this.advance(session, next, flow);
  }

  /** Moves to `nodeId`, running logic nodes until a screen or terminal is reached. */
  private async advance(
    session: FlowSession,
    nodeId: string,
    flow: { def: FlowDefinition; nodes: Map<string, FlowNode> } | undefined,
  ): Promise<FlowStep> {
    const f = flow ?? this.flows.get(session.flowId)!;
    let current = nodeId;

    for (let steps = 0; ; steps++) {
      if (steps > this.maxAutoSteps) {
        throw new FlowError(`Flow "${f.def.id}" ran more than ${this.maxAutoSteps} logic steps in a row`, "BROKEN_FLOW");
      }
      const node = this.node(f.nodes, current);
      session.currentNodeId = node.id;

      if (node.kind === "logic") {
        const result = await node.run(session.context, this.helpers(session));
        if (result.outcome === RETRY) {
          throw new FlowError(`Logic node "${node.id}" returned "${RETRY}"; only screens can retry`, "BROKEN_FLOW");
        }
        mergeContext(session.context, result.context);
        current = this.next(f.def, node.id, result.outcome);
        continue;
      }

      if (node.kind === "terminal") {
        session.completed = true;
        // Finished runs are removed so a session id cannot be replayed.
        await this.store.delete(session.id);
        return this.view(session, node);
      }

      await this.save(session);
      return this.view(session, node);
    }
  }

  private view(session: FlowSession, node: ScreenNode | TerminalNode, extra: { error?: string; fieldErrors?: Record<string, string> } = {}): FlowStep {
    if (node.kind === "terminal") {
      const view: FlowView = {
        type: "complete",
        sessionId: session.id,
        nodeId: node.id,
        status: node.status,
        title: node.title,
        ...(node.message !== undefined && { message: node.message }),
      };
      return { view, ...(node.result && { result: node.result(session.context) }) };
    }

    const view: FlowView = {
      type: "screen",
      sessionId: session.id,
      nodeId: node.id,
      title: node.title,
      submitLabel: node.submitLabel ?? "Continue",
      fields: node.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required ?? false,
        ...(f.placeholder !== undefined && { placeholder: f.placeholder }),
        ...(f.autocomplete !== undefined && { autocomplete: f.autocomplete }),
        ...(f.minLength !== undefined && { minLength: f.minLength }),
        ...(f.maxLength !== undefined && { maxLength: f.maxLength }),
      })),
      ...(node.description !== undefined && { description: node.description }),
      ...(node.render && { data: node.render(session.context) }),
      ...(extra.error !== undefined && { error: extra.error }),
      ...(extra.fieldErrors !== undefined && Object.keys(extra.fieldErrors).length > 0 && { fieldErrors: extra.fieldErrors }),
    };
    return { view };
  }

  private next(def: FlowDefinition, from: string, outcome: string): string {
    const to = def.transitions[from]?.[outcome];
    if (!to) throw new FlowError(`Node "${from}" returned outcome "${outcome}" with no transition`, "BROKEN_FLOW");
    return to;
  }

  private node(nodes: Map<string, FlowNode>, id: string): FlowNode {
    const node = nodes.get(id);
    if (!node) throw new FlowError(`Unknown node "${id}"`, "BROKEN_FLOW");
    return node;
  }

  private async load(sessionId: string) {
    const session = await this.store.get(sessionId);
    if (!session) throw new FlowError("Session not found or expired.", "SESSION_NOT_FOUND");
    const flow = this.flows.get(session.flowId);
    if (!flow) throw new FlowError(`Unknown flow "${session.flowId}"`, "UNKNOWN_FLOW");
    return { session, flow };
  }

  private async save(session: FlowSession): Promise<void> {
    session.updatedAt = Date.now();
    await this.store.set(session);
  }

  private helpers(session: FlowSession): NodeHelpers {
    return { sessionId: session.id };
  }

  /** Serialises work per session so two quick submits cannot interleave. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }
}

function mergeContext(target: FlowContext, patch: FlowContext | undefined): void {
  if (patch) Object.assign(target, patch);
}
