import { fixtureFetch as fetch, registerFixtureServer } from './helpers/daemon-client.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import { MockLLMClient } from '../src/evals/llm-client.js';
import { PlaceholderWorkProducer } from '../src/daemon/work-producer.js';

describe('Phase 4 slice: operator console served by the daemon', () => {
  const dbPath = path.join(process.cwd(), 'temp-console.db');
  const port = 4050;
  const base = 'http://127.0.0.1:' + port;
  const wipe = () => {
    for (const ext of ['', '-wal', '-shm']) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* busy */ } }
    }
  };

  it('serves the console, the state snapshot, health, and 404s everything else', async () => {
    wipe();
    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath, wsPort: port, cadenceMs: 100, maxConcurrency: 1,
      llmClient: new MockLLMClient(),
      workProducer: new PlaceholderWorkProducer(),
    });

    registerFixtureServer(port, daemon.wsServer);
    try {
      // 1. The original console. Cortex took over '/', so the hand-written
      // console lives at /legacy and /console - it must not have been deleted,
      // because it is also the fallback when web/dist has not been built.
      const page = await fetch(base + '/legacy');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') || '', /text\/html/);
      const html = await page.text();
      for (const marker of ['OpenAgents Operator Console', 'id="fleet"', 'id="runs"', 'id="log"', '/api/state', 'new WebSocket']) {
        assert.ok(html.includes(marker), 'console HTML must contain ' + marker);
      }
      assert.equal((await fetch(base + '/console')).status, 200, '/console must stay an alias');

      // 1b. Root serves Cortex when the bundle is built, and degrades to the old
      // console when it is not. Both are HTML and neither is a blank page.
      const bundleBuilt = fs.existsSync(path.resolve(process.cwd(), 'web/dist/index.html'));
      const root = await fetch(base + '/');
      assert.equal(root.status, 200);
      assert.match(root.headers.get('content-type') || '', /text\/html/);
      const rootHtml = await root.text();
      if (bundleBuilt) {
        assert.equal(rootHtml, fs.readFileSync(path.resolve(process.cwd(), 'web/dist/index.html'), 'utf8'), 'the actual built bundle must be served at /');
        const asset = rootHtml.match(/<script[^>]+src="(\/assets\/[^\"]+\.js)"/);
        assert.ok(asset, 'built bundle must reference its JavaScript module');
        const script = await fetch(base + asset[1]);
        assert.equal(script.status, 200, 'the referenced module must be served');
        assert.match(script.headers.get('content-type') ?? '', /javascript/);
        assert.ok(!rootHtml.includes('OpenAgents Operator Console'), 'Cortex, not the legacy console');
      } else {
        assert.ok(rootHtml.includes('OpenAgents Operator Console'),
          'with no bundle, / must fall back to the console rather than 404 or blank');
      }

      // 2. Health must still work - the console route replaced its old alias
      const health = await (await fetch(base + '/health')).json() as any;
      assert.equal(health.status, 'HEALTHY');

      // 3. State snapshot reflects the real store, not a stub
      const run = daemon.store.createTaskRun({ agentId: 'agent-alpha', taskName: 'cli-arg-parser' });
      const state = await (await fetch(base + '/api/state')).json() as any;
      assert.ok(Array.isArray(state.agents) && state.agents.length > 0, 'snapshot must list the seeded agent');
      assert.equal(state.agents[0].id, 'agent-alpha');
      assert.ok(state.taskRuns.some((r: any) => r.id === run.id),
        'snapshot must contain a task run created after boot - proves it is live, not cached');
      assert.equal(state.port, port);

      // 4. Unknown routes 404 rather than silently returning a page. Static
      // serving deliberately has no catch-all index.html fallback, or this
      // invariant would quietly become "everything returns 200".
      assert.equal((await fetch(base + '/nope')).status, 404);
      assert.equal((await fetch(base + '/assets/does-not-exist.js')).status, 404);
      // Traversal out of the bundle must not resolve to a file on disk.
      //
      // Two forms, and only ONE of them actually reaches the guard - verified by
      // neutralising the guard and re-running:
      //   /%2e%2e/package.json    -> still 404. new URL() treats %2e%2e as a
      //                              path segment '..' and collapses it, so this
      //                              never gets far enough to test anything. Kept
      //                              only so a future URL-parsing change is caught.
      //   /%2e%2e%2fpackage.json  -> LEAKED web/package.json with the guard off.
      //                              This is the assertion that carries weight.
      assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
      assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 404,
        'encoded-slash traversal must not escape the bundle root');
    } finally {
      await daemon.shutdown();
      wipe();
    }
  });
});
