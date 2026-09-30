/**
 * Alarm-time explanation hook (Phase 5, P5.2).
 *
 * Called by AlarmLifecycle.elevateAlarm after the alarm has committed. It must never throw and never
 * delay the alarm beyond the explanation's own queries: an explanation is an added record, not a
 * precondition of raising an alarm. It is also never silent. Every failure is logged, counted and
 * written to the audit chain (EXPLANATION_FAILED) so an alarm without an explanation can be found.
 * The feature flag defaults to OFF; while off nothing here touches the database.
 */
import { PrismaClient } from '@prisma/client';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';
import { AuditChainService } from '../audit/auditChain.service';
import { MetricsService } from '../observability/metrics.service';
import { generateExplanationForAlarm, GenerateOutcome } from './explanationService';

export type ExplanationHookOutcome = 'disabled' | 'generated' | 'exists' | 'failed';

const METRIC = 'vigilone_explanations_total';
const METRIC_HELP = 'Alarm explanations by outcome';

export type ExplanationGenerator = (prisma: PrismaClient, alarmId: string) => Promise<GenerateOutcome>;

export async function runExplanationHook(
  prisma: PrismaClient,
  alarm: { id: string; tenantId: string },
  generate: ExplanationGenerator = generateExplanationForAlarm
): Promise<ExplanationHookOutcome> {
  if (!isFeatureEnabled(FeatureFlag.EXPLANATIONS)) return 'disabled';
  try {
    const { created } = await generate(prisma, alarm.id);
    const outcome = created ? 'generated' : 'exists';
    MetricsService.incCounter(METRIC, METRIC_HELP, { outcome });
    return outcome;
  } catch (err: any) {
    const message = String(err?.message ?? err);
    MetricsService.incCounter(METRIC, METRIC_HELP, { outcome: 'failed' });
    console.error(`[Explanation] failed for alarm ${alarm.id} (the alarm was raised regardless): ${message}`);
    try {
      await AuditChainService.record(prisma, {
        tenantId: alarm.tenantId,
        userId: null,
        action: 'EXPLANATION_FAILED',
        resourceType: 'Alarm',
        resourceId: alarm.id,
        ipAddress: '127.0.0.1',
        metadata: { alarmId: alarm.id, error: message.slice(0, 1000), actor: 'SYSTEM' },
      });
    } catch (auditErr: any) {
      // The failure is still visible in the log and the counter; the audit write is the third channel.
      MetricsService.incCounter('vigilone_explanation_audit_failures_total', 'Explanation failures that could not be written to the audit chain');
      console.error(`[Explanation] could not audit the failure for alarm ${alarm.id}: ${String(auditErr?.message ?? auditErr)}`);
    }
    return 'failed';
  }
}
