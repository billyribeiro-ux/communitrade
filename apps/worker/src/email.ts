import nodemailer, { type Transporter } from 'nodemailer';

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

export interface EmailPort {
  send(message: OutboundEmail): Promise<{ messageId: string; accepted: boolean }>;
  close(): void;
}

export class EmailDeliveryError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(code: string, uncertain = false) {
    super(code);
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function classifySmtpFailure(error: unknown): EmailDeliveryError {
  const candidate = error as { code?: unknown; command?: unknown; responseCode?: unknown };
  const command = typeof candidate?.command === 'string' ? candidate.command.toUpperCase() : '';
  const smtpCode = Number(candidate?.responseCode);
  const uncertain = command === 'DATA' || candidate?.code === 'ETIMEDOUT' || candidate?.code === 'ECONNECTION';
  const code = command === 'RCPT' && smtpCode === 550 ? 'SMTP_RECIPIENT_REJECTED'
    : command === 'AUTH' && smtpCode >= 500 && smtpCode < 600 ? 'SMTP_AUTH_FAILED'
    : smtpCode >= 500 && smtpCode < 600 ? 'SMTP_REJECTED' : uncertain ? 'SMTP_ACK_UNCERTAIN' : 'SMTP_TEMPORARY_FAILURE';
  return new EmailDeliveryError(code, uncertain);
}

function setting(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function isValidSingleMailboxAddress(value: string): boolean {
  if (value.length > 254 || /[\s\r\n,;<>()[\]\\"]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !domain || domain.length > 253 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validFromAddress(value: string): boolean {
  return isValidSingleMailboxAddress(value);
}

/** Creates the replaceable SMTP adapter. Local mode is intended for Mailpit only. */
export function createSmtpEmailPort(env: Readonly<Record<string, string | undefined>>,isSuppressed?:(email:string)=>Promise<boolean>): EmailPort {
  const host = setting(env, 'SMTP_HOST');
  const port = Number(setting(env, 'SMTP_PORT') ?? '1025');
  const from = setting(env, 'EMAIL_FROM');
  const releaseMode = (setting(env, 'RELEASE_MODE') ?? 'local').toLowerCase();
  const production = releaseMode === 'public' || releaseMode === 'production' || (setting(env, 'NODE_ENV') ?? '').toLowerCase() === 'production';
  const tls = (setting(env, 'SMTP_TLS') ?? (port === 465 ? 'true' : 'false')).toLowerCase() === 'true';
  const user = setting(env, 'SMTP_USER');
  const pass = setting(env, 'SMTP_PASSWORD');

  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535 || !from || !validFromAddress(from)) {
    throw new Error('SMTP_CONFIGURATION_INVALID');
  }
  if (!production && host.toLowerCase() !== 'mailpit') throw new Error('LOCAL_SMTP_MUST_USE_MAILPIT');
  if (production && (!tls || !user || !pass || setting(env, 'EMAIL_FROM_VERIFIED') !== 'true')) {
    throw new Error('PRODUCTION_SMTP_CONFIGURATION_REQUIRED');
  }

  const transport: Transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465 && tls,
    requireTLS: production,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    ...(user && pass ? { auth: { user, pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    disableFileAccess: true,
    disableUrlAccess: true,
    maxRecipients: 1,
    logger: false,
    debug: false,
  });

  return {
    async send(message) {
      if (!isValidSingleMailboxAddress(message.to)) throw new EmailDeliveryError('INVALID_RECIPIENT_ADDRESS');
      if(isSuppressed&&await isSuppressed(message.to))throw new EmailDeliveryError('SMTP_RECIPIENT_REJECTED');
      try {
        const result = await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: message.messageId,
          headers: { 'X-Delivery-ID': message.messageId.replace(/[<>]/g, '') },
        });
        return {
          messageId: typeof result.messageId === 'string' ? result.messageId : message.messageId,
          accepted: Array.isArray(result.accepted) && result.accepted.length > 0,
        };
      } catch (error) {
        throw classifySmtpFailure(error);
      }
    },
    close() { transport.close(); },
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

export function safeInternalUrl(value: unknown, appOrigin: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\r\n\\]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value, appOrigin); } catch { return null; }
  if (parsed.origin !== appOrigin || !/^\/(ideas|app)(\/|$)/.test(parsed.pathname) && parsed.pathname !== '/digest/unsubscribe') return null;
  return parsed.toString();
}
