/**
 * Evidence package for a redacted derivative (P4.5): the same signed layout as a Section 63 export
 * (manifest.json + .sha256 + .sig, artifacts table, custody ledger, certificate, public key), with
 * the redacted video as primary media and a derivation.json that links it to the parent evidence:
 * parent master hash and Merkle leaves, the redaction job, detector models, masks and ffmpeg build.
 * tools/vigilone-verify checks the whole chain offline.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import config from '../../../config/env';
import { computeFileSha256 } from '../../../utils/crypto';
import { BsaCertificatePackageBuilder } from './bsaCertificatePackageBuilder';
import { canonicalizeJson } from './canonicalJson';
import { CustodyLedger } from './custodyLedger';
import { MerkleTree, MerkleLeafEntry } from './merkleTree';
import { PackageAssembler } from './packageAssembler';
import { collectAiProvenance } from './aiProvenance';
import { settingIfSet } from '../../../config/settings';

export const DERIVATION_SCHEMA = 'vigilone.derivation.v1';

export class RedactionPackageError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(`${code}: ${message}`);
  }
}

export async function buildRedactionPackage(prisma: PrismaClient, tenantId: string, jobId: string, requestedById: string): Promise<{ zipPath: string; packageSha256: string; manifestSignature: string }> {
  const job = await prisma.redactionJob.findFirst({ where: { id: jobId, tenantId }, include: { sourceManifest: true } });
  if (!job) throw new RedactionPackageError('REDACTION_JOB_NOT_FOUND', jobId, 404);
  if (job.status !== 'COMPLETED' || !job.outputObjectKey || !job.outputSha256 || !job.cameraId) {
    throw new RedactionPackageError('REDACTION_NOT_COMPLETED', `job ${jobId} is ${job.status}`, 409);
  }
  const exportsDir = settingIfSet('EXPORTS_DIR') ?? config.EXPORTS_DIR;
  const derivativePath = path.join(exportsDir, job.outputObjectKey);
  if (!fs.existsSync(derivativePath)) throw new RedactionPackageError('REDACTION_OUTPUT_MISSING', derivativePath, 410);
  const derivativeSha256 = await computeFileSha256(derivativePath);
  if (derivativeSha256 !== job.outputSha256) throw new RedactionPackageError('REDACTION_OUTPUT_TAMPERED', `file has ${derivativeSha256}, job recorded ${job.outputSha256}`, 409);

  const parent = job.sourceManifest;
  const leaves = (parent.segmentManifestJson as unknown as MerkleLeafEntry[]) || [];
  const recomputedRoot = MerkleTree.buildTree(
    leaves.map((l) => ({ segmentId: l.segmentId, cameraId: l.cameraId, startTime: new Date(l.startUtc), endTime: new Date(l.endUtc), mediaSha256: l.mediaSha256 }))
  ).rootHash;
  if (recomputedRoot !== parent.masterEvidenceHash) {
    throw new RedactionPackageError('PARENT_MANIFEST_INCONSISTENT', `parent leaves give root ${recomputedRoot}, the manifest records ${parent.masterEvidenceHash}`);
  }
  const camera = await prisma.camera.findUniqueOrThrow({ where: { id: job.cameraId } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: requestedById } });
  const camLeaves = leaves.filter((l) => l.cameraId === job.cameraId);
  const start = new Date(Math.min(...camLeaves.map((l) => Date.parse(l.startUtc))));
  const end = new Date(Math.max(...camLeaves.map((l) => Date.parse(l.endUtc))));

  const custody = new CustodyLedger(prisma);
  await custody.recordEvent({
    tenantId,
    evidenceId: parent.id,
    actorUserId: requestedById,
    action: 'DERIVATIVE_EXPORTED',
    sourceHash: derivativeSha256,
    resultHash: derivativeSha256,
    metadata: { redactionJobId: job.id, derivativeType: 'REDACTION', requestedBy: user.email },
  });
  const custodyHistory = await custody.getHistory(tenantId, parent.id);
  const custodyVerification = await custody.verifyChain(tenantId, parent.id);
  if (!custodyVerification.chainIntegrityValid) throw new RedactionPackageError('CUSTODY_CHAIN_INVALID', custodyVerification.error || 'custody chain does not verify');

  const exportId = crypto.randomUUID();
  const workDir = fs.mkdtempSync(path.join(exportsDir, `.redaction-package-${exportId}-`));
  try {
    const prov: any = job.provenanceJson || {};
    const derivation = {
      schema: DERIVATION_SCHEMA,
      type: 'REDACTION',
      parentEvidenceId: parent.id,
      parentMasterEvidenceHash: parent.masterEvidenceHash,
      cameraId: job.cameraId,
      redactionJobId: job.id,
      redactionMode: job.redactionMode,
      derivativeSha256,
      derivativeBytes: Number(job.outputBytes),
      sourceSegments: prov.source?.segments ?? [],
      detector: prov.detector ?? null,
      sampling: prov.sampling ?? null,
      masks: prov.masks ?? null,
      render: prov.render ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
    const derivationPath = path.join(workDir, 'derivation.json');
    fs.writeFileSync(derivationPath, canonicalizeJson(derivation), 'utf8');

    const ai = await collectAiProvenance(prisma, tenantId, job.cameraId, start, end);
    if (prov.detector) {
      const d = prov.detector;
      if (!ai.models.some((m) => m.sha256 === d.modelSha256)) {
        const m = await prisma.modelManifest.findFirst({ where: { sha256: d.modelSha256, name: d.modelName, version: d.modelVersion } });
        ai.models.push({
          name: d.modelName, version: d.modelVersion, sha256: d.modelSha256, task: m?.task ?? null, codeLicense: m?.codeLicense ?? null, weightLicense: m?.weightLicense ?? null,
          weightsSource: m?.weightsSource ?? null, evaluation: m?.evaluationJson ?? null, registered: Boolean(m),
        });
      }
    }
    const aiPath = path.join(workDir, 'ai_provenance.json');
    fs.writeFileSync(aiPath, canonicalizeJson(ai), 'utf8');

    const now = new Date();
    const applianceIdentifier = `VIGILONE-EDGE-${tenantId.substring(0, 8).toUpperCase()}`;
    const manifestData: any = {
      exportId,
      packageType: 'REDACTED_DERIVATIVE',
      applianceIdentifier,
      timestamp: now.toISOString(),
      requestingUser: { id: user.id, name: user.name, email: user.email },
      camera: { id: camera.id, name: camera.name, manufacturer: camera.manufacturer || 'Unknown', model: camera.model || 'Unknown', serialNumber: camera.serialNumber || 'Unknown' },
      timeWindow: { startUtc: start.toISOString(), endUtc: end.toISOString(), exportTimestampUtc: now.toISOString() },
      videoChecksumSha256: derivativeSha256,
      evidenceMerkleRoot: parent.masterEvidenceHash,
      leaves,
      segmentCount: leaves.length,
      derivation: { schema: DERIVATION_SCHEMA, artifact: 'derivation.json', type: 'REDACTION', parentEvidenceId: parent.id, parentMasterEvidenceHash: parent.masterEvidenceHash, redactionJobId: job.id },
      aiProvenance: {
        schema: ai.schema,
        artifact: 'ai_provenance.json',
        recordCount: ai.records.length,
        detectionCount: ai.records.filter((r) => r.kind === 'DETECTION').length,
        plateReadCount: ai.records.filter((r) => r.kind === 'PLATE_READ').length,
        unattributedCount: ai.unattributed.count,
        models: ai.models.map((m) => ({ name: m.name, version: m.version, sha256: m.sha256 })),
      },
      custodySummary: {
        chainIntegrityValid: custodyVerification.chainIntegrityValid,
        entriesCount: custodyVerification.entriesCount,
        initialHash: custodyVerification.initialHash,
        headHash: custodyVerification.headHash,
        unbrokenAncestry: custodyVerification.unbrokenAncestry,
      },
      bsaSection63Details: {
        complianceFramework: 'BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63',
        disclaimer: BsaCertificatePackageBuilder.STATUTORY_DISCLAIMER,
        provenanceNotice: BsaCertificatePackageBuilder.PROVENANCE_NOTICE,
      },
    };
    const pdf = path.join(workDir, 'certificate_sec63.pdf');
    await BsaCertificatePackageBuilder.generatePdf(pdf, {
      evidenceId: exportId,
      tenantId,
      applianceIdentifier,
      evidenceMerkleRoot: parent.masterEvidenceHash,
      startUtc: start,
      endUtc: end,
      custodyChainHeadHash: custodyVerification.headHash,
      cameras: [{ cameraId: camera.id, name: camera.name, model: camera.model || 'Generic', serialNumber: camera.serialNumber || 'N/A', segmentCount: camLeaves.length }],
      partAPartyName: user.name,
      aiProvenance: { recordCount: ai.records.length, unattributedCount: ai.unattributed.count, models: manifestData.aiProvenance.models },
      derivation: {
        type: 'REDACTION',
        parentEvidenceId: parent.id,
        parentMasterEvidenceHash: parent.masterEvidenceHash,
        description: `Faces/plates/regions were masked with opaque boxes by redaction job ${job.id}; ${prov.masks?.total ?? 0} mask(s).`,
      },
    });
    const zipPath = path.join(exportsDir, `Redacted_${job.id}_${exportId}.zip`);
    const r = await PackageAssembler.assemblePackage({
      exportId,
      targetZipPath: zipPath,
      videoFilePath: derivativePath,
      manifestData,
      applianceSignature: '',
      certificatePdfPath: pdf,
      custodyHistory,
      extraArtifacts: [
        { sourcePath: derivationPath, path: 'derivation.json', mediaType: 'application/json', role: 'DERIVATION_RECORD' },
        { sourcePath: aiPath, path: 'ai_provenance.json', mediaType: 'application/json', role: 'AI_PROVENANCE' },
      ],
    });
    return { zipPath: r.zipPath, packageSha256: r.packageSha256, manifestSignature: r.manifestSignature };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
