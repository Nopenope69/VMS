import {
  buildLoopbackRtspUrl,
  sanitizeStreamPath,
  validateLoopbackHost,
  CANONICAL_LOOPBACK_HOST,
  DEFAULT_MEDIAMTX_RTSP_PORT,
} from '../rtspUrlBuilder';

describe('Safe Loopback RTSP URL Construction & Sanitization', () => {
  const originalEnvPort = process.env.MEDIAMTX_RTSP_PORT;

  afterEach(() => {
    process.env.MEDIAMTX_RTSP_PORT = originalEnvPort;
  });

  describe('1. Canonical Loopback Host Invariant', () => {
    it('constructs canonical URL with default 127.0.0.1 and port 8554', () => {
      const url = buildLoopbackRtspUrl('cam_front_gate');
      expect(url).toBe(`rtsp://${CANONICAL_LOOPBACK_HOST}:${DEFAULT_MEDIAMTX_RTSP_PORT}/cam_front_gate`);
    });

    it('respects valid custom port parameter', () => {
      const url = buildLoopbackRtspUrl('cam_back_gate', 8555);
      expect(url).toBe(`rtsp://${CANONICAL_LOOPBACK_HOST}:8555/cam_back_gate`);
    });

    it('respects valid MEDIAMTX_RTSP_PORT environment variable', () => {
      process.env.MEDIAMTX_RTSP_PORT = '9554';
      const url = buildLoopbackRtspUrl('cam_test');
      expect(url).toBe(`rtsp://${CANONICAL_LOOPBACK_HOST}:9554/cam_test`);
    });

    it('rejects invalid port numbers (out of range, NaN, non-integer)', () => {
      expect(() => buildLoopbackRtspUrl('cam_test', 0)).toThrow(/Invalid RTSP port/);
      expect(() => buildLoopbackRtspUrl('cam_test', 65536)).toThrow(/Invalid RTSP port/);
      expect(() => buildLoopbackRtspUrl('cam_test', -5)).toThrow(/Invalid RTSP port/);
      expect(() => buildLoopbackRtspUrl('cam_test', NaN)).toThrow(/Invalid RTSP port/);
    });

    it('strictly validates loopback hosts and rejects non-loopback destinations', () => {
      expect(validateLoopbackHost('127.0.0.1')).toBe(true);
      expect(validateLoopbackHost('rtsp://127.0.0.1:8554/cam1')).toBe(true);

      // FORBIDDEN: External camera addresses and private network cameras
      expect(validateLoopbackHost('192.168.1.100')).toBe(false);
      expect(validateLoopbackHost('10.0.0.50')).toBe(false);
      expect(validateLoopbackHost('172.16.0.10')).toBe(false);
      expect(validateLoopbackHost('camera.local')).toBe(false);
      expect(validateLoopbackHost('rtsp://192.168.1.100:8554/cam1')).toBe(false);
      expect(validateLoopbackHost('rtsp://camera.internal:8554/cam1')).toBe(false);
      expect(validateLoopbackHost('rtsp://8.8.8.8:8554/cam1')).toBe(false);
    });
  });

  describe('2. Stream Path Sanitization & Injection Prevention', () => {
    it('normalizes valid alphanumeric stream paths with hyphens and underscores', () => {
      expect(sanitizeStreamPath('cam_lobby_01')).toBe('cam_lobby_01');
      expect(sanitizeStreamPath('tenant-alpha/cam-02')).toBe('tenant-alpha/cam-02');
    });

    it('strips redundant leading and trailing slashes cleanly', () => {
      expect(sanitizeStreamPath('/cam_lobby/')).toBe('cam_lobby');
      expect(sanitizeStreamPath('///tenant/cam///')).toBe('tenant/cam');
    });

    it('rejects directory traversal attempts (..)', () => {
      expect(() => sanitizeStreamPath('../../etc/shadow')).toThrow(/Directory traversal/);
      expect(() => sanitizeStreamPath('cam/../other')).toThrow(/Directory traversal/);
      expect(() => sanitizeStreamPath('..')).toThrow(/Directory traversal/);
    });

    it('rejects shell metacharacters, spaces, newlines, and control characters', () => {
      expect(() => sanitizeStreamPath('cam; rm -rf /')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam&touch/tmp/pwn')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam|sh')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam$FOO')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam`ls`')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam name with spaces')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam\nline')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam\0null')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath('cam"quote')).toThrow(/Contains disallowed characters/);
      expect(() => sanitizeStreamPath("cam'quote")).toThrow(/Contains disallowed characters/);
    });

    it('rejects empty, whitespace-only, or root-only paths', () => {
      expect(() => sanitizeStreamPath('')).toThrow(/non-empty string/);
      expect(() => sanitizeStreamPath('   ')).toThrow(/cannot be empty/);
      expect(() => sanitizeStreamPath('///')).toThrow(/cannot resolve to root/);
    });
  });
});

describe('loopback read credentials (MediaMTX authMethod: http)', () => {
  const { buildLoopbackRtspUrl, redactRtspUrl, validateLoopbackHost } = require('../rtspUrlBuilder');

  it('embeds URL-encoded credentials and still targets only 127.0.0.1', () => {
    const url = buildLoopbackRtspUrl('cam_1', 8554, { user: 'internal', password: 'p@ss/w:rd' });
    expect(url).toBe('rtsp://internal:p%40ss%2Fw%3Ard@127.0.0.1:8554/cam_1');
    expect(validateLoopbackHost(url)).toBe(true);
  });

  it('reads credentials from MEDIAMTX_READ_PASSWORD when not given explicitly', () => {
    const prev = process.env.MEDIAMTX_READ_PASSWORD;
    process.env.MEDIAMTX_READ_PASSWORD = 'secret123';
    try {
      expect(buildLoopbackRtspUrl('cam_2', 8554)).toBe('rtsp://internal:secret123@127.0.0.1:8554/cam_2');
    } finally {
      if (prev === undefined) delete process.env.MEDIAMTX_READ_PASSWORD;
      else process.env.MEDIAMTX_READ_PASSWORD = prev;
    }
  });

  it('never leaks the password into logs or errors', () => {
    expect(redactRtspUrl('failed: rtsp://internal:secret123@127.0.0.1:8554/cam_2: 401')).toBe(
      'failed: rtsp://internal:***@127.0.0.1:8554/cam_2: 401'
    );
  });
});
