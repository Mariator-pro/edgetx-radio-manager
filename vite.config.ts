import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API_PORT = 5174;

// In development the API server runs inside Vite; Vite forwards /api to it.
function apiServer(): Plugin {
  return {
    name: 'radio-manager-api',
    apply: 'serve',
    async configureServer() {
      const { startServer } = await import('./src/server/server.ts');
      const { paths } = await import('./src/core/paths.ts');
      await startServer({ paths: paths(), port: API_PORT, repoParent: resolve(import.meta.dirname, '..') });
    },
  };
}

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss(), apiServer()],
  build: { outDir: '../../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { proxy: { '/api/':`http://127.0.0.1:${API_PORT}` } },
});
