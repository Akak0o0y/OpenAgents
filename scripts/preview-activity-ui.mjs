import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = { name: 'isolated-activity-preview', configureServer(server) {
server.middlewares.use((req, res, next) => {
  if (/^\/(api|health|ws)(?:\/|$|\?)/.test(req.url ?? '')) { res.writeHead(404); res.end('No daemon in this preview'); return; }
  next();
});
server.middlewares.use('/__activity-preview', async (_req, res) => {
  const entry = '/@fs/' + path.join(root, 'scripts/fixtures/activity-preview.tsx').replaceAll('\\', '/');
  const html = await server.transformIndexHtml('/__activity-preview', `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OpenAgents activity design preview</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
  res.setHeader('Content-Type', 'text/html'); res.end(html);
});
} };
const server = await createServer({ configFile: path.join(root, 'web/vite.config.ts'), root: path.join(root, 'web'), plugins: [fixture], resolve: { dedupe: ['react', 'react-dom'] }, server: { port: 5188, strictPort: true, host: '127.0.0.1' } });
await server.listen();
console.log('Isolated activity preview: http://127.0.0.1:5188/__activity-preview');
