import checkDiskSpace from 'check-disk-space';
import { SegmentStatus } from '@prisma/client';
import prisma from '../../config/database';
import config from '../../config/env';

export interface MetricLabelSet {
  [key: string]: string | number;
}

export class MetricsService {
  private static prisma = prisma;
  public static setPrismaForTesting(p: any) { this.prisma = p; }

  // In-memory request metric counters
  private static httpRequestsTotal: Map<string, number> = new Map();
  private static httpRequestDurationBuckets: Map<string, number> = new Map(); // key = "route_method_le"
  private static httpRequestDurationSum: Map<string, number> = new Map(); // key = "route_method"
  private static httpRequestDurationCount: Map<string, number> = new Map(); // key = "route_method"

  // Standard histogram latency buckets (seconds)
  public static readonly LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

  /**
   * Records an HTTP request completion.
   */
  public static recordHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number) {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const counterKey = `method="${method}",route="${route}",status="${statusCode}",status_class="${statusClass}"`;
    this.httpRequestsTotal.set(counterKey, (this.httpRequestsTotal.get(counterKey) || 0) + 1);

    const histBaseKey = `method="${method}",route="${route}"`;
    this.httpRequestDurationSum.set(histBaseKey, (this.httpRequestDurationSum.get(histBaseKey) || 0) + durationSeconds);
    this.httpRequestDurationCount.set(histBaseKey, (this.httpRequestDurationCount.get(histBaseKey) || 0) + 1);

    for (const le of this.LATENCY_BUCKETS) {
      if (durationSeconds <= le) {
        const bucketKey = `${histBaseKey},le="${le}"`;
        this.httpRequestDurationBuckets.set(bucketKey, (this.httpRequestDurationBuckets.get(bucketKey) || 0) + 1);
      }
    }
    // +Inf bucket
    const infKey = `${histBaseKey},le="+Inf"`;
    this.httpRequestDurationBuckets.set(infKey, (this.httpRequestDurationBuckets.get(infKey) || 0) + 1);
  }

  /**
   * Collects all real-time VMS metrics and renders standard Prometheus text format.
   */
  public static async scrapeMetrics(): Promise<string> {
    const lines: string[] = [];

    // 1. Process & Runtime Info
    lines.push('# HELP vigilone_process_uptime_seconds Total seconds the process has been running');
    lines.push('# TYPE vigilone_process_uptime_seconds gauge');
    lines.push(`vigilone_process_uptime_seconds ${Math.round(process.uptime())}`);

    const mem = process.memoryUsage();
    lines.push('# HELP vigilone_process_resident_memory_bytes Resident memory size in bytes');
    lines.push('# TYPE vigilone_process_resident_memory_bytes gauge');
    lines.push(`vigilone_process_resident_memory_bytes ${mem.rss}`);

    // 2. Storage Vitals
    try {
      const disk = await checkDiskSpace(config.RECORDINGS_DIR);
      const usedBytes = disk.size - disk.free;
      const fillRatio = disk.size > 0 ? (usedBytes / disk.size).toFixed(4) : '0';

      lines.push('# HELP vigilone_storage_bytes_total Total size of recordings volume in bytes');
      lines.push('# TYPE vigilone_storage_bytes_total gauge');
      lines.push(`vigilone_storage_bytes_total ${disk.size}`);

      lines.push('# HELP vigilone_storage_bytes_free Free space available on recordings volume in bytes');
      lines.push('# TYPE vigilone_storage_bytes_free gauge');
      lines.push(`vigilone_storage_bytes_free ${disk.free}`);

      lines.push('# HELP vigilone_storage_fill_ratio Storage volume utilization ratio between 0.0 and 1.0');
      lines.push('# TYPE vigilone_storage_fill_ratio gauge');
      lines.push(`vigilone_storage_fill_ratio ${fillRatio}`);
    } catch (err: any) {
      lines.push('# HELP vigilone_storage_scrape_error Error status while querying disk capacity');
      lines.push('# TYPE vigilone_storage_scrape_error gauge');
      lines.push('vigilone_storage_scrape_error 1');
    }

    // 3. Database State Metrics (Cameras, Segments, Queues, Pins)
    try {
      // Camera states
      const cameras = await this.prisma.camera.groupBy({
        by: ['observedRecorderState'],
        _count: { id: true },
      });

      lines.push('# HELP vigilone_cameras_total Total registered cameras grouped by observed state');
      lines.push('# TYPE vigilone_cameras_total gauge');
      const allStates = ['RUNNING', 'STOPPED', 'STARTING', 'ERROR'];
      const observedCounts = new Map(cameras.map((c) => [c.observedRecorderState, c._count.id]));
      for (const st of allStates) {
        lines.push(`vigilone_cameras_total{state="${st}"} ${observedCounts.get(st as any) || 0}`);
      }

      // Durable Segment Job Queue Depth
      const jobs = await this.prisma.segmentJob.groupBy({
        by: ['status'],
        _count: { id: true },
      });
      lines.push('# HELP vigilone_segment_queue_depth Count of segment indexing jobs by status');
      lines.push('# TYPE vigilone_segment_queue_depth gauge');
      const jobStates = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
      const jobCounts = new Map(jobs.map((j) => [j.status, j._count.id]));
      for (const js of jobStates) {
        lines.push(`vigilone_segment_queue_depth{status="${js}"} ${jobCounts.get(js as any) || 0}`);
      }

      // Active Evidence Pins
      const activePins = await this.prisma.evidencePin.count({
        where: {
          releasedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      lines.push('# HELP vigilone_evidence_active_pins_count Total active unexpired evidence lease pins');
      lines.push('# TYPE vigilone_evidence_active_pins_count gauge');
      lines.push(`vigilone_evidence_active_pins_count ${activePins}`);

      // Finalized vs Corrupted vs Recording Segments
      const segments = await this.prisma.recordingSegment.groupBy({
        by: ['status'],
        _count: { id: true },
      });
      lines.push('# HELP vigilone_recording_segments_total Total recording segments recorded on disk');
      lines.push('# TYPE vigilone_recording_segments_total gauge');
      const segCounts = new Map(segments.map((s) => [s.status, s._count.id]));
      lines.push(`vigilone_recording_segments_total{status="FINALIZED"} ${segCounts.get(SegmentStatus.FINALIZED) || 0}`);
      lines.push(`vigilone_recording_segments_total{status="CORRUPTED"} ${segCounts.get(SegmentStatus.CORRUPTED) || 0}`);
      lines.push(`vigilone_recording_segments_total{status="RECORDING"} ${segCounts.get(SegmentStatus.RECORDING) || 0}`);

      // Database connection success
      lines.push('# HELP vigilone_database_connected Status of backend connection to PostgreSQL (1=connected, 0=disconnected)');
      lines.push('# TYPE vigilone_database_connected gauge');
      lines.push('vigilone_database_connected 1');

      // Audit Log High-Water Mark
      const auditCount = await this.prisma.auditEvent.count();
      lines.push('# HELP vigilone_audit_events_total Cryptographic audit chain high-water mark count');
      lines.push('# TYPE vigilone_audit_events_total counter');
      lines.push(`vigilone_audit_events_total ${auditCount}`);
    } catch (err: any) {
      // Graceful fallback for edge database offline or sandboxed test environment
      lines.push('# HELP vigilone_database_connected Status of backend connection to PostgreSQL (1=connected, 0=disconnected)');
      lines.push('# TYPE vigilone_database_connected gauge');
      lines.push('vigilone_database_connected 0');

      lines.push('# HELP vigilone_cameras_total Total registered cameras grouped by observed state');
      lines.push('# TYPE vigilone_cameras_total gauge');
      lines.push('vigilone_cameras_total{state="RUNNING"} 0');
      lines.push('vigilone_cameras_total{state="STOPPED"} 0');
      lines.push('vigilone_cameras_total{state="STARTING"} 0');
      lines.push('vigilone_cameras_total{state="ERROR"} 0');

      lines.push('# HELP vigilone_segment_queue_depth Count of segment indexing jobs by status');
      lines.push('# TYPE vigilone_segment_queue_depth gauge');
      lines.push('vigilone_segment_queue_depth{status="PENDING"} 0');
      lines.push('vigilone_segment_queue_depth{status="PROCESSING"} 0');
    }

    // 4. HTTP Request Metrics (RED method)
    lines.push('# HELP vigilone_http_requests_total Total HTTP requests handled by the gateway');
    lines.push('# TYPE vigilone_http_requests_total counter');
    if (this.httpRequestsTotal.size === 0) {
      lines.push('vigilone_http_requests_total{method="GET",route="/health",status="200",status_class="2xx"} 0');
    } else {
      for (const [labels, count] of this.httpRequestsTotal.entries()) {
        lines.push(`vigilone_http_requests_total{${labels}} ${count}`);
      }
    }

    // Latency Histograms
    lines.push('# HELP vigilone_http_request_duration_seconds HTTP request duration histogram in seconds');
    lines.push('# TYPE vigilone_http_request_duration_seconds histogram');
    for (const [bucketKey, count] of this.httpRequestDurationBuckets.entries()) {
      lines.push(`vigilone_http_request_duration_seconds_bucket{${bucketKey}} ${count}`);
    }
    for (const [baseKey, sum] of this.httpRequestDurationSum.entries()) {
      lines.push(`vigilone_http_request_duration_seconds_sum{${baseKey}} ${sum.toFixed(6)}`);
      lines.push(`vigilone_http_request_duration_seconds_count{${baseKey}} ${this.httpRequestDurationCount.get(baseKey) || 0}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Resets in-memory counters (useful for unit testing).
   */
  public static resetMetrics() {
    this.httpRequestsTotal.clear();
    this.httpRequestDurationBuckets.clear();
    this.httpRequestDurationSum.clear();
    this.httpRequestDurationCount.clear();
  }
}

export default MetricsService;
