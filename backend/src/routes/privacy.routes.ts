import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { RedactionMode, Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { PrivacyPolicyService } from '../services/privacy/privacyPolicy.service';
import { VideoRedactorService } from '../services/privacy/videoRedactor.service';

const router = Router();
const privacyService = new PrivacyPolicyService(prisma);
const videoRedactor = new VideoRedactorService(prisma);

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

/**
 * Create a video redaction job
 */
router.post('/jobs', authorize(Permission.REDACTION_EXECUTE), async (req: Request, res: Response) => {
  const { sourceManifestId, privacyPolicyId, redactionMode, modelVersion, masks } = req.body;
  if (!sourceManifestId || !redactionMode) {
    return res.status(400).json({ error: 'sourceManifestId and redactionMode are required' });
  }

  try {
    const job = await videoRedactor.createRedactionJob({
      tenantId: req.user!.tenantId,
      createdByUserId: req.user!.id,
      sourceManifestId,
      privacyPolicyId,
      redactionMode: redactionMode as RedactionMode,
      modelVersion,
      masks,
    });
    return res.status(201).json(job);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
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
    return res.json(job);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Execute a redaction job (asynchronously generates derivative)
 */
router.post('/jobs/:id/execute', authorize(Permission.REDACTION_EXECUTE), async (req: Request, res: Response) => {
  try {
    const completedJob = await videoRedactor.executeRedactionJob(req.params.id);
    return res.json({
      message: 'Redaction job completed successfully; derivative evidence hash recorded',
      job: completedJob,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
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
