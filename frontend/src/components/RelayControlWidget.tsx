import React, { useState, useEffect } from 'react';
import {
  Zap,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RotateCcw,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  AlertCircle,
} from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';
import Input from './ui/Input';

interface DigitalPin {
  id: string;
  pinNumber: number;
  name: string;
  direction: 'INPUT' | 'OUTPUT';
  state: 'HIGH' | 'LOW';
  activeLow: boolean;
  pulseDurationMs: number;
  lastStateChangeAt: string;
}

interface RelayLog {
  id: string;
  pin: { pinNumber: number; name: string };
  command: string;
  targetState: string;
  lifecycleState: 'COMMAND_SENT' | 'COMMAND_ACK' | 'STATE_CONFIRMED' | 'COMMAND_FAILED';
  sentAt: string;
  confirmedAt?: string;
  errorMessage?: string;
}

export const RelayControlWidget: React.FC = () => {
  const [pins, setPins] = useState<DigitalPin[]>([]);
  const [logs, setLogs] = useState<RelayLog[]>([]);
  const [triggeringPin, setTriggeringPin] = useState<number | null>(null);
  const [showAddPin, setShowAddPin] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [newPin, setNewPin] = useState({
    pinNumber: 1,
    name: '',
    direction: 'OUTPUT' as 'INPUT' | 'OUTPUT',
    activeLow: false,
    pulseDurationMs: 3000,
  });

  const fetchData = async () => {
    try {
      const [pinsRes, logsRes] = await Promise.all([
        api.get('/relays/pins'),
        api.get('/relays/logs?limit=10'),
      ]);
      setPins(pinsRes.data.pins || []);
      setLogs(logsRes.data.logs || []);
    } catch (err) {
      console.error('Failed to load relay data', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleTrigger = async (pinNumber: number, command: 'SET_HIGH' | 'SET_LOW' | 'PULSE') => {
    setTriggeringPin(pinNumber);
    setErrorNotice(null);
    try {
      await api.post('/relays/trigger', {
        pinNumber,
        command,
        pulseDurationMs: 3000,
      });
      await fetchData();
    } catch (err: any) {
      setErrorNotice(err.response?.data?.error || 'Relay command execution failed');
    } finally {
      setTriggeringPin(null);
    }
  };

  const handleCreatePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    try {
      await api.post('/relays/pins', newPin);
      setShowAddPin(false);
      setNewPin({
        pinNumber: pins.length + 1,
        name: '',
        direction: 'OUTPUT',
        activeLow: false,
        pulseDurationMs: 3000,
      });
      fetchData();
    } catch (err: any) {
      setErrorNotice(err.response?.data?.error || 'Failed to configure pin');
    }
  };

  const inputPins = pins.filter((p) => p.direction === 'INPUT');
  const outputPins = pins.filter((p) => p.direction === 'OUTPUT');

  return (
    <div className="bg-vms-surface border border-vms-border rounded p-4 font-sans text-vms-text select-none">
      <div className="flex items-center justify-between border-b border-vms-border pb-3 mb-4">
        <div className="flex items-center space-x-2">
          <Zap className="w-5 h-5 text-vms-accent" />
          <h3 className="font-bold text-xs uppercase tracking-wider text-vms-text font-mono">
            Physical Digital I/O & Relay Matrix
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-vms-panel border border-vms-border font-mono text-sky-400">
            Multi-Stage Hardware Handshake
          </span>
        </div>
        <Button
          variant="secondary"
          size="xs"
          icon={Plus}
          onClick={() => setShowAddPin(!showAddPin)}
        >
          Configure Pin
        </Button>
      </div>

      {errorNotice && (
        <div className="mb-4 p-2.5 rounded bg-rose-950/70 border border-rose-800 text-xs font-mono text-rose-300 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorNotice}</span>
          </div>
          <button type="button" onClick={() => setErrorNotice(null)} className="text-vms-muted hover:text-vms-text ml-2">
            ×
          </button>
        </div>
      )}

      {showAddPin && (
        <form onSubmit={handleCreatePin} className="mb-4 p-3.5 bg-vms-panel border border-vms-border rounded text-xs space-y-3">
          <div className="font-semibold text-vms-accent font-mono uppercase text-xs tracking-wider">Register Hardware I/O Pin</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">Pin Number</label>
              <Input
                type="number"
                min="1"
                max="64"
                value={newPin.pinNumber}
                onChange={(e) => setNewPin({ ...newPin, pinNumber: Number(e.target.value) })}
                className="w-full text-xs font-mono"
                required
              />
            </div>
            <div>
              <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">Pin Name / Device</label>
              <Input
                placeholder="e.g. Main Gate Barrier"
                value={newPin.name}
                onChange={(e) => setNewPin({ ...newPin, name: e.target.value })}
                className="w-full text-xs"
                required
              />
            </div>
            <div>
              <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">Direction</label>
              <select
                value={newPin.direction}
                onChange={(e) => setNewPin({ ...newPin, direction: e.target.value as any })}
                className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
              >
                <option value="OUTPUT">DO (Output Relay)</option>
                <option value="INPUT">DI (Input Sensor)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">Default Pulse (ms)</label>
              <Input
                type="number"
                step="500"
                value={newPin.pulseDurationMs}
                onChange={(e) => setNewPin({ ...newPin, pulseDurationMs: Number(e.target.value) })}
                className="w-full text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex justify-end space-x-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => setShowAddPin(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="xs"
            >
              Save Pin
            </Button>
          </div>
        </form>
      )}

      {/* Pins Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Output Relays (DO) */}
        <div>
          <div className="flex items-center space-x-1 text-xs font-semibold text-vms-muted mb-2 font-mono uppercase tracking-wider">
            <ArrowUpRight className="w-3.5 h-3.5 text-vms-accent" />
            <span>Digital Outputs (DO Relays & Actuators)</span>
          </div>
          <div className="space-y-2">
            {outputPins.length === 0 ? (
              <div className="text-xs text-vms-dim font-mono p-4 text-center bg-vms-panel/50 rounded border border-dashed border-vms-border">
                No output relays configured yet.
              </div>
            ) : (
              outputPins.map((pin) => {
                const isTriggering = triggeringPin === pin.pinNumber;
                return (
                  <div
                    key={pin.id}
                    className="p-3 bg-vms-panel border border-vms-border rounded flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-mono text-xs font-bold text-vms-accent">
                          PIN #{pin.pinNumber}
                        </span>
                        <span className="text-xs font-medium text-vms-text">{pin.name}</span>
                        <span
                          className={`text-[9px] px-1.5 py-[2px] rounded font-mono font-bold ${
                            pin.state === 'HIGH'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                              : 'bg-vms-surface text-vms-dim border border-vms-border'
                          }`}
                        >
                          {pin.state}
                        </span>
                      </div>
                      <div className="text-[10px] text-vms-dim mt-1 font-mono">
                        Pulse: {pin.pulseDurationMs}ms • Changed:{' '}
                        {new Date(pin.lastStateChangeAt).toLocaleTimeString()}
                      </div>
                    </div>

                    <div className="flex items-center space-x-1.5">
                      <button
                        type="button"
                        onClick={() => handleTrigger(pin.pinNumber, 'PULSE')}
                        disabled={isTriggering}
                        className="px-2 py-1 rounded bg-vms-accent/20 hover:bg-vms-accent/30 text-vms-accent border border-vms-accent/40 text-[11px] font-bold font-mono transition-colors"
                      >
                        {isTriggering ? 'PULSING...' : '⚡ PULSE'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleTrigger(pin.pinNumber, pin.state === 'HIGH' ? 'SET_LOW' : 'SET_HIGH')
                        }
                        disabled={isTriggering}
                        className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                          pin.state === 'HIGH'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30'
                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                        }`}
                      >
                        {pin.state === 'HIGH' ? 'SET LOW' : 'SET HIGH'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Input Sensors (DI) */}
        <div>
          <div className="flex items-center space-x-1 text-xs font-semibold text-vms-muted mb-2 font-mono uppercase tracking-wider">
            <ArrowDownRight className="w-3.5 h-3.5 text-sky-400" />
            <span>Digital Inputs (DI Sensors, Tamper & Beams)</span>
          </div>
          <div className="space-y-2">
            {inputPins.length === 0 ? (
              <div className="text-xs text-vms-dim font-mono p-4 text-center bg-vms-panel/50 rounded border border-dashed border-vms-border">
                No input sensors configured yet.
              </div>
            ) : (
              inputPins.map((pin) => (
                <div
                  key={pin.id}
                  className="p-3 bg-vms-panel border border-vms-border rounded flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-mono text-xs font-bold text-sky-400">
                        PIN #{pin.pinNumber}
                      </span>
                      <span className="text-xs font-medium text-vms-text">{pin.name}</span>
                    </div>
                    <div className="text-[10px] text-vms-dim mt-1 font-mono">
                      Telemetry state monitored • Last transition:{' '}
                      {new Date(pin.lastStateChangeAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <div
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-bold font-mono ${
                      pin.state === 'HIGH'
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-pulse'
                        : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    }`}
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>{pin.state === 'HIGH' ? 'TRIGGERED (HIGH)' : 'NORMAL (LOW)'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Multi-Stage Hardware Confirmation Audit Logs */}
      <div className="mt-4 pt-3 border-t border-vms-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono text-vms-muted uppercase tracking-wider">
            Recent Relay Hardware Confirmation Trajectory
          </span>
          <button
            type="button"
            onClick={fetchData}
            className="text-[10px] text-sky-400 hover:underline flex items-center space-x-1 font-mono"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Refresh</span>
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] font-mono">
            <thead>
              <tr className="border-b border-vms-border text-vms-dim uppercase text-[10px]">
                <th className="py-1">Timestamp</th>
                <th className="py-1">Pin</th>
                <th className="py-1">Command</th>
                <th className="py-1">Lifecycle Stage</th>
                <th className="py-1">Hardware Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vms-border/60 text-vms-text">
              {logs.map((log) => {
                const isConfirmed = log.lifecycleState === 'STATE_CONFIRMED';
                const isFailed = log.lifecycleState === 'COMMAND_FAILED';
                return (
                  <tr key={log.id} className="hover:bg-vms-panel/50">
                    <td className="py-1 text-vms-muted">
                      {new Date(log.sentAt).toLocaleTimeString()}
                    </td>
                    <td className="py-1 font-bold text-vms-accent">
                      PIN #{log.pin.pinNumber} ({log.pin.name})
                    </td>
                    <td className="py-1">{log.command}</td>
                    <td className="py-1">
                      <span
                        className={`px-1.5 py-[2px] rounded text-[9px] font-bold ${
                          isConfirmed
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : isFailed
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {log.lifecycleState}
                      </span>
                    </td>
                    <td className="py-1 text-vms-muted">
                      {isConfirmed ? (
                        <span className="text-emerald-400 flex items-center space-x-1">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Hardware Acknowledged</span>
                        </span>
                      ) : isFailed ? (
                        <span className="text-rose-400 flex items-center space-x-1">
                          <AlertTriangle className="w-3 h-3" />
                          <span>{log.errorMessage || 'Timeout'}</span>
                        </span>
                      ) : (
                        <span className="text-amber-400 flex items-center space-x-1">
                          <Clock className="w-3 h-3 animate-spin" />
                          <span>Awaiting Ack...</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-center text-vms-dim">
                    No recent relay hardware executions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default RelayControlWidget;
