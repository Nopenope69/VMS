import { ModelManifest, PrismaClient } from '@prisma/client';
import { AuditChainService } from '../audit/auditChain.service';
import { MetricsService } from '../observability/metrics.service';

const LIFECYCLE_METRIC = 'vigilone_ai_model_lifecycle_total';
const LIFECYCLE_HELP = 'AI model deploy/rollback/load/refusal events recorded in the audit chain';

/**
 * Model registry: which model the ai-worker runs, and the audit trail of every change.
 *
 * P2.6 invariants:
 *  - at most one deployed model per task; deploy/rollback serialize on an advisory lock;
 *  - deploy, rollback, worker load and worker refusal are written to the tamper-evident audit
 *    chain of every tenant (a model is appliance-wide: its detections reach every tenant);
 *  - only an active, licence-valid manifest can be deployed (licences were validated at registration).
 */
export type ModelLifecycleAction =
  | 'MODEL_DEPLOY'
  | 'MODEL_ROLLBACK'
  | 'MODEL_LOADED'
  | 'MODEL_LOAD_REFUSED'
  | 'MODEL_UNLOADED';

export interface ModelLifecycleReport {
  action: 'MODEL_LOADED' | 'MODEL_LOAD_REFUSED' | 'MODEL_UNLOADED';
  modelManifestId?: string;
  modelName?: string;
  modelVersion?: string;
  /** SHA-256 the worker computed from the artefact on disk (may differ from the manifest on refusal). */
  computedSha256?: string;
  adapterId: string;
  reasonCode?: string;
  message?: string;
  runtime?: string;
  runtimeVersion?: string | null;
  executionProvider?: string | null;
}

export class ModelRegistryError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) {
    super(message);
  }
}

export class ModelRegistryService {
  constructor(private prisma: PrismaClient) {}

  public async getDeployed(task = 'object_detection'): Promise<ModelManifest | null> {
    return this.prisma.modelManifest.findFirst({ where: { task, deployed: true } });
  }

  public async list(): Promise<ModelManifest[]> {
    return this.prisma.modelManifest.findMany({ orderBy: [{ task: 'asc' }, { createdAt: 'desc' }] });
  }

  /** Deploys a manifest for its task, undeploying the previous one, and audits it. */
  public async deploy(
    manifestId: string,
    actor: { userId?: string | null; reason: string; ipAddress?: string }
  ): Promise<ModelManifest> {
    return this.switchDeployment('MODEL_DEPLOY', async (tx) => {
      const target = await tx.modelManifest.findUnique({ where: { id: manifestId } });
      if (!target) throw new ModelRegistryError('MODEL_NOT_FOUND', `ModelManifest '${manifestId}' not found`, 404);
      return target;
    }, actor);
  }

  /** Re-deploys the most recently deployed other model of the task. */
  public async rollback(
    task: string,
    actor: { userId?: string | null; reason: string; ipAddress?: string }
  ): Promise<ModelManifest> {
    return this.switchDeployment('MODEL_ROLLBACK', async (tx) => {
      const previous = await tx.modelManifest.findFirst({
        where: { task, deployed: false, deployedAt: { not: null }, isActive: true },
        orderBy: { deployedAt: 'desc' },
      });
      if (!previous) {
        throw new ModelRegistryError('NO_ROLLBACK_TARGET', `No previously deployed model exists for task '${task}'`, 409);
      }
      return previous;
    }, actor);
  }

  /**
   * First-boot deployment: if nothing is deployed for the task, deploy the given manifest
   * (the model the appliance was installed with). Never replaces an existing deployment.
   */
  public async deployIfNoneDeployed(manifestId: string, adapterId: string): Promise<{ deployed: boolean; manifest: ModelManifest | null }> {
    const target = await this.prisma.modelManifest.findUnique({ where: { id: manifestId } });
    if (!target) throw new ModelRegistryError('MODEL_NOT_FOUND', `ModelManifest '${manifestId}' not found`, 404);
    const current = await this.getDeployed(target.task);
    if (current) return { deployed: false, manifest: current };
    const m = await this.deploy(manifestId, { userId: null, reason: `initial deployment requested by ${adapterId}` });
    return { deployed: true, manifest: m };
  }

  /** Records what the worker actually did with a model (load / refuse / unload). */
  public async recordWorkerReport(report: ModelLifecycleReport): Promise<void> {
    if (!['MODEL_LOADED', 'MODEL_LOAD_REFUSED', 'MODEL_UNLOADED'].includes(report.action)) {
      throw new ModelRegistryError('INVALID_ACTION', `Unknown model lifecycle action '${report.action}'`);
    }
    if (!report.adapterId) throw new ModelRegistryError('INVALID_REPORT', 'adapterId is required');
    await this.auditAllTenants(this.prisma, {
      action: report.action,
      resourceId: report.modelManifestId ?? null,
      userId: null,
      ipAddress: '127.0.0.1',
      metadata: { ...report },
    });
    MetricsService.incCounter(LIFECYCLE_METRIC, LIFECYCLE_HELP, { action: report.action });
  }

  private async switchDeployment(
    action: 'MODEL_DEPLOY' | 'MODEL_ROLLBACK',
    pickTarget: (tx: any) => Promise<ModelManifest>,
    actor: { userId?: string | null; reason: string; ipAddress?: string }
  ): Promise<ModelManifest> {
    if (!actor.reason || !actor.reason.trim()) {
      throw new ModelRegistryError('REASON_REQUIRED', 'A reason is required to change the deployed model');
    }
    const result = await this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('model_registry'), hashtext('deploy'))`;
      const target = await pickTarget(tx);
      if (!target.isActive) {
        throw new ModelRegistryError('MODEL_INACTIVE', `ModelManifest '${target.name}:${target.version}' is inactive and cannot be deployed`, 409);
      }
      if (!target.modelSignatureJson) {
        throw new ModelRegistryError(
          'MODEL_SIGNATURE_MISSING',
          `ModelManifest '${target.name}:${target.version}' has no model signature; the worker cannot decode it`,
          409
        );
      }
      const previous = await tx.modelManifest.findFirst({ where: { task: target.task, deployed: true } });
      if (previous && previous.id === target.id) return { target, previous, changed: false };
      if (previous) {
        await tx.modelManifest.update({ where: { id: previous.id }, data: { deployed: false } });
      }
      const updated = await tx.modelManifest.update({
        where: { id: target.id },
        data: { deployed: true, deployedAt: new Date() },
      });
      await this.auditAllTenants(tx, {
        action,
        resourceId: target.id,
        userId: actor.userId ?? null,
        ipAddress: actor.ipAddress ?? '127.0.0.1',
        metadata: {
          task: target.task,
          reason: actor.reason,
          model: { name: target.name, version: target.version, sha256: target.sha256 },
          previous: previous ? { id: previous.id, name: previous.name, version: previous.version, sha256: previous.sha256 } : null,
        },
      });
      return { target: updated, previous, changed: true };
    });
    if (result.changed) MetricsService.incCounter(LIFECYCLE_METRIC, LIFECYCLE_HELP, { action });
    return result.target;
  }

  private async auditAllTenants(
    db: any,
    entry: { action: ModelLifecycleAction; resourceId: string | null; userId: string | null; ipAddress: string; metadata: any }
  ): Promise<void> {
    const tenants = await db.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      // A user id belongs to one tenant; other tenants' chains record the change as SYSTEM.
      let userId: string | null = null;
      if (entry.userId) {
        const u = await db.user.findFirst({ where: { id: entry.userId, tenantId: t.id }, select: { id: true } });
        userId = u ? u.id : null;
      }
      await AuditChainService.record(db, {
        tenantId: t.id,
        userId,
        action: entry.action,
        resourceType: 'ModelManifest',
        resourceId: entry.resourceId,
        ipAddress: entry.ipAddress,
        metadata: { ...entry.metadata, actorUserId: entry.userId ?? 'SYSTEM' },
      });
    }
  }
}
