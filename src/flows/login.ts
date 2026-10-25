import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { FlowDefinition } from "../engine/types.js";
import { RETRY } from "../engine/types.js";

/*
 * Login flow
 *
 *   identify ──► password ──► mfa-check ──skip──────────────────────────► success
 *                   │             │
 *                   │             └─required─► send-code ──► verify-code ──ok──► success
 *                   │                              ▲              │  │
 *                   │                              └───resend─────┘  └─failed─► mfa-failed
 *                   └─locked──► locked
 */

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  mfaEnabled: boolean;
}

export interface UserDirectory {
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  isLocked(userId: string): Promise<boolean>;
  recordFailure(userId: string): Promise<{ locked: boolean }>;
  recordSuccess(userId: string): Promise<void>;
}

/** Delivers a one-time code, e.g. by email or SMS. */
export type CodeSender = (user: UserRecord, code: string) => Promise<void>;

export interface LoginFlowDeps {
  users: UserDirectory;
  sendCode: CodeSender;
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  /** A valid hash of some throwaway password, checked when the email is unknown so response time does not reveal it. */
  dummyPasswordHash: string;
  codeTtlMs?: number;
  maxCodeAttempts?: number;
  maxCodeSends?: number;
  now?: () => number;
}

const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

export function createLoginFlow(deps: LoginFlowDeps): FlowDefinition {
  const codeTtlMs = deps.codeTtlMs ?? 5 * 60 * 1000;
  const maxCodeAttempts = deps.maxCodeAttempts ?? 5;
  const maxCodeSends = deps.maxCodeSends ?? 3;
  const now = deps.now ?? Date.now;

  return {
    id: "login",
    start: "identify",
    nodes: [
      {
        id: "identify",
        kind: "screen",
        title: "Sign in",
        description: "Enter the email address for your account.",
        fields: [{ name: "email", label: "Email", type: "email", required: true, autocomplete: "username", maxLength: 254 }],
        // Always continue to the password screen, so this step does not reveal whether the account exists.
        handle: async ({ email }) => {
          const user = await deps.users.findByEmail(email!);
          return { outcome: "next", context: { email, userId: user?.id ?? null } };
        },
      },
      {
        id: "password",
        kind: "screen",
        title: "Enter your password",
        submitLabel: "Sign in",
        fields: [{ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password", maxLength: 1024 }],
        render: (ctx) => ({ email: ctx.email }),
        handle: async ({ password }, ctx) => {
          const userId = ctx.userId as string | null;
          const user = userId ? await deps.users.findById(userId) : undefined;

          if (!user) {
            await deps.verifyPassword(password!, deps.dummyPasswordHash);
            return { outcome: RETRY, error: GENERIC_LOGIN_ERROR };
          }
          if (await deps.users.isLocked(user.id)) return { outcome: "locked" };

          if (!(await deps.verifyPassword(password!, user.passwordHash))) {
            const { locked } = await deps.users.recordFailure(user.id);
            return locked ? { outcome: "locked" } : { outcome: RETRY, error: GENERIC_LOGIN_ERROR };
          }
          await deps.users.recordSuccess(user.id);
          return { outcome: "ok", context: { passwordVerified: true } };
        },
      },
      {
        id: "mfa-check",
        kind: "logic",
        run: async (ctx) => {
          const user = await deps.users.findById(ctx.userId as string);
          if (!user) return { outcome: "skip" }; // unreachable: password step guarantees a user
          return { outcome: user.mfaEnabled ? "required" : "skip" };
        },
      },
      {
        id: "send-code",
        kind: "logic",
        run: async (ctx) => {
          const sends = (ctx.codeSends as number | undefined) ?? 0;
          if (sends >= maxCodeSends) return { outcome: "sent", context: { codeNotice: "No more codes can be sent. Use the last code you received." } };

          const user = (await deps.users.findById(ctx.userId as string))!;
          const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
          await deps.sendCode(user, code);
          return {
            outcome: "sent",
            context: {
              codeHash: hashCode(code),
              codeExpiresAt: now() + codeTtlMs,
              codeAttempts: 0,
              codeSends: sends + 1,
              codeNotice: sends === 0 ? undefined : "A new code has been sent.",
            },
          };
        },
      },
      {
        id: "verify-code",
        kind: "screen",
        title: "Check your email",
        submitLabel: "Verify",
        fields: [
          { name: "code", label: "Verification code", type: "otp", autocomplete: "one-time-code", maxLength: 6, pattern: /^\d{6}$/ },
          { name: "resend", label: "Send me a new code", type: "checkbox" },
        ],
        render: (ctx) => ({ sentTo: maskEmail(ctx.email as string), notice: ctx.codeNotice }),
        handle: async ({ code, resend }, ctx) => {
          if (resend === "true") return { outcome: "resend" };
          if (!code) return { outcome: RETRY, fieldErrors: { code: "Verification code is required." }, context: { codeNotice: undefined } };

          const attempts = ((ctx.codeAttempts as number | undefined) ?? 0) + 1;
          if (now() > (ctx.codeExpiresAt as number)) {
            return { outcome: RETRY, error: "That code has expired. Request a new one.", context: { codeAttempts: attempts, codeNotice: undefined } };
          }
          if (!sameHash(hashCode(code), ctx.codeHash as string)) {
            if (attempts >= maxCodeAttempts) return { outcome: "failed" };
            return { outcome: RETRY, error: "That code is not correct.", context: { codeAttempts: attempts, codeNotice: undefined } };
          }
          return { outcome: "ok", context: { codeHash: undefined, mfaVerified: true } };
        },
      },
      {
        id: "success",
        kind: "terminal",
        status: "success",
        title: "You're signed in",
        result: (ctx) => ({ userId: ctx.userId, mfa: ctx.mfaVerified === true }),
      },
      {
        id: "locked",
        kind: "terminal",
        status: "failure",
        title: "Account temporarily locked",
        message: "Too many failed attempts. Try again in a few minutes.",
      },
      {
        id: "mfa-failed",
        kind: "terminal",
        status: "failure",
        title: "Verification failed",
        message: "Too many incorrect codes. Start again to get a new one.",
      },
    ],
    transitions: {
      identify: { next: "password" },
      password: { ok: "mfa-check", locked: "locked" },
      "mfa-check": { required: "send-code", skip: "success" },
      "send-code": { sent: "verify-code" },
      "verify-code": { ok: "success", resend: "send-code", failed: "mfa-failed" },
    },
  };
}
