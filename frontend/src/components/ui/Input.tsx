import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, helperText, error, className = '', id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-[11px] font-mono font-medium text-vms-muted uppercase tracking-wider"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`w-full bg-vms-bg border ${
            error ? 'border-rose-500 focus:border-rose-500' : 'border-vms-border focus:border-vms-accent'
          } text-vms-text text-xs rounded px-3 py-2 transition-colors placeholder:text-vms-dim focus-visible:outline-none focus-visible:ring-1 ${
            error ? 'focus-visible:ring-rose-500' : 'focus-visible:ring-vms-accent'
          } ${className}`}
          {...props}
        />
        {error ? (
          <p className="text-[11px] text-rose-400 font-sans">{error}</p>
        ) : helperText ? (
          <p className="text-[11px] text-vms-dim font-sans">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helperText?: string;
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, helperText, error, className = '', id, children, ...props }, ref) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-[11px] font-mono font-medium text-vms-muted uppercase tracking-wider"
          >
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`w-full bg-vms-bg border ${
            error ? 'border-rose-500 focus:border-rose-500' : 'border-vms-border focus:border-vms-accent'
          } text-vms-text text-xs rounded px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 ${
            error ? 'focus-visible:ring-rose-500' : 'focus-visible:ring-vms-accent'
          } ${className}`}
          {...props}
        >
          {children}
        </select>
        {error ? (
          <p className="text-[11px] text-rose-400 font-sans">{error}</p>
        ) : helperText ? (
          <p className="text-[11px] text-vms-dim font-sans">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Input;
