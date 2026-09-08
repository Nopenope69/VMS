import React, { useState, useEffect } from 'react';
import { X, Bell, Plus, Trash2, Send, ShieldCheck, RefreshCw, Key } from 'lucide-react';
import api from '../services/api';

interface NotificationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Channel {
  id: string;
  name: string;
  type: 'WEBHOOK' | 'SLACK' | 'EMAIL';
  targetUrl: string;
  secretToken?: string;
  minSeverity: 'INFO' | 'WARNING' | 'CRITICAL';
  enabled: boolean;
  createdAt: string;
}

export const NotificationSettingsModal: React.FC<NotificationSettingsModalProps> = ({ isOpen, onClose }) => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'channels' | 'logs'>('channels');
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New Channel Form
  const [isAdding, setIsAdding] = useState<boolean>(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'WEBHOOK' | 'SLACK' | 'EMAIL'>('WEBHOOK');
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

  useEffect(() => {
    if (isOpen) {
      fetchChannels();
      fetchLogs();
    }
  }, [isOpen]);

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newTargetUrl) return;

    try {
      await api.post('/notifications/channels', {
        name: newName,
        type: newType,
        targetUrl: newTargetUrl,
        secretToken: newSecretToken || undefined,
        minSeverity: newMinSeverity,
        enabled: true,
      });
      setActionNotice({ type: 'success', message: `Channel '${newName}' created successfully.` });
      setIsAdding(false);
      setNewName('');
      setNewTargetUrl('');
      setNewSecretToken('');
      fetchChannels();
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: err.response?.data?.error || 'Failed to create notification channel.',
      });
    }
  };

  const handleDeleteChannel = async (id: string) => {
    if (!window.confirm('Delete this notification channel?')) return;
    try {
      await api.delete(`/notifications/channels/${id}`);
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
      setActionNotice({
        type: 'success',
        message: `Test ping to '${name}' succeeded (HTTP ${res.data.statusCode}, ${res.data.durationMs}ms)`,
      });
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="bg-graphite-850 border border-graphite-700 w-full max-w-4xl max-h-[85vh] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex items-center justify-between bg-graphite-900">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-cctv-amber/20 border border-cctv-amber/40 text-cctv-amber">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-wide uppercase">Outbound Notification Channels</h2>
              <p className="text-[11px] text-slate-400 font-mono">
                HMAC-SHA256 Authenticated Webhooks, Slack Alerts & SMTP Dispatch
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Notice */}
        {actionNotice && (
          <div
            className={`px-4 py-2 text-xs flex items-center justify-between ${
              actionNotice.type === 'success'
                ? 'bg-emerald-950/70 text-emerald-300 border-b border-emerald-800'
                : 'bg-rose-950/70 text-rose-300 border-b border-rose-800'
            }`}
          >
            <span>{actionNotice.message}</span>
            <button onClick={() => setActionNotice(null)} className="text-xs opacity-60 hover:opacity-100">
              Dismiss
            </button>
          </div>
        )}

        {/* Tab Controls */}
        <div className="flex border-b border-graphite-700 bg-graphite-850 px-5 pt-2 justify-between items-center">
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('channels')}
              className={`py-2 px-4 text-xs font-semibold border-b-2 transition ${
                activeTab === 'channels'
                  ? 'border-cctv-amber text-cctv-amber bg-graphite-800/50'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Configured Channels ({channels.length})
            </button>
            <button
              onClick={() => {
                setActiveTab('logs');
                fetchLogs();
              }}
              className={`py-2 px-4 text-xs font-semibold border-b-2 transition ${
                activeTab === 'logs'
                  ? 'border-cctv-amber text-cctv-amber bg-graphite-800/50'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Dispatch Audit Logs ({logs.length})
            </button>
          </div>

          {activeTab === 'channels' && !isAdding && (
            <button
              onClick={() => setIsAdding(true)}
              className="flex items-center space-x-1 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Channel</span>
            </button>
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
                  className="bg-graphite-900 border border-cctv-amber/40 rounded-lg p-4 space-y-3 mb-4"
                >
                  <div className="flex justify-between items-center border-b border-graphite-700 pb-2">
                    <span className="text-xs font-bold text-cctv-amber uppercase">New Dispatch Channel</span>
                    <button
                      type="button"
                      onClick={() => setIsAdding(false)}
                      className="text-xs text-slate-400 hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">Channel Name</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. SecOps PagerDuty Webhook"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full bg-graphite-800 border border-graphite-700 rounded px-2.5 py-1.5 text-slate-100 focus:border-cctv-amber focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">Channel Type</label>
                      <select
                        value={newType}
                        onChange={(e) => setNewType(e.target.value as any)}
                        className="w-full bg-graphite-800 border border-graphite-700 rounded px-2.5 py-1.5 text-slate-100 focus:border-cctv-amber focus:outline-none"
                      >
                        <option value="WEBHOOK">Webhook (JSON + HMAC-SHA256 Signature)</option>
                        <option value="SLACK">Slack Incoming Webhook</option>
                        <option value="EMAIL">SMTP Email Notification</option>
                      </select>
                    </div>

                    <div className="md:col-span-2">
                      <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">
                        Endpoint URL or Recipient Address
                      </label>
                      <input
                        type="text"
                        required
                        placeholder={
                          newType === 'EMAIL'
                            ? 'ops-team@enterprise.com'
                            : 'https://hooks.slack.com/services/... or https://api.alert.com/webhook'
                        }
                        value={newTargetUrl}
                        onChange={(e) => setNewTargetUrl(e.target.value)}
                        className="w-full bg-graphite-800 border border-graphite-700 rounded px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-cctv-amber focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">
                        HMAC Secret Token (Optional Signing Key)
                      </label>
                      <div className="relative">
                        <input
                          type="password"
                          placeholder="Secret key for X-VigilOne-Signature"
                          value={newSecretToken}
                          onChange={(e) => setNewSecretToken(e.target.value)}
                          className="w-full bg-graphite-800 border border-graphite-700 rounded px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-cctv-amber focus:outline-none"
                        />
                        <Key className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-2.5" />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">
                        Minimum Severity Trigger
                      </label>
                      <select
                        value={newMinSeverity}
                        onChange={(e) => setNewMinSeverity(e.target.value as any)}
                        className="w-full bg-graphite-800 border border-graphite-700 rounded px-2.5 py-1.5 text-slate-100 focus:border-cctv-amber focus:outline-none"
                      >
                        <option value="INFO">INFO (All Alarms & Status Changes)</option>
                        <option value="WARNING">WARNING (Priority Incidents)</option>
                        <option value="CRITICAL">CRITICAL Only (Watchlist Hits & Breaches)</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      className="px-4 py-1.5 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition"
                    >
                      Save Channel
                    </button>
                  </div>
                </form>
              )}

              {/* Channels List */}
              <div className="divide-y divide-graphite-700 border border-graphite-700 rounded-lg overflow-hidden bg-graphite-900">
                {channels.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 font-mono text-xs">
                    No notification channels configured yet. Click "Add Channel" to setup webhooks or Slack alerts.
                  </div>
                ) : (
                  channels.map((chan) => (
                    <div key={chan.id} className="p-3.5 flex items-center justify-between hover:bg-graphite-800/60 transition text-xs">
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-slate-100">{chan.name}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 font-mono">
                            {chan.type}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-graphite-800 text-slate-300 font-mono">
                            Min: {chan.minSeverity}
                          </span>
                          {chan.secretToken && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono flex items-center space-x-1">
                              <ShieldCheck className="w-3 h-3" />
                              <span>HMAC Signed</span>
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 truncate max-w-md">
                          {chan.targetUrl}
                        </div>
                      </div>

                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleTestPing(chan.id, chan.name)}
                          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 text-[11px] font-semibold transition"
                          title="Dispatch test payload"
                        >
                          <Send className="w-3 h-3" />
                          <span>Test Ping</span>
                        </button>
                        <button
                          onClick={() => handleDeleteChannel(chan.id)}
                          className="p-1.5 rounded hover:bg-rose-900/40 text-slate-400 hover:text-rose-400 transition"
                          title="Delete channel"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Logs Tab */
            <div className="border border-graphite-700 rounded-lg overflow-hidden bg-graphite-900">
              <div className="px-4 py-2 border-b border-graphite-700 bg-graphite-850 flex justify-between items-center text-xs font-semibold text-slate-300">
                <span>Recent Dispatch Attempts</span>
                <button onClick={fetchLogs} className="p-1 text-slate-400 hover:text-white">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-graphite-800 max-h-[380px] overflow-y-auto">
                {logs.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 font-mono text-xs">
                    No dispatch log entries recorded.
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="p-3 hover:bg-graphite-800/40 text-xs flex items-center justify-between">
                      <div className="space-y-0.5">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              log.status === 'SENT'
                                ? 'bg-emerald-400'
                                : log.status === 'DEAD_LETTER'
                                ? 'bg-rose-500'
                                : 'bg-amber-400'
                            }`}
                          />
                          <span className="font-semibold text-slate-200">
                            {log.channel?.name || 'Channel ' + log.channelId}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">
                            HTTP {log.responseStatus || 'N/A'} • {log.durationMs || 0}ms
                          </span>
                        </div>
                        {log.errorMessage && (
                          <div className="text-[11px] text-rose-400 font-mono">{log.errorMessage}</div>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
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
