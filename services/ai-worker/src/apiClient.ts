import http from 'http';
import https from 'https';
import { URL } from 'url';
import { NormalizedDetectionEvent, DiscoveredCamera } from './types';
import type { ModelLockEntry } from './modelCatalog';
import type { CameraActivity } from './motionGate';

export interface ApiClientConfig {
  baseUrl: string;
  internalSecret: string;
  timeoutMs?: number;
}

export interface IngestionResponse {
  success: boolean;
  detectionId: string;
  inferenceId: string;
}

/** ModelManifest as served by GET /internal/ai/models/deployed. */
export interface DeployedModel {
  id: string;
  name: string;
  version: string;
  sha256: string;
  codeLicense: string;
  weightLicense: string;
  runtimeConfigJson: any;
  thresholdsJson?: any;
  classesJson?: any;
  modelSignatureJson?: any;
  nmsConfigJson?: any;
  evaluationJson?: any;
  weightsSource?: string | null;
  isActive: boolean;
}

export class InternalApiError extends Error {
  constructor(public readonly statusCode: number | undefined, message: string) {
    super(message);
  }
}

export class AuthenticatedInternalApiClient {
  private baseUrl: string;
  private secret: string;
  private timeoutMs: number;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret = config.internalSecret;
    this.timeoutMs = config.timeoutMs || 5000;
  }

  /** JSON request to the backend internal API; non-2xx and unparseable bodies reject. */
  private request<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const targetUrl = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) targetUrl.searchParams.set(k, v);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers: Record<string, string | number> = { Authorization: `Bearer ${this.secret}` };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = transport.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method,
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (responseBody += chunk));
          res.on('end', () => {
            let parsed: any;
            try {
              parsed = JSON.parse(responseBody);
            } catch {
              return reject(new InternalApiError(res.statusCode, `Failed to parse backend response (HTTP ${res.statusCode}) for ${method} ${path}: ${responseBody.slice(0, 500)}`));
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed as T);
            reject(new InternalApiError(res.statusCode, `${method} ${path} returned status ${res.statusCode}: ${parsed.error || responseBody.slice(0, 500)}`));
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new InternalApiError(undefined, `${method} ${path} timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', (err) => reject(err));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /**
   * Submits a normalized detection event (with provenance) to the VigilOne backend internal ingestion endpoint.
   */
  public submitDetection(detection: NormalizedDetectionEvent): Promise<IngestionResponse> {
    return this.request<IngestionResponse>('POST', '/detections', detection);
  }

  /**
   * Fetches active camera loopback streams from the appliance backend.
   * Only safe metadata is returned (no credentials or external IPs).
   */
  public async fetchActiveCameras(params?: { tenantId?: string; monitored?: boolean }): Promise<DiscoveredCamera[]> {
    const query: Record<string, string> = {};
    if (params?.tenantId) query.tenantId = params.tenantId;
    if (params?.monitored !== undefined) query.monitored = String(params.monitored);
    const res = await this.request<{ cameras: DiscoveredCamera[] }>('GET', '/cameras', undefined, query);
    return res.cameras;
  }

  /** Registers a pinned model (idempotent; licences and immutability are validated by the backend). */
  public async registerModelManifest(entry: ModelLockEntry): Promise<{ id: string }> {
    const res = await this.request<{ manifest: { id: string } }>('POST', '/model-manifests', {
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256,
      codeLicense: entry.codeLicense,
      weightLicense: entry.weightLicense,
      trainingData: entry.trainingData,
      thresholds: entry.thresholds,
      runtimeConfig: entry.runtimeConfig,
      attributionRequired: entry.attributionRequired,
      noticeRequired: entry.noticeRequired,
      licenseNotes: entry.licenseNotes,
      task: entry.task,
      weightsSource: entry.weightsSource,
      modelSignature: entry.modelSignature,
      classes: entry.classes,
      nmsConfig: entry.nmsConfig,
    });
    return res.manifest;
  }

  /** Registers an ANPR pipeline manifest (P4.1); the backend re-checks every component approval. */
  public async registerPipelineManifest(body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await this.request<{ manifest: { id: string } }>('POST', '/model-manifests', body);
    return res.manifest;
  }

  public async getLprCameras(): Promise<Array<{ cameraId: string; tenantId: string; streamPath: string; lpr: { fps?: number; roi?: number[]; maxWidth?: number; minConfidence?: number } }>> {
    const res = await this.request<{ cameras: any[] }>('GET', '/anpr/cameras');
    return res.cameras;
  }

  public postAnprObservations(body: Record<string, unknown>): Promise<{ accepted: number }> {
    return this.request('POST', '/anpr/observations', body);
  }

  /** First boot only: deploys the manifest if no model is deployed for its task. */
  public bootstrapDeploy(modelManifestId: string, adapterId: string): Promise<{ deployed: boolean }> {
    return this.request('POST', '/ai/models/bootstrap-deploy', { modelManifestId, adapterId });
  }

  public async getDeployedModel(task: string): Promise<DeployedModel | null> {
    const res = await this.request<{ model: DeployedModel | null }>('GET', '/ai/models/deployed', undefined, { task });
    return res.model;
  }

  /** Reports a load / refusal / unload to the backend, which writes it to the audit chain. */
  public reportModelLifecycle(report: Record<string, unknown>): Promise<{ recorded: boolean }> {
    return this.request('POST', '/ai/model-events', report);
  }

  /** Reports a confirmed camera-sabotage condition (covered, defocused, moved, blinded); ADR 0019. */
  public reportCameraSabotage(body: Record<string, unknown>): Promise<{ eventId: string; duplicate?: boolean }> {
    return this.request('POST', '/camera-sabotage', body);
  }

  /** Per-camera gating inputs: armed by AI rules, time of last classical motion (P2.5). */
  public async fetchAiActivity(): Promise<Record<string, CameraActivity>> {
    const res = await this.request<{ cameras: Array<{ cameraId: string; armed: boolean; lastMotionAt: string | null }> }>('GET', '/ai/activity');
    const out: Record<string, CameraActivity> = {};
    for (const c of res.cameras) {
      out[c.cameraId] = { armed: c.armed, lastMotionAt: c.lastMotionAt ? Date.parse(c.lastMotionAt) : undefined };
    }
    return out;
  }
}
