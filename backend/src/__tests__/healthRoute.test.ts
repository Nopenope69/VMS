import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';

/**
 * /health must report the media engine as down when its control API is unreachable
 * (previously it always said "ok" because the probe swallowed errors).
 */
describe('GET /api/v1/health media engine probe', () => {
  const originalUrl = process.env.MEDIAMTX_API_URL;
  let engine: http.Server | null = null;

  afterEach(async () => {
    // Assigning undefined would store the string "undefined" and leak into later test files.
    if (originalUrl === undefined) delete process.env.MEDIAMTX_API_URL;
    else process.env.MEDIAMTX_API_URL = originalUrl;
    if (engine) await new Promise<void>((r) => engine!.close(() => r()));
    engine = null;
    jest.resetModules();
  });

  const startApp = async () => {
    const healthRoutes = (await import('../routes/health.routes')).default;
    const app = express();
    app.use('/api/v1', healthRoutes);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/health` };
  };

  it('reports an error when the engine control API is unreachable', async () => {
    process.env.MEDIAMTX_API_URL = 'http://127.0.0.1:1';
    jest.resetModules();
    const { server, url } = await startApp();
    try {
      const body: any = await (await fetch(url)).json();
      expect(body.services.mediaEngine).toMatch(/^error: MediaMTX control API unreachable/);
    } finally {
      server.close();
    }
  });

  it('reports ok when the engine control API answers', async () => {
    engine = http.createServer((req, res) => {
      res.writeHead(req.url?.startsWith('/v3/paths/list') ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end('{"itemCount":0,"pageCount":0,"items":[]}');
    });
    await new Promise<void>((r) => engine!.listen(0, '127.0.0.1', r));
    process.env.MEDIAMTX_API_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    jest.resetModules();
    const { server, url } = await startApp();
    try {
      const body: any = await (await fetch(url)).json();
      expect(body.services.mediaEngine).toBe('ok');
    } finally {
      server.close();
    }
  });
});
