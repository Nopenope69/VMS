import React, { useState, useEffect } from 'react';
import { X, Bell, Plus, Trash2, Send, ShieldCheck, RefreshCw, Key, RotateCcw } from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';
import Input from './ui/Input';

interface NotificationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ChannelType = 'WEBHOOK' | 'SLACK' | 'EMAIL' | 'WHATSAPP' | 'SMS';

interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  targetUrl: string;
  /** The API never returns secrets, only whether one is stored. */
  secretTokenSet?: boolean;
  configJson?: Record<string, any>;
  minSeverity: 'INFO' | 'WARNING' | 'CRITICAL';
  enabled: boolean;
  createdAt: string;
}

interface ConfigField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  numeric?: boolean;
  options?: Array<[string, string]>;
}

const RATE_FIELD: ConfigField = { key: 'ratePerMinute', label: 'Max messages per minute', placeholder: '10', numeric: true };

/** Mirrors backend channelConfig.ts. Secret fields are write-only: leave blank to keep the stored value. */
const CONFIG_FIELDS: Record<ChannelType, ConfigField[]> = {
  WEBHOOK: [RATE_FIELD],
  SLACK: [RATE_FIELD],
  EMAIL: [
    { key: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.enterprise.com', required: true },
    { key: 'smtpPort', label: 'SMTP port', placeholder: '587', required: true, numeric: true },
    {
      key: 'security',
      label: 'Transport security',
      options: [
        ['starttls', 'STARTTLS (required, port 587)'],
        ['tls', 'Implicit TLS (port 465)'],
        ['none', 'None (local relay only, no credentials)'],
      ],
    },
    { key: 'from', label: 'From', placeholder: 'VigilOne <alerts@enterprise.com>', required: true },
    { key: 'username', label: 'SMTP username' },
    { key: 'password', label: 'SMTP password', secret: true },
    { key: 'rejectUnauthorized', label: 'Certificate check', options: [['true', 'Verify relay certificate'], ['false', 'Do not verify (self-signed relay)']] },
    RATE_FIELD,
  ],
  WHATSAPP: [
    { key: 'phoneNumberId', label: 'Phone number ID', placeholder: 'WhatsApp Business phone number id', required: true },
    { key: 'accessToken', label: 'Access token', secret: true, required: true },
    { key: 'templateName', label: 'Approved template name', placeholder: 'vigilone_alarm (params: severity, title, camera, time)', required: true },
    { key: 'languageCode', label: 'Template language', placeholder: 'en' },
    { key: 'appSecret', label: 'App secret (verifies delivery receipts)', secret: true },
    { key: 'verifyToken', label: 'Webhook verify token', secret: true },
    RATE_FIELD,
  ],
  SMS: [
    { key: 'providerUrl', label: 'Gateway URL (https)', placeholder: 'https://sms-gateway.example/v1/send', required: true },
    { key: 'apiKey', label: 'Gateway API key', secret: true, required: true },
    { key: 'senderId', label: 'Sender ID', placeholder: 'VIGIL1' },
    RATE_FIELD,
  ],
};

export const NotificationSettingsModal: React.FC<NotificationSettingsModalProps> = ({ isOpen, onClose }) => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'channels' | 'logs' | 'deadletters'>('channels');
  const [deadLetters, setDeadLetters] = useState<any[]>([]);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [channelToDelete, setChannelToDelete] = useState<string | null>(null);

  // New Channel Form
  const [isAdding, setIsAdding] = useState<boolean>(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ChannelType>('WEBHOOK');
  const [newConfig, setNewConfig] = useState<Record<string, string>>({});
  const setCfg = (k: string, v: string) => setNewConfig((c) => ({ ...c, [k]: v }));
  const [newTargetUrl, setNewTargetUrl] = useState('');
  const [newSecretToken, setNewSecretToken] = useState('');
  const [newMinSeverity, setNewMinSeverity] = useState<'INFO' | 'WARNING' | 'CRITICAL'>('WARNING');

  const fetchChannels = async () => {
    try {
      const res = await api.get('/notifications/channels');
      setChannels(res.data.channels || []);
    } catch (err: any) {
      console.error('Failed to load notification channels:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await api.get('/notifications/logs');
      setLogs(res.data.logs || []);
    } catch (err) {
      console.error('Failed to load notification logs:', err);
    }
  };

  const fetchDeadLetters = async () => {
    try {
      const res = await api.get('/notifications/dead-letters');
      setDeadLetters(res.data.jobs || []);
    } catch (err) {
      console.error('Failed to load dead-lettered notifications:', err);
    }
  };

  const handleRetry = async (jobId: string) => {
    try {
      await api.post(`/notifications/jobs/${jobId}/retry`);
      setActionNotice({ type: 'success', message: 'Notification requeued; it is sent on the next queue run.' });
      fetchDeadLetters();
    } catch (err: any) {
      setActionNotice({ type: 'error', message: err.response?.data?.error || 'Failed to requeue notification.' });
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchChannels();
      fetchLogs();
      fetchDeadLetters();
    }
  }, [isOpen]);

  /** configJson for the selected type; empty strings are dropped, numbers parsed. */
  const buildConfig = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(newConfig)) {
      if (v === '') continue;
      c[k] = k === 'smtpPort' || k === 'ratePerMinute' ? Number(v) : v;
    }
    if (newType === 'EMAIL') {
      c.security = c.security || 'starttls';
      if (newConfig.rejectUnauthorized === 'false') c.rejectUnauthorized = false;
      else delete c.rejectUnauthorized;
    }
    const allowed: Record<ChannelType, string[]> = {
      WEBHOOK: ['ratePerMinute'],
      SLACK: ['ratePerMinute'],
      EMAIL: ['smtpHost', 'smtpPort', 'security', 'username', 'password', 'from', 'rejectUnauthorized', 'ratePerMinute'],
      WHATSAPP: ['phoneNumberId', 'accessToken', 'templateName', 'languageCode', 'apiVersion', 'appSecret', 'verifyToken', 'ratePerMinute'],
      SMS: ['providerUrl', 'apiKey', 'senderId', 'ratePerMinute'],
    };
    return Object.fromEntries(Object.entries(c).filter(([k]) => allowed[newType].includes(k)));
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newTargetUrl) return;

    try {
      await api.post('/notifications/channels', {
        name: newName,
        type: newType,
        targetUrl: newTargetUrl,
        secretToken: newType === 'WEBHOOK' ? newSecretToken || undefined : undefined,
        configJson: buildConfig(),
        minSeverity: newMinSeverity,
        enabled: true,
      });
      setActionNotice({ type: 'success', message: `Channel '${newName}' created successfully.` });
      setIsAdding(false);
      setNewName('');
      setNewTargetUrl('');
      setNewSecretToken('');
      setNewConfig({});
      fetchChannels();
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: err.response?.data?.error || 'Failed to create notification channel.',
      });
    }
  };

  const handleDeleteChannel = async (id: string) => {
    try {
      await api.delete(`/notifications/channels/${id}`);
      setChannelToDelete(null);
      fetchChannels();
      setActionNotice({ type: 'success', message: 'Channel deleted.' });
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: err.response?.data?.error || 'Failed to delete channel.',
      });
    }
  };

  const handleTestPing = async (id: string, name: string) => {
    try {
      setActionNotice(null);
      const res = await api.post(`/notifications/channels/${id}/test`);
      // The endpoint answers 200 with the dispatch result: only success=true is a delivery.
      if (res.data.success) {
        const ids = (res.data.receipts || []).map((r: any) => r.providerMessageId).filter(Boolean);
        setActionNotice({
          type: 'success',
          message: `Test to '${name}' accepted by the provider (code ${res.data.statusCode}, ${res.data.latencyMs} ms${ids.length ? `, receipt ${ids.join(', ')}` : ''})`,
        });
      } else {
        setActionNotice({ type: 'error', message: `Test to '${name}' failed: ${res.data.error || `code ${res.data.statusCode}`}` });
      }
      fetchLogs();
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: `Test ping failed: ${err.response?.data?.error || err.message}`,
      });
      fetchLogs();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notification-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none"
    >
      <div className="bg-vms-elevated border border-vms-border w-full max-w-4xl max-h-[85vh] rounded shadow-2xl flex flex-col overflow-hidden text-vms-text font-sans">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-vms-border flex items-center justify-between bg-vms-panel">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-vms-accent/20 border border-vms-accent/40 text-vms-accent">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <h2 id="notification-modal-title" className="text-xs font-bold tracking-wider uppercase font-mono text-vms-text">
                Outbound Notification Channels
              </h2>
              <p className="text-[11px] text-vms-muted font-mono">
                Signed webhooks, Slack, SMTP email, WhatsApp and SMS, with delivery receipts
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-surface transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Notice */}
        {actionNotice && (
          <div
            className={`px-4 py-2 text-xs flex items-center justify-between font-mono ${
              actionNotice.type === 'success'
                ? 'bg-emerald-950/70 text-emerald-300 border-b border-emerald-800'
                : 'bg-rose-950/70 text-rose-300 border-b border-rose-800'
            }`}
          >
            <span>{actionNotice.message}</span>
            <button onClick={() => setActionNotice(null)} className="text-xs text-vms-muted hover:text-vms-text ml-2">
              Dismiss
            </button>
          </div>
        )}

        {/* Tab Controls */}
        <div className="flex border-b border-vms-border bg-vms-surface px-5 pt-2 justify-between items-center">
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('channels')}
              className={`py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
                activeTab === 'channels'
                  ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                  : 'border-transparent text-vms-muted hover:text-vms-text'
              }`}
            >
              Configured Channels ({channels.length})
            </button>
            <button
              onClick={() => {
                setActiveTab('logs');
                fetchLogs();
              }}
              className={`py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
                activeTab === 'logs'
                  ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                  : 'border-transparent text-vms-muted hover:text-vms-text'
              }`}
            >
              Dispatch Audit Logs ({logs.length})
            </button>
            <button
              onClick={() => {
                setActiveTab('deadletters');
                fetchDeadLetters();
              }}
              className={`py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
                activeTab === 'deadletters'
                  ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                  : 'border-transparent text-vms-muted hover:text-vms-text'
              }`}
            >
              Dead Letters ({deadLetters.length})
            </button>
          </div>

          {activeTab === 'channels' && !isAdding && (
            <Button
              variant="primary"
              size="xs"
              icon={Plus}
              onClick={() => setIsAdding(true)}
            >
              Add Channel
            </Button>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'channels' ? (
            <div className="space-y-4">
              {/* Add Channel Form */}
              {isAdding && (
                <form
                  onSubmit={handleCreateChannel}
                  className="bg-vms-panel border border-vms-accent/40 rounded p-4 space-y-3 mb-4"
                >
                  <div className="flex justify-between items-center border-b border-vms-border pb-2">
                    <span className="text-xs font-bold text-vms-accent uppercase font-mono tracking-wider">
                      New Dispatch Channel
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsAdding(false)}
                      className="text-xs text-vms-muted hover:text-vms-text font-mono"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                        Channel Name
                      </label>
                      <Input
                        required
                        placeholder="e.g. SecOps PagerDuty Webhook"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                        Channel Type
                      </label>
                      <select
                        value={newType}
                        onChange={(e) => {
                          setNewType(e.target.value as ChannelType);
                          setNewConfig({});
                        }}
                        className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
                      >
                        <option value="WEBHOOK">Webhook (JSON + HMAC-SHA256 Signature)</option>
                        <option value="SLACK">Slack Incoming Webhook</option>
                        <option value="EMAIL">Email (SMTP relay)</option>
                        <option value="WHATSAPP">WhatsApp Business Cloud API (template)</option>
                        <option value="SMS">SMS (HTTPS gateway)</option>
                      </select>
                    </div>

                    <div className="md:col-span-2">
                      <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                        {newType === 'EMAIL'
                          ? 'Recipient Addresses (comma-separated)'
                          : newType === 'WHATSAPP' || newType === 'SMS'
                          ? 'Recipient Numbers, E.164 (comma-separated)'
                          : 'Endpoint URL'}
                      </label>
                      <Input
                        required
                        placeholder={
                          newType === 'EMAIL'
                            ? 'ops-team@enterprise.com, guard@enterprise.com'
                            : newType === 'WHATSAPP' || newType === 'SMS'
                            ? '+919812345678, +919876543210'
                            : 'https://hooks.slack.com/services/... or https://api.alert.com/webhook'
                        }
                        value={newTargetUrl}
                        onChange={(e) => setNewTargetUrl(e.target.value)}
                        className="w-full text-xs font-mono"
                      />
                    </div>

                    {CONFIG_FIELDS[newType].map((f) => (
                      <div key={f.key}>
                        <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                          {f.label}
                          {f.required ? ' *' : ''}
                        </label>
                        {f.options ? (
                          <select
                            value={newConfig[f.key] ?? f.options[0][0]}
                            onChange={(e) => setCfg(f.key, e.target.value)}
                            className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
                          >
                            {f.options.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            required={f.required}
                            type={f.secret ? 'password' : f.numeric ? 'number' : 'text'}
                            placeholder={f.placeholder}
                            value={newConfig[f.key] ?? ''}
                            onChange={(e) => setCfg(f.key, e.target.value)}
                            className="w-full text-xs font-mono"
                          />
                        )}
                      </div>
                    ))}

                    {newType === 'WEBHOOK' && (
                    <div>
                      <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                        HMAC Secret Token (Optional Signing Key)
                      </label>
                      <div className="relative">
                        <Input
                          type="password"
                          placeholder="Secret key for X-VigilOne-Signature"
                          value={newSecretToken}
                          onChange={(e) => setNewSecretToken(e.target.value)}
                          className="w-full text-xs font-mono"
                        />
                        <Key className="w-3.5 h-3.5 text-vms-dim absolute right-2.5 top-2.5" />
                      </div>
                    </div>
                    )}

                    <div>
                      <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                        Minimum Severity Trigger
                      </label>
                      <select
                        value={newMinSeverity}
                        onChange={(e) => setNewMinSeverity(e.target.value as any)}
                        className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
                      >
                        <option value="INFO">INFO (All Alarms & Status Changes)</option>
                        <option value="WARNING">WARNING (Priority Incidents)</option>
                        <option value="CRITICAL">CRITICAL Only (Watchlist Hits & Breaches)</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                    >
                      Save Channel
                    </Button>
                  </div>
                </form>
              )}

              {/* Channels List */}
              <div className="divide-y divide-vms-border border border-vms-border rounded overflow-hidden bg-vms-panel">
                {channels.length === 0 ? (
                  <div className="p-8 text-center text-vms-dim font-mono text-xs">
                    No notification channels configured yet. Click "Add Channel" to setup webhooks or Slack alerts.
                  </div>
                ) : (
                  channels.map((chan) => (
                    <div key={chan.id} className="p-3.5 flex items-center justify-between hover:bg-vms-surface/60 transition-colors text-xs">
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-vms-text font-mono">{chan.name}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-400 font-mono">
                            {chan.type}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-vms-surface text-vms-muted font-mono border border-vms-border">
                            Min: {chan.minSeverity}
                          </span>
                          {chan.secretTokenSet && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono flex items-center space-x-1">
                              <ShieldCheck className="w-3 h-3" />
                              <span>HMAC Signed</span>
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-vms-muted truncate max-w-md">
                          {chan.targetUrl}
                        </div>
                      </div>

                      <div className="flex items-center space-x-2">
                        <Button
                          variant="secondary"
                          size="xs"
                          icon={Send}
                          onClick={() => handleTestPing(chan.id, chan.name)}
                          title="Dispatch test payload"
                        >
                          Test Ping
                        </Button>
                        {channelToDelete === chan.id ? (
                          <div className="flex items-center space-x-1">
                            <button
                              type="button"
                              onClick={() => handleDeleteChannel(chan.id)}
                              className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setChannelToDelete(null)}
                              className="px-1 py-0.5 text-vms-muted text-[10px]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setChannelToDelete(chan.id)}
                            className="p-1.5 rounded hover:bg-rose-900/40 text-vms-dim hover:text-rose-400 transition-colors"
                            title="Delete channel"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : activeTab === 'deadletters' ? (
            <div className="border border-vms-border rounded overflow-hidden bg-vms-panel">
              <div className="px-4 py-2 border-b border-vms-border bg-vms-surface flex justify-between items-center text-xs font-semibold text-vms-text font-mono uppercase tracking-wider">
                <span>Undelivered Notifications</span>
                <button onClick={fetchDeadLetters} className="p-1 text-vms-muted hover:text-vms-text transition-colors" aria-label="Refresh dead letters">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="divide-y divide-vms-border max-h-[380px] overflow-y-auto">
                {deadLetters.length === 0 ? (
                  <div className="p-8 text-center text-vms-dim font-mono text-xs">No dead-lettered notifications.</div>
                ) : (
                  deadLetters.map((job) => (
                    <div key={job.id} className="p-3 text-xs flex items-center justify-between">
                      <div className="space-y-0.5">
                        <div className="flex items-center space-x-2">
                          <span className="w-2 h-2 rounded-full bg-rose-500" />
                          <span className="font-semibold text-vms-text font-mono">{job.channel?.name}</span>
                          <span className="font-mono text-[10px] text-vms-muted">
                            {job.channel?.type} • {job.attempts}/{job.maxAttempts} attempts
                            {job.escalationStep !== null && job.escalationStep !== undefined ? ` • escalation step ${job.escalationStep}` : ''}
                          </span>
                        </div>
                        <div className="text-[11px] text-rose-400 font-mono">{job.error}</div>
                        <div className="text-[10px] text-vms-dim font-mono">
                          alarm {job.alarmId} • {job.processedAt ? new Date(job.processedAt).toLocaleString() : ''}
                        </div>
                      </div>
                      <Button variant="secondary" size="xs" icon={RotateCcw} onClick={() => handleRetry(job.id)}>
                        Retry
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Logs Tab */
            <div className="border border-vms-border rounded overflow-hidden bg-vms-panel">
              <div className="px-4 py-2 border-b border-vms-border bg-vms-surface flex justify-between items-center text-xs font-semibold text-vms-text font-mono uppercase tracking-wider">
                <span>Recent Dispatch Attempts</span>
                <button onClick={fetchLogs} className="p-1 text-vms-muted hover:text-vms-text transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-vms-border max-h-[380px] overflow-y-auto">
                {logs.length === 0 ? (
                  <div className="p-8 text-center text-vms-dim font-mono text-xs">
                    No dispatch log entries recorded.
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="p-3 hover:bg-vms-surface/40 text-xs flex items-center justify-between transition-colors">
                      <div className="space-y-0.5">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              log.status === 'DELIVERED'
                                ? 'bg-emerald-400'
                                : log.status === 'DEAD_LETTER'
                                ? 'bg-rose-500'
                                : 'bg-amber-400'
                            }`}
                          />
                          <span className="font-semibold text-vms-text font-mono">
                            {log.channel?.name || 'Channel ' + log.channelId}
                          </span>
                          <span className="font-mono text-[10px] text-vms-muted">
                            {log.status} • code {log.responseCode ?? 'N/A'} • {log.latencyMs ?? 0} ms
                          </span>
                          {log.deliveryStatus && (
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-vms-surface border border-vms-border text-vms-muted">
                              receipt: {log.deliveryStatus}
                            </span>
                          )}
                        </div>
                        {log.providerMessageId && (
                          <div className="text-[10px] text-vms-dim font-mono truncate max-w-md">id {log.providerMessageId}</div>
                        )}
                        {log.error && <div className="text-[11px] text-rose-400 font-mono">{log.error}</div>}
                      </div>
                      <div className="text-[10px] font-mono text-vms-dim">
                        {new Date(log.dispatchedAt).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NotificationSettingsModal;
