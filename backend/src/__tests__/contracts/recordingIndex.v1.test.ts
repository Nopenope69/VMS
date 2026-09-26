import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient, SegmentStatus } from '@prisma/client';
import { RecordingIndexRecordV1, toRecordingIndexRecordV1 } from '../../contracts/recordingIndex.v1';

const examples = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/examples/recording-index.v1.json'), 'utf8')
);

describe('contract recording-index.v1', () => {
  it.each<[any, any]>(examples.valid.map((v: any) => [v.segmentId, v]))('accepts valid example %s', (_id, v) => {
    const res = RecordingIndexRecordV1.safeParse(v);
    expect(res.success ? [] : res.error.issues).toEqual([]);
  });

  it.each<[any, any]>(examples.invalid.map((e: any) => [e.why, e.value]))('rejects: %s', (_why, v) => {
    expect(RecordingIndexRecordV1.safeParse(v).success).toBe(false);
  });

  describe('round trip through the real database (Postgres via Prisma)', () => {
    const prisma = new PrismaClient();
    const suffix = crypto.randomBytes(4).toString('hex');
    let tenantId = '';

    afterAll(async () => {
      if (tenantId) {
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    });

    it('maps a persisted RecordingSegment row, including a still-pending hash, onto v1', async () => {
      const tenant = await prisma.tenant.create({ data: { name: `contract-${suffix}`, slug: `contract-${suffix}` } });
      tenantId = tenant.id;
      const site = await prisma.site.create({ data: { tenantId, name: 'Contract Site' } });
      const camera = await prisma.camera.create({
        data: {
          tenantId,
          siteId: site.id,
          name: 'Contract Cam',
          streamPath: `contract_${suffix}`,
          ipAddress: '10.0.0.5',
          mainRtspUri: 'rtsp://10.0.0.5:554/s1',
        },
      });
      const hash = crypto.createHash('sha256').update(`segment-${suffix}`).digest('hex');
      const hashed = await prisma.recordingSegment.create({
        data: {
          tenantId,
          cameraId: camera.id,
          filePath: `/recordings/contract_${suffix}/a.mp4`,
          startTime: new Date('2026-09-26T10:00:00.000Z'),
          endTime: new Date('2026-09-26T10:10:00.000Z'),
          durationMs: 600000,
          sizeBytes: BigInt('5000000000'),
          sha256Hash: hash,
          endPts: BigInt(54000000),
          status: SegmentStatus.FINALIZED,
        },
      });
      const pending = await prisma.recordingSegment.create({
        data: {
          tenantId,
          cameraId: camera.id,
          filePath: `/recordings/contract_${suffix}/b.mp4`,
          startTime: new Date('2026-09-26T10:10:00.000Z'),
          endTime: new Date('2026-09-26T10:10:05.000Z'),
          durationMs: 5000,
          sizeBytes: BigInt(1024),
          status: SegmentStatus.RECORDING,
        },
      });

      const readBack = await prisma.recordingSegment.findMany({ where: { cameraId: camera.id }, orderBy: { startTime: 'asc' } });
      const [a, b] = readBack.map((s) => toRecordingIndexRecordV1(s, false));

      expect(a).toMatchObject({
        segmentId: hashed.id,
        sizeBytes: '5000000000',
        integrity: { state: 'HASHED', sha256: hash },
        pts: { start: '0', end: '54000000', timebase: { numerator: 1, denominator: 90000 } },
        status: 'FINALIZED',
      });
      expect(b).toMatchObject({ segmentId: pending.id, status: 'RECORDING', integrity: { state: 'PENDING' } });
      expect(RecordingIndexRecordV1.safeParse(a).success).toBe(true);
      expect(RecordingIndexRecordV1.safeParse(b).success).toBe(true);
    });
  });
});
