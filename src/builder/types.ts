/**
 * The document the whiteboard edits. It is a plain, linear list of steps
 * after a Starter node, plus free-floating notes. The compiler turns it
 * into an engine FlowDefinition.
 */

export const STEP_TYPES = ["authenticate", "password", "email-code", "age-check", "passkey", "deny"] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Step types that end the flow. They must be the last step. */
export const TERMINAL_STEPS: ReadonlySet<StepType> = new Set(["authenticate", "deny"]);

/** Step types that prove who the user is. Authenticate needs at least one before it. */
export const FACTOR_STEPS: ReadonlySet<StepType> = new Set(["password", "email-code", "passkey"]);

export interface StepConfigSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

/** Settings each step type exposes in the whiteboard. */
export const STEP_CONFIG: Record<StepType, StepConfigSpec[]> = {
  authenticate: [],
  password: [{ key: "maxAttempts", label: "Wrong passwords allowed before deny", min: 1, max: 10, default: 5 }],
  "email-code": [{ key: "codeMinutes", label: "Code valid for (minutes)", min: 1, max: 30, default: 5 }],
  "age-check": [{ key: "minAge", label: "Minimum age", min: 1, max: 120, default: 18 }],
  passkey: [],
  deny: [],
};

export interface BuilderStep {
  id: string;
  type: StepType;
  config: Record<string, number>;
}

export interface BuilderNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface BuilderDoc {
  id: string;
  name: string;
  /** null until the user clicks "Start with a Starter Node". */
  starter: { identifier: "email" } | null;
  steps: BuilderStep[];
  notes: BuilderNote[];
  updatedAt: number;
}

export interface Problem {
  level: "error" | "warning";
  message: string;
  stepId?: string;
}
