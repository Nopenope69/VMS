import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Demo mode is a BUILD-TIME switch. Production builds (VITE_DEMO_MODE unset) compile __DEMO_MODE__
// to the literal `false`, so Rollup removes every demo branch and the fixtures module from the bundle.
const DEMO_MODE = process.env.VITE_DEMO_MODE === 'true';

export default defineConfig({
  plugins: [react()],
  define: {
    __DEMO_MODE__: JSON.stringify(DEMO_MODE),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/whep': {
        target: 'http://localhost:8889',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/whep/, ''),
      },
      '/hls': {
        target: 'http://localhost:8888',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hls/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
