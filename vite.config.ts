import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API_PORT = 5174;
const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

// In development the API server runs inside Vite; Vite forwards /api to it and puts its key into the page.
function apiServer(): Plugin {
  let page = (html: string) => html;
  return {
    name: 'radio-manager-api',
    apply: 'serve',
    async configureServer() {
      const { startServer } = await import('./src/server/server.ts');
      const { withToken } = await import('./src/server/api.ts');
      const { paths } = await import('./src/core/paths.ts');
      const { token } = await startServer({ paths: paths(), port: API_PORT, repoParent: resolve(import.meta.dirname, '..') });
      page = (html) => withToken(html, token);
    },
    transformIndexHtml: (html) => page(html),
  };
}

// Every file Vite bundles into the page, so the license list names exactly the packages the app ships.
function bundledFiles(): Plugin {
  return {
    name: 'radio-manager-bundled-files',
    apply: 'build',
    generateBundle() {
      const files = [...this.getModuleIds()].map((id) => id.replace(/^\0/, '').split('?')[0]!);
      writeFileSync(resolve(import.meta.dirname, 'dist/ui-files.json'), JSON.stringify(files));
    },
  };
}

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss(), apiServer(), bundledFiles()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: '../../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { proxy: { '/api/':`http://127.0.0.1:${API_PORT}` } },
});
