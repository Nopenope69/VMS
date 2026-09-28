import { z } from 'zod';
import { NotificationChannelType } from '@prisma/client';
import { encryptCredential, decryptCredential } from '../../../utils/crypto';

/**
 * Per-channel configuration (P3.3). Secrets are write-only: accepted in plaintext on create/update,
 * stored AES-256-GCM encrypted (appliance credential key), never returned by the API.
 *
 * NotificationChannel.targetUrl keeps its historical meaning per type:
 *   WEBHOOK / SLACK: the URL; EMAIL: comma-separated addresses; WHATSAPP / SMS: comma-separated
 *   E.164 phone numbers.
 */
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

export const EmailChannelConfig = z
  .object({
    smtpHost: z.string().min(1),
    smtpPort: z.number().int().min(1).max(65535),
    security: z.enum(['tls', 'starttls', 'none']),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    from: z.string().regex(/^([^<>]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/, 'from must be an address or "Name <address>"'),
    rejectUnauthorized: z.boolean().optional(),
    ratePerMinute: z.number().int().min(1).max(600).optional(),
  })
  .strict()
  .refine((c) => c.security !== 'none' || !c.username, 'credentials require security tls or starttls');

export const WhatsAppChannelConfig = z
  .object({
    phoneNumberId: z.string().regex(/^\d{5,30}$/, 'phoneNumberId is the numeric WhatsApp Business phone number id'),
    accessToken: z.string().min(20),
    /** Pre-approved template (business-initiated messages outside the 24 h window need one). */
    templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
    languageCode: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
    apiVersion: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
    /** Meta app secret: verifies X-Hub-Signature-256 on delivery-status callbacks. */
    appSecret: z.string().min(16).optional(),
    /** Token Meta echoes during webhook verification (GET hub.verify_token). */
    verifyToken: z.string().min(16).optional(),
    ratePerMinute: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const SmsChannelConfig = z
  .object({
    /** HTTPS JSON endpoint of the SMS gateway (see GenericHttpSmsProvider). */
    providerUrl: z.string().url().refine((u) => u.startsWith('https://'), 'providerUrl must be https'),
    apiKey: z.string().min(8),
    senderId: z.string().min(1).max(11).optional(),
    ratePerMinute: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const WebhookChannelConfig = z.object({ ratePerMinute: z.number().int().min(1).max(600).optional() }).strict();

const SECRET_FIELDS: Record<string, string[]> = {
  EMAIL: ['password'],
  WHATSAPP: ['accessToken', 'appSecret', 'verifyToken'],
  SMS: ['apiKey'],
  WEBHOOK: [],
  SLACK: [],
};

export class ChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function schemaFor(type: NotificationChannelType) {
  switch (type) {
    case 'EMAIL':
      return EmailChannelConfig;
    case 'WHATSAPP':
      return WhatsAppChannelConfig;
    case 'SMS':
      return SmsChannelConfig;
    default:
      return WebhookChannelConfig;
  }
}

/** Validates targets for the channel type (addresses, numbers or URL). */
export function validateTargets(type: NotificationChannelType, targetUrl: string): string[] {
  const list = String(targetUrl || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new ChannelConfigError('targetUrl is required');
  if (type === 'EMAIL' && !list.every((a) => EMAIL.test(a))) throw new ChannelConfigError('EMAIL targets must be email addresses');
  if ((type === 'WHATSAPP' || type === 'SMS') && !list.every((n) => E164.test(n))) {
    throw new ChannelConfigError(`${type} targets must be E.164 phone numbers such as +919812345678`);
  }
  if ((type === 'WEBHOOK' || type === 'SLACK') && list.length !== 1) throw new ChannelConfigError('exactly one URL is required');
  return list;
}

/**
 * Validates a config for storage and encrypts its secrets. `previous` is the stored config: a
 * secret omitted on update keeps its stored value (write-only fields are never echoed to clients).
 */
export function prepareChannelConfig(type: NotificationChannelType, input: unknown, previous?: any): Record<string, unknown> {
  const merged: Record<string, any> = { ...(input as any) };
  for (const f of SECRET_FIELDS[type] || []) {
    if (merged[f] === undefined && previous?.[`${f}Encrypted`]) merged[f] = decryptCredential(previous[`${f}Encrypted`]);
  }
  const parsed = schemaFor(type).safeParse(merged);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new ChannelConfigError(`Invalid ${type} channel config: ${i.path.join('.') || 'config'}: ${i.message}`);
  }
  const out: Record<string, unknown> = { ...(parsed.data as any) };
  for (const f of SECRET_FIELDS[type] || []) {
    if (out[f] !== undefined) {
      out[`${f}Encrypted`] = encryptCredential(String(out[f]));
      delete out[f];
    }
  }
  return out;
}

/** Decrypted config for dispatch (server side only). */
export function resolveChannelConfig(type: NotificationChannelType, stored: any): any {
  const cfg: Record<string, any> = { ...(stored || {}) };
  for (const f of SECRET_FIELDS[type] || []) {
    if (cfg[`${f}Encrypted`]) {
      cfg[f] = decryptCredential(cfg[`${f}Encrypted`]);
      delete cfg[`${f}Encrypted`];
    }
  }
  return cfg;
}

/** API view of a channel: secrets replaced by booleans, the webhook HMAC secret never returned. */
export function redactChannel<T extends { type: NotificationChannelType; configJson: any; secretToken?: string | null }>(ch: T) {
  const cfg: Record<string, any> = { ...(ch.configJson || {}) };
  for (const f of SECRET_FIELDS[ch.type] || []) {
    if (cfg[`${f}Encrypted`] !== undefined) {
      delete cfg[`${f}Encrypted`];
      cfg[`${f}Set`] = true;
    }
  }
  const { secretToken, ...rest } = ch as any;
  return { ...rest, configJson: cfg, secretTokenSet: !!secretToken };
}
