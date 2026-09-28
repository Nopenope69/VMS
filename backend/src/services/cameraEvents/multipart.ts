/**
 * Incremental parser for multipart/mixed and multipart/x-mixed-replace event streams.
 * Parts are delimited by "--boundary"; a part's Content-Length is used when present, otherwise
 * the next boundary ends it. Tolerates devices that put "--" in the boundary parameter itself
 * and devices that omit the blank CRLF before the delimiter.
 */
export interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
}

export function boundaryFromContentType(ct: string | undefined): string | null {
  const m = /boundary\s*=\s*"?([^";]+)"?/i.exec(ct || '');
  if (!m) return null;
  return m[1].replace(/^--/, '').trim();
}

const MAX_BUFFER = 4 * 1024 * 1024;

export class MultipartStreamParser {
  private buf = Buffer.alloc(0);
  private readonly delim: Buffer;

  constructor(boundary: string, private onPart: (p: MultipartPart) => void) {
    this.delim = Buffer.from(`--${boundary}`);
  }

  feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_BUFFER) throw new Error(`multipart part exceeds ${MAX_BUFFER} bytes without a delimiter`);
    for (;;) {
      const start = this.buf.indexOf(this.delim);
      if (start < 0) return;
      let p = start + this.delim.length;
      if (this.buf.length < p + 2) return;
      if (this.buf[p] === 0x2d && this.buf[p + 1] === 0x2d) {
        // closing delimiter
        this.buf = this.buf.subarray(p + 2);
        continue;
      }
      const headerEnd = this.buf.indexOf('\r\n\r\n', p);
      if (headerEnd < 0) return;
      const headers: Record<string, string> = {};
      for (const line of this.buf.subarray(p, headerEnd).toString('latin1').split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const bodyStart = headerEnd + 4;
      const len = Number(headers['content-length']);
      let bodyEnd: number;
      let next: number;
      if (Number.isFinite(len) && len >= 0 && headers['content-length'] !== undefined) {
        if (this.buf.length < bodyStart + len) return;
        bodyEnd = bodyStart + len;
        next = bodyEnd;
      } else {
        const d = this.buf.indexOf(this.delim, bodyStart);
        if (d < 0) return;
        bodyEnd = d;
        next = d;
      }
      let body = this.buf.subarray(bodyStart, bodyEnd);
      // Without Content-Length the CRLF before the delimiter is not part of the body. With it,
      // the body is exact (binary snapshots may legitimately end in CR/LF bytes).
      if (!(Number.isFinite(len) && headers['content-length'] !== undefined)) {
        while (body.length && (body[body.length - 1] === 0x0a || body[body.length - 1] === 0x0d)) body = body.subarray(0, body.length - 1);
      }
      this.buf = this.buf.subarray(next);
      this.onPart({ headers, body: Buffer.from(body) });
    }
  }
}
