/**
 * explain-template.v1: the fixed wording for explanation records.
 *
 * The renderer is a pure function of the facts. `tools/vigilone-verify` carries an identical copy
 * so an offline reader can re-render the text from the facts; `explanationTemplateParity.test.ts`
 * runs both on the same inputs and requires identical output. Change the wording only by adding a
 * new template version, never by editing this one: old records must keep verifying.
 */
import { canonicalizeJson } from '../evidence/archive/canonicalJson';
import { EXPLAIN_TEMPLATE_V1, ExplanationFactsV1 } from './types';

const MAX_LIST = 10;
const MAX_TEXT = 200;
const MAX_JSON = 240;

/** Recorded strings can hold anything (a camera name, a sign read by a model): collapse control characters, cap the length, quote. */
const q = (v: unknown): string => JSON.stringify(String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT));
const num = (v: number): string => String(v);
const cj = (v: unknown): string => {
  const s = canonicalizeJson(v);
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}...` : s;
};
const isPresent = (v: unknown): boolean =>
  v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

type Payload = Record<string, unknown>;
const str = (p: Payload, k: string): string | null => (typeof p[k] === 'string' && (p[k] as string).length > 0 ? (p[k] as string) : null);
const numeric = (p: Payload, k: string): number | null => (typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : null);

function payloadSentence(payload: Payload | null): string | null {
  if (!payload) return null;
  const kind = str(payload, 'kind');
  if (!kind) return `The trigger payload has no kind; recorded fields: ${cj(payload)}.`;
  const generic = () => `The trigger payload of kind ${q(kind)} is missing fields for a specific description; recorded fields: ${cj(payload)}.`;
  switch (kind) {
    case 'TRIPWIRE_CROSS': {
      const track = str(payload, 'trackId');
      const wire = str(payload, 'tripwireId');
      const dir = str(payload, 'direction');
      if (!track || !wire || !dir) return generic();
      return `Track ${q(track)} crossed tripwire ${q(wire)} in direction ${dir}.`;
    }
    case 'LOITERING_DWELL': {
      const track = str(payload, 'trackId');
      const zone = str(payload, 'zoneId');
      const dwell = numeric(payload, 'dwellTimeSeconds');
      const limit = numeric(payload, 'thresholdSeconds');
      if (!track || !zone || dwell === null || limit === null) return generic();
      return `Track ${q(track)} stayed in zone ${q(zone)} for ${num(dwell)} seconds; the configured threshold is ${num(limit)} seconds.`;
    }
    case 'UNATTENDED_OBJECT': {
      const track = str(payload, 'trackId');
      const zone = str(payload, 'zoneId');
      const cls = str(payload, 'objectClass');
      const secs = numeric(payload, 'unattendedSeconds');
      const limit = numeric(payload, 'thresholdSeconds');
      if (!track || !zone || !cls || secs === null || limit === null) return generic();
      return `A ${q(cls)} (track ${q(track)}) lay still in zone ${q(zone)} with no person near it for ${num(secs)} seconds; the configured threshold is ${num(limit)} seconds.`;
    }
    case 'WRONG_WAY': {
      const track = str(payload, 'trackId');
      const zone = str(payload, 'zoneId');
      const angle = numeric(payload, 'angleDegrees');
      const travel = numeric(payload, 'travel');
      if (!track || !zone || angle === null || travel === null) return generic();
      return `Track ${q(track)} moved ${num(angle)} degrees against the allowed direction of zone ${q(zone)} over a distance of ${num(travel)} of the picture.`;
    }
    case 'ANPR_MATCH': {
      const plate = str(payload, 'plateText');
      const conf = numeric(payload, 'confidence');
      if (!plate || conf === null) return generic();
      const cat = str(payload, 'watchlistCategory');
      return `Plate ${q(plate)} was read with confidence ${num(conf)}${cat ? ` and matched watchlist category ${q(cat)}` : ''}.`;
    }
    case 'AI_OBJECT_DETECTED': {
      const cls = str(payload, 'objectClass');
      const conf = numeric(payload, 'confidence');
      if (!cls || conf === null) return generic();
      return `A model detected ${q(cls)} with confidence ${num(conf)}.`;
    }
    case 'CAMERA_OFFLINE': {
      const last = str(payload, 'lastSeenUtc');
      if (!last) return generic();
      return `The camera was last seen at ${last}${str(payload, 'reason') ? `; recorded reason ${q(str(payload, 'reason'))}` : ''}.`;
    }
    case 'STREAM_DEGRADED': {
      const fps = numeric(payload, 'fps');
      const expected = numeric(payload, 'expectedFps');
      if (fps === null || expected === null) return generic();
      return `The stream ran at ${num(fps)} frames per second against an expected ${num(expected)}.`;
    }
    case 'MOTION': {
      const score = numeric(payload, 'score');
      if (score === null) return generic();
      return `Classical motion detection reported a score of ${num(score)}.`;
    }
    default:
      return `The trigger payload of kind ${q(kind)} has no dedicated wording; recorded fields: ${cj(payload)}.`;
  }
}

export function renderExplanationV1(facts: ExplanationFactsV1): string {
  const out: string[] = [];
  const { alarm, subject, trigger, rule } = facts;

  out.push(
    `Alarm ${q(alarm.title)} with severity ${alarm.severity} was raised at ${alarm.triggeredAtUtc} on ${
      subject.cameraId ? `camera ${subject.cameraId}` : 'no specific camera'
    }.`
  );

  if (trigger.type) {
    out.push(
      `It was raised from a ${trigger.type} event${trigger.source ? ` from source ${q(trigger.source)}` : ''}${
        trigger.eventId ? ` (event ${trigger.eventId})` : ''
      }${trigger.timestampUtc ? ` recorded at ${trigger.timestampUtc}` : ''}.`
    );
  } else {
    out.push('No triggering event is linked to this alarm.');
  }

  const p = payloadSentence(trigger.payload);
  if (p) out.push(p);

  if (rule) {
    out.push(
      `Rule ${q(rule.name ?? rule.id)} (${rule.triggerType ?? 'unknown trigger type'}) matched${
        isPresent(rule.conditions) ? ` with conditions ${cj(rule.conditions)}` : ''
      }${rule.cooldownSeconds !== null ? `; its cooldown is ${num(rule.cooldownSeconds)} seconds` : ''}.`
    );
  } else {
    out.push('No automation rule is linked to this alarm.');
  }

  if (facts.models.length > 0) {
    out.push(
      `Models involved: ${facts.models
        .map((m) => `${m.name}@${m.version} (sha256 ${m.sha256.slice(0, 12)}, ${m.evaluated ? 'evaluation published' : 'not evaluated on site data'})`)
        .join('; ')}.`
    );
  } else {
    out.push('No AI model is recorded for this alarm.');
  }

  if (facts.detections.length > 0) {
    const shown = facts.detections.slice(0, MAX_LIST).map((d) => `${q(d.label)} with confidence ${num(d.confidence)} at ${d.frameTimestampUtc}`);
    const more = facts.detections.length > MAX_LIST ? `; and ${facts.detections.length - MAX_LIST} more` : '';
    out.push(`Detections recorded with this alarm: ${shown.join('; ')}${more}.`);
  }

  if (facts.correlated.length > 0) {
    const shown = facts.correlated.slice(0, MAX_LIST).map((c) => `${c.type} at ${c.timestampUtc}`);
    const more = facts.correlated.length > MAX_LIST ? `; and ${facts.correlated.length - MAX_LIST} more` : '';
    out.push(`Earlier events in the same correlation chain: ${shown.join('; ')}${more}.`);
  }

  out.push(`Camera clock check: ${facts.cameraClock.status}.`);
  out.push(
    `This explanation was generated by template ${EXPLAIN_TEMPLATE_V1} from recorded facts. It is not a model opinion and does not by itself show that the event occurred.`
  );
  return out.join('\n');
}

const RENDERERS: Record<string, (f: ExplanationFactsV1) => string> = {
  [EXPLAIN_TEMPLATE_V1]: renderExplanationV1,
};

export function isKnownTemplate(version: string): boolean {
  return Object.prototype.hasOwnProperty.call(RENDERERS, version);
}

export function renderExplanation(facts: ExplanationFactsV1, templateVersion: string): string {
  const r = RENDERERS[templateVersion];
  if (!r) throw new Error(`unknown explanation template version: ${templateVersion}`);
  return r(facts);
}
