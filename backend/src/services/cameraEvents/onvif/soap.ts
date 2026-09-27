import crypto from 'crypto';
import { parseStringPromise, processors } from 'xml2js';
import { digestText, Credentials, CameraHttpError } from '../httpDigest';

/**
 * SOAP 1.2 transport for ONVIF with WS-Security UsernameToken PasswordDigest
 * (Base64(SHA1(nonce + created + password))) and WS-Addressing. `Created` is expressed in the
 * camera's clock (appliance time + measured skew): cameras reject tokens outside a few seconds
 * of their own clock, which is the usual cause of "NotAuthorized" on correctly configured
 * credentials. Pattern cross-checked with the MIT-licensed `onvif` npm package.
 */
export const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  tt: 'http://www.onvif.org/ver10/schema',
};

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function wsSecurityHeader(creds: Credentials, cameraNow: Date, nonce = crypto.randomBytes(16)): string {
  const created = cameraNow.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(creds.password, 'utf8')])).digest('base64');
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:UsernameToken><wsse:Username>${xmlEscape(creds.username)}</wsse:Username>` +
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  );
}

export function envelope(body: string, opts: { creds?: Credentials | null; cameraNow?: Date; action?: string; to?: string } = {}): string {
  const header =
    (opts.creds ? wsSecurityHeader(opts.creds, opts.cameraNow ?? new Date()) : '') +
    (opts.action ? `<a:Action s:mustUnderstand="1">${xmlEscape(opts.action)}</a:Action><a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>` : '') +
    (opts.to ? `<a:To s:mustUnderstand="1">${xmlEscape(opts.to)}</a:To>` : '');
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:tds="${NS.tds}" xmlns:tev="${NS.tev}" xmlns:wsnt="${NS.wsnt}" xmlns:tt="${NS.tt}"><s:Header>${header}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}

export class OnvifFault extends Error {
  constructor(public readonly code: string, message: string, public readonly permanent: boolean) {
    super(message);
  }
}

/** xml2js with namespace prefixes stripped; attributes under '$'. */
export async function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, { explicitArray: false, tagNameProcessors: [processors.stripPrefix], attrNameProcessors: [processors.stripPrefix], attrkey: '$' });
}

export async function soapCall(
  url: string,
  body: string,
  opts: { creds: Credentials | null; cameraNow?: Date; action: string; to?: string; timeoutMs?: number; httpCreds?: boolean }
): Promise<{ body: any; headers: Record<string, any> }> {
  const xml = envelope(body, { creds: opts.creds, cameraNow: opts.cameraNow, action: opts.action, to: opts.to });
  const res = await digestText(url, opts.httpCreds === false ? null : opts.creds, {
    method: 'POST',
    headers: { 'content-type': `application/soap+xml; charset=utf-8; action="${opts.action}"` },
    body: xml,
    timeoutMs: opts.timeoutMs ?? 10000,
    allowErrorStatus: true,
  });
  const doc = await parseXml(res.body).catch(() => null);
  const b = doc?.Envelope?.Body;
  if (!b) {
    if (res.status >= 400) throw new CameraHttpError(res.status, `${url} -> ${res.status} ${res.body.slice(0, 200)}`, res.status === 403 || res.status === 404);
    throw new OnvifFault('MALFORMED', `${url}: response is not a SOAP envelope`, false);
  }
  if (b.Fault) throw faultFrom(doc);
  return { body: b, headers: res.headers };
}

function faultFrom(doc: any): OnvifFault {
  const f = doc?.Envelope?.Body?.Fault ?? {};
  const sub = JSON.stringify(f.Code ?? '');
  const reasonNode = f.Reason?.Text;
  const reason = typeof reasonNode === 'string' ? reasonNode : reasonNode?._ ?? 'SOAP fault';
  const notAuth = /NotAuthorized|FailedAuthentication|InvalidSecurity/i.test(sub + reason);
  return new OnvifFault(notAuth ? 'NOT_AUTHORIZED' : 'SOAP_FAULT', `ONVIF fault: ${reason}${notAuth ? ' (check credentials and the camera clock)' : ''}`, notAuth);
}
