import type { FieldDefinition, FieldErrors, FlowDefinition, FlowNode } from "./types.js";
import { RETRY } from "./types.js";

export class FlowDefinitionError extends Error {
  constructor(flowId: string, public readonly problems: string[]) {
    super(`Flow "${flowId}" is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "FlowDefinitionError";
  }
}

/**
 * Checks a flow definition for structural mistakes before it ever runs:
 * duplicate ids, a missing start node, transitions to unknown nodes,
 * non-terminal nodes with no way out, and nodes that can never be reached.
 */
export function assertValidFlow(flow: FlowDefinition): void {
  const problems: string[] = [];
  const byId = new Map<string, FlowNode>();

  for (const node of flow.nodes) {
    if (byId.has(node.id)) problems.push(`duplicate node id "${node.id}"`);
    byId.set(node.id, node);
  }

  if (!byId.has(flow.start)) problems.push(`start node "${flow.start}" does not exist`);

  for (const [from, outcomes] of Object.entries(flow.transitions)) {
    const node = byId.get(from);
    if (!node) {
      problems.push(`transitions defined for unknown node "${from}"`);
      continue;
    }
    if (node.kind === "terminal") problems.push(`terminal node "${from}" must not have transitions`);
    for (const [outcome, to] of Object.entries(outcomes)) {
      if (outcome === RETRY) problems.push(`node "${from}" maps reserved outcome "${RETRY}"; retry always stays on the current screen`);
      if (!byId.has(to)) problems.push(`node "${from}" outcome "${outcome}" points to unknown node "${to}"`);
    }
  }

  for (const node of flow.nodes) {
    if (node.kind === "terminal") continue;
    const outs = flow.transitions[node.id];
    if (!outs || Object.keys(outs).length === 0) problems.push(`node "${node.id}" has no outgoing transitions`);
    if (node.kind === "screen") {
      const names = new Set<string>();
      for (const field of node.fields) {
        if (names.has(field.name)) problems.push(`screen "${node.id}" has duplicate field "${field.name}"`);
        names.add(field.name);
      }
    }
  }

  // Reachability from start.
  if (byId.has(flow.start)) {
    const seen = new Set<string>([flow.start]);
    const queue = [flow.start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of Object.values(flow.transitions[id] ?? {})) {
        if (!seen.has(next) && byId.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const node of flow.nodes) {
      if (!seen.has(node.id)) problems.push(`node "${node.id}" is unreachable from start`);
    }
  }

  if (problems.length > 0) throw new FlowDefinitionError(flow.id, problems);
}

/**
 * Keeps only the fields the screen declares, coerces them to trimmed strings
 * (passwords are left untrimmed), and runs the declared rules.
 */
export function cleanAndValidateInput(
  fields: FieldDefinition[],
  raw: Record<string, unknown>,
): { input: Record<string, string>; errors: FieldErrors } {
  const input: Record<string, string> = {};
  const errors: FieldErrors = {};

  for (const field of fields) {
    const value = raw[field.name];
    let str: string;
    if (field.type === "checkbox") {
      str = value === true || value === "true" || value === "on" ? "true" : "";
    } else if (typeof value === "string") {
      str = field.type === "password" ? value : value.trim();
    } else if (typeof value === "number") {
      str = String(value);
    } else {
      str = "";
    }
    input[field.name] = str;
  }

  for (const field of fields) {
    const value = input[field.name] ?? "";
    if (value === "") {
      if (field.required) errors[field.name] = `${field.label} is required.`;
      continue;
    }
    if (field.minLength !== undefined && value.length < field.minLength) {
      errors[field.name] = `${field.label} must be at least ${field.minLength} characters.`;
    } else if (field.maxLength !== undefined && value.length > field.maxLength) {
      errors[field.name] = `${field.label} must be at most ${field.maxLength} characters.`;
    } else if (field.pattern && !field.pattern.test(value)) {
      errors[field.name] = `${field.label} is not in the expected format.`;
    } else if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors[field.name] = `${field.label} must be a valid email address.`;
    } else if (field.validate) {
      const message = field.validate(value, input);
      if (message) errors[field.name] = message;
    }
  }

  return { input, errors };
}
