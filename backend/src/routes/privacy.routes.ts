import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { RedactionMode, Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { PrivacyPolicyService } from '../services/privacy/privacyPolicy.service';
import { VideoRedactorService, RedactionError } from '../services/privacy/videoRedactor.service';
import { RedactionQueue } from '../services/privacy/redactionQueue';
import { AuditChainService } from '../services/audit/auditChain.service';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const router = Router();
const privacyService = new PrivacyPolicyService(prisma);
const videoRedactor = new VideoRedactorService(prisma);
export const redactionQueue = new RedactionQueue(prisma, videoRedactor);

router.use(requireAuth);

/**
 * List all privacy policies for tenant
 */
router.get('/policies', async (req: Request, res: Response) => {
  try {
    const policies = await privacyService.listPolicies(req.user!.tenantId);
    return res.json(policies);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Create a new privacy policy
 */
router.post('/policies', authorize(Permission.PRIVACY_POLICY_MANAGE), async (req: Request, res: Response) => {
  const {
    name,
    enabled,
    faceRedaction,
    plateRedaction,
    bystanderRedaction,
    restrictedZonesJson,
    defaultExportMode,
    approvalRequired,
    retentionDays,
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const policy = await privacyService.createPolicy({
      tenantId: req.user!.tenantId,
      name,
      enabled,
      faceRedaction,
      plateRedaction,
      bystanderRedaction,
      restrictedZonesJson,
      defaultExportMode,
      approvalRequired,
      retentionDays,
    });
    return res.status(201).json(policy);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get privacy policy by ID
 */
router.get('/policies/:id', async (req: Request, res: Response) => {
  try {
    const policy = await privacyService.getPolicy(req.user!.tenantId, req.params.id);
    if (!policy) return res.status(404).json({ error: 'Privacy policy not found' });
    return res.json(policy);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Update privacy policy
 */
router.put('/policies/:id', authorize(Permission.PRIVACY_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    const policy = await privacyService.updatePolicy(
      req.user!.tenantId,
      req.params.id,
      req.body
    );
    return res.json(policy);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Delete privacy policy
 */
router.delete('/policies/:id', authorize(Permission.PRIVACY_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    await privacyService.deletePolicy(req.user!.tenantId, req.params.id);
    return res.json({ message: 'Privacy policy deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const CreateJobBody = z
  .object({
    sourceManifestId: z.string().min(1),
    privacyPolicyId: z.string().min(1).optional(),
    redactionMode: z.nativeEnum(RedactionMode),
    cameraId: z.string().min(1).optional(),
    detectKinds: z.array(z.enum(['FACE', 'LICENSE_PLATE'])).max(2).optional(),
    sampleFps: z.number().min(0.5).max(10).optional(),
    masks: z.array(z.any()).max(500).optional(),
  })
  .strict();

const audit = (req: Request, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  AuditChainService.record(prisma, { tenantId: req.user!.tenantId, userId: req.user!.id, action, resourceType: 'RedactionJob', resourceId, ipAddress: req.ip || '127.0.0.1', metadata });

const fail = (res: Response, err: any) => {
  if (err instanceof RedactionError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ error: `${err.issues[0].path.join('.')}: ${err.issues[0].message}`, code: 'INVALID_MASK' });
  return res.status(500).json({ error: err.message });
};

/**
 * Create a video redaction job (P4.4). It stays QUEUED until POST /jobs/:id/execute.
 */
router.post('/jobs', authorize(Permission.REDACTION_EXECUTE), async (req: Request, res: Response) => {
  const p = CreateJobBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.')}: ${p.error.issues[0].message}` });
  try {
    const job = await videoRedactor.createRedactionJob({ tenantId: req.user!.tenantId, createdByUserId: req.user!.id, ...p.data });
    await audit(req, 'REDACTION_JOB_CREATE', job.id, { sourceManifestId: job.sourceManifestId, mode: job.redactionMode, cameraId: job.cameraId, detectKinds: job.detectKinds, manualMasks: (p.data.masks || []).length });
    return res.status(201).json(job);
  } catch (err: any) {
    return fail(res, err);
  }
});

router.get('/jobs', async (req: Request, res: Response) => {
  const jobs = await prisma.redactionJob.findMany({
    where: { tenantId: req.user!.tenantId, ...(typeof req.query.sourceManifestId === 'string' ? { sourceManifestId: req.query.sourceManifestId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return res.json({ jobs: jobs.map((j) => ({ ...j, outputBytes: j.outputBytes === null ? null : Number(j.outputBytes) })) });
});

/**
 * Get redaction job status
 */
router.get('/jobs/:id', async (req: Request, res: Response) => {
  try {
    const job = await prisma.redactionJob.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: {
        sourceManifest: { select: { id: true, masterEvidenceHash: true } },
        privacyPolicy: { select: { id: true, name: true } },
      },
    });
    if (!job) return res.status(404).json({ error: 'Redaction job not found' });
    return res.json({ ...job, outputBytes: job.outputBytes === null ? null : Number(job.outputBytes) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Start a QUEUED job. Jobs run one at a time in the background; poll GET /jobs/:id.
 * The outcome is COMPLETED with a verified, hashed derivative, or FAILED with an error code.
 */
router.post('/jobs/:id/execute', authorize(Permission.REDACTION_EXECUTE), async (req: Request, res: Response) => {
  const job = await prisma.redactionJob.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!job) return res.status(404).json({ error: 'Redaction job not found' });
  if (job.status !== 'QUEUED') return res.status(409).json({ error: `job is ${job.status}`, code: 'REDACTION_INVALID_STATE' });
  await audit(req, 'REDACTION_JOB_EXECUTE', job.id, { sourceManifestId: job.sourceManifestId });
  redactionQueue.enqueue(job.id);
  return res.status(202).json({ jobId: job.id, status: 'QUEUED', poll: `/api/v1/privacy/jobs/${job.id}` });
});

/**
 * Download the redacted derivative. The file's SHA-256 is re-checked before it is served.
 */
router.get('/jobs/:id/download', authorize(Permission.REDACTION_EXECUTE), async (req: Request, res: Response) => {
  const job = await prisma.redactionJob.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!job || job.status !== 'COMPLETED' || !job.outputObjectKey || !job.outputSha256) return res.status(404).json({ error: 'No completed derivative for this job' });
  const file = path.join(process.env.EXPORTS_DIR || '/recordings/exports', job.outputObjectKey);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'The derivative file is no longer on disk', code: 'REDACTION_OUTPUT_MISSING' });
  const h = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject));
  if (h.digest('hex') !== job.outputSha256) return res.status(409).json({ error: 'The derivative on disk does not match its recorded SHA-256', code: 'REDACTION_OUTPUT_TAMPERED' });
  await audit(req, 'REDACTION_DERIVATIVE_DOWNLOAD', job.id, { outputSha256: job.outputSha256 });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="redacted-${job.id}.mp4"`);
  res.setHeader('X-VigilOne-SHA256', job.outputSha256);
  fs.createReadStream(file).pipe(res);
});

/**
 * Test compliance of an export against an active privacy policy
 */
router.post('/evaluate-compliance', async (req: Request, res: Response) => {
  const { policyId, isRedactedExport } = req.body;
  if (!policyId) return res.status(400).json({ error: 'policyId is required' });

  try {
    const policy = await privacyService.getPolicy(req.user!.tenantId, policyId);
    if (!policy) return res.status(404).json({ error: 'Privacy policy not found' });

    const evaluation = privacyService.evaluateExportCompliance(
      policy,
      req.user!.role as Role,
      isRedactedExport ?? false
    );
    return res.json(evaluation);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
