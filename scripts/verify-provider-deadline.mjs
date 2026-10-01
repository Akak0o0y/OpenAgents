import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LiveLLMClient } from '../dist/src/evals/llm-client.js';

// Real HTTP body held beyond the removed 45-second cutoff. No external provider.
const output = process.argv[2];
if (!output) throw new Error('Supply the evidence JSON path.');
const events = []; let requests = 0;
const server = http.createServer((_req,res) => {
  requests++;
  res.writeHead(200, {'Content-Type':'application/json'}); res.flushHeaders();
  const timer = setTimeout(() => res.end(JSON.stringify({choices:[{message:{content:'delayed final answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:3}})), 46_000);
  res.on('close',()=>clearTimeout(timer));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const fetchOriginal = globalThis.fetch, key = process.env.OPENROUTER_API_KEY;
const started = performance.now();
try {
  process.env.OPENROUTER_API_KEY = 'local-fixture-only';
  globalThis.fetch = (_url,init) => fetchOriginal(`http://127.0.0.1:${server.address().port}/fixture`,init);
  const result = await new LiveLLMClient().generateCode({modelId:'fixture/exact-model',systemPrompt:'Fixture',userPrompt:'Fixture',onProviderEvent:e=>events.push(e)});
  assert.equal(result.content,'delayed final answer'); assert.equal(requests,1); assert.equal(result.attemptCount,1);
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({timestamp:new Date().toISOString(),durationMs:Math.round(performance.now()-started),requests,events,result},null,2));
  console.log(`Delayed body completed with one request: ${output}`);
} finally {
  globalThis.fetch=fetchOriginal; if(key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=key;
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
