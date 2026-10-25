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

export type SettingValue = number | boolean | string;

export type SettingSpec =
  | { kind: "number"; key: string; label: string; help?: string; min: number; max: number; default: number }
  | { kind: "boolean"; key: string; label: string; help?: string; default: boolean }
  | { kind: "text"; key: string; label: string; help?: string; maxLength: number; default: string };

/** Settings the Starter node exposes. */
export const STARTER_SETTINGS: SettingSpec[] = [
  { kind: "text", key: "title", label: "Screen title", maxLength: 80, default: "Sign in" },
  { kind: "text", key: "help", label: "Help text", maxLength: 200, default: "Enter your email to continue." },
];

/** Settings each step type exposes in the whiteboard. */
export const STEP_SETTINGS: Record<StepType, SettingSpec[]> = {
  authenticate: [
    { kind: "number", key: "sessionHours", label: "Keep users signed in for (hours)", help: "Used by published sites.", min: 1, max: 720, default: 24 },
    { kind: "text", key: "welcome", label: "Success message", maxLength: 120, default: "You're signed in" },
  ],
  password: [
    { kind: "number", key: "maxAttempts", label: "Wrong passwords allowed before deny", min: 1, max: 10, default: 5 },
    {
      kind: "boolean",
      key: "allowSignup",
      label: "Allow creating new accounts",
      help: "Unknown emails are asked to choose a password. This reveals which emails have accounts.",
      default: false,
    },
    { kind: "number", key: "minLength", label: "Minimum length for new passwords", min: 8, max: 64, default: 10 },
  ],
  "email-code": [
    { kind: "number", key: "codeMinutes", label: "Code valid for (minutes)", min: 1, max: 30, default: 5 },
    { kind: "number", key: "maxWrong", label: "Wrong codes allowed before deny", min: 1, max: 10, default: 5 },
    { kind: "number", key: "maxResends", label: "Resends allowed", min: 0, max: 5, default: 2 },
  ],
  "age-check": [
    { kind: "number", key: "minAge", label: "Minimum age required", min: 0, max: 120, default: 18 },
    { kind: "number", key: "maxAge", label: "Maximum age required", min: 1, max: 150, default: 150 },
  ],
  passkey: [
    {
      kind: "boolean",
      key: "allowCreate",
      label: "Allow creating new passkey",
      help: "Users without a passkey can add one here, if an earlier node proved who they are.",
      default: true,
    },
    {
      kind: "boolean",
      key: "requireVerification",
      label: "Require PIN or biometrics",
      help: "Rejects passkeys that only prove the device is present.",
      default: false,
    },
  ],
  deny: [{ kind: "text", key: "message", label: "Message shown", maxLength: 200, default: "This flow ends here. You have been signed out." }],
};

export type Settings = Record<string, SettingValue>;

export interface BuilderStep {
  id: string;
  type: StepType;
  config: Settings;
}

export interface BuilderNote {
  id: string;
  /** Markdown. May contain image links, including small pasted images as data URLs. */
  text: string;
  x: number;
  y: number;
}

export interface BuilderDoc {
  id: string;
  name: string;
  /** null until the user clicks "Start with a Starter Node". */
  starter: { identifier: "email"; config: Settings } | null;
  steps: BuilderStep[];
  notes: BuilderNote[];
  updatedAt: number;
}

export interface Problem {
  level: "error" | "warning";
  message: string;
  /** The step this is about. "starter" for the Starter node. */
  stepId?: string;
}

/** Fills in defaults and coerces values to the declared kinds and ranges. */
export function normalizeSettings(specs: SettingSpec[], raw: unknown): Settings {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Settings = {};
  for (const spec of specs) {
    const v = input[spec.key];
    if (spec.kind === "number") {
      const n = Number(v);
      out[spec.key] = v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, Math.round(n))) : spec.default;
    } else if (spec.kind === "boolean") {
      out[spec.key] = typeof v === "boolean" ? v : spec.default;
    } else {
      out[spec.key] = typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, spec.maxLength) || spec.default : spec.default;
    }
  }
  return out;
}
