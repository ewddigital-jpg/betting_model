import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { env, hasEmailConfig } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.buffer = "";
    this.queue = [];
    this.waiters = [];
    this.error = null;
    this.closed = false;
    this.attachSocket(socket);
  }

  attachSocket(socket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.buffer = "";
    this.queue = [];
    this.waiters = [];
    this.error = null;
    this.closed = false;

    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.flushResponses();
    });

    socket.on("error", (error) => {
      this.error = error;
      while (this.waiters.length) {
        this.waiters.shift().reject(error);
      }
    });

    socket.on("close", () => {
      this.closed = true;
      if (this.waiters.length) {
        const error = this.error ?? new Error("SMTP connection closed.");
        while (this.waiters.length) {
          this.waiters.shift().reject(error);
        }
      }
    });
  }

  flushResponses() {
    while (true) {
      const parsed = this.extractResponse();
      if (!parsed) {
        return;
      }

      if (this.waiters.length) {
        this.waiters.shift().resolve(parsed);
      } else {
        this.queue.push(parsed);
      }
    }
  }

  extractResponse() {
    if (!this.buffer.includes("\r\n")) {
      return null;
    }

    let consumed = 0;
    const lines = [];

    while (true) {
      const end = this.buffer.indexOf("\r\n", consumed);
      if (end === -1) {
        return null;
      }

      const line = this.buffer.slice(consumed, end);
      lines.push(line);
      consumed = end + 2;

      if (/^\d{3}\s/u.test(line)) {
        this.buffer = this.buffer.slice(consumed);
        return {
          code: Number(line.slice(0, 3)),
          lines
        };
      }
    }
  }

  nextResponse() {
    if (this.queue.length) {
      return Promise.resolve(this.queue.shift());
    }

    if (this.error) {
      return Promise.reject(this.error);
    }

    if (this.closed) {
      return Promise.reject(new Error("SMTP connection is closed."));
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  sendLine(line) {
    this.socket.write(`${line}\r\n`);
  }

  async expect(codes, context) {
    const response = await this.nextResponse();
    const list = Array.isArray(codes) ? codes : [codes];

    if (!list.includes(response.code)) {
      throw new Error(`${context} failed: ${response.lines.join(" | ")}`);
    }

    return response;
  }

  async command(line, codes, context) {
    this.sendLine(line);
    return this.expect(codes, context);
  }

  async upgradeToTls(host) {
    const secureSocket = tls.connect({
      socket: this.socket,
      host,
      servername: host
    });

    await new Promise((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });

    this.attachSocket(secureSocket);
  }

  close() {
    try {
      this.sendLine("QUIT");
    } catch {
      // ignore close path errors
    }
    this.socket.end();
  }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = env.smtpSecure
      ? tls.connect({
          host: env.smtpHost,
          port: env.smtpPort,
          servername: env.smtpHost
        })
      : net.createConnection({
          host: env.smtpHost,
          port: env.smtpPort
        });

    const onError = (error) => reject(error);

    socket.once(env.smtpSecure ? "secureConnect" : "connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}

function smtpBody({ from, to, subject, text }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n")
  ];

  return `${lines.join("\r\n")}\r\n.`;
}

export async function sendSmtpEmail({ to, subject, text }) {
  if (!hasEmailConfig()) {
    throw new Error("Email config is incomplete.");
  }

  const socket = await connectSocket();
  const session = new SmtpSession(socket);
  const clientName = os.hostname().replaceAll(/\s+/gu, "-") || "localhost";

  try {
    await session.expect(220, "SMTP greeting");
    const ehlo = await session.command(`EHLO ${clientName}`, 250, "EHLO");
    const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/u.test(line));

    if (!env.smtpSecure && supportsStartTls) {
      await session.command("STARTTLS", 220, "STARTTLS");
      await session.upgradeToTls(env.smtpHost);
      await session.command(`EHLO ${clientName}`, 250, "EHLO after STARTTLS");
    }

    if (env.smtpUser && env.smtpPassword) {
      await session.command("AUTH LOGIN", 334, "AUTH LOGIN");
      await session.command(Buffer.from(env.smtpUser, "utf8").toString("base64"), 334, "SMTP username");
      await session.command(Buffer.from(env.smtpPassword, "utf8").toString("base64"), 235, "SMTP password");
    }

    await session.command(`MAIL FROM:<${env.emailFrom}>`, 250, "MAIL FROM");
    await session.command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await session.command("DATA", 354, "DATA");
    const messageId = `<bet-reminder-${Date.now()}@${clientName}>`;
    session.sendLine(smtpBody({
      from: env.emailFrom,
      to,
      subject,
      text: `${text}\r\n\r\nMessage-ID: ${messageId}`
    }));
    await session.expect(250, "message delivery");
    session.close();
    return { ok: true, messageId };
  } catch (error) {
    logger.error("SMTP send failed", { message: error.message });
    session.close();
    throw error;
  }
}
