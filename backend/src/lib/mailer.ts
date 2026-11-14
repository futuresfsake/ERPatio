/**
 * Outgoing e-mail (US-120, US-015). SMTP when SMTP_URL is set; otherwise messages are kept in memory
 * (development and tests) so nothing is ever sent by accident.
 */
import nodemailer from 'nodemailer';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  readonly kind: 'smtp' | 'memory';
  send(mail: Mail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly kind = 'memory' as const;
  readonly outbox: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
    // Never log the body: it carries a one-time link.
    logger().info({ subject: mail.subject }, 'mail queued in memory');
    if (getEnv().NODE_ENV === 'development') console.log(`\n[mail to ${mail.to}] ${mail.subject}\n${mail.text}\n`);
  }
}

class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transport = nodemailer.createTransport(getEnv().SMTP_URL!);
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: getEnv().MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
    logger().info({ subject: mail.subject }, 'mail sent');
  }
}

let mailer: Mailer | undefined;
export function getMailer(): Mailer {
  return (mailer ??= getEnv().SMTP_URL ? new SmtpMailer() : new MemoryMailer());
}
export const setMailer = (m: Mailer | undefined): void => {
  mailer = m;
};
export const mailConfigured = (): boolean => !!getEnv().SMTP_URL;
