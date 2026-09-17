import React, { useState, useEffect } from 'react';
import {
  Trash2,
  Plus,
  Zap,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

interface EventActionRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EventActionRuleModal: React.FC<EventActionRuleModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [rules, setRules] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'rules' | 'create' | 'history'>('rules');
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState('TRIPWIRE_CROSS');
  const [cooldownSeconds, setCooldownSeconds] = useState(30);
  const [priority, setPriority] = useState(1);
  const [actions, setActions] = useState<any[]>([
    {
      id: 'act_1',
      type: 'FIRE_DO_RELAY',
      config: { pinNumber: 1, durationMs: 2000 },
      timeoutMs: 3000,
      continueOnFailure: true,
    },
  ]);

  const fetchRulesAndHistory = async () => {
    try {
      const [rulesRes, execRes] = await Promise.all([
        api.get('/automation/rules'),
        api.get('/automation/executions?limit=15'),
      ]);
      setRules(rulesRes.data.rules || []);
      setExecutions(execRes.data.executions || []);
    } catch (err) {
      console.error('Failed to load automation data', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchRulesAndHistory();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddAction = () => {
    setActions([
      ...actions,
      {
        id: `act_${Date.now()}`,
        type: 'TRIGGER_ALARM',
        config: { severity: 'WARNING', message: 'Automated perimeter alert' },
        timeoutMs: 3000,
        continueOnFailure: true,
      },
    ]);
  };

  const handleRemoveAction = (index: number) => {
    setActions(actions.filter((_, i) => i !== index));
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setStatusNotice(null);
      await api.post('/automation/rules', {
        name,
        description,
        triggerType,
        cooldownSeconds,
        priority,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: actions,
      });
      setName('');
      setDescription('');
      setActiveTab('rules');
      setStatusNotice({ type: 'success', message: `Rule '${name}' created successfully.` });
      fetchRulesAndHistory();
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to save automation rule' });
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      setStatusNotice(null);
      await api.delete(`/automation/rules/${id}`);
      setRuleToDelete(null);
      setStatusNotice({ type: 'success', message: 'Rule deleted.' });
      fetchRulesAndHistory();
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to delete rule' });
    }
  };

  const handleToggleRule = async (rule: any) => {
    try {
      setStatusNotice(null);
      await api.put(`/automation/rules/${rule.id}`, {
        enabled: !rule.enabled,
      });
      fetchRulesAndHistory();
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to update rule' });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Event-Action Automation Matrix"
      subtitle="Deterministic cross-subsystem rule engine with cooldown suppression & execution audits"
      icon={<Zap className="w-4 h-4 text-vms-accent" />}
      size="4xl"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {statusNotice && (
          <div
            className={`p-3 rounded text-xs font-mono flex items-center justify-between ${
              statusNotice.type === 'error'
                ? 'bg-rose-950/70 border border-rose-800 text-rose-300'
                : 'bg-emerald-950/70 border border-emerald-800 text-emerald-300'
            }`}
          >
            <div className="flex items-center space-x-2">
              {statusNotice.type === 'error' ? (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span>{statusNotice.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-vms-muted hover:text-vms-text ml-2"
            >
              ×
            </button>
          </div>
        )}

        {/* Modal Tabs */}
        <div className="flex border-b border-vms-border bg-vms-panel px-4 space-x-2 rounded-t">
          <button
            type="button"
            onClick={() => setActiveTab('rules')}
            className={`py-2 px-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'rules'
                ? 'border-vms-accent text-vms-accent'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Active Rules ({rules.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`py-2 px-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'create'
                ? 'border-vms-accent text-vms-accent'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            + Create Automation Rule
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`py-2 px-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'history'
                ? 'border-vms-accent text-vms-accent'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Audit Trail / Executions
          </button>
        </div>

        {/* Modal Body */}
        <div className="space-y-4">
          {activeTab === 'rules' && (
            <div className="space-y-3">
              {rules.length === 0 ? (
                <div className="text-center py-12 text-vms-dim font-mono text-xs border border-dashed border-vms-border rounded">
                  No automation rules configured. Click &quot;+ Create Automation Rule&quot; to build edge actions.
                </div>
              ) : (
                rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="p-3.5 bg-vms-panel border border-vms-border rounded flex items-center justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-vms-text font-mono">{rule.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 font-mono border border-sky-500/40">
                          {rule.triggerType}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-vms-surface text-vms-muted font-mono border border-vms-border">
                          Cooldown: {rule.cooldownSeconds}s
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-vms-surface text-vms-muted font-mono border border-vms-border">
                          Priority: #{rule.priority}
                        </span>
                      </div>
                      <p className="text-xs text-vms-muted">{rule.description || 'No description provided'}</p>
                      <div className="flex items-center space-x-2 text-[11px] font-mono text-vms-muted pt-1">
                        <span className="text-vms-dim">Actions:</span>
                        {(rule.actionsJson || []).map((act: any, idx: number) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.5 rounded bg-vms-surface border border-vms-border text-vms-accent text-[10px]"
                          >
                            {act.type}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center space-x-3">
                      <button
                        type="button"
                        onClick={() => handleToggleRule(rule)}
                        className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition-colors ${
                          rule.enabled
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30'
                            : 'bg-vms-surface text-vms-dim border border-vms-border hover:bg-vms-hover'
                        }`}
                      >
                        {rule.enabled ? 'ENABLED' : 'DISABLED'}
                      </button>

                      {ruleToDelete === rule.id ? (
                        <div className="flex items-center space-x-1">
                          <button
                            type="button"
                            onClick={() => handleDeleteRule(rule.id)}
                            className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setRuleToDelete(null)}
                            className="px-1 py-0.5 text-vms-muted text-[10px]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setRuleToDelete(rule.id)}
                          className="p-1 rounded text-vms-dim hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'create' && (
            <form onSubmit={handleSaveRule} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                    Rule Name
                  </label>
                  <Input
                    placeholder="e.g. South Gate Breach Alert"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                    Trigger Event
                  </label>
                  <select
                    value={triggerType}
                    onChange={(e) => setTriggerType(e.target.value)}
                    className="w-full bg-vms-surface border border-vms-border rounded p-2 text-vms-text font-mono text-xs focus:border-vms-accent focus:outline-none"
                  >
                    <option value="TRIPWIRE_CROSS">TRIPWIRE_CROSS (Spatial Vector Line)</option>
                    <option value="LOITERING_DWELL">LOITERING_DWELL (Continuous Area Dwell)</option>
                    <option value="ANPR_WATCHLIST">ANPR_WATCHLIST (Hotlist Vehicle Match)</option>
                    <option value="MOTION_ZONE">MOTION_ZONE (Pixel Dynamic Motion)</option>
                    <option value="DIGITAL_INPUT_STATE">DIGITAL_INPUT_STATE (DI Sensor Trigger)</option>
                    <option value="CAMERA_OFFLINE">CAMERA_OFFLINE (Network Disconnection)</option>
                    <option value="SCENE_CHANGE">SCENE_CHANGE (Camera Tamper / Obscuration)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Description / Notes
                </label>
                <Input
                  placeholder="Automated dispatch, siren strobe and high-res recording trigger"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                    Cooldown Timer (Seconds - Suppress feedback cascades)
                  </label>
                  <Input
                    type="number"
                    min="0"
                    max="3600"
                    value={cooldownSeconds}
                    onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                    className="w-full text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                    Execution Priority (Lowest number first)
                  </label>
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full text-xs font-mono"
                  />
                </div>
              </div>

              {/* Actions Builder */}
              <div className="pt-2 border-t border-vms-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-vms-accent font-mono text-xs uppercase tracking-wider">
                    Cascading Actions Pipeline
                  </span>
                  <button
                    type="button"
                    onClick={handleAddAction}
                    className="flex items-center space-x-1 text-sky-400 hover:underline font-mono text-xs"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Action Step</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {actions.map((act, index) => (
                    <div
                      key={act.id || index}
                      className="p-3 bg-vms-panel border border-vms-border rounded flex items-center space-x-3"
                    >
                      <div className="w-6 h-6 rounded-full bg-vms-surface border border-vms-border flex items-center justify-center font-mono font-bold text-vms-muted text-xs">
                        {index + 1}
                      </div>

                      <div className="flex-1 grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] text-vms-muted mb-1 font-mono">Action Type</label>
                          <select
                            value={act.type}
                            onChange={(e) => {
                              const updated = [...actions];
                              updated[index].type = e.target.value;
                              setActions(updated);
                            }}
                            className="w-full bg-vms-surface border border-vms-border rounded p-1.5 font-mono text-vms-text text-xs focus:border-vms-accent focus:outline-none"
                          >
                            <option value="FIRE_DO_RELAY">FIRE_DO_RELAY (Physical Hardware)</option>
                            <option value="TRIGGER_ALARM">TRIGGER_ALARM (CMS Alarm Workflow)</option>
                            <option value="PTZ_PRESET_GOTO">PTZ_PRESET_GOTO (Slew Camera)</option>
                            <option value="DISPATCH_NOTIFICATION">DISPATCH_NOTIFICATION (Webhook/Email)</option>
                            <option value="START_HIGH_RES_RECORDING">START_HIGH_RES_RECORDING</option>
                            <option value="BOOKMARK_SEGMENT">BOOKMARK_SEGMENT (Legal Pin)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] text-vms-muted mb-1 font-mono">Timeout (ms)</label>
                          <Input
                            type="number"
                            step="500"
                            value={act.timeoutMs || 3000}
                            onChange={(e) => {
                              const updated = [...actions];
                              updated[index].timeoutMs = Number(e.target.value);
                              setActions(updated);
                            }}
                            className="w-full text-xs font-mono"
                          />
                        </div>

                        <div className="flex items-center pt-4 space-x-2">
                          <input
                            type="checkbox"
                            checked={act.continueOnFailure ?? true}
                            onChange={(e) => {
                              const updated = [...actions];
                              updated[index].continueOnFailure = e.target.checked;
                              setActions(updated);
                            }}
                            id={`continue_${index}`}
                            className="rounded accent-[#C05800]"
                          />
                          <label htmlFor={`continue_${index}`} className="text-[10px] text-vms-muted font-mono">
                            Continue on failure
                          </label>
                        </div>
                      </div>

                      {actions.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveAction(index)}
                          className="p-1 rounded text-vms-dim hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t border-vms-border">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setActiveTab('rules')}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                >
                  Deploy Automation Rule
                </Button>
              </div>
            </form>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="text-xs font-mono text-vms-muted mb-2 uppercase tracking-wider">
                Recent Rule Executions & Action Latency Trajectory
              </div>
              <div className="divide-y divide-vms-border">
                {executions.length === 0 ? (
                  <div className="text-center py-10 text-vms-dim font-mono text-xs border border-dashed border-vms-border rounded">
                    No automated executions recorded yet.
                  </div>
                ) : (
                  executions.map((exec) => {
                    const isSuccess = exec.overallStatus === 'SUCCESS';
                    const isPartial = exec.overallStatus === 'PARTIAL';
                    return (
                      <div key={exec.id} className="py-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="font-mono text-xs font-bold text-vms-text">
                              {exec.rule?.name || 'Rule'}
                            </span>
                            <span className="font-mono text-[10px] text-vms-dim">{exec.id}</span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                                isSuccess
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                  : isPartial
                                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                              }`}
                            >
                              {exec.overallStatus}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-vms-dim">
                            {new Date(exec.triggeredAt).toLocaleString()}
                          </span>
                        </div>

                        {/* Action Steps Breakdown */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                          {(exec.actionRecords || []).map((step: any) => (
                            <div
                              key={step.id}
                              className="p-2 bg-vms-surface rounded border border-vms-border text-[10px] font-mono flex items-center justify-between"
                            >
                              <span className="text-vms-text">{step.actionType}</span>
                              <div className="flex items-center space-x-1.5">
                                <span className="text-vms-dim">{step.durationMs}ms</span>
                                <span
                                  className={
                                    step.status === 'SUCCESS'
                                      ? 'text-emerald-400 font-bold'
                                      : 'text-rose-400 font-bold'
                                  }
                                >
                                  {step.status}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default EventActionRuleModal;
