import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { bundledFiles } from './scripts/licenses.ts';

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

// In development the API server runs inside Vite on a free port; Vite forwards /api to it and puts its key
// and the stored choices into the page.
function apiServer(): Plugin {
  let page = (html: string) => html;
  let close = () => {};
  return {
    name: 'radio-manager-api',
    apply: 'serve',
    // started here, before Vite sets up its forwarding, which needs the port
    async config() {
      const { startServer } = await import('./src/server/server.ts');
      const { paths } = await import('./src/core/paths.ts');
      const s = await startServer({ paths: paths(), port: 0, repoParent: resolve(import.meta.dirname, '..') });
      ({ page, close } = s);
      return { server: { proxy: { '/api/': s.url.replace('localhost', '127.0.0.1') } } };
    },
    configureServer(server) {
      server.httpServer?.once('close', close);
    },
    transformIndexHtml: (html) => page(html),
  };
}

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss(), apiServer(), bundledFiles()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: '../../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
