import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  header?: React.ReactNode;
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  header,
  title,
  subtitle,
  action,
  footer,
  padding = 'md',
}) => {
  const paddingStyles = {
    none: '',
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  };

  return (
    <div
      className={`bg-vms-surface border border-vms-border rounded overflow-hidden shadow-sm transition-colors ${className}`}
    >
      {(header || title || action) && (
        <div className="px-4 py-3 border-b border-vms-border bg-vms-panel flex items-center justify-between gap-3">
          {header ? (
            header
          ) : (
            <div>
              {title && (
                <h3 className="text-xs font-semibold text-vms-text uppercase tracking-wider font-mono">
                  {title}
                </h3>
              )}
              {subtitle && <p className="text-[11px] text-vms-muted mt-0.5 font-sans">{subtitle}</p>}
            </div>
          )}
          {action && <div className="flex items-center space-x-2 shrink-0">{action}</div>}
        </div>
      )}

      <div className={paddingStyles[padding]}>{children}</div>

      {footer && (
        <div className="px-4 py-2.5 border-t border-vms-border bg-vms-panel/70 text-xs text-vms-muted">
          {footer}
        </div>
      )}
    </div>
  );
};

export default Card;
