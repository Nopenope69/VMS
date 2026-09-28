import React from 'react';
import Input from './ui/Input';

/**
 * Trigger filters and conditions for an automation rule (P3.5 / P3.6). Mirrors the backend
 * validation in services/automation/ruleSchema.ts; the backend remains the authority and its
 * RULE_INVALID message is shown as is.
 */
export interface RuleDraft {
  minConfidence: string;
  minDwellSeconds: string;
  vehicleClasses: string[];
  analyticTypes: string;
  scheduleEnabled: boolean;
  scheduleMode: 'BETWEEN' | 'NOT_BETWEEN';
  scheduleDays: number[];
  scheduleStart: string;
  scheduleEnd: string;
  scheduleTimezone: string;
  correlation: 'NONE' | 'PRECEDED_BY' | 'NOT_PRECEDED_BY';
  correlationEventTypes: string[];
  correlationWithinSeconds: string;
  correlationScope: 'SAME_CAMERA' | 'ANY_CAMERA';
}

export const emptyRuleDraft = (): RuleDraft => ({
  minConfidence: '',
  minDwellSeconds: '',
  vehicleClasses: [],
  analyticTypes: '',
  scheduleEnabled: false,
  scheduleMode: 'BETWEEN',
  scheduleDays: [0, 1, 2, 3, 4, 5, 6],
  scheduleStart: '22:00',
  scheduleEnd: '06:00',
  scheduleTimezone: '',
  correlation: 'NONE',
  correlationEventTypes: ['DI_TRIGGER'],
  correlationWithinSeconds: '30',
  correlationScope: 'SAME_CAMERA',
});

const AI_TRIGGERS = ['PERSON_DETECTED', 'VEHICLE_DETECTED'];
const VEHICLE_CLASSES = ['bicycle', 'motorcycle', 'car', 'bus', 'truck'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CORRELATABLE = ['DI_TRIGGER', 'AI_OBJECT_DETECTED', 'TRIPWIRE_CROSS', 'LOITERING_DWELL', 'MOTION', 'ANPR_MATCH', 'CAMERA_ANALYTIC', 'CAMERA_OFFLINE'];

/** triggerConfig and conditions exactly as the API expects them. */
export function buildRuleParts(triggerType: string, d: RuleDraft): { triggerConfig: Record<string, unknown>; conditions: unknown[] } {
  const triggerConfig: Record<string, unknown> = {};
  if (d.minConfidence !== '' && triggerType !== 'CAMERA_OFFLINE' && triggerType !== 'SCENE_CHANGE' && triggerType !== 'DIGITAL_INPUT_STATE' && triggerType !== 'CAMERA_ANALYTIC') {
    triggerConfig.minConfidence = Number(d.minConfidence);
  }
  if (AI_TRIGGERS.includes(triggerType) && d.minDwellSeconds !== '') triggerConfig.minDwellSeconds = Number(d.minDwellSeconds);
  if (triggerType === 'VEHICLE_DETECTED' && d.vehicleClasses.length) triggerConfig.objectClasses = d.vehicleClasses;
  if (triggerType === 'CAMERA_ANALYTIC' && d.analyticTypes.trim()) {
    triggerConfig.analyticTypes = d.analyticTypes.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  const conditions: unknown[] = [];
  if (d.scheduleEnabled) {
    conditions.push({
      type: 'TIME_SCHEDULE',
      operator: d.scheduleMode,
      value: {
        windows: [{ days: d.scheduleDays, start: d.scheduleStart, end: d.scheduleEnd }],
        ...(d.scheduleTimezone.trim() ? { timezone: d.scheduleTimezone.trim() } : {}),
      },
    });
  }
  if (d.correlation !== 'NONE') {
    conditions.push({
      type: d.correlation,
      value: { eventTypes: d.correlationEventTypes, withinSeconds: Number(d.correlationWithinSeconds), scope: d.correlationScope },
    });
  }
  return { triggerConfig, conditions };
}

const label = 'block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]';
const select = 'w-full bg-vms-surface border border-vms-border rounded p-2 text-vms-text font-mono text-xs focus:border-vms-accent focus:outline-none';

export const RuleConditionsEditor: React.FC<{ triggerType: string; draft: RuleDraft; onChange: (d: RuleDraft) => void }> = ({ triggerType, draft, onChange }) => {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...draft, [k]: v });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const isAi = AI_TRIGGERS.includes(triggerType);

  return (
    <div className="pt-2 border-t border-vms-border space-y-3 text-xs">
      <span className="font-semibold text-vms-accent font-mono text-xs uppercase tracking-wider">Filters &amp; Conditions</span>

      {(isAi || ['TRIPWIRE_CROSS', 'LOITERING_DWELL', 'ANPR_WATCHLIST', 'MOTION_ZONE'].includes(triggerType)) && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={label}>Minimum confidence (0-1)</label>
            <Input type="number" step="0.05" min="0" max="1" placeholder="any" value={draft.minConfidence} onChange={(e) => set('minConfidence', e.target.value)} className="w-full text-xs font-mono" />
          </div>
          {isAi && (
            <div>
              <label className={label}>Minimum dwell (seconds tracked before firing)</label>
              <Input type="number" min="1" max="3600" placeholder="fire on confirmation" value={draft.minDwellSeconds} onChange={(e) => set('minDwellSeconds', e.target.value)} className="w-full text-xs font-mono" />
            </div>
          )}
        </div>
      )}

      {triggerType === 'VEHICLE_DETECTED' && (
        <div>
          <label className={label}>Vehicle classes (none = all)</label>
          <div className="flex flex-wrap gap-3 font-mono">
            {VEHICLE_CLASSES.map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input type="checkbox" checked={draft.vehicleClasses.includes(c)} onChange={() => set('vehicleClasses', toggle(draft.vehicleClasses, c))} />
                {c}
              </label>
            ))}
          </div>
        </div>
      )}

      {triggerType === 'CAMERA_ANALYTIC' && (
        <div>
          <label className={label}>Camera analytic types (comma-separated, none = all)</label>
          <Input placeholder="LINE_CROSSING, INTRUSION" value={draft.analyticTypes} onChange={(e) => set('analyticTypes', e.target.value)} className="w-full text-xs font-mono" />
        </div>
      )}

      <div className="p-3 bg-vms-panel border border-vms-border rounded space-y-2">
        <label className="flex items-center gap-2 font-mono">
          <input type="checkbox" checked={draft.scheduleEnabled} onChange={(e) => set('scheduleEnabled', e.target.checked)} />
          Time schedule
        </label>
        {draft.scheduleEnabled && (
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className={label}>Fire</label>
              <select className={select} value={draft.scheduleMode} onChange={(e) => set('scheduleMode', e.target.value as RuleDraft['scheduleMode'])}>
                <option value="BETWEEN">inside window</option>
                <option value="NOT_BETWEEN">outside window</option>
              </select>
            </div>
            <div>
              <label className={label}>From</label>
              <Input type="time" value={draft.scheduleStart} onChange={(e) => set('scheduleStart', e.target.value)} className="w-full text-xs font-mono" />
            </div>
            <div>
              <label className={label}>To (exclusive)</label>
              <Input type="time" value={draft.scheduleEnd} onChange={(e) => set('scheduleEnd', e.target.value)} className="w-full text-xs font-mono" />
            </div>
            <div>
              <label className={label}>Time zone</label>
              <Input placeholder="camera's site" value={draft.scheduleTimezone} onChange={(e) => set('scheduleTimezone', e.target.value)} className="w-full text-xs font-mono" />
            </div>
            <div className="col-span-4 flex gap-3 font-mono">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.scheduleDays.includes(i)} onChange={() => set('scheduleDays', toggle(draft.scheduleDays, i).sort())} />
                  {d}
                </label>
              ))}
              <span className="text-vms-dim">(an overnight window belongs to the day it starts)</span>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 bg-vms-panel border border-vms-border rounded space-y-2">
        <label className={label}>Correlation with earlier events</label>
        <div className="grid grid-cols-4 gap-3">
          <select className={select} value={draft.correlation} onChange={(e) => set('correlation', e.target.value as RuleDraft['correlation'])}>
            <option value="NONE">none</option>
            <option value="PRECEDED_BY">only if preceded by</option>
            <option value="NOT_PRECEDED_BY">only if NOT preceded by</option>
          </select>
          {draft.correlation !== 'NONE' && (
            <>
              <select
                multiple
                className={`${select} h-20`}
                value={draft.correlationEventTypes}
                onChange={(e) => set('correlationEventTypes', Array.from(e.target.selectedOptions).map((o) => o.value))}
              >
                {CORRELATABLE.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <div>
                <label className={label}>within (seconds)</label>
                <Input type="number" min="1" max="86400" value={draft.correlationWithinSeconds} onChange={(e) => set('correlationWithinSeconds', e.target.value)} className="w-full text-xs font-mono" />
              </div>
              <select className={select} value={draft.correlationScope} onChange={(e) => set('correlationScope', e.target.value as RuleDraft['correlationScope'])}>
                <option value="SAME_CAMERA">on the same camera</option>
                <option value="ANY_CAMERA">on any camera</option>
              </select>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RuleConditionsEditor;
