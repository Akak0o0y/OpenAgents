/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';

const DAEMON = process.env.OPENHOURS_DAEMON ?? 'http://127.0.0.1:4001';
const AUTH_FILE = process.env.OPENHOURS_AUTH_FILE ?? path.resolve(__dirname, '../data/openhours.db.auth.json');
// This code runs in Vite's Node process. Credentials never enter a browser bundle.
const authorizeProxy = (proxy: any) => {
  const authorize = (request: any, incoming: any) => {
    try { request.setHeader('Authorization', `Bearer ${JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).token}`); } catch { /* daemon returns 401 until configured */ }
    const origin = incoming.headers.origin;
    if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') request.setHeader('Origin', new URL(DAEMON).origin);
  };
  proxy.on('proxyReq', authorize);
  proxy.on('proxyReqWs', authorize);
};

export default defineConfig({
  // Tailwind scans the source for utility classes at build time; the token
  // mapping it resolves them against lives in src/tailwind.css.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The layer taxonomy and the rendering rules are IMPORTED from the daemon
      // source, never copied. A copy would let the panel drift away from the
      // behaviour `npm test` guarantees.
      '@kernel': path.resolve(__dirname, '../src'),
      // Coss components import from `@/registry/default/...`, which is the
      // path they live at in their own repository. Mapping it here means their
      // files can be vendored VERBATIM - no import rewriting, so a component
      // updated upstream is a straight copy rather than a merge.
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    fs: {
      // Required because @kernel resolves outside web/.
      allow: [path.resolve(__dirname, '..')],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.db*', '**/openhours.config*.json'],
    },
    // Proxying keeps the daemon free of CORS handling: to the browser, the API
    // and the app share an origin.
    proxy: {
      '/api': { target: DAEMON, ws: true, changeOrigin: true, configure: authorizeProxy },
      '/health': { target: DAEMON, changeOrigin: true, configure: authorizeProxy },
      '/ws': { target: DAEMON.replace(/^http/, 'ws'), ws: true, changeOrigin: true, configure: authorizeProxy },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The Aora engine and the galaxy canvas are WebGL/SVG-heavy and are not
    // what these tests are about; jsdom is enough for everything else.
    restoreMocks: true,
  },
});
