import React, { useState, useEffect } from 'react';
import {
  X,
  Trash2,
  Plus,
  Zap,
} from 'lucide-react';
import api from '../services/api';

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
      fetchRulesAndHistory();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save automation rule');
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('Are you sure you want to delete this automation rule?')) return;
    try {
      await api.delete(`/automation/rules/${id}`);
      fetchRulesAndHistory();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete rule');
    }
  };

  const handleToggleRule = async (rule: any) => {
    try {
      await api.put(`/automation/rules/${rule.id}`, {
        enabled: !rule.enabled,
      });
      fetchRulesAndHistory();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update rule');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 font-sans text-slate-100">
      <div className="bg-graphite-900 border border-graphite-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-graphite-700 flex items-center justify-between bg-graphite-850">
          <div className="flex items-center space-x-2">
            <Zap className="w-5 h-5 text-cctv-amber" />
            <div>
              <h2 className="text-base font-bold tracking-wider uppercase text-slate-100">
                Event-Action Automation Matrix
              </h2>
              <p className="text-[11px] font-mono text-slate-400">
                Deterministic cross-subsystem rule engine with cooldown suppression & execution audits
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="flex border-b border-graphite-700 bg-graphite-850 px-6 space-x-2">
          <button
            onClick={() => setActiveTab('rules')}
            className={`py-2 px-3 text-xs font-semibold border-b-2 transition ${
              activeTab === 'rules'
                ? 'border-cctv-amber text-cctv-amber'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Active Rules ({rules.length})
          </button>
          <button
            onClick={() => setActiveTab('create')}
            className={`py-2 px-3 text-xs font-semibold border-b-2 transition ${
              activeTab === 'create'
                ? 'border-cctv-amber text-cctv-amber'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            + Create Automation Rule
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`py-2 px-3 text-xs font-semibold border-b-2 transition ${
              activeTab === 'history'
                ? 'border-cctv-amber text-cctv-amber'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Audit Trail / Executions
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {activeTab === 'rules' && (
            <div className="space-y-3">
              {rules.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-mono text-xs">
                  No automation rules configured. Click &quot;Create Automation Rule&quot; to build deterministic edge actions.
                </div>
              ) : (
                rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="p-4 bg-graphite-800 border border-graphite-700 rounded-lg flex items-center justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-bold text-slate-200">{rule.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal font-mono border border-cctv-teal/40">
                          {rule.triggerType}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-graphite-700 text-slate-400 font-mono">
                          Cooldown: {rule.cooldownSeconds}s
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-graphite-700 text-slate-400 font-mono">
                          Priority: #{rule.priority}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">{rule.description || 'No description provided'}</p>
                      <div className="flex items-center space-x-2 text-[11px] font-mono text-slate-400 pt-1">
                        <span className="text-slate-500">Actions:</span>
                        {(rule.actionsJson || []).map((act: any, idx: number) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.5 rounded bg-graphite-900 border border-graphite-700 text-cctv-amber"
                          >
                            {act.type}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center space-x-3">
                      <button
                        onClick={() => handleToggleRule(rule)}
                        className={`px-3 py-1 rounded text-xs font-mono font-bold transition ${
                          rule.enabled
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30'
                            : 'bg-graphite-700 text-slate-400 border border-graphite-600 hover:bg-graphite-600'
                        }`}
                      >
                        {rule.enabled ? 'ENABLED' : 'DISABLED'}
                      </button>
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="p-1.5 rounded hover:bg-graphite-700 text-slate-400 hover:text-rose-400 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
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
                  <label className="block text-slate-400 mb-1">Rule Name</label>
                  <input
                    type="text"
                    placeholder="e.g. South Gate Breach Alert"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Trigger Event</label>
                  <select
                    value={triggerType}
                    onChange={(e) => setTriggerType(e.target.value)}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
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
                <label className="block text-slate-400 mb-1">Description / Notes</label>
                <input
                  type="text"
                  placeholder="Automated dispatch, siren strobe and high-res recording trigger"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Cooldown Timer (Seconds - Suppress feedback cascades)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    value={cooldownSeconds}
                    onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Execution Priority (Lowest number first)</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  />
                </div>
              </div>

              {/* Actions Builder */}
              <div className="pt-2 border-t border-graphite-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-cctv-amber">Cascading Actions Pipeline</span>
                  <button
                    type="button"
                    onClick={handleAddAction}
                    className="flex items-center space-x-1 text-cctv-teal hover:underline font-mono"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Action Step</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {actions.map((act, index) => (
                    <div
                      key={act.id || index}
                      className="p-3 bg-graphite-800 border border-graphite-700 rounded flex items-center space-x-3"
                    >
                      <div className="w-6 h-6 rounded-full bg-graphite-700 flex items-center justify-center font-mono font-bold text-slate-400">
                        {index + 1}
                      </div>

                      <div className="flex-1 grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Action Type</label>
                          <select
                            value={act.type}
                            onChange={(e) => {
                              const updated = [...actions];
                              updated[index].type = e.target.value;
                              setActions(updated);
                            }}
                            className="w-full bg-graphite-900 border border-graphite-600 rounded p-1.5 font-mono text-slate-200"
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
                          <label className="block text-[10px] text-slate-400 mb-1">Timeout (ms)</label>
                          <input
                            type="number"
                            step="500"
                            value={act.timeoutMs || 3000}
                            onChange={(e) => {
                              const updated = [...actions];
                              updated[index].timeoutMs = Number(e.target.value);
                              setActions(updated);
                            }}
                            className="w-full bg-graphite-900 border border-graphite-600 rounded p-1.5 font-mono text-slate-200"
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
                            className="rounded bg-graphite-900 border-graphite-600 text-cctv-amber"
                          />
                          <label htmlFor={`continue_${index}`} className="text-[10px] text-slate-300">
                            Continue on failure
                          </label>
                        </div>
                      </div>

                      {actions.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveAction(index)}
                          className="p-1 rounded text-slate-400 hover:text-rose-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t border-graphite-800">
                <button
                  type="button"
                  onClick={() => setActiveTab('rules')}
                  className="px-4 py-2 rounded bg-graphite-800 text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-cctv-amber text-graphite-900 font-bold hover:bg-amber-400"
                >
                  Deploy Automation Rule
                </button>
              </div>
            </form>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="text-xs font-mono text-slate-400 mb-2">
                Recent Rule Executions & Action Latency Trajectory
              </div>
              <div className="divide-y divide-graphite-800">
                {executions.length === 0 ? (
                  <div className="text-center py-10 text-slate-500 font-mono text-xs">
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
                            <span className="font-mono text-xs font-bold text-slate-200">
                              {exec.rule?.name || 'Rule'}
                            </span>
                            <span className="font-mono text-[10px] text-slate-500">{exec.id}</span>
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
                          <span className="font-mono text-[10px] text-slate-400">
                            {new Date(exec.triggeredAt).toLocaleString()}
                          </span>
                        </div>

                        {/* Action Steps Breakdown */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                          {(exec.actionRecords || []).map((step: any) => (
                            <div
                              key={step.id}
                              className="p-2 bg-graphite-850 rounded border border-graphite-750 text-[10px] font-mono flex items-center justify-between"
                            >
                              <span className="text-slate-300">{step.actionType}</span>
                              <div className="flex items-center space-x-1.5">
                                <span className="text-slate-500">{step.durationMs}ms</span>
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
    </div>
  );
};

export default EventActionRuleModal;
