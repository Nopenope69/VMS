import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { ExportStatus } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { EvidenceArchive } from '../services/evidence/archive';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const evidenceArchive = new EvidenceArchive(prisma);

router.use(requireAuth);

/**
 * Trigger evidence package generation under Section 63 BSA (Legacy single camera package)
 */
router.post('/export', authorize(Permission.EVIDENCE_EXPORT), async (req: Request, res: Response) => {
  const {
    cameraId,
    startTime,
    endTime,
    exportMode = 'STREAM_COPY',
    partAPartyName,
    partAPartyDesignation,
    partBExpertName,
    partBExpertDesignation,
    partBExpertOrganization,
    partBSigningMode,
  } = req.body;

  if (!cameraId || !startTime || !endTime) {
    return res.status(400).json({ error: 'cameraId, startTime, and endTime are required' });
  }

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: cameraId, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    // Process export
    const zipPath = await evidenceArchive.processExport({
      tenantId: req.user!.tenantId,
      cameraId,
      requestedById: req.user!.id,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      exportMode,
      partAPartyName,
      partAPartyDesignation,
      partBExpertName,
      partBExpertDesignation,
      partBExpertOrganization,
      partBSigningMode,
    });

    // Tamper-evident cryptographic audit chain log
    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'EXPORT_EVIDENCE_BSA63',
      resourceType: 'Camera',
      resourceId: camera.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: {
        cameraId: camera.id,
        startTime,
        endTime,
        exportMode,
        zipFilename: path.basename(zipPath),
      },
    });

    return res.status(201).json({
      message: 'Section 63 BSA evidence package generated successfully',
      downloadUrl: `/api/v1/evidence/download/${path.basename(zipPath)}`,
      filename: path.basename(zipPath),
    });
  } catch (err: any) {
    if (err.message?.includes('NO_RECORDING_SEGMENTS_FOUND')) {
      return res.status(404).json({ error: err.message, code: 'NO_RECORDING_SEGMENTS_FOUND' });
    }
    return res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

/**
 * List all evidence exports for tenant
 */
router.get('/', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const exports = await prisma.evidenceExport.findMany({
      where: { tenantId: req.user!.tenantId },
      include: {
        camera: { select: { id: true, name: true } },
        requestedBy: { select: { id: true, name: true, email: true } },
        approvedByUser: { select: { id: true, name: true, email: true } },
        manifest: { select: { id: true, masterEvidenceHash: true, legalHold: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const serialized = exports.map((e) => ({
      ...e,
      fileSizeBytes: e.fileSizeBytes ? e.fileSizeBytes.toString() : null,
    }));

    return res.json({ exports: serialized });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * CREATE MULTI-CAMERA IMMUTABLE EVIDENCE MANIFEST
 */
router.post('/manifests', authorize(Permission.EVIDENCE_EXPORT), async (req: Request, res: Response) => {
  const { cameraIds, startUtc, endUtc, legalHold, notes, partAPartyName, partAPartyDesignation } = req.body;
  if (!cameraIds || !Array.isArray(cameraIds) || cameraIds.length === 0 || !startUtc || !endUtc) {
    return res.status(400).json({ error: 'cameraIds array, startUtc, and endUtc are required' });
  }

  try {
    const manifest = await evidenceArchive.createManifest({
      tenantId: req.user!.tenantId,
      createdByUserId: req.user!.id,
      cameraIds,
      startUtc: new Date(startUtc),
      endUtc: new Date(endUtc),
      legalHold: legalHold ?? false,
      notes,
      partAPartyName,
      partAPartyDesignation,
    });

    return res.status(201).json(manifest);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * List manifests for tenant
 */
router.get('/manifests', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const manifests = await prisma.evidenceManifest.findMany({
      where: { tenantId: req.user!.tenantId },
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
        exports: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const serialized = manifests.map((m) => ({
      ...m,
      exports: m.exports.map((e) => ({
        ...e,
        fileSizeBytes: e.fileSizeBytes != null ? e.fileSizeBytes.toString() : null,
      })),
    }));
    return res.json(serialized);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get manifest by ID
 */
router.get('/manifests/:id', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const manifest = await prisma.evidenceManifest.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
        exports: true,
        redactionJobs: true,
      },
    });
    if (!manifest) return res.status(404).json({ error: 'Manifest not found' });
    const serialized = {
      ...manifest,
      exports: manifest.exports.map((e) => ({
        ...e,
        fileSizeBytes: e.fileSizeBytes != null ? e.fileSizeBytes.toString() : null,
      })),
    };
    return res.json(serialized);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Verify cryptographic integrity of manifest
 */
router.get('/manifests/:id/verify', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const manifest = await prisma.evidenceManifest.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!manifest) return res.status(404).json({ error: 'Manifest not found' });

    const result = await evidenceArchive.verifyManifestIntegrity(manifest.id);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Produce derivative export from manifest
 */
router.post('/manifests/:id/export-derivative', authorize(Permission.EVIDENCE_EXPORT), async (req: Request, res: Response) => {
  const { cameraId, outputFilePath, redactionPolicyId, format } = req.body;
  if (!cameraId) {
    return res.status(400).json({ error: 'cameraId is required' });
  }

  try {
    const manifest = await prisma.evidenceManifest.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!manifest) return res.status(404).json({ error: 'Manifest not found' });

    const exportRecord = await evidenceArchive.exportDerivativeClip({
      tenantId: req.user!.tenantId,
      manifestId: manifest.id,
      cameraId,
      requestedById: req.user!.id,
      outputFilePath: outputFilePath || `/var/lib/vigilone/exports/${manifest.id}_${cameraId}.mp4`,
      redactionPolicyId,
      format: format || 'MP4',
    });

    return res.status(201).json({
      ...exportRecord,
      fileSizeBytes: exportRecord.fileSizeBytes?.toString(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Update legal hold on evidence manifest
 */
router.post('/manifests/:id/legal-hold', authorize(Permission.EVIDENCE_APPROVE), async (req: Request, res: Response) => {
  const { legalHold } = req.body;
  if (typeof legalHold !== 'boolean') {
    return res.status(400).json({ error: 'legalHold boolean is required' });
  }

  try {
    const manifest = await evidenceArchive.setLegalHold(
      req.user!.tenantId,
      req.params.id,
      req.user!.id,
      legalHold
    );
    return res.json(manifest);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get chain of custody history
 */
router.get('/custody/:evidenceId', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const history = await evidenceArchive.getCustodyHistory(
      req.user!.tenantId,
      req.params.evidenceId
    );
    return res.json(history);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Verify unbroken chain of custody
 */
router.get('/custody/:evidenceId/verify', authorize(Permission.EVIDENCE_VIEW), async (req: Request, res: Response) => {
  try {
    const verification = await evidenceArchive.verifyCustodyChain(
      req.user!.tenantId,
      req.params.evidenceId
    );
    return res.json(verification);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Dual-custody approval of an evidence export
 */
router.post('/exports/:id/approve', authorize(Permission.EVIDENCE_APPROVE), async (req: Request, res: Response) => {
  try {
    const exportRecord = await prisma.evidenceExport.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!exportRecord) return res.status(404).json({ error: 'Export record not found' });

    if (exportRecord.requestedById === req.user!.id) {
      return res.status(400).json({ error: 'Dual-custody violation: Requester cannot approve their own export' });
    }

    const approved = await prisma.evidenceExport.update({
      where: { id: exportRecord.id },
      data: {
        approvedByUserId: req.user!.id,
        status: ExportStatus.COMPLETED,
      },
    });

    if (exportRecord.manifestId) {
      await evidenceArchive.logCustodyEvent({
        tenantId: req.user!.tenantId,
        evidenceId: exportRecord.manifestId,
        actorUserId: req.user!.id,
        action: 'EVIDENCE_APPROVED',
        sourceHash: exportRecord.outputSha256 || exportRecord.sha256Hash || 'N/A',
        metadata: {
          exportId: exportRecord.id,
          approvedBy: req.user!.id,
        },
      });
    }

    return res.json({
      message: 'Evidence export approved successfully',
      export: {
        ...approved,
        fileSizeBytes: approved.fileSizeBytes?.toString(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Download the generated Section 63 BSA evidence package zip file
 */
router.get('/download/:filename', async (req: Request, res: Response) => {
  const filename = req.params.filename;

  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const exportRecord = await prisma.evidenceExport.findFirst({
    where: {
      tenantId: req.user!.tenantId,
      outputFilePath: { endsWith: filename },
    },
  });

  if (!exportRecord || !exportRecord.outputFilePath || !fs.existsSync(exportRecord.outputFilePath)) {
    return res.status(404).json({ error: 'Evidence package file not found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const fileStream = fs.createReadStream(exportRecord.outputFilePath);
  fileStream.pipe(res);
});

export default router;
