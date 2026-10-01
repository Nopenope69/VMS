import crypto from 'crypto';
import { setting } from '../../../config/settings';

/**
 * WhatsApp Business Cloud API client (P3.3).
 *
 * POST https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages with a pre-approved
 * template (business-initiated messages outside the 24 h customer window must use templates).
 * The response's messages[0].id (a "wamid") is the delivery-receipt key; delivery states arrive
 * later on the webhook (verifyWebhookSignature + parseStatusCallback).
 *
 * The base URL can only be overridden under NODE_ENV=test (WHATSAPP_API_BASE_URL), for the test
 * double; on an appliance every call goes to graph.facebook.com.
 */
export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  languageCode: string;
  apiVersion: string;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
  statusCode: number;
}

export class WhatsAppError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly permanent: boolean) {
    super(message);
  }
}

export function whatsappBaseUrl(): string {
  const testBase = setting('WHATSAPP_API_BASE_URL');
  if (setting('NODE_ENV') === 'test' && testBase) return testBase;
  return 'https://graph.facebook.com';
}

/** Sends one template message; template body parameters are the alarm fields, in order. */
export async function sendWhatsAppTemplate(cfg: WhatsAppConfig, to: string, bodyParams: string[], timeoutMs = 10000): Promise<WhatsAppSendResult> {
  const url = `${whatsappBaseUrl()}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: cfg.templateName,
      language: { code: cfg.languageCode },
      components: [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t.slice(0, 1000) })) }],
    },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'error',
    });
  } catch (e: any) {
    throw new WhatsAppError(0, `WhatsApp request failed: ${e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : e.message}`, false);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    // 4xx (bad token, unknown template, invalid number) will not fix itself; 429 and 5xx are retried.
    throw new WhatsAppError(res.status, `WhatsApp API ${res.status}: ${msg}`, res.status >= 400 && res.status < 500 && res.status !== 429);
  }
  const id = json?.messages?.[0]?.id;
  if (typeof id !== 'string' || !id) {
    throw new WhatsAppError(res.status, 'WhatsApp API accepted the request but returned no message id', false);
  }
  return { providerMessageId: id, statusCode: res.status };
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256(appSecret, raw body). Constant-time compare. */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

export interface DeliveryStatusUpdate {
  providerMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  at: Date;
  error?: string;
}

/** Extracts message status updates from a WhatsApp webhook payload (entry[].changes[].value.statuses[]). */
export function parseStatusCallback(payload: any): DeliveryStatusUpdate[] {
  const out: DeliveryStatusUpdate[] = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const s of change?.value?.statuses || []) {
        const status = String(s?.status || '').toUpperCase();
        if (!['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status) || typeof s?.id !== 'string') continue;
        const ts = Number(s.timestamp);
        out.push({
          providerMessageId: s.id,
          status: status as DeliveryStatusUpdate['status'],
          at: Number.isFinite(ts) ? new Date(ts * 1000) : new Date(),
          error: s.errors?.[0]?.title || s.errors?.[0]?.message,
        });
      }
    }
  }
  return out;
}
