import { WorkerHealthStatus, ModelManifestRecord } from './types';

export class WorkerHealthMonitor {
  private startTime: number;
  private workerId: string;
  private loadedModel?: ModelManifestRecord & { verified: boolean };
  private inferenceCount: number = 0;

  constructor(workerId?: string) {
    this.startTime = Date.now();
    this.workerId = workerId || `worker-${process.pid}`;
  }

  public recordModelLoaded(manifest: ModelManifestRecord, verified: boolean): void {
    this.loadedModel = { ...manifest, verified };
  }

  public incrementInference(): void {
    this.inferenceCount++;
  }

  public getStatus(): WorkerHealthStatus {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const status: 'HEALTHY' | 'DEGRADED' | 'INITIALIZING' = this.loadedModel?.verified
      ? 'HEALTHY'
      : 'INITIALIZING';

    return {
      status,
      workerId: this.workerId,
      uptimeSeconds,
      loadedModel: this.loadedModel
        ? {
            id: this.loadedModel.id,
            name: this.loadedModel.name,
            version: this.loadedModel.version,
            sha256: this.loadedModel.sha256,
            verified: this.loadedModel.verified,
          }
        : undefined,
      inferenceCount: this.inferenceCount,
    };
  }
}
