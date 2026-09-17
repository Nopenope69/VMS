/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Control-room optimized palette: warm industrial dark foundation, safety amber, and ivory text
        vms: {
          bg: '#150E07',         // Deep dark umber canvas base
          panel: '#22170B',      // Headers, toolbars, sidebar
          surface: '#38240D',    // Primary cards, table rows, input wells (User foundation swatch)
          elevated: '#473014',   // Modals, dropdowns, popovers
          hover: '#563B19',      // Row hover, button hover
          border: '#5E401C',     // 1px structural boundaries
          'border-subtle': '#422D13',
          'border-focus': '#C05800', // High-visibility focus ring (User accent swatch)
          text: '#FDFBD4',       // Primary UI text (User ivory swatch, 17.5:1 contrast)
          muted: '#D8CEAA',      // Secondary metadata labels (10:1 contrast)
          dim: '#B8A982',        // Tertiary notes, inactive icons (6.2:1 contrast)
          accent: '#C05800',     // High-vis burnt amber accent (User accent swatch)
          'accent-hover': '#D96500',
          earth: '#713600',      // Bronze structural accent (User earth swatch)
        },
        status: {
          live: '#10B981',       // Stream online, recording active, hash verified
          'live-bg': 'rgba(16, 185, 129, 0.15)',
          'live-border': 'rgba(16, 185, 129, 0.35)',
          warn: '#C05800',       // Warning, high capacity, in review
          'warn-bg': 'rgba(192, 88, 0, 0.18)',
          'warn-border': 'rgba(192, 88, 0, 0.4)',
          alarm: '#EF4444',      // Critical breach, hardware offline, tamper
          'alarm-bg': 'rgba(239, 68, 68, 0.18)',
          'alarm-border': 'rgba(239, 68, 68, 0.45)',
          telemetry: '#38BDF8',  // Diagnostic, UTC time, telemetry data
          'telemetry-bg': 'rgba(56, 189, 248, 0.15)',
          'telemetry-border': 'rgba(56, 189, 248, 0.35)',
          legal: '#C084FC',      // Section 63 BSA legal seals, custody chains
          'legal-bg': 'rgba(192, 132, 252, 0.15)',
          'legal-border': 'rgba(192, 132, 252, 0.35)',
        },
        // Safety aliases for legacy modal migration
        graphite: {
          600: '#5E401C',
          700: '#503718',
          750: '#473014',
          800: '#38240D',
          850: '#2A1C0E',
          900: '#22170B',
          950: '#150E07',
        },
        cctv: {
          amber: '#C05800',
          'amber-hover': '#D96500',
          teal: '#38BDF8',
          'teal-deep': '#0284C7',
        },
        // Backwards compatibility aliases for progressive transition & test compliance
        tactical: {
          canvas: '#07090E',
          bg: '#07090E',
          panel: '#0C1017',
          surface: '#121721',
          raised: '#1A2438',
          border: '#1E293B',
          'border-active': '#2E3D56',
          'border-focus': '#38BDF8',
          muted: '#94A3B8',
          text: '#F1F5F9',
          bright: '#FFFFFF',
        },
        phosphor: {
          green: '#10B981',
          'green-deep': '#059669',
          'green-glow': '#34D399',
          amber: '#F59E0B',
          'amber-hover': '#FBBF24',
          'amber-deep': '#D97706',
          red: '#EF4444',
          'red-deep': '#DC2626',
          cyan: '#38BDF8',
          'cyan-deep': '#0284C7',
          'cyan-glow': '#7DD3FC',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
