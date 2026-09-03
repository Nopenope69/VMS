import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { EvidenceExportService } from '../services/evidenceExport.service';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();
const evidenceService = new EvidenceExportService(prisma);

router.use(requireAuth);

/**
 * Trigger evidence package generation under Section 63 BSA
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
    const zipPath = await evidenceService.processExport({
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
    return res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

/**
 * List all evidence exports for tenant
 */
router.get('/', authorize(Permission.RECORDING_VIEW), async (req: Request, res: Response) => {
  try {
    const exports = await prisma.evidenceExport.findMany({
      where: { tenantId: req.user!.tenantId },
      include: {
        camera: { select: { id: true, name: true } },
        requestedBy: { select: { id: true, name: true, email: true } },
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
 * Download the generated Section 63 BSA evidence package zip file
 */
router.get('/download/:filename', async (req: Request, res: Response) => {
  const filename = req.params.filename;

  // Security: prevent directory traversal
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
