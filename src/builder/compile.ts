import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FlowContext, FlowDefinition, FlowNode, NodeResult } from "../engine/types.js";
import { RETRY } from "../engine/types.js";
import type { StoredPasskey, UserDirectory, UserRecord } from "../flows/login.js";
import { checkDoc } from "./document.js";
import type { BuilderDoc, BuilderStep, Problem } from "./types.js";

export interface BuilderUserDirectory extends UserDirectory {
  /** Returns undefined if the email is already taken. */
  createUser(email: string, passwordHash: string): Promise<UserRecord | undefined>;
  addPasskey(userId: string, passkey: StoredPasskey): Promise<void>;
  updatePasskeyCounter(userId: string, credentialId: string, counter: number): Promise<void>;
}

export interface BuilderDeps {
  users: BuilderUserDirectory;
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  hashPassword: (password: string) => Promise<string>;
  /** Hash of a throwaway password, checked for unknown emails so timing does not reveal them. */
  dummyPasswordHash: string;
  /** Delivers a one-time code. `to` may be an email with no account yet, when the flow allows sign-up. */
  sendCode: (to: { email: string }, code: string, info: { ttlMinutes: number }) => Promise<void>;
  /** Testing mode: return false to turn an email away at the Starter node. Read on every sign-in. */
  isAllowed?: (email: string) => boolean;
  /** Whether email is switched on in Settings. Read when compiling. */
  emailEnabled?: () => boolean;
  webauthn: { rpID: string; rpName: string; origin: string };
  now?: () => number;
}

export type CompileResult = { ok: true; flow: FlowDefinition; problems: Problem[] } | { ok: false; problems: Problem[] };

const MAX_PASSKEY_ATTEMPTS = 5;
const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

/* ---------- context helpers ---------- */

function factors(ctx: FlowContext): string[] {
  return Array.isArray(ctx.factors) ? (ctx.factors as string[]) : [];
}

function withFactor(ctx: FlowContext, factor: string): FlowContext {
  const list = factors(ctx);
  return { factors: list.includes(factor) ? list : [...list, factor] };
}

/** Per-step state lives under one key, replaced as a whole, so two steps of the same type never collide. */
function stateKey(step: BuilderStep): string {
  return `step:${step.id}`;
}

function state<T extends object>(ctx: FlowContext, step: BuilderStep): Partial<T> {
  return (ctx[stateKey(step)] as Partial<T> | undefined) ?? {};
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

/** Whole years between a YYYY-MM-DD birth date and `now`. Returns undefined for impossible dates. */
export function ageOn(dob: string, now: Date): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  if (y < 1900 || date.getTime() > now.getTime()) return undefined;
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/* ---------- compiler ---------- */

/**
 * Turns a whiteboard document into a runnable flow.
 * Fails (ok: false) when checkDoc reports any error.
 */
export function compileDoc(doc: BuilderDoc, deps: BuilderDeps, flowId = `builder:${doc.id}`): CompileResult {
  const problems = checkDoc(doc, { emailEnabled: deps.emailEnabled?.() ?? true });
  if (problems.some((p) => p.level === "error")) return { ok: false, problems };

  const now = deps.now ?? Date.now;
  const nodes: FlowNode[] = [];
  const transitions: Record<string, Record<string, string>> = {};
  const entryOf = (i: number) => doc.steps[i]!.id;

  // Starter node: ask for the email and look the user up. Unknown emails continue, so this step reveals nothing.
  const starter = doc.starter!.config;
  const signupLater = doc.steps.some((s) => s.type === "password" && s.config.allowSignup === true);

  nodes.push({
    id: "start",
    kind: "screen",
    title: String(starter.title),
    description: String(starter.help),
    fields: [{ name: "email", label: "Email", type: "email", required: true, autocomplete: "username webauthn", maxLength: 254 }],
    handle: async ({ email }) => {
      if (deps.isAllowed && !deps.isAllowed(email!)) return { outcome: "blocked" };
      const user = await deps.users.findByEmail(email!);
      return { outcome: "next", context: { email: email!.toLowerCase(), userId: user?.id ?? null, factors: [] } };
    },
  });
  transitions.start = { next: entryOf(0), blocked: "start:blocked" };
  nodes.push({
    id: "start:blocked",
    kind: "terminal",
    status: "failure",
    title: "Invite only",
    message: "This app is in testing. Only invited testers can sign in right now.",
  });

  doc.steps.forEach((step, i) => {
    const next = i + 1 < doc.steps.length ? entryOf(i + 1) : undefined;
    const add = (node: FlowNode, outs?: Record<string, string>) => {
      nodes.push(node);
      if (outs) transitions[node.id] = outs;
    };
    const failTerminal = (title: string, message: string) => {
      const id = `${step.id}:fail`;
      add({ id, kind: "terminal", status: "failure", title, message });
      return id;
    };

    switch (step.type) {
      case "password": {
        const maxAttempts = step.config.maxAttempts as number;
        const allowSignup = step.config.allowSignup === true;
        const minLength = step.config.minLength as number;
        const failed = failTerminal("Access denied", "Too many incorrect passwords.");
        const locked = `${step.id}:locked`;
        add({ id: locked, kind: "terminal", status: "failure", title: "Account temporarily locked", message: "Too many failed attempts. Try again in a few minutes." });

        // Router: known users enter their password, unknown users create one if sign-up is on.
        add(
          {
            id: step.id,
            kind: "logic",
            run: (ctx) => ({ outcome: !ctx.userId && allowSignup ? "create" : "enter" }),
          },
          allowSignup ? { enter: `${step.id}:enter`, create: `${step.id}:create` } : { enter: `${step.id}:enter` },
        );

        add(
          {
            id: `${step.id}:enter`,
            kind: "screen",
            title: "Enter your password",
            submitLabel: "Continue",
            fields: [{ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password", maxLength: 1024 }],
            render: (ctx) => ({ email: ctx.email }),
            handle: async ({ password }, ctx): Promise<NodeResult> => {
              const attempts = (state<{ attempts: number }>(ctx, step).attempts ?? 0) + 1;
              const fail = (): NodeResult =>
                attempts >= maxAttempts
                  ? { outcome: "fail" }
                  : { outcome: RETRY, error: GENERIC_LOGIN_ERROR, context: { [stateKey(step)]: { attempts } } };

              const user = ctx.userId ? await deps.users.findById(ctx.userId as string) : undefined;
              if (!user) {
                await deps.verifyPassword(password!, deps.dummyPasswordHash);
                return fail();
              }
              if (await deps.users.isLocked(user.id)) return { outcome: "locked" };
              if (!(await deps.verifyPassword(password!, user.passwordHash))) {
                const { locked: nowLocked } = await deps.users.recordFailure(user.id);
                return nowLocked ? { outcome: "locked" } : fail();
              }
              await deps.users.recordSuccess(user.id);
              return { outcome: "pass", context: withFactor(ctx, "password") };
            },
          },
          { pass: next!, fail: failed, locked },
        );

        if (allowSignup) {
          add(
            {
              id: `${step.id}:create`,
              kind: "screen",
              title: "Create your account",
              submitLabel: "Create account",
              fields: [
                { name: "password", label: "Choose a password", type: "password", required: true, autocomplete: "new-password", minLength, maxLength: 1024 },
                {
                  name: "confirm",
                  label: "Repeat the password",
                  type: "password",
                  required: true,
                  autocomplete: "new-password",
                  maxLength: 1024,
                  validate: (v, input) => (v !== input.password ? "The passwords do not match." : undefined),
                },
              ],
              render: (ctx) => ({ email: ctx.email, description: `There is no account for ${String(ctx.email)} yet. Choose a password to create one.` }),
              handle: async ({ password }, ctx): Promise<NodeResult> => {
                const user = await deps.users.createUser(ctx.email as string, await deps.hashPassword(password!));
                if (!user) return { outcome: RETRY, error: "An account with this email was just created. Start again to sign in." };
                return { outcome: "pass", context: { userId: user.id, accountCreated: true, ...withFactor(ctx, "password") } };
              },
            },
            { pass: next! },
          );
        }
        break;
      }

      case "email-code": {
        const ttlMs = (step.config.codeMinutes as number) * 60_000;
        const maxWrong = step.config.maxWrong as number;
        const maxSends = 1 + (step.config.maxResends as number);
        const failed = failTerminal("Verification failed", "Too many incorrect codes. Start again to get a new one.");
        type CodeState = { codeHash: string; expiresAt: number; attempts: number; sends: number; notice?: string };
        add(
          {
            id: step.id,
            kind: "logic",
            run: async (ctx) => {
              const prev = state<CodeState>(ctx, step);
              const sends = prev.sends ?? 0;
              if (sends >= maxSends) {
                return { outcome: "sent", context: { [stateKey(step)]: { ...prev, notice: "No more codes can be sent. Use the last code you received." } } };
              }
              const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
              const user = ctx.userId ? await deps.users.findById(ctx.userId as string) : undefined;
              // With sign-up on, new emails get a real code so they can prove they own the address.
              // Otherwise unknown emails get the same screen, with a code nobody received.
              const deliver = !!user || signupLater;
              let sent = deliver;
              if (deliver) {
                try {
                  await deps.sendCode({ email: String(ctx.email) }, code, { ttlMinutes: ttlMs / 60_000 });
                } catch (err) {
                  // Keep the user on the code screen with a clear message. The reason goes to the server log only.
                  console.error(`[email] code for ${String(ctx.email)} not sent: ${err instanceof Error ? err.message : String(err)}`);
                  sent = false;
                }
              }
              const failedNotice = "We couldn't send the email right now. Try \"Send me a new code\" in a moment.";
              const next: CodeState = {
                codeHash: sent ? sha256(code) : sha256(randomBytes(16).toString("hex")),
                expiresAt: now() + ttlMs,
                attempts: 0,
                sends: sends + 1,
                ...(deliver && !sent ? { notice: failedNotice } : sends > 0 ? { notice: "A new code has been sent." } : {}),
              };
              return { outcome: "sent", context: { [stateKey(step)]: next } };
            },
          },
          { sent: `${step.id}:verify` },
        );
        add(
          {
            id: `${step.id}:verify`,
            kind: "screen",
            title: "Check your email",
            submitLabel: "Verify",
            fields: [
              { name: "code", label: "Verification code", type: "otp", autocomplete: "one-time-code", maxLength: 6, pattern: /^\d{6}$/ },
              ...(maxSends > 1 ? [{ name: "resend", label: "Send me a new code", type: "checkbox" as const }] : []),
            ],
            render: (ctx) => ({ sentTo: maskEmail(String(ctx.email ?? "")), notice: state<CodeState>(ctx, step).notice }),
            handle: async ({ code, resend }, ctx): Promise<NodeResult> => {
              const st = state<CodeState>(ctx, step) as CodeState;
              if (resend === "true") return { outcome: "resend" };
              const quiet = { ...st, notice: undefined };
              if (!code) return { outcome: RETRY, fieldErrors: { code: "Verification code is required." }, context: { [stateKey(step)]: quiet } };
              const attempts = st.attempts + 1;
              if (now() > st.expiresAt) {
                return { outcome: RETRY, error: "That code has expired. Request a new one.", context: { [stateKey(step)]: { ...quiet, attempts } } };
              }
              if (!sameHex(sha256(code), st.codeHash)) {
                if (attempts >= maxWrong) return { outcome: "fail" };
                return { outcome: RETRY, error: "That code is not correct.", context: { [stateKey(step)]: { ...quiet, attempts } } };
              }
              return { outcome: "pass", context: { ...withFactor(ctx, "email"), emailVerified: ctx.email, [stateKey(step)]: undefined } };
            },
          },
          { pass: next!, resend: step.id, fail: failed },
        );
        break;
      }

      case "age-check": {
        const minAge = step.config.minAge as number;
        const maxAge = step.config.maxAge as number;
        const rule = maxAge >= 150 ? `at least ${minAge}` : minAge <= 0 ? `${maxAge} or younger` : `between ${minAge} and ${maxAge}`;
        const failed = failTerminal("Access denied", `You must be ${rule} to continue.`);
        add(
          {
            id: step.id,
            kind: "screen",
            title: "Confirm your age",
            description: `You must be ${rule} to continue.`,
            fields: [
              {
                name: "dob",
                label: "Date of birth",
                type: "date",
                required: true,
                autocomplete: "bday",
                validate: (v) => (ageOn(v, new Date(now())) === undefined ? "Enter a real date of birth." : undefined),
              },
            ],
            handle: async ({ dob }): Promise<NodeResult> => {
              const age = ageOn(dob!, new Date(now()))!;
              return { outcome: age >= minAge && age <= maxAge ? "pass" : "fail" };
            },
          },
          { pass: next!, fail: failed },
        );
        break;
      }

      case "passkey": {
        type PasskeyState = { mode: "login" | "register"; challenge: string; options: unknown; attempts: number };
        const allowCreate = step.config.allowCreate === true;
        const requireUV = step.config.requireVerification === true;
        const uv = requireUV ? "required" : "preferred";
        const failed = failTerminal("Passkey check failed", "We could not verify your passkey.");
        const missing = `${step.id}:missing`;
        add({
          id: missing,
          kind: "terminal",
          status: "failure",
          title: "No passkey available",
          message: allowCreate
            ? "There is no passkey for this account. Sign in with a flow that lets you add one first."
            : "This sign-in only accepts passkeys that are already set up, and there is none for this account.",
        });

        const prepare = async (ctx: FlowContext, attempts: number): Promise<PasskeyState | undefined> => {
          const user = ctx.userId ? await deps.users.findById(ctx.userId as string) : undefined;
          if (!user) return undefined;
          const passkeys = user.passkeys ?? [];
          if (passkeys.length > 0) {
            const options = await generateAuthenticationOptions({
              rpID: deps.webauthn.rpID,
              userVerification: uv,
              allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] | undefined })),
            });
            return { mode: "login", challenge: options.challenge, options, attempts };
          }
          // Enrolling is only safe once an earlier step has proved who this is.
          if (!allowCreate || factors(ctx).length === 0) return undefined;
          const options = await generateRegistrationOptions({
            rpName: deps.webauthn.rpName,
            rpID: deps.webauthn.rpID,
            userName: user.email,
            userID: new TextEncoder().encode(user.id),
            attestationType: "none",
            authenticatorSelection: { residentKey: "preferred", userVerification: uv },
          });
          return { mode: "register", challenge: options.challenge, options, attempts };
        };

        add(
          {
            id: step.id,
            kind: "logic",
            run: async (ctx) => {
              const st = await prepare(ctx, 0);
              return st ? { outcome: "ready", context: { [stateKey(step)]: st } } : { outcome: "missing" };
            },
          },
          { ready: `${step.id}:verify`, missing },
        );

        add(
          {
            id: `${step.id}:verify`,
            kind: "screen",
            title: "Use your passkey",
            submitLabel: "Continue with passkey",
            fields: [{ name: "credential", label: "Passkey", type: "passkey", required: true, maxLength: 8000 }],
            render: (ctx) => {
              const st = state<PasskeyState>(ctx, step);
              return {
                email: ctx.email,
                passkey: { mode: st.mode, options: st.options },
                description:
                  st.mode === "register"
                    ? "Create a passkey for this account. Next time you can use it to sign in."
                    : "Confirm it's you with the passkey saved on this device.",
              };
            },
            handle: async ({ credential }, ctx): Promise<NodeResult> => {
              const st = state<PasskeyState>(ctx, step) as PasskeyState;
              const user = (await deps.users.findById(ctx.userId as string))!;
              const retry = async (error: string): Promise<NodeResult> => {
                const attempts = st.attempts + 1;
                if (attempts >= MAX_PASSKEY_ATTEMPTS) return { outcome: "fail" };
                // Fresh challenge on every attempt, so a captured response cannot be replayed.
                const fresh = await prepare(ctx, attempts);
                if (!fresh) return { outcome: "fail" };
                return { outcome: RETRY, error, context: { [stateKey(step)]: fresh } };
              };

              let response: unknown;
              try {
                response = JSON.parse(credential!);
              } catch {
                return retry("The passkey response was malformed. Try again.");
              }
              const expected = { expectedChallenge: st.challenge, expectedOrigin: deps.webauthn.origin, expectedRPID: deps.webauthn.rpID };

              try {
                if (st.mode === "register") {
                  const result = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, ...expected, requireUserVerification: requireUV });
                  if (!result.verified) return retry("We could not create that passkey. Try again.");
                  const c = result.registrationInfo.credential;
                  await deps.users.addPasskey(user.id, {
                    id: c.id,
                    publicKey: c.publicKey,
                    counter: c.counter,
                    ...(c.transports && { transports: c.transports }),
                    createdAt: now(),
                  });
                  return { outcome: "pass", context: { ...withFactor(ctx, "passkey"), passkeyCreated: true, [stateKey(step)]: undefined } };
                }

                const auth = response as AuthenticationResponseJSON;
                const stored = (user.passkeys ?? []).find((p) => p.id === auth?.id);
                if (!stored) return retry("That passkey is not registered to this account.");
                const result = await verifyAuthenticationResponse({
                  response: auth,
                  ...expected,
                  requireUserVerification: requireUV,
                  credential: {
                    id: stored.id,
                    publicKey: stored.publicKey as Uint8Array<ArrayBuffer>,
                    counter: stored.counter,
                    ...(stored.transports && { transports: stored.transports as AuthenticatorTransportFuture[] }),
                  },
                });
                if (!result.verified) return retry("We could not verify that passkey. Try again.");
                await deps.users.updatePasskeyCounter(user.id, stored.id, result.authenticationInfo.newCounter);
                return { outcome: "pass", context: { ...withFactor(ctx, "passkey"), [stateKey(step)]: undefined } };
              } catch {
                // The library throws on any mismatch (challenge, origin, signature, counter).
                return retry("We could not verify that passkey. Try again.");
              }
            },
          },
          { pass: next ?? failed, fail: failed },
        );
        break;
      }

      case "authenticate": {
        const denied = failTerminal("Access denied", "This sign-in did not verify who you are.");
        // Defence in depth: checkDoc already requires a factor before Authenticate, and this re-checks at run time.
        add(
          {
            id: step.id,
            kind: "logic",
            run: (ctx) => ({ outcome: ctx.userId && factors(ctx).length > 0 ? "ok" : "deny" }),
          },
          { ok: `${step.id}:done`, deny: denied },
        );
        add({
          id: `${step.id}:done`,
          kind: "terminal",
          status: "success",
          title: String(step.config.welcome),
          result: (ctx) => ({
            userId: ctx.userId,
            email: ctx.email,
            factors: factors(ctx),
            passkeyCreated: ctx.passkeyCreated === true,
            accountCreated: ctx.accountCreated === true,
            sessionHours: step.config.sessionHours,
          }),
        });
        break;
      }

      case "deny": {
        add({ id: step.id, kind: "terminal", status: "failure", title: "Access denied", message: String(step.config.message) });
        break;
      }
    }
  });

  return { ok: true, problems, flow: { id: flowId, start: "start", nodes, transitions } };
}
