/*
 * Renders flow screens from the engine's JSON views. Used by the run page and published sites.
 *
 *   FlowClient.mount(container, {
 *     start:  () => Promise<view>,
 *     submit: (view, input) => Promise<view>,
 *     onComplete?: (view) => void,
 *     footer?: () => Node,
 *   });
 *
 * Passkey screens need /vendor/webauthn.js loaded first.
 */
(function () {
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  // Like append/replaceChildren, but skips null and undefined instead of printing them.
  function appendAll(root, ...nodes) { root.append(...nodes.filter((n) => n != null)); }
  function replaceAll(root, ...nodes) { root.replaceChildren(...nodes.filter((n) => n != null)); }

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status, problems: data.problems });
    return data;
  }

  async function runPasskey(passkey) {
    const lib = window.SimpleWebAuthnBrowser;
    if (!lib || !lib.browserSupportsWebAuthn()) throw new Error("This browser does not support passkeys.");
    const result = passkey.mode === "register"
      ? await lib.startRegistration({ optionsJSON: passkey.options })
      : await lib.startAuthentication({ optionsJSON: passkey.options });
    return JSON.stringify(result);
  }

  function mount(root, opts) {
    root.classList.add("fc");
    root.setAttribute("aria-live", "polite");
    let view = null;
    const footer = () => (opts.footer ? opts.footer() : null);

    async function start() {
      root.replaceChildren(el("p", {}, "Loading…"));
      try { render(await opts.start()); }
      catch (e) { fatal(e.message, e.problems); }
    }

    function render(v) {
      view = v;
      root.replaceChildren();
      if (v.type === "complete") return complete(v);

      appendAll(root, el("h1", {}, v.title));
      const d = v.data || {};
      const subtitle = v.description || d.description || (d.email && `Signing in as ${d.email}`) ||
        (d.sentTo && `We sent a 6-digit code to ${d.sentTo}.`);
      if (subtitle) appendAll(root, el("p", {}, subtitle));
      if (v.error) appendAll(root, el("div", { class: "banner error", role: "alert" }, v.error));
      if (d.notice) appendAll(root, el("div", { class: "banner notice" }, d.notice));

      const form = el("form", { novalidate: true, onsubmit: onSubmit });
      let firstInput = null;
      for (const f of v.fields) {
        if (f.type === "passkey") continue; // driven by the submit button
        const id = `fc-${f.name}`;
        const err = v.fieldErrors && v.fieldErrors[f.name];
        const errId = err ? `${id}-err` : undefined;
        if (f.type === "checkbox") {
          form.append(el("div", { class: "field" },
            el("label", { class: "check", for: id }, el("input", { type: "checkbox", id, name: f.name }), f.label)));
          continue;
        }
        const input = el("input", {
          id, name: f.name,
          type: f.type === "otp" ? "text" : f.type,
          inputmode: f.type === "otp" ? "numeric" : undefined,
          autocomplete: f.autocomplete, placeholder: f.placeholder,
          maxlength: f.maxLength, required: f.required,
          "aria-invalid": err ? "true" : undefined, "aria-describedby": errId,
        });
        firstInput = firstInput || input;
        form.append(el("div", { class: "field" }, el("label", { for: id }, f.label), input,
          err ? el("div", { class: "field-error", id: errId }, err) : null));
      }
      const passkeyErr = v.fieldErrors && v.fields.find((f) => f.type === "passkey" && v.fieldErrors[f.name]);
      if (passkeyErr) appendAll(root, el("div", { class: "banner error", role: "alert" }, v.fieldErrors[passkeyErr.name]));
      form.append(el("button", { type: "submit" }, v.submitLabel));
      appendAll(root, form, footer());
      (form.querySelector("[aria-invalid=true]") || firstInput || form.querySelector("button")).focus();
    }

    async function onSubmit(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const input = {};
      const button = form.querySelector("button");
      button.disabled = true;
      for (const f of view.fields) {
        if (f.type === "passkey") {
          try { input[f.name] = await runPasskey(view.data.passkey); }
          catch (e) {
            // Closing the browser prompt lands here. Stay put and let the user retry.
            const msg = e && e.name === "NotAllowedError" ? "The passkey prompt was closed or timed out. Try again." : (e.message || "Passkey failed.");
            root.querySelector(".banner.error")?.remove();
            form.before(el("div", { class: "banner error", role: "alert" }, msg));
            button.disabled = false;
            return;
          }
          continue;
        }
        const node = form.elements[f.name];
        input[f.name] = f.type === "checkbox" ? node.checked : node.value;
      }
      try { render(await opts.submit(view, input)); }
      catch (e) { e.status === 410 ? fatal("Your sign-in session expired.") : fatal(e.message); }
    }

    function complete(v) {
      appendAll(root, 
        el("div", { class: `status ${v.status}`, "aria-hidden": "true" }, v.status === "success" ? "✓" : "✕"),
        el("h1", {}, v.title),
        v.message ? el("p", {}, v.message) : null,
        v.redirect ? el("p", {}, "Taking you in…") : el("button", { class: "link", type: "button", onclick: start }, v.status === "success" ? "Sign in again" : "Start over"),
        footer(),
      );
      if (opts.onComplete) opts.onComplete(v);
    }

    function fatal(message, problems) {
      const list = problems && problems.length
        ? el("ul", { class: "problems" }, ...problems.filter((p) => p.level === "error").map((p) => el("li", {}, p.message)))
        : null;
      replaceAll(root, el("h1", {}, "Can't continue"), el("p", {}, message), list,
        el("button", { type: "button", onclick: start }, "Start over"), footer());
    }

    start();
    return { restart: start };
  }

  window.FlowClient = { mount, post, el };
})();
