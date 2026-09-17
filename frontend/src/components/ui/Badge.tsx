import React from 'react';

export type BadgeVariant =
  | 'live'
  | 'warn'
  | 'alarm'
  | 'telemetry'
  | 'legal'
  | 'neutral'
  | 'default'
  | 'success'
  | 'outline';

export interface BadgeProps {
  variant?: BadgeVariant;
  pulse?: boolean;
  dot?: boolean;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  children: React.ReactNode;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  pulse = false,
  dot = false,
  icon,
  size = 'sm',
  children,
  className = '',
}) => {
  const normalizedVariant =
    variant === 'default'
      ? 'neutral'
      : variant === 'success'
      ? 'live'
      : variant;

  const variantStyles: Record<string, string> = {
    live: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    alarm: 'bg-rose-500/15 text-rose-400 border-rose-500/40',
    telemetry: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    legal: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    neutral: 'bg-slate-800/60 text-slate-300 border-slate-700/50',
    outline: 'bg-transparent text-slate-400 border-slate-700',
  };

  const dotColors: Record<string, string> = {
    live: 'bg-emerald-400',
    warn: 'bg-amber-400',
    alarm: 'bg-rose-400',
    telemetry: 'bg-sky-400',
    legal: 'bg-purple-400',
    neutral: 'bg-slate-400',
    outline: 'bg-slate-400',
  };

  const sizeStyles = {
    sm: 'text-[10px] px-1.5 py-0.5 gap-1',
    md: 'text-xs px-2 py-0.5 gap-1.5',
  };

  const showDot = dot || pulse;

  return (
    <span
      className={`inline-flex items-center font-mono font-medium tracking-wide uppercase border rounded ${
        sizeStyles[size]
      } ${variantStyles[normalizedVariant] || variantStyles.neutral} ${className}`}
    >
      {showDot && (
        <span className="flex h-1.5 w-1.5 relative shrink-0">
          {pulse && (
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                dotColors[normalizedVariant] || dotColors.neutral
              }`}
            />
          )}
          <span
            className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
              dotColors[normalizedVariant] || dotColors.neutral
            }`}
          />
        </span>
      )}
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </span>
  );
};

export default Badge;
