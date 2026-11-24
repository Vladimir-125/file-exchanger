import nodemailer from 'nodemailer';
import type { Config } from '../config.ts';

export type Mail = { to: string; subject: string; text: string };
export type Mailer = { send(msg: Mail): Promise<void> };

export function createMailer(config: Config): Mailer {
  if (!config.smtpUrl) {
    return {
      async send(msg) {
        console.log(`[mail] SMTP_URL not set; to=${msg.to} subject=${msg.subject}\n${msg.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({ from: config.mailFrom, ...msg });
    },
  };
}
