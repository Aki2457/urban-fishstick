/**
 * Core types for the authentication flow engine.
 *
 * A flow is a directed graph of nodes:
 *  - ScreenNode:   shown to the user, collects input, then decides an outcome.
 *  - LogicNode:    runs on the server with no user input and decides an outcome.
 *  - TerminalNode: ends the flow with success or failure.
 *
 * Each non-terminal node returns an outcome name. The flow's transition table
 * maps (nodeId, outcome) to the next node.
 */

/** Server-side state shared by every node in one run of a flow. Never sent to the client. */
export type FlowContext = Record<string, unknown>;

export type FieldType = "text" | "email" | "password" | "otp" | "checkbox" | "hidden";

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  /** Hint for the client, e.g. "username" or "one-time-code". */
  autocomplete?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Custom check. Return an error message, or undefined when the value is fine. */
  validate?: (value: string, input: Record<string, string>) => string | undefined;
}

export type FieldErrors = Record<string, string>;

/**
 * What a node returns once it has done its work.
 * - outcome: picks the next node through the transition table.
 * - context: merged into the flow context before moving on.
 * - error / fieldErrors: only valid with outcome "retry"; keeps the user on the same screen.
 */
export interface NodeResult {
  outcome: string;
  context?: FlowContext;
  error?: string;
  fieldErrors?: FieldErrors;
}

/** Reserved outcome: stay on the current screen and show an error. */
export const RETRY = "retry";

export interface NodeHelpers {
  /** The session id of the current run. Useful for logging or rate limiting. */
  sessionId: string;
}

interface BaseNode {
  id: string;
}

export interface ScreenNode extends BaseNode {
  kind: "screen";
  title: string;
  description?: string;
  submitLabel?: string;
  fields: FieldDefinition[];
  /**
   * Called after field validation passes.
   * Return { outcome: RETRY, error } to keep the user on this screen.
   */
  handle: (input: Record<string, string>, ctx: FlowContext, helpers: NodeHelpers) => NodeResult | Promise<NodeResult>;
  /** Optional extra screen data computed from context, e.g. a masked email address. */
  render?: (ctx: FlowContext) => Record<string, unknown>;
}

export interface LogicNode extends BaseNode {
  kind: "logic";
  run: (ctx: FlowContext, helpers: NodeHelpers) => NodeResult | Promise<NodeResult>;
}

export interface TerminalNode extends BaseNode {
  kind: "terminal";
  status: "success" | "failure";
  title: string;
  message?: string;
  /** Builds the result handed to the caller on completion, e.g. a user id for issuing a session. */
  result?: (ctx: FlowContext) => Record<string, unknown>;
}

export type FlowNode = ScreenNode | LogicNode | TerminalNode;

export interface FlowDefinition {
  id: string;
  start: string;
  nodes: FlowNode[];
  /** transitions[nodeId][outcome] = nextNodeId */
  transitions: Record<string, Record<string, string>>;
  /** Builds the initial context for a new run. */
  initialContext?: () => FlowContext;
}

/* ---------- What the engine sends to the client ---------- */

export interface ClientField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  autocomplete?: string;
  minLength?: number;
  maxLength?: number;
}

export interface ScreenView {
  type: "screen";
  sessionId: string;
  nodeId: string;
  title: string;
  description?: string;
  submitLabel: string;
  fields: ClientField[];
  data?: Record<string, unknown>;
  error?: string;
  fieldErrors?: FieldErrors;
}

export interface CompleteView {
  type: "complete";
  sessionId: string;
  nodeId: string;
  status: "success" | "failure";
  title: string;
  message?: string;
}

export type FlowView = ScreenView | CompleteView;

/** Returned by the engine. `result` is server-only data from the terminal node; do not forward it blindly. */
export interface FlowStep {
  view: FlowView;
  result?: Record<string, unknown>;
}

/* ---------- Session storage ---------- */

export interface FlowSession {
  id: string;
  flowId: string;
  currentNodeId: string;
  context: FlowContext;
  createdAt: number;
  updatedAt: number;
  completed: boolean;
}

export interface SessionStore {
  get(id: string): Promise<FlowSession | undefined>;
  set(session: FlowSession): Promise<void>;
  delete(id: string): Promise<void>;
}
