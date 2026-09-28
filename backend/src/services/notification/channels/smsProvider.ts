/**
 * SMS provider interface (P3.3). Gateways differ per country and contract, so VigilOne ships the
 * interface plus one generic HTTPS JSON provider; a gateway-specific provider implements
 * SmsProvider. Nothing is sent when no provider is configured (NO_SMS_PROVIDER_CONFIGURED).
 */
export interface SmsSendResult {
  providerMessageId: string | null;
  statusCode: number;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<SmsSendResult>;
}

export class SmsError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly permanent: boolean) {
    super(message);
  }
}

/**
 * POST {providerUrl} with Authorization: Bearer <apiKey> and body
 * {"to": "+91...", "message": "...", "sender": "<senderId>"}. The response's "id" or "messageId"
 * is taken as the receipt; a 2xx without one is still accepted (receipt null), never invented.
 */
export class GenericHttpSmsProvider implements SmsProvider {
  readonly name = 'generic-https-json';
  constructor(private cfg: { providerUrl: string; apiKey: string; senderId?: string }, private timeoutMs = 10000) {}

  async send(to: string, message: string): Promise<SmsSendResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.cfg.providerUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to, message: message.slice(0, 1000), ...(this.cfg.senderId ? { sender: this.cfg.senderId } : {}) }),
        signal: ctl.signal,
        redirect: 'error',
      });
    } catch (e: any) {
      throw new SmsError(0, `SMS gateway request failed: ${e.name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : e.message}`, false);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new SmsError(res.status, `SMS gateway ${res.status}: ${text.slice(0, 300)}`, res.status >= 400 && res.status < 500 && res.status !== 429);
    }
    let id: string | null = null;
    try {
      const j = JSON.parse(text);
      id = typeof j?.id === 'string' ? j.id : typeof j?.messageId === 'string' ? j.messageId : null;
    } catch {
      /* gateway answered 2xx without JSON */
    }
    return { providerMessageId: id, statusCode: res.status };
  }
}
