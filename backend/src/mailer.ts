import nodemailer from 'nodemailer';
import { config } from './config.js';

export class EmailDeliveryUnavailableError extends Error {
  constructor() {
    super('Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_FROM, FRONTEND_ORIGIN and the required SMTP credentials.');
    this.name = 'EmailDeliveryUnavailableError';
  }
}

export function isEmailDeliveryConfigured() {
  return Boolean(config.smtpHost && config.smtpFrom && config.frontendOrigin && (!config.smtpUser || config.smtpPassword));
}

export async function sendTransactionalEmail(input: { to: string; subject: string; text: string; html: string }) {
  if (!isEmailDeliveryConfigured()) throw new EmailDeliveryUnavailableError();
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({ from: config.smtpFrom, to: input.to, subject: input.subject, text: input.text, html: input.html });
  } finally {
    transport.close();
  }
}
