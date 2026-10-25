import { randomUUID } from "node:crypto";
import type { BuilderDoc, BuilderNote, BuilderStep, Problem, StepType } from "./types.js";
import { FACTOR_STEPS, STEP_CONFIG, STEP_TYPES, TERMINAL_STEPS } from "./types.js";

export class BuilderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderInputError";
  }
}

export const LIMITS = { name: 80, steps: 40, notes: 100, noteText: 2000, coord: 20000 } as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses an untrusted document from the browser. Unknown properties are dropped,
 * ids are checked, numbers are clamped, and missing settings get defaults.
 */
export function sanitizeDoc(raw: unknown, id: string): BuilderDoc {
  if (!isObject(raw)) throw new BuilderInputError("Flow must be a JSON object.");

  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, LIMITS.name) : "";

  let starter: BuilderDoc["starter"] = null;
  if (raw.starter !== null && raw.starter !== undefined) {
    if (!isObject(raw.starter) || raw.starter.identifier !== "email") throw new BuilderInputError("Unsupported starter node.");
    starter = { identifier: "email" };
  }

  if (!Array.isArray(raw.steps)) throw new BuilderInputError("steps must be an array.");
  if (raw.steps.length > LIMITS.steps) throw new BuilderInputError(`A flow can have at most ${LIMITS.steps} nodes.`);
  const seen = new Set<string>();
  const steps: BuilderStep[] = raw.steps.map((s, i) => {
    if (!isObject(s)) throw new BuilderInputError(`Node ${i + 1} is malformed.`);
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) throw new BuilderInputError(`Node ${i + 1} has an invalid id.`);
    if (seen.has(s.id)) throw new BuilderInputError(`Duplicate node id "${s.id}".`);
    seen.add(s.id);
    if (!STEP_TYPES.includes(s.type as StepType)) throw new BuilderInputError(`Node ${i + 1} has an unknown type.`);
    const type = s.type as StepType;
    const rawConfig = isObject(s.config) ? s.config : {};
    const config: Record<string, number> = {};
    for (const spec of STEP_CONFIG[type]) {
      const v = Number(rawConfig[spec.key]);
      config[spec.key] = Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, Math.round(v))) : spec.default;
    }
    return { id: s.id, type, config };
  });

  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
  if (rawNotes.length > LIMITS.notes) throw new BuilderInputError(`A flow can have at most ${LIMITS.notes} notes.`);
  const notes: BuilderNote[] = rawNotes.map((n, i) => {
    if (!isObject(n) || typeof n.id !== "string" || !ID_RE.test(n.id)) throw new BuilderInputError(`Note ${i + 1} is malformed.`);
    return {
      id: n.id,
      text: typeof n.text === "string" ? n.text.slice(0, LIMITS.noteText) : "",
      x: clampCoord(n.x),
      y: clampCoord(n.y),
    };
  });

  return { id, name: name || "Untitled flow", starter, steps, notes, updatedAt: Date.now() };
}

export function newDoc(name = "Untitled flow"): BuilderDoc {
  return { id: shortId(), name, starter: null, steps: [], notes: [], updatedAt: Date.now() };
}

export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Rules a flow must meet before it can run. Errors block running; warnings do not.
 */
export function checkDoc(doc: BuilderDoc): Problem[] {
  const problems: Problem[] = [];
  const { steps } = doc;

  if (!doc.starter) problems.push({ level: "error", message: "Add a Starter Node. It asks the user for their email." });
  if (steps.length === 0) {
    problems.push({ level: "error", message: "Add nodes from the Toolbox. The flow must end with Authenticate or Log Out / Deny." });
    return problems;
  }

  steps.forEach((step, i) => {
    if (TERMINAL_STEPS.has(step.type) && i < steps.length - 1) {
      problems.push({ level: "error", stepId: step.id, message: `${label(step.type)} ends the flow, so it must be the last node. Nodes after it never run.` });
    }
  });

  const last = steps[steps.length - 1]!;
  if (!TERMINAL_STEPS.has(last.type)) {
    problems.push({ level: "error", stepId: last.id, message: "The flow must end with Authenticate or Log Out / Deny." });
  }

  steps.forEach((step, i) => {
    const before = steps.slice(0, i);
    if (step.type === "authenticate" && !before.some((s) => FACTOR_STEPS.has(s.type))) {
      problems.push({
        level: "error",
        stepId: step.id,
        message: "Authenticate needs Enter Password, Verification Email or Passkey before it. Otherwise anyone who types an email gets in.",
      });
    }
    if (step.type === "passkey" && !before.some((s) => s.type === "password" || s.type === "email-code")) {
      problems.push({
        level: "warning",
        stepId: step.id,
        message: "Users without a passkey cannot sign in here. Put Enter Password or Verification Email before Passkey to let them create one.",
      });
    }
    if (FACTOR_STEPS.has(step.type) && before.some((s) => s.type === step.type)) {
      problems.push({ level: "warning", stepId: step.id, message: `${label(step.type)} appears twice. The second one adds friction and no extra security.` });
    }
  });

  return problems;
}

export function label(type: StepType): string {
  return {
    authenticate: "Authenticate",
    password: "Enter Password",
    "email-code": "Verification Email",
    "age-check": "Age Check",
    passkey: "Passkey",
    deny: "Log Out / Deny",
  }[type];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampCoord(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(LIMITS.coord, Math.max(0, Math.round(n))) : 0;
}
