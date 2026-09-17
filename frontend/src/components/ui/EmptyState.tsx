import React from 'react';
import { LucideIcon } from 'lucide-react';
import Button from './Button';

export interface EmptyStateProps {
  icon?: LucideIcon | React.ReactNode;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  className = '',
}) => {
  const effectiveActionLabel = action?.label || actionLabel;
  const effectiveOnAction = action?.onClick || onAction;

  const renderIcon = () => {
    if (!icon) return null;
    if (React.isValidElement(icon)) {
      return icon;
    }
    const IconComponent = icon as LucideIcon;
    return <IconComponent className="w-5 h-5 text-vms-dim" />;
  };

  return (
    <div
      className={`h-full min-h-[240px] flex flex-col items-center justify-center text-center p-8 border border-vms-border rounded bg-vms-surface/50 ${className}`}
    >
      {icon && (
        <div className="w-10 h-10 rounded bg-vms-panel border border-vms-border flex items-center justify-center text-vms-muted mb-3">
          {renderIcon()}
        </div>
      )}
      <h4 className="text-xs font-semibold text-vms-text uppercase tracking-wider font-mono mb-1">
        {title}
      </h4>
      <p className="text-xs text-vms-muted max-w-sm font-sans mb-5 leading-relaxed">
        {description}
      </p>

      {(effectiveActionLabel || secondaryActionLabel) && (
        <div className="flex items-center space-x-2">
          {effectiveActionLabel && effectiveOnAction && (
            <Button variant="primary" size="sm" onClick={effectiveOnAction}>
              {effectiveActionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <Button variant="secondary" size="sm" onClick={onSecondaryAction}>
              {secondaryActionLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
