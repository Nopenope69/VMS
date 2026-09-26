// Minimal ONVIF client (SOAP 1.2 + WS-Security UsernameToken digest), enough for the bench:
// GetDeviceInformation, GetCapabilities (media XAddr), GetProfiles, GetStreamUri.
import crypto from 'node:crypto';

const NS = {
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
};

export function wsseHeader(username, password, now = new Date(), nonce = crypto.randomBytes(16)) {
  if (!username) return '';
  const created = now.toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password || '')]))
    .digest('base64');
  return `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${escapeXml(username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Extracts the text of the first element with this local name, ignoring namespace prefixes. */
export function xmlText(xml, localName) {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${localName}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${localName}>`));
  return m ? m[1].trim() : null;
}

export function xmlAttr(xml, localName, attr) {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${localName}\\s[^>]*\\b${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

async function soap(url, body, { username, password, timeoutMs = 8000 }) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${wsseHeader(username, password)}<s:Body>${body}</s:Body></s:Envelope>`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: envelope,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok || /<(?:[\w-]+:)?Fault[\s>]/.test(text)) {
      const reason = xmlText(text, 'Text') || xmlText(text, 'faultstring') || `HTTP ${res.status}`;
      throw new Error(`ONVIF fault at ${url}: ${reason}`);
    }
    return text;
  } finally {
    clearTimeout(t);
  }
}

export async function probeOnvif({ host, port = 80, username, password, timeoutMs }) {
  const deviceUrl = `http://${host}:${port}/onvif/device_service`;
  const opts = { username, password, timeoutMs };
  const info = await soap(deviceUrl, `<GetDeviceInformation xmlns="${NS.tds}"/>`, opts);
  const deviceInfo = {
    manufacturer: xmlText(info, 'Manufacturer'),
    model: xmlText(info, 'Model'),
    firmwareVersion: xmlText(info, 'FirmwareVersion'),
    serialNumber: xmlText(info, 'SerialNumber'),
    hardwareId: xmlText(info, 'HardwareId'),
  };
  const caps = await soap(deviceUrl, `<GetCapabilities xmlns="${NS.tds}"><Category>Media</Category></GetCapabilities>`, opts);
  const mediaSection = caps.match(/<(?:[\w-]+:)?Media>[\s\S]*?<\/(?:[\w-]+:)?Media>/);
  const mediaUrl = (mediaSection && xmlText(mediaSection[0], 'XAddr')) || deviceUrl;
  const profiles = await soap(mediaUrl, `<GetProfiles xmlns="${NS.trt}"/>`, opts);
  const profileToken = xmlAttr(profiles, 'Profiles', 'token');
  let streamUri = null;
  if (profileToken) {
    const uriRes = await soap(
      mediaUrl,
      `<GetStreamUri xmlns="${NS.trt}"><StreamSetup><Stream xmlns="${NS.tt}">RTP-Unicast</Stream><Transport xmlns="${NS.tt}"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetStreamUri>`,
      opts
    );
    streamUri = xmlText(uriRes, 'Uri');
  }
  return { deviceInfo, mediaUrl, profileToken, streamUri };
}
