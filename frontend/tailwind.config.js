/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        graphite: {
          900: '#121418',
          850: '#181b20',
          800: '#1e2229',
          700: '#2a303c',
          600: '#384152',
        },
        cctv: {
          amber: '#f59e0b',
          teal: '#14b8a6',
          red: '#ef4444',
          gray: '#64748b',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
};
