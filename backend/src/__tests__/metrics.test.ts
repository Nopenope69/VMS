import MetricsService from '../services/observability/metrics.service';
import requestLogger from '../middleware/requestLogger';
import metricsRoutes from '../routes/metrics.routes';

describe('Prometheus Metrics Engine & Request Logger Middleware', () => {
  beforeEach(() => {
    MetricsService.resetMetrics();
  });

  it('should record HTTP requests and duration in histogram buckets', async () => {
    MetricsService.recordHttpRequest('GET', '/api/v1/cameras', 200, 0.045);
    MetricsService.recordHttpRequest('GET', '/api/v1/cameras', 200, 0.120);
    MetricsService.recordHttpRequest('POST', '/api/v1/auth/login', 401, 0.015);

    const scraped = await MetricsService.scrapeMetrics();

    // Verify presence of standard Prometheus metrics
    expect(scraped).toContain('# HELP vigilone_http_requests_total');
    expect(scraped).toContain('# TYPE vigilone_http_requests_total counter');
    expect(scraped).toContain('vigilone_http_requests_total{method="GET",route="/api/v1/cameras",status="200",status_class="2xx"} 2');
    expect(scraped).toContain('vigilone_http_requests_total{method="POST",route="/api/v1/auth/login",status="401",status_class="4xx"} 1');

    // Verify histogram buckets
    expect(scraped).toContain('# HELP vigilone_http_request_duration_seconds');
    expect(scraped).toContain('# TYPE vigilone_http_request_duration_seconds histogram');
    expect(scraped).toContain('vigilone_http_request_duration_seconds_bucket{method="GET",route="/api/v1/cameras",le="0.05"} 1');
    expect(scraped).toContain('vigilone_http_request_duration_seconds_bucket{method="GET",route="/api/v1/cameras",le="0.25"} 2');
    expect(scraped).toContain('vigilone_http_request_duration_seconds_bucket{method="GET",route="/api/v1/cameras",le="+Inf"} 2');
  });

  it('should scrape storage vitals and system metrics', async () => {
    const scraped = await MetricsService.scrapeMetrics();

    expect(scraped).toContain('vigilone_process_uptime_seconds');
    expect(scraped).toContain('vigilone_process_resident_memory_bytes');
    expect(scraped).toContain('vigilone_storage_bytes_total');
    expect(scraped).toContain('vigilone_storage_bytes_free');
    expect(scraped).toContain('vigilone_storage_fill_ratio');
    expect(scraped).toContain('vigilone_cameras_total');
    expect(scraped).toContain('vigilone_segment_queue_depth');
  });

  it('should attach and preserve x-request-id correlation header via requestLogger middleware', () => {
    // 1. Auto-generate UUID when missing
    const req1: any = {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/v1/cameras',
      method: 'GET',
    };
    const headersSet1: Record<string, string> = {};
    const res1: any = {
      setHeader: (k: string, v: string) => {
        headersSet1[k] = v;
      },
      on: jest.fn(),
      statusCode: 200,
    };
    let nextCalled1 = false;
    requestLogger(req1, res1, () => {
      nextCalled1 = true;
    });

    expect(nextCalled1).toBe(true);
    expect(headersSet1['x-request-id']).toBeDefined();
    expect(headersSet1['x-request-id'].length).toBeGreaterThan(20);
    expect(req1.requestId).toBe(headersSet1['x-request-id']);

    // 2. Preserve client-supplied correlation ID
    const clientTraceId = 'trace_ext_client_998812';
    const req2: any = {
      headers: { 'x-request-id': clientTraceId },
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/v1/cameras',
      method: 'GET',
    };
    const headersSet2: Record<string, string> = {};
    const res2: any = {
      setHeader: (k: string, v: string) => {
        headersSet2[k] = v;
      },
      on: jest.fn(),
      statusCode: 200,
    };
    let nextCalled2 = false;
    requestLogger(req2, res2, () => {
      nextCalled2 = true;
    });

    expect(nextCalled2).toBe(true);
    expect(headersSet2['x-request-id']).toBe(clientTraceId);
    expect(req2.requestId).toBe(clientTraceId);
  });

  it('should invoke metricsRoutes handler and return 200 text/plain exposition', async () => {
    let responseData = '';
    let responseHeaders: Record<string, string> = {};
    let statusCode = 0;

    const mockReq: any = { method: 'GET', url: '/' };
    const mockRes: any = {
      setHeader: (k: string, v: string) => {
        responseHeaders[k] = v;
      },
      status: (code: number) => {
        statusCode = code;
        return mockRes;
      },
      send: (body: string) => {
        responseData = body;
        return mockRes;
      },
    };

    // Find GET route handler on router stack
    const routeLayer = (metricsRoutes as any).stack.find((l: any) => l.route && l.route.methods.get);
    expect(routeLayer).toBeDefined();

    const handler = routeLayer.route.stack[0].handle;
    await handler(mockReq, mockRes);

    expect(statusCode).toBe(200);
    expect(responseHeaders['Content-Type']).toContain('text/plain; version=0.0.4');
    expect(responseData).toContain('vigilone_process_uptime_seconds');
    expect(responseData).toContain('vigilone_storage_bytes_total');
  });

  it('should reject external non-authorized client IPs with 403 Forbidden', async () => {
    let statusCode = 0;
    let responseData = '';
    const mockReq = {
      ip: '203.0.113.195', // External WAN IP
      headers: {},
      socket: { remoteAddress: '203.0.113.195' },
    };
    const mockRes = {
      status: (code: number) => {
        statusCode = code;
        return mockRes;
      },
      send: (body: string) => {
        responseData = body;
        return mockRes;
      },
      setHeader: () => mockRes,
    };

    const routeLayer = (metricsRoutes as any).stack.find((l: any) => l.route && l.route.methods.get);
    const handler = routeLayer.route.stack[0].handle;
    await handler(mockReq, mockRes);

    expect(statusCode).toBe(403);
    expect(responseData).toContain('Forbidden: External metrics scrape prohibited');
  });
});
