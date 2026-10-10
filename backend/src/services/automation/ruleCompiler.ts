import { RuleTriggerType, RuleActionType } from '@prisma/client';
import {
  RuleIntentIR,
  RuleCompileResult,
  RuleInterpretation,
  RuleInterpretationStatus,
  CompiledDraftRule,
} from './ruleIntentTypes';
import { validateRuleInput, RuleValidationError } from './ruleSchema';

export interface RuleCompilerCamera {
  id: string;
  name: string;
  tenantId: string;
}

export interface RuleCompilerZone {
  id: string;
  name: string;
  tenantId: string;
  cameraId?: string;
}

export interface RuleCompilerContext {
  tenantId: string;
  cameras: RuleCompilerCamera[];
  zones: RuleCompilerZone[];
  timezone?: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compileRuleIntent(
  ir: RuleIntentIR,
  context: RuleCompilerContext
): RuleCompileResult {
  const assumptions: string[] = [];
  const unresolvedFields: string[] = [];
  let status: RuleInterpretationStatus = 'ready_for_review';
  let summary = `Compiled rule for ${ir.behavior}`;

  // 1. Tenant Isolation: only consider cameras & zones belonging to context.tenantId
  const tenantCameras = context.cameras.filter((c) => c.tenantId === context.tenantId);
  const tenantZones = context.zones.filter((z) => z.tenantId === context.tenantId);

  // 2. Entity Resolution
  const resolvedCameras: Array<{ id: string; name: string }> = [];
  const resolvedZones: Array<{ id: string; name: string; cameraId?: string }> = [];
  let resolvedCameraId: string | undefined;
  let resolvedZoneId: string | undefined;

  if (ir.locationPhrase && ir.locationPhrase.trim()) {
    const normPhrase = normalize(ir.locationPhrase);

    const matchedZones = tenantZones.filter((z) => {
      const nz = normalize(z.name);
      return nz === normPhrase || nz.includes(normPhrase) || normPhrase.includes(nz);
    });

    const matchedCameras = tenantCameras.filter((c) => {
      const nc = normalize(c.name);
      return nc === normPhrase || nc.includes(normPhrase) || normPhrase.includes(nc);
    });

    const totalMatches = matchedZones.length + matchedCameras.length;

    if (totalMatches === 0) {
      status = 'needs_clarification';
      unresolvedFields.push('locationPhrase');
      summary = `No camera or zone found matching "${ir.locationPhrase}".`;
    } else if (matchedZones.length === 1 && matchedCameras.length === 0) {
      const z = matchedZones[0];
      resolvedZones.push({ id: z.id, name: z.name, cameraId: z.cameraId });
      resolvedZoneId = z.id;
      if (z.cameraId) {
        resolvedCameraId = z.cameraId;
        const cam = tenantCameras.find((c) => c.id === z.cameraId);
        if (cam) resolvedCameras.push({ id: cam.id, name: cam.name });
      }
    } else if (matchedCameras.length === 1 && matchedZones.length === 0) {
      const c = matchedCameras[0];
      resolvedCameras.push({ id: c.id, name: c.name });
      resolvedCameraId = c.id;
    } else if (matchedZones.length === 1 && matchedCameras.length === 1 && matchedZones[0].cameraId === matchedCameras[0].id) {
      // Zone and its parent camera matched
      const z = matchedZones[0];
      const c = matchedCameras[0];
      resolvedZones.push({ id: z.id, name: z.name, cameraId: z.cameraId });
      resolvedCameras.push({ id: c.id, name: c.name });
      resolvedZoneId = z.id;
      resolvedCameraId = c.id;
    } else {
      // Multiple ambiguous matches
      status = 'needs_clarification';
      unresolvedFields.push('locationPhrase');
      const candidates = [
        ...matchedZones.map((z) => `Zone: ${z.name}`),
        ...matchedCameras.map((c) => `Camera: ${c.name}`),
      ].join(', ');
      summary = `Multiple locations matched "${ir.locationPhrase}": ${candidates}. Please select a specific camera or zone.`;
    }
  }

  // 3. Model unresolved notes
  if (ir.unresolvedNotes && ir.unresolvedNotes.length > 0) {
    const isAdversarialOrUnsupported = ir.unresolvedNotes.some(
      (n) =>
        n.toLowerCase().includes('adversarial') ||
        n.toLowerCase().includes('override') ||
        n.toLowerCase().includes('unsupported')
    );
    status = isAdversarialOrUnsupported ? 'unsupported_request' : 'needs_clarification';
    ir.unresolvedNotes.forEach((n) => {
      if (!assumptions.includes(n)) assumptions.push(n);
    });
  }

  // 4. Trigger & TriggerConfig mapping
  let triggerType: RuleTriggerType;
  const triggerConfig: Record<string, unknown> = {};

  if (resolvedCameraId) triggerConfig.cameraId = resolvedCameraId;
  if (resolvedZoneId) triggerConfig.zoneId = resolvedZoneId;

  switch (ir.behavior) {
    case 'LOITERING':
      triggerType = RuleTriggerType.PERSON_DETECTED;
      triggerConfig.objectClasses = ['person'];
      const dwell = ir.durationSeconds ?? 300;
      triggerConfig.minDwellSeconds = dwell;
      if (!ir.durationSeconds) {
        assumptions.push(`Default dwell threshold of 300s (5 minutes) applied.`);
      }
      break;

    case 'AREA_INTRUSION':
      if (ir.targetClass === 'person') {
        triggerType = RuleTriggerType.PERSON_DETECTED;
        triggerConfig.objectClasses = ['person'];
      } else if (ir.targetClass === 'vehicle') {
        triggerType = RuleTriggerType.VEHICLE_DETECTED;
      } else {
        triggerType = RuleTriggerType.MOTION_ZONE;
      }
      break;

    case 'TRIPWIRE_CROSS':
      triggerType = RuleTriggerType.TRIPWIRE_CROSS;
      break;

    case 'FENCE_CLIMB':
      triggerType = RuleTriggerType.FENCE_CLIMB;
      break;

    case 'PERSON_DOWN':
      triggerType = RuleTriggerType.PERSON_DOWN;
      break;

    case 'CAMERA_TAMPER':
      triggerType = RuleTriggerType.SCENE_CHANGE;
      break;

    case 'OBJECT_ABANDONED':
      triggerType = RuleTriggerType.UNATTENDED_OBJECT;
      break;

    case 'UNRECOGNIZED_VEHICLE':
      triggerType = RuleTriggerType.VEHICLE_DETECTED;
      break;

    case 'GENERIC_DETECTION':
    default:
      if (ir.targetClass === 'vehicle') {
        triggerType = RuleTriggerType.VEHICLE_DETECTED;
      } else {
        triggerType = RuleTriggerType.PERSON_DETECTED;
        triggerConfig.objectClasses = ['person'];
      }
      break;
  }

  // 5. Conditions mapping (Schedules, Timezones)
  const conditions: any[] = [];
  const tz = context.timezone || 'Asia/Kolkata';

  const scheduleDays =
    ir.schedule.days && ir.schedule.days.length > 0 ? ir.schedule.days : [0, 1, 2, 3, 4, 5, 6];
  if (!ir.schedule.days || ir.schedule.days.length === 0) {
    if (ir.schedule.type !== 'ALWAYS') {
      assumptions.push('Schedule active on all days of the week (Sun-Sat).');
    }
  }

  if (ir.schedule.type === 'AFTER') {
    const start = ir.schedule.startTime || '22:00';
    const end = ir.schedule.endTime || '06:00';
    if (!ir.schedule.endTime) {
      assumptions.push(`Overnight schedule assumed: ${start} to ${end} (until morning shift). Please confirm the desired end time.`);
    }
    conditions.push({
      type: 'TIME_SCHEDULE',
      operator: 'BETWEEN',
      value: {
        windows: [{ days: scheduleDays, start, end }],
        timezone: tz,
      },
    });
  } else if (ir.schedule.type === 'BEFORE') {
    const start = ir.schedule.startTime || '00:00';
    const end = ir.schedule.endTime || '06:00';
    if (!ir.schedule.startTime) {
      assumptions.push(`Schedule assumed: ${start} to ${end}. Please confirm the desired start time.`);
    }
    conditions.push({
      type: 'TIME_SCHEDULE',
      operator: 'BETWEEN',
      value: {
        windows: [{ days: scheduleDays, start, end }],
        timezone: tz,
      },
    });
  } else if (ir.schedule.type === 'BETWEEN') {
    const start = ir.schedule.startTime || '09:00';
    const end = ir.schedule.endTime || '17:00';
    conditions.push({
      type: 'TIME_SCHEDULE',
      operator: 'BETWEEN',
      value: {
        windows: [{ days: scheduleDays, start, end }],
        timezone: tz,
      },
    });
  }

  // 6. Action mapping
  const actions: any[] = [];
  const actionId = `action_${Date.now()}`;

  switch (ir.actionType) {
    case 'ALARM':
      actions.push({
        id: actionId,
        type: RuleActionType.TRIGGER_ALARM,
        config: {
          incidentWindowSeconds: 300,
          severity: ir.severity,
        },
      });
      break;
    case 'NOTIFICATION':
      actions.push({
        id: actionId,
        type: RuleActionType.DISPATCH_NOTIFICATION,
        config: { severity: ir.severity },
      });
      break;
    case 'RELAY':
      actions.push({
        id: actionId,
        type: RuleActionType.FIRE_DO_RELAY,
        config: {},
      });
      break;
    case 'RECORD':
      actions.push({
        id: actionId,
        type: RuleActionType.START_HIGH_RES_RECORDING,
        config: { durationSeconds: 60 },
      });
      break;
  }

  const draftRule: CompiledDraftRule = {
    name: ir.suggestedName,
    triggerType,
    triggerConfig,
    conditions,
    actions,
    cooldownSeconds: 30,
    priority: 1,
    enabled: true,
  };

  // 7. Schema Validation
  try {
    validateRuleInput(draftRule);
  } catch (err: any) {
    if (err instanceof RuleValidationError) {
      status = 'unsupported_request';
      summary = `Generated rule failed schema validation: ${err.message}`;
    }
  }

  const interpretation: RuleInterpretation = {
    status,
    summary,
    assumptions,
    unresolvedFields,
    resolvedEntities: {
      cameras: resolvedCameras,
      zones: resolvedZones,
    },
  };

  return {
    interpretation,
    draftRule: status === 'unsupported_request' ? null : draftRule,
  };
}
