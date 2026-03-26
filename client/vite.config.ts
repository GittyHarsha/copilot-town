import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'xterm': ['@xterm/xterm'],
        },
      },
    },
  },
  server: {
    port: 3847,
    proxy: {
      '/api': 'http://localhost:3848',
      '/ws/status': {
        target: 'ws://localhost:3848',
        ws: true,
      },
    },
  },
});
