import crypto from 'crypto';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';

/**
 * Migration tests for 20260927000000_ai_provenance_canonical_events.
 *
 * 1. Drift: applying every migration in prisma/migrations must yield exactly schema.prisma. Before
 *    this migration the Incident model (Step 4) existed only in the schema, so every database built
 *    with `prisma migrate deploy` lacked the table and spatial incident inserts failed. The drift
 *    check uses a throwaway shadow database, so it needs CREATEDB (true for the CI service user).
 * 2. The new columns and tables behave as intended on the real database.
 */
const BACKEND = path.resolve(__dirname, '..', '..');

function shadowUrl(name: string): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.pathname = `/${name}`;
  u.search = '';
  return u.toString();
}

describe('Phase 2 migration', () => {
  const prisma = new PrismaClient();
  const suffix = crypto.randomBytes(4).toString('hex');

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('schema.prisma and the migration history have no drift', async () => {
    const shadow = `vigilone_shadow_${suffix}`;
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${shadow}"`);
    try {
      // --exit-code: 0 = no difference, 2 = difference (execFileSync throws on non-zero).
      execFileSync(
        path.join(BACKEND, 'node_modules', '.bin', 'prisma'),
        [
          'migrate', 'diff',
          '--from-migrations', 'prisma/migrations',
          '--to-schema-datamodel', 'prisma/schema.prisma',
          '--shadow-database-url', shadowUrl(shadow),
          '--exit-code',
        ],
        { cwd: BACKEND, stdio: 'pipe', env: process.env }
      );
    } finally {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadow}" WITH (FORCE)`);
    }
  }, 60000);

  describe('on the migrated database', () => {
    let tenantId = '';
    let cameraId = '';

    beforeAll(async () => {
      ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'mig'));
    });

    afterAll(async () => {
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    });

    it('Incident exists and keeps its row (ruleId -> NULL) when the spatial rule is deleted', async () => {
      const rule = await prisma.spatialAnalyticsRule.create({
        data: { tenantId, cameraId, name: 'wire', type: 'TRIPWIRE', lineCoordinatesJson: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      });
      const inc = await prisma.incident.create({
        data: { tenantId, cameraId, ruleId: rule.id, trackId: 't1', cooldownBucket: BigInt(1), ruleType: 'TRIPWIRE', title: 'x' },
      });
      await prisma.spatialAnalyticsRule.delete({ where: { id: rule.id } });
      const after = await prisma.incident.findUnique({ where: { id: inc.id } });
      expect(after).not.toBeNull();
      expect(after!.ruleId).toBeNull();
    });

    it('CanonicalEvent ids are unique (re-ingesting an event cannot duplicate it)', async () => {
      const data = {
        id: `ev_${suffix}`, tenantId, type: 'TRIPWIRE_CROSS', source: 'SPATIAL_ANALYTICS',
        timestampUtc: new Date(), correlationId: 'c', payloadJson: {},
      };
      await prisma.canonicalEvent.create({ data });
      await expect(prisma.canonicalEvent.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('an alarm can reference its canonical event and automation rule', async () => {
      const rule = await prisma.automationRule.create({
        data: { tenantId, name: 'r', triggerType: 'TRIPWIRE_CROSS', triggerConfigJson: {}, conditionsJson: [], actionsJson: [] },
      });
      const alarm = await prisma.alarm.create({
        data: { tenantId, title: 'a', canonicalEventId: `ev_${suffix}`, automationRuleId: rule.id },
        include: { canonicalEvent: true },
      });
      expect(alarm.canonicalEvent?.type).toBe('TRIPWIRE_CROSS');
    });

    it('ModelManifest has deployment and evaluation columns with safe defaults', async () => {
      const m = await prisma.modelManifest.create({
        data: {
          name: `mig-model-${suffix}`, version: '1', sha256: 'a'.repeat(64), codeLicense: 'MIT', weightLicense: 'MIT',
          trainingDataJson: {}, runtimeConfigJson: {},
        },
      });
      expect(m.deployed).toBe(false);
      expect(m.evaluationJson).toBeNull();
      expect(m.task).toBe('object_detection');
      await prisma.modelManifest.delete({ where: { id: m.id } });
    });
  });
});
