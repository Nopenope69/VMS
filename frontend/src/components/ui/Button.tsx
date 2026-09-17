import React from 'react';
import { LucideIcon, Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'subtle';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  icon?: LucideIcon | React.ReactNode;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  isLoading?: boolean;
  hotkey?: string;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'sm',
  icon,
  iconPosition = 'left',
  loading = false,
  isLoading = false,
  hotkey,
  className = '',
  children,
  disabled,
  ...props
}) => {
  const isButtonLoading = loading || isLoading;

  const baseStyles =
    'inline-flex items-center justify-center font-sans font-medium transition-colors select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vms-accent disabled:opacity-40 disabled:pointer-events-none active:translate-y-[1px]';

  const sizeStyles = {
    xs: 'text-[11px] px-2 py-1 gap-1',
    sm: 'text-xs px-2.5 py-1.5 gap-1.5',
    md: 'text-sm px-3.5 py-2 gap-2',
    lg: 'text-base px-4 py-2.5 gap-2.5',
  };

  const variantStyles = {
    primary:
      'bg-vms-accent hover:bg-vms-accent-hover active:bg-[#A34A00] text-vms-text font-semibold shadow-sm',
    secondary:
      'bg-vms-surface hover:bg-vms-hover active:bg-vms-elevated text-vms-text border border-vms-border',
    danger:
      'bg-rose-500/15 hover:bg-rose-500/25 active:bg-rose-500/30 text-rose-300 border border-rose-500/40',
    ghost:
      'bg-transparent hover:bg-vms-hover active:bg-vms-elevated text-vms-muted hover:text-vms-text',
    outline:
      'bg-transparent hover:bg-vms-surface text-vms-text border border-vms-border',
    subtle:
      'bg-vms-elevated hover:bg-vms-hover text-vms-text border border-transparent hover:border-vms-border',
  };

  const iconSize = {
    xs: 'w-3 h-3',
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  const renderIcon = () => {
    if (!icon) return null;
    if (React.isValidElement(icon)) {
      return icon;
    }
    const IconComponent = icon as LucideIcon;
    return <IconComponent className={iconSize[size]} />;
  };

  return (
    <button
      className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      disabled={disabled || isButtonLoading}
      {...props}
    >
      {isButtonLoading ? (
        <Loader2 className={`${iconSize[size]} animate-spin`} />
      ) : (
        iconPosition === 'left' && renderIcon()
      )}

      {children && <span>{children}</span>}

      {!isButtonLoading && iconPosition === 'right' && renderIcon()}

      {hotkey && (
        <kbd className="ml-1.5 px-1 py-0.5 text-[9px] font-mono rounded bg-vms-bg border border-vms-border text-vms-muted">
          {hotkey}
        </kbd>
      )}
    </button>
  );
};

export default Button;
