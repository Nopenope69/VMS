/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        tactical: {
          bg: '#080b10',
          panel: '#0d1117',
          surface: '#161b22',
          raised: '#21262d',
          border: '#21262d',
          'border-active': '#30363d',
          'border-focus': '#484f58',
          muted: '#7d8590',
          text: '#e6edf3',
        },
        phosphor: {
          green: '#3fb950',
          amber: '#e3b341',
          red: '#f85149',
          cyan: '#58a6ff',
        },
        graphite: {
          950: '#080b10',
          900: '#0d1117',
          850: '#161b22',
          800: '#21262d',
          700: '#30363d',
          600: '#484f58',
        },
        cctv: {
          amber: '#e3b341',
          teal: '#58a6ff',
          red: '#f85149',
          green: '#3fb950',
          gray: '#7d8590',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
