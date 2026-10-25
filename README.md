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
npm test        # 41 tests
npm run demo    # whiteboard at http://localhost:3000, hand-written login at /login
```

Demo accounts (seeded on first run only, see "Before production"):

- `ada@example.com` / `correct horse`
- `grace@example.com` / `battery staple` (MFA in the `/login` flow)

Email codes are printed to the server console.

Everything the demo saves lives in `data/` (override with `DATA_DIR`):

| File | Contents |
|------|----------|
| `flows.json` | Whiteboard flows |
| `users.json` | Accounts and passkeys (owner-only permissions) |
| `session-secret` | Key that signs site session cookies (owner-only permissions) |
| `sites/` | Published sites: `sites.json` plus each site's generated HTML |

## The whiteboard

`http://localhost:3000/` is a visual builder for flows. Every node maps to real engine nodes, so whatever you build runs.

1. Click **Start with a Starter Node**. It asks the user for their email.
2. Drag nodes from the **Toolbox** onto the whiteboard, or click a tile to add it to the end. Drag nodes to reorder them, or use the arrow buttons (Alt+Up/Down on the keyboard). Delete removes the selected node.
3. Click any node, the Starter included, to open its settings.
4. Press **N** or **Add a note** for a sticky note. Notes are Markdown: headings, lists, links, tables, code and images. Paste or drop an image into a note to embed it (it is shrunk to 1000px and stored in the flow). Double-click a note or press **Edit** to change it, Esc to finish.
5. Press **Run flow** to try it in a new tab, or **Publish** to put it on a website.

### Node settings

| Node | Settings | What it does at run time |
|------|----------|--------------------------|
| Starter Node | Screen title, help text | Asks for the email and looks the user up. Unknown emails continue, so it reveals nothing. |
| Enter Password | Wrong passwords allowed (1–10), **Allow creating new accounts**, minimum length for new passwords | Checks the password with scrypt and locks the account after 5 failures across all flows. With sign-up on, unknown emails choose a password and get an account. |
| Verification Email | Code lifetime (minutes), wrong codes allowed, resends allowed | Emails a 6-digit code. With sign-up on later in the flow, new emails get real codes too, so they can prove they own the address. |
| Age Check | **Minimum age required**, **Maximum age required** | Asks for a date of birth and checks the age is in range. |
| Passkey | **Allow creating new passkey**, require PIN or biometrics | Signs in with a passkey (WebAuthn). Users without one can create one, if that is allowed and an earlier node proved who they are. |
| Authenticate | Session length (hours), success message | Ends the flow signed in. Re-checks at run time that a factor really passed. |
| Log Out / Deny | Message shown | Ends the flow signed out. |

Every failure path ends on an "Access denied" screen.

The whiteboard checks the flow as you edit. Errors block **Run flow** and **Publish**, warnings do not:

- **Error:** no Starter Node, the flow doesn't end in Authenticate or Log Out / Deny, or a node sits after one of them.
- **Error:** Authenticate with no Enter Password, Verification Email or Passkey before it. Without one, anyone who types an email gets in.
- **Error:** Age Check minimum above its maximum.
- **Warning:** Passkey that new users can't get through (creating passkeys is off, or nothing before it proves who they are).
- **Warning:** account sign-up with no Verification Email before it. Anyone could register an email they don't own.

The seeded flow **Sign in with a passkey** (Age Check, Passkey, Authenticate) only works for users who already have a passkey, so run **Password, then add a passkey** once first.

Passkeys need `localhost` or HTTPS. For another host, set `ORIGIN` (e.g. `https://auth.example.com`) and optionally `RP_ID`.

Each saved version of a flow compiles to its own engine flow, so editing a flow never breaks a run that is already in progress.

## Publishing a site

Press **Publish** next to **Add a note**. Give the site a title and an address, then write two Markdown pages (Preview shows the result, pasted images work here too):

- **Public page**, shown to everyone, with your flow as the sign-in form next to it.
- **Members page**, which only signed-in users can open.

The site goes live at `/s/<address>/`. Visitors who complete the flow get a session cookie and are sent to `/s/<address>/members`.

How it works:

- Publishing writes two static HTML pages. The public page is served to anyone. The members page is served only when the request carries a valid session cookie. Without one, the server redirects to the public page and the members HTML never leaves the server.
- The session cookie is HMAC-signed, `HttpOnly`, `SameSite=Lax`, scoped to that site's path, `Secure` when `ORIGIN` is HTTPS, and lasts as long as the Authenticate node's session setting.
- A site uses a copy of the flow taken at publish time. Editing the whiteboard does not change the live site until you press **Update site**. The dialog tells you when the live copy is out of date.
- Sign-in sessions are tied to their site. A sign-in started on one site or in **Run flow** cannot be completed on another site to get its cookie.
- Markdown is rendered and sanitized on the server (no scripts, event handlers or `javascript:` links). Pages are sent with a Content-Security-Policy, `X-Frame-Options: DENY` and `nosniff`.
- Starting and submitting sign-ins is rate limited to 60 requests per minute per IP.
- **Unpublish** takes the site down. Accounts are kept.

The pages are static files, but the sign-in and the members check need this server running. You can't upload them to GitHub Pages or Netlify on their own.

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

- The whiteboard API has no login. The server binds to `127.0.0.1` by default and refuses cross-origin writes, but anyone who can reach it can edit flows. Put it behind your admin auth, or run the builder separately from the published sites, before exposing it.
- Start the public server with `SEED_DEMO_USERS=false` so the demo accounts with known passwords are never created, and with `ORIGIN=https://your-domain` so cookies are `Secure` and passkeys work.
- Age Check uses the date of birth the user types. It stops honest under-age users, not people who lie. Real age estimation (face scan or ID check) needs a third-party provider.
- Signing out clears the cookie, but a copied cookie stays valid until it expires. Keep the session length short, or move to server-side sessions if you need instant revocation.
- Accounts are stored in a JSON file. That is fine for one server and a modest number of users. Use a database beyond that.

- `MemorySessionStore` keeps in-progress sign-ins in memory, so a restart abandons them (finished sessions are cookies and survive). Implement `SessionStore` against Redis to run more than one server.
- The rate limit is per IP and in memory. Add per-email limits, and a shared limiter if you run several servers.
- Wire `sendCode` to your email or SMS provider.
- Add CSRF protection if the API shares a cookie domain with other apps.

## Layout

```
src/engine/     engine, types, validation, session store
src/flows/      login flow and the in-memory user directory
src/builder/    whiteboard document format, node settings, rules, compiler, file store
src/sites/      publishing: site store, page templates, Markdown, session cookies, rate limit
src/demo/       HTTP server, whiteboard page, run page, shared sign-in form (flow-client.js)
test/           node:test suites for the engine and the login flow
```
