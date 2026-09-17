import React from 'react';
import { LucideIcon } from 'lucide-react';

export interface KpiStatProps {
  label: string;
  value: string | number;
  subvalue?: string;
  subtext?: string;
  icon?: LucideIcon | React.ReactNode;
  status?: 'live' | 'warn' | 'alarm' | 'telemetry' | 'neutral' | 'default' | 'success' | 'legal';
  trend?: string;
  className?: string;
}

export const KpiStat: React.FC<KpiStatProps> = ({
  label,
  value,
  subvalue,
  subtext,
  icon,
  status = 'neutral',
  trend,
  className = '',
}) => {
  const normalizedStatus =
    status === 'default'
      ? 'neutral'
      : status === 'success'
      ? 'live'
      : status;

  const statusColor: Record<string, string> = {
    live: 'text-emerald-400',
    warn: 'text-amber-400',
    alarm: 'text-rose-400',
    telemetry: 'text-sky-400',
    legal: 'text-purple-400',
    neutral: 'text-vms-text',
  };

  const iconBg: Record<string, string> = {
    live: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    alarm: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    telemetry: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    legal: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    neutral: 'bg-vms-elevated text-vms-muted border-vms-border',
  };

  const effectiveSubvalue = subtext || subvalue;

  const renderIcon = () => {
    if (!icon) return null;
    if (React.isValidElement(icon)) {
      return icon;
    }
    const IconComponent = icon as LucideIcon;
    return <IconComponent className="w-4 h-4" />;
  };

  return (
    <div
      className={`bg-vms-surface border border-vms-border rounded p-3 flex items-start justify-between gap-3 shadow-sm ${className}`}
    >
      <div className="space-y-1">
        <span className="text-[11px] font-mono uppercase tracking-wider text-vms-muted block">
          {label}
        </span>
        <div className="flex items-baseline space-x-2">
          <span
            className={`text-xl font-bold font-mono tracking-tight ${
              statusColor[normalizedStatus] || statusColor.neutral
            }`}
          >
            {value}
          </span>
          {trend && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-vms-elevated text-vms-muted">
              {trend}
            </span>
          )}
        </div>
        {effectiveSubvalue && (
          <p className="text-[11px] text-vms-dim font-sans">{effectiveSubvalue}</p>
        )}
      </div>

      {icon && (
        <div
          className={`p-2 rounded border shrink-0 ${
            iconBg[normalizedStatus] || iconBg.neutral
          }`}
        >
          {renderIcon()}
        </div>
      )}
    </div>
  );
};

export default KpiStat;
