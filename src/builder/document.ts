import { randomUUID } from "node:crypto";
import type { BuilderDoc, BuilderNote, BuilderStep, Problem, StepType } from "./types.js";
import { FACTOR_STEPS, normalizeSettings, STARTER_SETTINGS, STEP_SETTINGS, STEP_TYPES, TERMINAL_STEPS } from "./types.js";

export class BuilderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderInputError";
  }
}

/** noteText is large enough for a few small pasted images stored as data URLs. */
export const LIMITS = { name: 80, steps: 40, notes: 100, noteText: 400_000, totalNoteText: 2_000_000, coord: 20000 } as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses an untrusted document from the browser. Unknown properties are dropped,
 * ids are checked, settings are coerced and clamped, and missing settings get defaults.
 */
export function sanitizeDoc(raw: unknown, id: string): BuilderDoc {
  if (!isObject(raw)) throw new BuilderInputError("Flow must be a JSON object.");

  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, LIMITS.name) : "";

  let starter: BuilderDoc["starter"] = null;
  if (raw.starter !== null && raw.starter !== undefined) {
    if (!isObject(raw.starter) || raw.starter.identifier !== "email") throw new BuilderInputError("Unsupported starter node.");
    starter = { identifier: "email", config: normalizeSettings(STARTER_SETTINGS, raw.starter.config) };
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
    return { id: s.id, type, config: normalizeSettings(STEP_SETTINGS[type], s.config) };
  });

  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
  if (rawNotes.length > LIMITS.notes) throw new BuilderInputError(`A flow can have at most ${LIMITS.notes} notes.`);
  let total = 0;
  const notes: BuilderNote[] = rawNotes.map((n, i) => {
    if (!isObject(n) || typeof n.id !== "string" || !ID_RE.test(n.id)) throw new BuilderInputError(`Note ${i + 1} is malformed.`);
    const text = typeof n.text === "string" ? n.text : "";
    if (text.length > LIMITS.noteText) throw new BuilderInputError(`Note ${i + 1} is too long. Use image links instead of pasting large images.`);
    total += text.length;
    return { id: n.id, text, x: clampCoord(n.x), y: clampCoord(n.y) };
  });
  if (total > LIMITS.totalNoteText) throw new BuilderInputError("Notes are too large in total. Use image links instead of pasting large images.");

  return { id, name: name || "Untitled flow", starter, steps, notes, updatedAt: Date.now() };
}

export function newDoc(name = "Untitled flow"): BuilderDoc {
  return { id: shortId(), name, starter: null, steps: [], notes: [], updatedAt: Date.now() };
}

export function newStarter(): NonNullable<BuilderDoc["starter"]> {
  return { identifier: "email", config: normalizeSettings(STARTER_SETTINGS, {}) };
}

export function newStep(id: string, type: StepType, config: Record<string, unknown> = {}): BuilderStep {
  return { id, type, config: normalizeSettings(STEP_SETTINGS[type], config) };
}

export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Rules a flow must meet before it can run. Errors block running; warnings do not.
 */
export interface CheckOptions {
  /** Email is switched on in Settings. When off, Verification Email nodes are an error. */
  emailEnabled?: boolean;
  /** Email is on but its settings have errors. Verification Email nodes are an error until fixed. */
  emailReady?: boolean;
}

export function checkDoc(doc: BuilderDoc, opts: CheckOptions = {}): Problem[] {
  const emailEnabled = opts.emailEnabled ?? true;
  const problems: Problem[] = [];
  const { steps } = doc;

  if (!doc.starter) problems.push({ level: "error", stepId: "starter", message: "Add a Starter Node. It asks the user for their email." });
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
    const c = step.config;

    if (step.type === "email-code" && !emailEnabled) {
      problems.push({ level: "error", stepId: step.id, message: "Email is turned off in Settings. Remove Verification Email or turn email on." });
    } else if (step.type === "email-code" && opts.emailReady === false) {
      problems.push({ level: "error", stepId: step.id, message: "Email settings have errors, so codes can't be sent. Fix them in Settings." });
    }

    if (step.type === "authenticate" && !before.some((s) => FACTOR_STEPS.has(s.type))) {
      problems.push({
        level: "error",
        stepId: step.id,
        message: "Authenticate needs Enter Password, Verification Email or Passkey before it. Otherwise anyone who types an email gets in.",
      });
    }

    if (step.type === "age-check" && (c.minAge as number) > (c.maxAge as number)) {
      problems.push({ level: "error", stepId: step.id, message: "Minimum age is higher than maximum age, so nobody can pass." });
    }

    if (step.type === "passkey") {
      if (!c.allowCreate) {
        problems.push({
          level: "warning",
          stepId: step.id,
          message: "Creating new passkeys is off, so only users who already have a passkey can get past this node.",
        });
      } else if (!before.some((s) => s.type === "password" || s.type === "email-code")) {
        problems.push({
          level: "warning",
          stepId: step.id,
          message: "Users without a passkey cannot sign in here. Put Enter Password or Verification Email before Passkey to let them create one.",
        });
      }
    }

    if (step.type === "password" && c.allowSignup && !before.some((s) => s.type === "email-code")) {
      problems.push({
        level: "warning",
        stepId: step.id,
        message: emailEnabled
          ? "Anyone can create an account for an email they don't own. Put Verification Email before Enter Password to prove the email first."
          : "Anyone can create an account for an email they don't own. Turn email on in Settings and put Verification Email before Enter Password.",
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
