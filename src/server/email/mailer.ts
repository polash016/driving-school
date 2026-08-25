import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Mail delivery port (spec-03). Auth emails are sent inline through this interface today;
 * when the BullMQ worker lands (spec-06) the `emails` queue slots in behind the same port
 * without touching a single call site.
 *
 * Transports: "smtp" (nodemailer — mailpit in dev, real SMTP in prod), "capture" (in-memory,
 * used by tests), "log" (structured log only).
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** Test sink — assertions read this instead of standing up an SMTP server. */
const captured: MailMessage[] = [];

export function capturedMail(): readonly MailMessage[] {
  return captured;
}

export function clearCapturedMail(): void {
  captured.length = 0;
}

const captureTransport: MailTransport = {
  async send(message) {
    captured.push(message);
  },
};

const logTransport: MailTransport = {
  async send(message) {
    logger.info({ to: message.to, subject: message.subject }, "mail (log transport)");
  },
};

let smtp: Transporter | undefined;

function smtpTransport(): MailTransport {
  return {
    async send(message) {
      smtp ??= nodemailer.createTransport(env().SMTP_URL ?? "smtp://localhost:1025");
      await smtp.sendMail({ from: env().EMAIL_FROM, ...message });
    },
  };
}

export function mailTransport(): MailTransport {
  switch (env().MAIL_TRANSPORT) {
    case "smtp":
      return smtpTransport();
    case "log":
      return logTransport;
    default:
      return captureTransport;
  }
}

/**
 * Sends a message. Never throws: a mail outage must not roll back the user's registration or
 * password reset — the failure is logged and the user can request a new link.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  try {
    await mailTransport().send(message);
    return true;
  } catch (error) {
    logger.error({ to: message.to, subject: message.subject, error }, "mail send failed");
    return false;
  }
}
