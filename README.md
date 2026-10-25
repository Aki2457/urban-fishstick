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
npm test        # 34 tests
npm run demo    # whiteboard at http://localhost:3000, hand-written login at /login
```

Demo accounts:

- `ada@example.com` / `correct horse`
- `grace@example.com` / `battery staple` (MFA in the `/login` flow)

Email codes are printed to the server console.

## The whiteboard

`http://localhost:3000/` is a visual builder for flows. Every node maps to real engine nodes, so whatever you build runs.

1. Click **Start with a Starter Node**. It asks the user for their email.
2. Drag nodes from the **Toolbox** onto the whiteboard, or click a tile to add it to the end. Drag nodes to reorder them, or use the arrow buttons (Alt+Up/Down on the keyboard). Delete removes the selected node.
3. Click a node to change its settings (minimum age, password attempts, code lifetime).
4. Press **N** or **Add a note** for a sticky note. Drag it by its header.
5. Press **Run flow** to try it in a new tab.

Flows save automatically to `data/flows.json`.

| Node | What it does at run time | On failure |
|------|--------------------------|------------|
| Starter Node | Asks for the email and looks the user up. Unknown emails continue, so it reveals nothing. | |
| Enter Password | Checks the password with scrypt. Locks the account after 5 failures across all flows. | Denied after the set number of tries |
| Verification Email | Emails a 6-digit code (expires, 5 attempts, up to 3 resends). | Denied after 5 wrong codes |
| Age Check | Asks for a date of birth and checks it against the minimum age. | Denied if under age |
| Passkey | Signs in with a passkey (WebAuthn). If the user has none and an earlier step proved who they are, it creates one instead. | Denied after 5 failed attempts. Users with no passkey and no earlier proof are stopped. |
| Authenticate | Ends the flow signed in. Re-checks at run time that a factor really passed. | Denied |
| Log Out / Deny | Ends the flow signed out. | |

The whiteboard checks the flow as you edit. Errors block **Run flow**, warnings do not:

- **Error:** no Starter Node, the flow doesn't end in Authenticate or Log Out / Deny, or a node sits after one of them.
- **Error:** Authenticate with no Enter Password, Verification Email or Passkey before it. Without one, anyone who types an email gets in.
- **Warning:** Passkey with no Enter Password or Verification Email before it. Users who have no passkey yet can't get through.

The seeded flows show this. **Sign in with a passkey** (Age Check, Passkey, Authenticate) only works for users who already have a passkey, so run **Password, then add a passkey** once first.

Passkeys need `localhost` or HTTPS. For another host, set `ORIGIN` (e.g. `https://auth.example.com`) and optionally `RP_ID`.

Each saved version of a flow compiles to its own engine flow, so editing a flow never breaks a run that is already in progress.

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

- The whiteboard API has no login. The server binds to `127.0.0.1` by default and refuses cross-origin writes, but anyone who can reach it can edit flows. Put it behind your admin auth before exposing it.
- Age Check is self-declared. It stops honest under-age users, not determined ones.

- `MemorySessionStore` and `InMemoryUserDirectory` work for one process only. Implement `SessionStore` and `UserDirectory` against Redis or your database.
- Add rate limiting per IP and per email at the HTTP layer. The engine does not do this.
- On `success`, create the real login session from `step.result` (for example an HttpOnly, Secure, SameSite cookie). The demo only logs it.
- Wire `sendCode` to your email or SMS provider.
- Add CSRF protection if the API shares a cookie domain with other apps.

## Layout

```
src/engine/     engine, types, validation, session store
src/flows/      login flow and the in-memory user directory
src/builder/    whiteboard document format, rules, compiler, file store
src/demo/       HTTP server, whiteboard page and run page
test/           node:test suites for the engine and the login flow
```
