/**
 * P3.1 / P3.2 protocol pieces with independent vectors and fixture documents
 * (fixtures/camera-events/README.md says where each format comes from).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { digestAuthorization, parseDigestChallenge } from '../services/cameraEvents/httpDigest';
import { MultipartStreamParser, boundaryFromContentType, MultipartPart } from '../services/cameraEvents/multipart';
import { parseHikvisionAlert } from '../services/cameraEvents/hikvision';
import { parseDahuaEventText } from '../services/cameraEvents/dahua';
import { parseXml, wsSecurityHeader } from '../services/cameraEvents/onvif/soap';
import { parseNotificationMessages, topicToAnalyticType } from '../services/cameraEvents/onvif/notifications';
import { skewFromCameraTime, onvifUtcDateTime } from '../services/cameraEvents/onvif/clockSkew';
import { parseMetadataStream, MetadataArchive } from '../services/cameraEvents/onvif/profileM';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'camera-events', f), 'utf8');

describe('HTTP Digest (RFC 7616 section 3.9.1 example)', () => {
  // Expected responses are the RFC's published values; the RFC site is not reachable from the
  // sandbox, so they were also recomputed with Python hashlib (a separate implementation).
  const chal = parseDigestChallenge(
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"'
  )!;
  const creds = { username: 'Mufasa', password: 'Circle of Life' };
  const cnonce = 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';

  it('SHA-256', () => {
    expect(digestAuthorization(chal, creds, 'GET', '/dir/index.html', 1, cnonce)).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"');
  });
  it('MD5', () => {
    expect(digestAuthorization({ ...chal, algorithm: 'MD5' }, creds, 'GET', '/dir/index.html', 1, cnonce)).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
  });
  it('rejects unknown algorithms instead of guessing', () => {
    expect(() => digestAuthorization({ ...chal, algorithm: 'SHA-512-256' }, creds, 'GET', '/', 1)).toThrow(/Unsupported digest algorithm/);
  });
});

describe('WS-Security UsernameToken PasswordDigest', () => {
  it('matches Base64(SHA1(nonce + created + password)) computed independently (Python hashlib)', () => {
    const h = wsSecurityHeader({ username: 'admin', password: 'cam-pass' }, new Date('2026-09-27T10:00:05.123Z'), Buffer.from([...Array(16).keys()]));
    expect(h).toContain('>UzN1WL6/fYl8kuNdRJyDU959R4M=</wsse:Password>');
    expect(h).toContain('<wsu:Created>2026-09-27T10:00:05Z</wsu:Created>');
    expect(h).toContain('>AAECAwQFBgcICQoLDA0ODw==</wsse:Nonce>');
  });
  it('escapes the username', () => {
    expect(wsSecurityHeader({ username: 'a<b', password: 'x' }, new Date())).toContain('<wsse:Username>a&lt;b</wsse:Username>');
  });
});

describe('multipart stream parser', () => {
  const partsOf = (stream: Buffer, boundary: string, chunk: number) => {
    const out: MultipartPart[] = [];
    const p = new MultipartStreamParser(boundary, (x) => out.push(x));
    for (let i = 0; i < stream.length; i += chunk) p.feed(stream.subarray(i, i + chunk));
    return out;
  };
  const body1 = fx('hikvision-fielddetection-active.xml');
  const stream = Buffer.from(
    `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}\r\n` +
      `--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\r\n\r\n` +
      `--boundary\r\nContent-Type: text/plain\r\n\r\nHeartbeat\r\n--boundary\r\n`,
    'latin1'
  );

  it.each([1, 7, 64, 100000])('yields the same parts for any chunking (%d-byte chunks)', (chunk) => {
    const parts = partsOf(stream, 'boundary', chunk);
    expect(parts.map((p) => p.headers['content-type'])).toEqual(['application/xml; charset="UTF-8"', 'image/jpeg', 'text/plain']);
    expect(parts[0].body.toString('utf8')).toBe(body1);
    expect([...parts[1].body]).toEqual([0xff, 0xd8, 0x0d, 0x0a]); // exact bytes, trailing CRLF kept
    expect(parts[2].body.toString()).toBe('Heartbeat');
  });

  it('reads the boundary with or without quotes and a leading --', () => {
    expect(boundaryFromContentType('multipart/mixed; boundary=boundary')).toBe('boundary');
    expect(boundaryFromContentType('multipart/x-mixed-replace; boundary="--myboundary"')).toBe('myboundary');
    expect(boundaryFromContentType('text/plain')).toBeNull();
  });
});

describe('Hikvision ISAPI', () => {
  it('maps fielddetection active / inactive to INTRUSION start / stop with channel, region and target', async () => {
    const a = await parseHikvisionAlert(fx('hikvision-fielddetection-active.xml'));
    expect(a.heartbeat).toBe(false);
    expect(a.event).toMatchObject({ protocol: 'HIKVISION_ISAPI', analyticType: 'INTRUSION', state: true, vendorTopic: 'fielddetection', channel: 1, ruleName: 'region 2', objectType: 'human' });
    expect(a.event!.cameraTimeUtc!.toISOString()).toBe('2026-09-27T10:00:12.000Z');
    expect((await parseHikvisionAlert(fx('hikvision-fielddetection-inactive.xml'))).event!.state).toBe(false);
  });
  it('treats videoloss/inactive as a heartbeat, not an event', async () => {
    expect(await parseHikvisionAlert(fx('hikvision-videoloss-heartbeat.xml'))).toEqual({ heartbeat: true, event: null });
  });
  it('refuses DTDs (no entity expansion from a hostile device)', async () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "xxxxxxxx"><!ENTITY y "&x;&x;&x;&x;">]><EventNotificationAlert><eventType>&y;</eventType></EventNotificationAlert>';
    await expect(parseHikvisionAlert(bomb)).rejects.toThrow(/DOCTYPE/);
  });
  it('unknown vendor types are VENDOR_OTHER, never guessed', async () => {
    const xml = fx('hikvision-fielddetection-active.xml').replace('fielddetection</eventType>', 'thermometry</eventType>');
    expect((await parseHikvisionAlert(xml)).event!.analyticType).toBe('VENDOR_OTHER');
  });
});

describe('Dahua eventManager', () => {
  it('parses start / stop with JSON data that itself contains ";"', () => {
    const s = parseDahuaEventText(fx('dahua-crossline-start.txt'));
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ protocol: 'DAHUA_EVENT_MANAGER', analyticType: 'LINE_CROSSING', state: true, vendorTopic: 'CrossLineDetection', channel: 0, ruleName: 'Gate; north', objectType: 'Human' });
    expect(s.events[0].cameraTimeUtc).toBeNull(); // Dahua's UTC field is not trusted as UTC
    expect(parseDahuaEventText(fx('dahua-crossline-stop.txt')).events[0].state).toBe(false);
  });
  it('heartbeats and multi-event parts', () => {
    expect(parseDahuaEventText(fx('dahua-heartbeat.txt'))).toEqual({ heartbeat: true, events: [] });
    const two = parseDahuaEventText('Code=VideoMotion;action=Start;index=0\r\nCode=VideoBlind;action=Pulse;index=1');
    expect(two.events.map((e) => [e.analyticType, e.state, e.channel])).toEqual([['MOTION', true, 0], ['TAMPER', null, 1]]);
  });
});

describe('ONVIF notifications', () => {
  it('parses PullMessages: skips Initialized, keeps Changed and instantaneous messages', async () => {
    const doc = await parseXml(fx('onvif-pullmessages-response.xml'));
    const evs = parseNotificationMessages(doc.Envelope.Body.PullMessagesResponse);
    expect(evs.map((e) => [e.analyticType, e.state, e.ruleName ?? null])).toEqual([
      ['INTRUSION', true, 'Perimeter'],
      ['LINE_CROSSING', null, 'Gate'],
      ['DIGITAL_INPUT', true, null],
    ]);
    expect(evs[0].cameraTimeUtc!.toISOString()).toBe('2026-09-27T10:00:07.000Z');
    expect(evs[0].vendorTopic).toBe('tns1:RuleEngine/FieldDetector/ObjectsInside');
  });
  it('topic mapping falls back to VENDOR_OTHER', () => {
    expect(topicToAnalyticType('tns1:VideoSource/MotionAlarm')).toBe('MOTION');
    expect(topicToAnalyticType('tns1:Monitoring/ProcessorUsage')).toBe('VENDOR_OTHER');
  });
});

describe('camera clock skew (second-resolution camera clock)', () => {
  const cam = new Date('2026-09-27T10:00:05Z');
  it('reports DRIFT only when the whole interval exceeds the threshold', () => {
    // camera says 10:00:05, appliance sent at 10:00:03.500 and got the answer at 10:00:03.520
    const r = skewFromCameraTime(cam, cam.getTime() - 1500, cam.getTime() - 1480, 100);
    expect(r).toMatchObject({ lowerMs: 1480, upperMs: 2500, verdict: 'DRIFT' });
  });
  it('is UNDETERMINED when a 100 ms threshold is inside the 1 s uncertainty', () => {
    const r = skewFromCameraTime(cam, cam.getTime() + 400, cam.getTime() + 420, 100);
    expect(r.verdict).toBe('UNDETERMINED');
    expect(r.lowerMs).toBe(-420);
    expect(r.upperMs).toBe(600);
  });
  it('can never confirm a 100 ms bound: the interval is always wider than the 1 s clock resolution', () => {
    // Best case: the answer arrived instantly just before the camera's next second.
    const r = skewFromCameraTime(cam, cam.getTime() + 999, cam.getTime() + 999, 100);
    expect(r.upperMs - r.lowerMs).toBeGreaterThanOrEqual(1000);
    expect(r.verdict).toBe('UNDETERMINED');
    // With a threshold the resolution can support, a well-synchronised camera reads OK.
    expect(skewFromCameraTime(cam, cam.getTime() + 450, cam.getTime() + 460, 600).verdict).toBe('OK');
  });
  it('reads tt:UTCDateTime', () => {
    expect(onvifUtcDateTime({ Date: { Year: '2026', Month: '9', Day: '27' }, Time: { Hour: '10', Minute: '0', Second: '5' } })!.toISOString()).toBe('2026-09-27T10:00:05.000Z');
  });
});

describe('Profile M metadata', () => {
  it('converts ONVIF [-1,1] y-up boxes (and Frame transformations) to top-left [0,1] boxes', async () => {
    const frames = await parseMetadataStream(fx('onvif-metadata-stream.xml'));
    expect(frames).toHaveLength(2);
    const [f1, f2] = frames;
    expect(f1.utcTime).toBe('2026-09-27T10:00:05.100Z');
    const b7 = f1.objects[0].bbox!;
    [b7.x, b7.y, b7.width, b7.height].forEach((v, i) => expect(v).toBeCloseTo([0.25, 0.25, 0.25, 0.5][i], 9));
    expect(f1.objects[0].classes).toEqual([{ type: 'Human', likelihood: 0.85 }]);
    const b8 = f1.objects[1].bbox!;
    [b8.x, b8.y, b8.width, b8.height].forEach((v, i) => expect(v).toBeCloseTo([0.6, 0.6, 0.2, 0.3][i], 9));
    expect(f1.objects[1].classes).toEqual([{ type: 'Vehicle', likelihood: 0.6 }]);
    const t7 = f2.objects[0].bbox!;
    [t7.x, t7.y, t7.width, t7.height].forEach((v, i) => expect(v).toBeCloseTo([0.25, 0.25, 0.25, 0.5][i], 9));
  });

  it('archives frames as JSONL per camera and day, and prunes by retention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-meta-'));
    try {
      const archive = new MetadataArchive(dir, 30);
      const frames = await parseMetadataStream(fx('onvif-metadata-stream.xml'));
      await archive.append('cam-1', frames);
      await archive.append('cam-1', [{ utcTime: '2026-07-01T00:00:00.000Z', objects: [] }]);
      const lines = fs.readFileSync(path.join(dir, 'cam-1', '2026-09-27.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ cameraId: 'cam-1', utcTime: '2026-09-27T10:00:05.100Z' });
      expect(await archive.prune(new Date('2026-09-27T12:00:00Z'))).toEqual([path.join('cam-1', '2026-07-01.jsonl')]);
      await expect(archive.append('../escape', frames)).rejects.toThrow(/invalid cameraId/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
