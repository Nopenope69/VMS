// node --test scripts/**/*.test.mjs
// Exercises the ONVIF client against a local SOAP stub. This validates request/response handling
// only; interoperability with real cameras is the P1.6 bench (HUMAN-REQUIRED).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { probeOnvif, wsseHeader, xmlText } from './onvif.mjs';

const env = (body) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="x" xmlns:trt="y" xmlns:tt="z"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function stub({ requireAuth = true, fault = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, body });
      const authed = /PasswordDigest/.test(body) && /<wsse:Username>admin<\/wsse:Username>/.test(body);
      if (fault || (requireAuth && !authed)) {
        res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
        return res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Reason><SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>'));
      }
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      if (body.includes('GetDeviceInformation')) {
        return res.end(env('<tds:GetDeviceInformationResponse><tds:Manufacturer>StubCam</tds:Manufacturer><tds:Model>SC-1</tds:Model><tds:FirmwareVersion>9.9.9</tds:FirmwareVersion><tds:SerialNumber>S1</tds:SerialNumber><tds:HardwareId>H1</tds:HardwareId></tds:GetDeviceInformationResponse>'));
      }
      if (body.includes('GetCapabilities')) {
        return res.end(env(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://127.0.0.1:${port}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`));
      }
      if (body.includes('GetProfiles')) {
        return res.end(env('<trt:GetProfilesResponse><trt:Profiles token="Profile_1" fixed="true"><tt:Name>main</tt:Name></trt:Profiles></trt:GetProfilesResponse>'));
      }
      if (body.includes('GetStreamUri')) {
        return res.end(env('<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:554/Streaming/Channels/101</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>'));
      }
      res.end(env(''));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('WS-Security digest follows Base64(SHA1(nonce + created + password))', () => {
  const nonce = Buffer.alloc(16, 1);
  const now = new Date('2026-09-26T10:00:00.000Z');
  const header = wsseHeader('admin', 'pw', now, nonce);
  const expected = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(now.toISOString()), Buffer.from('pw')])).digest('base64');
  assert.equal(xmlText(header, 'Password'), expected);
  assert.equal(xmlText(header, 'Created'), now.toISOString());
});

test('probe walks device info -> media XAddr -> profiles -> stream URI', async () => {
  const { server, seen, port } = await stub();
  try {
    const r = await probeOnvif({ host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    assert.deepEqual(r.deviceInfo, { manufacturer: 'StubCam', model: 'SC-1', firmwareVersion: '9.9.9', serialNumber: 'S1', hardwareId: 'H1' });
    assert.equal(r.profileToken, 'Profile_1');
    assert.equal(r.streamUri, 'rtsp://127.0.0.1:554/Streaming/Channels/101');
    assert.deepEqual(seen.map((s) => s.url), ['/onvif/device_service', '/onvif/device_service', '/onvif/media_service', '/onvif/media_service']);
  } finally {
    server.close();
  }
});

test('SOAP faults surface as errors, never as empty device info', async () => {
  const { server, port } = await stub({ requireAuth: true });
  try {
    await assert.rejects(probeOnvif({ host: '127.0.0.1', port, username: 'wrong', password: 'pw' }), /Sender not Authorized/);
  } finally {
    server.close();
  }
});
