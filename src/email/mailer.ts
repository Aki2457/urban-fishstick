import nodemailer from "nodemailer";
import type { AppConfig } from "../config/schema.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

type Transport = "smtp" | "api" | "console";

const ORDER: Record<string, Transport[]> = {
  smtp: ["smtp"],
  api: ["api"],
  "api-smtp": ["api", "smtp"],
  "smtp-api": ["smtp", "api"],
  console: ["console"],
};

const DEFAULT_API_URLS: Record<string, string> = {
  resend: "https://api.resend.com",
  sendgrid: "https://api.sendgrid.com",
  postmark: "https://api.postmarkapp.com",
};

export interface SmtpLike {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

export interface MailerOptions {
  /** Current settings and whether email may be sent. Read on every send, so changes apply at once. */
  settings: () => { config: AppConfig; ready: boolean; problems: string[] };
  /** Swappable for tests. */
  createSmtp?: (options: Record<string, unknown>) => SmtpLike;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * Sends email the way email_type says: one transport, or two with the second as fallback.
 * Errors name the transport and the reason, never a password or key.
 */
export class Mailer {
  private smtpCache: { key: string; transport: SmtpLike } | undefined;

  constructor(private readonly opts: MailerOptions) {}

  async send(mail: OutgoingEmail): Promise<{ via: Transport }> {
    const { config, ready, problems } = this.opts.settings();
    if (!config.enable_email) throw new EmailError("Email is turned off in Settings.");
    if (!ready) throw new EmailError(`Email settings have errors: ${problems.join(" ")}`);

    const failures: string[] = [];
    for (const transport of ORDER[config.email_type ?? ""] ?? []) {
      try {
        if (transport === "smtp") await this.viaSmtp(config, mail);
        else if (transport === "api") await this.viaApi(config, mail);
        else this.log(`[email:console] to ${mail.to} | ${mail.subject}\n${mail.text}`);
        if (failures.length) this.log(`[email] sent via ${transport} after: ${failures.join("; ")}`);
        return { via: transport };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(`${transport.toUpperCase()}: ${reason}`);
        this.log(`[email] ${transport} failed: ${reason}`);
      }
    }
    throw new EmailError(`Could not send the email. ${failures.join(" ")}`);
  }

  private from(c: AppConfig): { name: string; address: string } {
    return { name: c.email_from_name, address: c.email_from };
  }

  private async viaSmtp(c: AppConfig, mail: OutgoingEmail): Promise<void> {
    const options = {
      host: c.email_smtp_server,
      port: c.email_smtp_port,
      // ssl: TLS from the first byte. tls: plain connect, then STARTTLS, and refuse to continue without it.
      secure: c.email_smtp_tlsorssl === "ssl",
      requireTLS: c.email_smtp_tlsorssl === "tls",
      ...(c.email_smtp_useauth && { auth: { user: c.email_smtp_username, pass: c.email_smtp_password } }),
      connectionTimeout: this.opts.timeoutMs ?? 10_000,
      greetingTimeout: this.opts.timeoutMs ?? 10_000,
      socketTimeout: (this.opts.timeoutMs ?? 10_000) * 2,
    };
    // Reuse the connection pool until any SMTP setting changes.
    const key = JSON.stringify(options);
    if (!this.smtpCache || this.smtpCache.key !== key) {
      const create = this.opts.createSmtp ?? ((o) => nodemailer.createTransport(o) as unknown as SmtpLike);
      this.smtpCache = { key, transport: create(options) };
    }
    try {
      await this.smtpCache.transport.sendMail({ from: this.from(c), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (err) {
      // nodemailer error messages can include the server's reply, but not our credentials.
      const e = err as { code?: string; responseCode?: number; message?: string };
      const detail = e.code === "EAUTH" ? "the server rejected the username or password" : (e.message ?? "unknown error").split("\n")[0]!.slice(0, 200);
      throw new Error(`${c.email_smtp_server}:${c.email_smtp_port} ${detail}`);
    }
  }

  private async viaApi(c: AppConfig, mail: OutgoingEmail): Promise<void> {
    const base = c.email_api_url || DEFAULT_API_URLS[c.email_api_provider] || "";
    const from = this.from(c);
    const fromText = `${from.name.replace(/["<>\r\n]/g, "")} <${from.address}>`;
    let url = base;
    let headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    let body: unknown;

    switch (c.email_api_provider) {
      case "resend":
        url = `${base}/emails`;
        headers.authorization = `Bearer ${c.email_api_key}`;
        body = { from: fromText, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html };
        break;
      case "sendgrid":
        url = `${base}/v3/mail/send`;
        headers.authorization = `Bearer ${c.email_api_key}`;
        body = {
          personalizations: [{ to: [{ email: mail.to }] }],
          from: { email: from.address, name: from.name },
          subject: mail.subject,
          content: [
            { type: "text/plain", value: mail.text },
            { type: "text/html", value: mail.html },
          ],
        };
        break;
      case "postmark":
        url = `${base}/email`;
        headers = { ...headers, "x-postmark-server-token": c.email_api_key };
        body = { From: fromText, To: mail.to, Subject: mail.subject, TextBody: mail.text, HtmlBody: mail.html, MessageStream: "outbound" };
        break;
      default:
        headers.authorization = `Bearer ${c.email_api_key}`;
        body = { from: fromText, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html };
    }

    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // A redirect could carry the key to another host.
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const e = err as Error;
      throw new Error(`${new URL(url).host} ${e.name === "TimeoutError" ? "timed out" : "could not be reached"}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${new URL(url).host} answered ${res.status}${text ? `: ${text}` : ""}`);
    }
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** The sign-in code email. */
export function codeEmail(appName: string, to: string, code: string, minutes: number): OutgoingEmail {
  const subject = `Your ${appName} sign-in code`;
  const text = `Your ${appName} code is ${code}.\n\nIt expires in ${minutes} minute${minutes === 1 ? "" : "s"}. If you did not try to sign in, ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#15181c;line-height:1.5">
<p>Your ${esc(appName)} code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p>
<p style="color:#59626c">It expires in ${minutes} minute${minutes === 1 ? "" : "s"}. If you did not try to sign in, ignore this email.</p>
</body></html>`;
  return { to, subject, text, html };
}

export function testEmail(appName: string, to: string, via: string): OutgoingEmail {
  return {
    to,
    subject: `${appName}: test email`,
    text: `This is a test email from ${appName}. Email sending works (${via}).`,
    html: `<p>This is a test email from <b>${esc(appName)}</b>. Email sending works (${esc(via)}).</p>`,
  };
}
