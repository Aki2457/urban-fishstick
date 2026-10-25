import { renderMarkdown } from "./markdown.js";
import type { SiteRecord } from "./site-store.js";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SITE_CSS = `
:root { --bg:#f6f7f9; --surface:#fff; --text:#15181c; --muted:#59626c; --border:#dde2e8; --accent:#2557d6; --accent-text:#fff; --code:#eef1f4; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111418; --surface:#1a1e24; --text:#eceef1; --muted:#a0a9b3; --border:#2d333b; --accent:#7aa0ff; --accent-text:#0b0d10; --code:#232930; } }
:root[data-theme="dark"] { --bg:#111418; --surface:#1a1e24; --text:#eceef1; --muted:#a0a9b3; --border:#2d333b; --accent:#7aa0ff; --accent-text:#0b0d10; --code:#232930; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
.top { background:var(--surface); border-bottom:1px solid var(--border); }
.top .in { max-width:1040px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
.brand { font-weight:800; font-size:1.15rem; color:var(--text); text-decoration:none; margin-right:auto; }
.who { color:var(--muted); font-size:.92rem; overflow-wrap:anywhere; }
.top a.btn, .top button.btn { background:var(--accent); color:var(--accent-text); border:0; border-radius:8px; padding:8px 14px; font:inherit; font-size:.92rem; font-weight:600; cursor:pointer; text-decoration:none; }
.top button.btn.ghost { background:transparent; color:var(--text); border:1px solid var(--border); }
main.wrap { max-width:1040px; margin:0 auto; padding:32px 16px 64px; display:grid; gap:32px; grid-template-columns:minmax(0,1fr) 380px; align-items:start; }
main.wrap.single { grid-template-columns:minmax(0,1fr); max-width:760px; }
@media (max-width:860px) { main.wrap { grid-template-columns:minmax(0,1fr); } }
.content { min-width:0; overflow-wrap:anywhere; }
.content img { max-width:100%; height:auto; border-radius:8px; }
.content pre { background:var(--code); padding:12px 14px; border-radius:8px; overflow-x:auto; }
.content code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:.92em; }
.content pre code { background:none; padding:0; }
.content table { border-collapse:collapse; display:block; overflow-x:auto; }
.content th, .content td { border:1px solid var(--border); padding:6px 10px; }
.content blockquote { margin:0; padding-left:14px; border-left:3px solid var(--border); color:var(--muted); }
.content a { color:var(--accent); }
.content h1 { line-height:1.2; }
.signin-card { position:sticky; top:24px; }
.signed { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:24px; }
.signed a { color:var(--accent); font-weight:600; }
`;

function shell(site: SiteRecord, opts: { title: string; header: string; body: string; script: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="/assets/flow-client.css">
<style>${SITE_CSS}</style>
</head>
<body>
<header class="top"><div class="in"><a class="brand" href="/s/${site.slug}/">${esc(site.title)}</a>${opts.header}</div></header>
${opts.body}
<script src="/vendor/webauthn.js"></script>
<script src="/assets/flow-client.js"></script>
<script>${opts.script}</script>
</body>
</html>`;
}

/** Builds the two static pages for a site. The members page is only ever served after a session check. */
export function renderSitePages(site: SiteRecord): { index: string; members: string } {
  const base = `/s/${site.slug}`;
  const index = shell(site, {
    title: site.title,
    header: `<span class="who" id="who"></span>`,
    body: `<main class="wrap">
  <article class="content">${renderMarkdown(site.publicMd)}</article>
  <aside class="signin-card" id="signin" aria-label="Sign in"></aside>
</main>`,
    script: `(async () => {
  const base = ${JSON.stringify(base)};
  const box = document.getElementById("signin");
  const me = await fetch(base + "/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((d) => (d && d.signedIn ? d : null)).catch(() => null);
  if (me) {
    document.getElementById("who").textContent = "Signed in as " + me.email;
    const card = document.createElement("div");
    card.className = "signed";
    const p = document.createElement("p");
    p.textContent = "You're signed in.";
    const a = document.createElement("a");
    a.href = base + "/members";
    a.textContent = "Go to the members page →";
    card.append(p, a);
    box.replaceChildren(card);
    return;
  }
  FlowClient.mount(box, {
    start: () => FlowClient.post(base + "/api/start"),
    submit: (view, input) => FlowClient.post(base + "/api/submit/" + encodeURIComponent(view.sessionId), { nodeId: view.nodeId, input }),
    onComplete: (view) => { if (view.redirect) setTimeout(() => location.assign(view.redirect), 600); },
  });
})();`,
  });

  const members = shell(site, {
    title: `${site.title} · Members`,
    header: `<span class="who" id="who"></span><button class="btn ghost" id="signout" type="button">Sign out</button>`,
    body: `<main class="wrap single"><article class="content">${renderMarkdown(site.membersMd)}</article></main>`,
    script: `(async () => {
  const base = ${JSON.stringify(base)};
  const me = await fetch(base + "/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((d) => (d && d.signedIn ? d : null)).catch(() => null);
  if (!me) { location.replace(base + "/"); return; }
  document.getElementById("who").textContent = "Signed in as " + me.email;
  document.getElementById("signout").addEventListener("click", async () => {
    await FlowClient.post(base + "/api/logout").catch(() => {});
    location.assign(base + "/");
  });
})();`,
  });

  return { index, members };
}
