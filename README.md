# auth-flow

A node-based authentication flow engine in TypeScript, with no runtime dependencies.

You describe a flow as a graph of nodes. The engine runs it one screen at a time,
keeps all state on the server, and tells the client what to draw next.

| Node kind  | What it does |
|------------|--------------|
| `screen`   | Shown to the user. Declares fields, validates them, then its `handle` returns an outcome. |
| `logic`    | Runs on the server with no input (check MFA, send a code, look something up) and returns an outcome. |
| `terminal` | Ends the flow with `success` or `failure`. Can return a server-only `result`, such as a user id. |

Outcomes map to the next node through a transition table. A screen can return
`RETRY` with an error to keep the user where they are.

## Quick start

```bash
npm install
npm test        # 20 tests
npm run demo    # http://localhost:3000
```

Demo accounts:

- `ada@example.com` / `correct horse`: password only
- `grace@example.com` / `battery staple`: password, then a 6-digit code printed to the server console

## The included login flow

```
identify ──► password ──► mfa-check ──skip──────────────────────────► success
                │             │
                │             └─required─► send-code ──► verify-code ──ok──► success
                │                              ▲              │  │
                │                              └───resend─────┘  └─failed─► mfa-failed
                └─locked──► locked
```

What it handles:

- The email step never reveals whether an account exists. Unknown emails still reach the password screen, get a dummy hash check, and see the same error as a wrong password.
- Passwords are hashed with scrypt and compared in constant time.
- The account locks after 5 failed passwords (15 minutes by default).
- One-time codes are stored only as SHA-256 hashes in the server context. They expire after 5 minutes, allow 5 attempts, and can be resent up to 3 times.

## Writing your own flow

```ts
import { FlowEngine, RETRY, type FlowDefinition } from "auth-flow";

const flow: FlowDefinition = {
  id: "invite",
  start: "code",
  nodes: [
    {
      id: "code",
      kind: "screen",
      title: "Enter your invite code",
      fields: [{ name: "code", label: "Invite code", type: "text", required: true, pattern: /^[A-Z0-9]{8}$/ }],
      handle: async ({ code }) =>
        (await isValidInvite(code!)) ? { outcome: "valid", context: { code } } : { outcome: RETRY, error: "Unknown code." },
    },
    { id: "check-seat", kind: "logic", run: async () => ({ outcome: (await seatsLeft()) > 0 ? "ok" : "full" }) },
    { id: "joined", kind: "terminal", status: "success", title: "Welcome aboard", result: (ctx) => ({ code: ctx.code }) },
    { id: "full", kind: "terminal", status: "failure", title: "This team is full" },
  ],
  transitions: {
    code: { valid: "check-seat" },
    "check-seat": { ok: "joined", full: "full" },
  },
};

const engine = new FlowEngine().register(flow);   // throws if the graph is broken
const first = await engine.start("invite");       // { view: ScreenView }
const next = await engine.submit(first.view.sessionId, first.view.nodeId, { code: "ABCD1234" });
```

`register` checks the graph up front: duplicate ids, a missing start node, transitions to
unknown nodes, dead ends, and unreachable nodes all fail immediately.

## Engine guarantees

- The client receives the current screen only. Flow context never leaves the server.
- Only declared fields reach a handler. Anything else in the request is dropped.
- Each submit names the screen it came from. A stale submit (double click, back button) applies nothing and returns the real current screen.
- Submits on the same session run one at a time.
- Finished sessions are deleted, so a session id cannot be replayed.
- Back-to-back logic nodes are capped (50 by default) to catch loops.

## Before production

- `MemorySessionStore` and `InMemoryUserDirectory` work for one process only. Implement `SessionStore` and `UserDirectory` against Redis or your database.
- Add rate limiting per IP and per email at the HTTP layer. The engine does not do this.
- On `success`, create the real login session from `step.result` (for example an HttpOnly, Secure, SameSite cookie). The demo only logs it.
- Wire `sendCode` to your email or SMS provider.
- Add CSRF protection if the API shares a cookie domain with other apps.

## Layout

```
src/engine/     engine, types, validation, session store
src/flows/      login flow and the in-memory user directory
src/demo/       HTTP server and the browser page
test/           node:test suites for the engine and the login flow
```
