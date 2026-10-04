import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on :5173 and proxies the API to a local
// server on :8080 (npm run dev -w server). In production the server serves dist/.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/s/': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
