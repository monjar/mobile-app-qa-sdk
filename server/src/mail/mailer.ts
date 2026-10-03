/**
 * Outbound mail. SNITCH_SMTP_URL (smtp://user:pass@host:587, smtps://… for 465)
 * selects SMTP via nodemailer; without it mail is logged, not sent, and email
 * integrations fail loudly so nobody thinks a message went out.
 */
import { log } from '../log';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid?: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  readonly driver: 'smtp' | 'console';
  send(msg: MailMessage): Promise<{ messageId: string | null }>;
}

export class ConsoleMailer implements Mailer {
  readonly driver = 'console' as const;
  readonly sent: MailMessage[] = [];

  async send(msg: MailMessage): Promise<{ messageId: string | null }> {
    this.sent.push(msg);
    log.info('mail', 'console mailer: message not sent (SNITCH_SMTP_URL unset)', { to: msg.to, subject: msg.subject });
    return { messageId: null };
  }
}

export class SmtpMailer implements Mailer {
  readonly driver = 'smtp' as const;
  private transport: import('nodemailer').Transporter | null = null;

  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  async send(msg: MailMessage): Promise<{ messageId: string | null }> {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      this.transport = nodemailer.createTransport(smtpOptions(this.url));
    }
    const info = await this.transport.sendMail({
      from: this.from,
      to: msg.to.join(', '),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid })),
    });
    return { messageId: info.messageId ?? null };
  }
}

/** Turns smtp[s]://user:pass@host:port into nodemailer options with sane timeouts. */
export function smtpOptions(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SNITCH_SMTP_URL must start with smtp:// or smtps://');
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export function buildMailer(smtpUrl: string | null, from: string): Mailer {
  return smtpUrl ? new SmtpMailer(smtpUrl, from) : new ConsoleMailer();
}
