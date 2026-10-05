/**
 * Alarm triage data for frontend/e2e/alarm-triage.spec.ts (ADR 0015): a tenant of its own, so the alarm counts of the
 * operations test stay as they are. Three open alarms: a CRITICAL one the second-opinion model doubts, a WARNING one
 * from a rule operators have marked false 12 times on this camera, and a WARNING one from a rule they confirmed 12
 * times and that repeated 5 times. A second rule on the same camera has 25 alarms all marked false, with no
 * incident window, which is what produces a suggested rule change. A fourth, acknowledged alarm ('Summary alarm') is for
 * frontend/e2e/incident-summary.spec.ts (ADR 0016); it is not open, so it is not in the triage queue.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient, RuleActionType, RuleTriggerType } from '@prisma/client';
import { LicenseClaims, signLicensePayload } from '../../src/utils/license';

export async function seedTriage(prisma: PrismaClient, opts: { password: string; licencePrivateKey: string }) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Triage ${suffix}`, slug: `triage-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'Triage site', timezone: 'UTC' } });
  const camera = await prisma.camera.create({
    data: { tenantId: tenant.id, siteId: site.id, name: 'Dock camera', streamPath: `triage_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/triage_${suffix}` },
  });
  const email = `triage-${suffix}@e2e.invalid`;
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email, name: 'Triage Admin', role: 'TENANT_ADMIN', passwordHash: await bcrypt.hash(opts.password, 10) },
  });
  const now = new Date();
  const licence: LicenseClaims = {
    licenseId: `lic_triage_${suffix}`,
    tenantId: tenant.id,
    tier: 'PROFESSIONAL',
    maxCameras: 4,
    features: ['EVIDENCE_EXPORT', 'ADVANCED_SEARCH'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  };
  await prisma.license.create({
    data: {
      tenantId: tenant.id,
      licenseId: licence.licenseId,
      tier: licence.tier,
      maxCameras: licence.maxCameras,
      features: licence.features,
      expiresAt: new Date(licence.expiresAt!),
      ...signLicensePayload(licence, opts.licencePrivateKey),
    },
  });

  const rule = (name: string) =>
    prisma.automationRule.create({
      data: {
        tenantId: tenant.id,
        name,
        triggerType: RuleTriggerType.MOTION_ZONE,
        triggerConfigJson: {},
        conditionsJson: {},
        actionsJson: [{ id: 'a1', type: RuleActionType.TRIGGER_ALARM, config: {} }],
      },
    });
  const noisy = await rule('Dock motion');
  const steady = await rule('Door forced');
  const loud = await rule('Shadow motion');

  const past = async (ruleId: string, n: number, falses: number) => {
    for (let i = 0; i < n; i++) {
      const a = await prisma.alarm.create({ data: { tenantId: tenant.id, cameraId: camera.id, automationRuleId: ruleId, title: 'past', state: 'RESOLVED', resolvedAt: new Date() } });
      await prisma.alarmFeedback.create({
        data: { tenantId: tenant.id, alarmId: a.id, verdict: i < falses ? 'FALSE_ALARM' : 'TRUE_ALARM', userId: admin.id, automationRuleId: ruleId, cameraId: camera.id },
      });
    }
  };
  await past(noisy.id, 12, 12);
  await past(steady.id, 12, 0);
  await past(loud.id, 25, 25);

  const open = (title: string, over: Record<string, unknown>) =>
    prisma.alarm.create({ data: { tenantId: tenant.id, cameraId: camera.id, title, ...over } });
  const critical = await open('Triage crash on dock', { severity: 'CRITICAL', triggeredAt: new Date(now.getTime() - 60_000) });
  await prisma.vlmVerification.create({
    data: {
      tenantId: tenant.id, alarmId: critical.id, cameraId: camera.id, imageSource: 'SNAPSHOT', imageSha256: 'a'.repeat(64), targetClass: 'person', answer: 'no',
      reason: 'seed', promptSha256: 'b'.repeat(64), modelName: 'seed', modelVersion: '1', modelSha256: crypto.randomBytes(32).toString('hex'), adapterId: 'seed',
      inferenceId: crypto.randomUUID(), provenanceJson: {}, latencyMs: 1,
    },
  });
  const noisyOpen = await open('Triage dock motion', { severity: 'WARNING', automationRuleId: noisy.id, triggeredAt: new Date(now.getTime() - 300_000) });
  const steadyOpen = await open('Triage door forced', { severity: 'WARNING', automationRuleId: steady.id, occurrenceCount: 5, triggeredAt: new Date(now.getTime() - 120_000) });

  // For the incident summary spec: already acknowledged, so it is not in the triage queue (open alarms only) and the two
  // specs cannot change each other's counts.
  const summary = await open('Summary alarm', { severity: 'WARNING', state: 'ACKNOWLEDGED', acknowledgedAt: new Date(now.getTime() - 30_000), acknowledgedById: admin.id, triggeredAt: new Date(now.getTime() - 90_000) });

  return { tenantId: tenant.id, email, alarms: { critical: critical.id, noisy: noisyOpen.id, steady: steadyOpen.id, summary: summary.id }, noisyRuleName: noisy.name, loudRuleName: loud.name };
}
