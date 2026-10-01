/**
 * Development daemon.
 *
 * THIS IS A FIXTURE HOST, NOT A SECOND DAEMON. It boots the real
 * `startDaemon()` - the real SQLite store, the real WebSocket and HTTP API, the
 * real cron engine, the real chat service with its real budget reservations -
 * and substitutes exactly one thing: the model client.
 *
 * Why substitute it: verifying the workspace UI should not spend money or
 * depend on a provider being up, and a fixture reply is deterministic enough to
 * assert against. Every reply this client produces SAYS SO in its own text, and
 * the banner below is printed on every boot, so a fixture session can never be
 * mistaken for a real one.
 *
 *   node scripts/dev-daemon.mjs
 *
 * Run `npm run build` first: this imports the compiled daemon rather than
 * duplicating it.
 */

import { startDaemon } from '../dist/src/daemon/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * A model client that answers without contacting anything.
 *
 * The reply is deliberately self-identifying. A screenshot of this daemon must
 * never be presentable as evidence that a real model answered.
 */
class FixtureLLMClient {
  /** OH_FIXTURE_DELAY_MS makes a reply slow, so agent-switching mid-request
   *  can be exercised deliberately rather than raced. */
  async generateCode(request) {
    const delay = Number(process.env.OH_FIXTURE_DELAY_MS ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const prompt = String(request.userPrompt ?? '');
    const lastLine = prompt.split('\n').filter(Boolean).at(-1) ?? '';
    return {
      content:
        `[local fixture model - no provider was contacted]\n\n` +
        `I received ${prompt.length} characters. The last line was: "${lastLine.slice(0, 160)}".\n\n` +
        `This daemon was started with scripts/dev-daemon.mjs, so this reply is generated ` +
        `locally for interface testing. Start the daemon normally to talk to a real model.`,
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: 64,
      attemptCount: 1,
    };
  }
}

console.warn('****************************************************************');
console.warn('  OPENAGENTS DEV DAEMON - FIXTURE MODEL CLIENT IS ACTIVE.');
console.warn('  No provider is contacted. Replies are generated locally and');
console.warn('  say so in their own text. Do not use this to verify model');
console.warn('  behaviour, cost, or provider integration.');
console.warn('****************************************************************');

const { shutdown } = await startDaemon({
  dbPath: process.env.OPENHOURS_DB_PATH ?? path.join(repoRoot, 'data', 'openhours-dev.db'),
  wsPort: Number(process.env.OPENHOURS_PORT ?? 4001),
  cadenceMs: 5000,
  maxConcurrency: 1,
  llmClient: new FixtureLLMClient(),
  configPath: process.env.OPENHOURS_CONFIG ?? path.join(repoRoot, 'openhours.config.dev.json'),
});

const onSignal = async () => {
  await shutdown();
  process.exit(0);
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
