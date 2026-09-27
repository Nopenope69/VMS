/**
 * Migration test for 20260930000000_redaction_jobs_real: defaults (no invented modelVersion),
 * CHECK constraints, and the rule that a COMPLETED job has a hashed, non-empty output.
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
let userId = '';
let manifestId = '';
const violates = (p: Promise<unknown>) => expect(p).rejects.toThrow();

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'mig4red'));
  ({ userId } = await createUserWithToken(prisma, tenantId));
  const m = await prisma.evidenceManifest.create({
    data: { tenantId, createdByUserId: userId, startUtc: new Date(), endUtc: new Date(), cameraIdsJson: [cameraId], masterEvidenceHash: 'a'.repeat(64), sourceMetadataJson: {}, segmentManifestJson: [] },
  });
  manifestId = m.id;
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

const job = (data: Record<string, unknown> = {}) => prisma.redactionJob.create({ data: { tenantId, sourceManifestId: manifestId, createdByUserId: userId, ...data } as any });

describe('P4.4 redaction migration', () => {
  it('defaults: no model version, no detection kinds, 4 fps', async () => {
    const j = await job();
    expect(j.modelVersion).toBeNull();
    expect(j.detectKinds).toEqual([]);
    expect(j.sampleFps).toBe(4);
    expect([j.provenanceJson, j.outputBytes, j.maskCount, j.errorCode, j.startedAt, j.cameraId]).toEqual([null, null, null, null, null, null]);
  });

  it('checks detection kinds, sampling rate and output size', async () => {
    await job({ detectKinds: ['FACE', 'LICENSE_PLATE'], sampleFps: 0.5 });
    await violates(job({ detectKinds: ['PERSON'] }));
    await violates(job({ sampleFps: 0.1 }));
    await violates(job({ sampleFps: 11 }));
    await violates(job({ outputBytes: BigInt(0) }));
  });

  it('COMPLETED requires a SHA-256, a positive size and an object key', async () => {
    await violates(job({ status: 'COMPLETED' }));
    await violates(job({ status: 'COMPLETED', outputSha256: 'not-a-hash', outputBytes: BigInt(10), outputObjectKey: 'k' }));
    await violates(job({ status: 'COMPLETED', outputSha256: 'b'.repeat(64), outputObjectKey: 'k' }));
    const ok = await job({ status: 'COMPLETED', outputSha256: 'b'.repeat(64), outputBytes: BigInt(10), outputObjectKey: 'k' });
    expect(ok.status).toBe('COMPLETED');
    await prisma.redactionJob.create({ data: { tenantId, sourceManifestId: manifestId, createdByUserId: userId, status: 'FAILED', errorCode: 'REDACTION_OUTPUT_MISSING' } });
  });
});
