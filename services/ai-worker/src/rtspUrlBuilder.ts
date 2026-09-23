/**
 * Safe Loopback RTSP URL Construction & Sanitization.
 *
 * STRICT ARCHITECTURAL INVARIANT:
 * The AI Worker communicates EXCLUSIVELY with the MediaMTX localhost relay on 127.0.0.1.
 * Direct connection to external IP cameras or ONVIF devices is strictly forbidden.
 */

export const CANONICAL_LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_MEDIAMTX_RTSP_PORT = 8554;

const SAFE_STREAM_PATH_PATTERN = /^[a-zA-Z0-9_\-\/]+$/;

/**
 * Validates that a host or URL strictly targets the canonical 127.0.0.1 loopback interface.
 * Rejects external IP addresses, private subnets (RFC 1918), and remote hostnames.
 */
export function validateLoopbackHost(hostOrUrl: string): boolean {
  if (!hostOrUrl || typeof hostOrUrl !== 'string') {
    return false;
  }

  try {
    if (hostOrUrl.includes('://')) {
      const parsed = new URL(hostOrUrl);
      return parsed.hostname === CANONICAL_LOOPBACK_HOST;
    }
    // Bare hostname or host:port
    const host = hostOrUrl.split(':')[0].trim();
    return host === CANONICAL_LOOPBACK_HOST;
  } catch {
    return false;
  }
}

/**
 * Validates and sanitizes a MediaMTX streamPath.
 * Prevents command injection, path traversal, and argument smuggling.
 */
export function sanitizeStreamPath(streamPath: string): string {
  if (!streamPath || typeof streamPath !== 'string') {
    throw new Error('streamPath must be a non-empty string');
  }

  const trimmed = streamPath.trim();
  if (trimmed.length === 0) {
    throw new Error('streamPath cannot be empty');
  }

  // Reject directory traversal
  if (trimmed.includes('..')) {
    throw new Error(`Invalid streamPath '${streamPath}': Directory traversal (..) is strictly prohibited`);
  }

  // Reject shell metacharacters, control codes, and whitespace
  if (!SAFE_STREAM_PATH_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid streamPath '${streamPath}': Contains disallowed characters. Must match [a-zA-Z0-9_\\-/]`
    );
  }

  // Strip leading and trailing slashes to guarantee clean canonical pathing
  const normalized = trimmed.replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0) {
    throw new Error('streamPath cannot resolve to root');
  }

  return normalized;
}

/**
 * Validates an RTSP port number.
 */
export function validateRtspPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid RTSP port '${port}': Port must be an integer between 1 and 65535`);
  }
  return port;
}

/**
 * Builds the canonical localhost loopback RTSP URL for a camera stream.
 *
 * @param streamPath The MediaMTX path key (e.g. 'cam_gate_north')
 * @param customPort Optional port override (defaults to MEDIAMTX_RTSP_PORT env or 8554)
 * @returns Fully qualified loopback RTSP URL: rtsp://127.0.0.1:<port>/<sanitizedPath>
 */
export function buildLoopbackRtspUrl(streamPath: string, customPort?: number): string {
  const sanitizedPath = sanitizeStreamPath(streamPath);

  let port = DEFAULT_MEDIAMTX_RTSP_PORT;
  if (customPort !== undefined) {
    port = validateRtspPort(customPort);
  } else if (process.env.MEDIAMTX_RTSP_PORT) {
    const parsed = parseInt(process.env.MEDIAMTX_RTSP_PORT, 10);
    port = validateRtspPort(parsed);
  }

  const constructedUrl = `rtsp://${CANONICAL_LOOPBACK_HOST}:${port}/${sanitizedPath}`;

  // Final sanity assertion
  if (!validateLoopbackHost(constructedUrl)) {
    throw new Error(`Constructed URL '${constructedUrl}' violated loopback host invariant`);
  }

  return constructedUrl;
}
