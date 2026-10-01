import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveLLMClient, ProviderCallError, loadEnvFiles, type LLMRequest, type ProviderEvent } from '../src/evals/llm-client.js';

const fixtureRequest = {modelId:'test/model',systemPrompt:'Fixture',userPrompt:'Fixture'};
async function withProviderFixture(fetcher: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch, key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-only'; globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; }
}

test('an explicitly selected env file works when the daemon cwd is its profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-env-file-'));
  const envFile = path.join(root, 'credentials.env');
  const variable = 'OPENHOURS_EXPLICIT_ENV_FIXTURE';
  const previousCwd = process.cwd();
  const previousFile = process.env.OPENHOURS_ENV_FILE;
  const previousValue = process.env[variable];
  try {
    fs.writeFileSync(envFile, `${variable}=from-explicit-file\n`);
    process.chdir(root);
    process.env.OPENHOURS_ENV_FILE = envFile;
    delete process.env[variable];
    loadEnvFiles();
    assert.equal(process.env[variable], 'from-explicit-file');

    process.env[variable] = 'environment-wins';
    fs.writeFileSync(envFile, `${variable}=must-not-clobber\n`);
    loadEnvFiles();
    assert.equal(process.env[variable], 'environment-wins');

    process.env.OPENHOURS_ENV_FILE = path.join(root, 'missing.env');
    assert.throws(() => loadEnvFiles(), /does not exist/);
    process.env.OPENHOURS_ENV_FILE = '.env';
    assert.throws(() => loadEnvFiles(), /absolute path/);
  } finally {
    process.chdir(previousCwd);
    if (previousFile === undefined) delete process.env.OPENHOURS_ENV_FILE;
    else process.env.OPENHOURS_ENV_FILE = previousFile;
    if (previousValue === undefined) delete process.env[variable];
    else process.env[variable] = previousValue;
    if (fs.existsSync(envFile)) fs.unlinkSync(envFile);
    fs.rmdirSync(root);
  }
});

test('provider deadline stops a stalled body without redispatch and retains timing metadata', async () => {
  let calls = 0;
  const events: ProviderEvent[] = [];
  await withProviderFixture((async (_url, init) => {
    calls++;
    return new Response(new ReadableStream({start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {once:true}); }}));
  }) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient({requestTimeoutMs:60}).generateCode({...fixtureRequest,onProviderEvent:e=>events.push(e)}), (error: unknown) => error instanceof ProviderCallError && error.code === 'TIMEOUT');
    assert.equal(calls,1); assert.deepEqual(events.map(e=>e.phase),['attempt','headers','failed']);
    assert.equal(events.at(-1)?.code,'TIMEOUT'); assert.ok(events.at(-1)!.elapsedMs >= 45);
  });
});

test('stream progress extends the idle deadline but never the absolute cap', async () => {
  for (const mode of ['complete', 'total', 'idle', 'cancel'] as const) {
    let calls = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const caller = new AbortController();
    await withProviderFixture((async (_url, init) => {
      calls++;
      return new Response(new ReadableStream({start(controller) {
        let ticks = 0;
        const emit = (data: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        init!.signal!.addEventListener('abort', () => { clearInterval(interval); controller.error(init!.signal!.reason); }, {once:true});
        interval = setInterval(() => {
          ticks++;
          emit({choices:[{delta:mode === 'idle' ? {} : {reasoning_content:'progress'}}]});
          if (mode === 'cancel' && ticks === 2) caller.abort();
          if (mode === 'complete' && ticks === 8) {
            emit({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            clearInterval(interval);controller.close();
          }
        }, 30);
      }}), {headers:{'Content-Type':'text/event-stream'}});
    }) as typeof fetch, async () => {
      try {
        const request = new LiveLLMClient({requestTimeoutMs:mode === 'total' ? 250 : 1500,idleTimeoutMs:150})
          .generateCode({...fixtureRequest,signal:caller.signal,onStream:()=>{}});
        if (mode === 'complete') assert.equal((await request).content,'done');
        else await assert.rejects(request,(error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code,mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
          if (mode === 'idle') assert.match(error.message,/stopped making progress/);
          if (mode === 'total') assert.match(error.message,/total provider response deadline/);
          return true;
        });
        assert.equal(calls,1,'Never redispatch a timed-out generation');
      } finally { clearInterval(interval); }
    });
  }
});

test('cancellation interrupts provider backoff and does not make another request', async () => {
  let calls = 0;
  const controller = new AbortController();
  await withProviderFixture((async () => {calls++;return new Response('{}',{status:503});}) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient().generateCode({...fixtureRequest,signal:controller.signal,onProviderEvent:e=>{if(e.phase==='retry')controller.abort();}}), (e: unknown) => e instanceof ProviderCallError && e.code === 'CANCELLED');
    assert.equal(calls,1);
  });
});

test('unavailable responses retry only the exact selected model with bounded attempts', async () => {
  const models: string[] = [];
  await withProviderFixture((async (_url, init) => {models.push(JSON.parse(String(init?.body)).model);return new Response('{}',{status:503});}) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient({retryBaseDelayMs:0}).generateCode(fixtureRequest), /503/);
    assert.deepEqual(models,Array(4).fill('test/model'));
  });
});

test('network failures and ambiguous gateway timeouts are not replayed', async () => {
  for (const mode of ['network', '504', 'invalid-json']) {
    let calls = 0;
    await withProviderFixture((async () => {calls++; if(mode==='network')throw new TypeError('fixture disconnect'); return new Response(mode==='invalid-json'?'not-json':'{}',{status:mode==='504'?504:200});}) as typeof fetch, async () => {
      await assert.rejects(new LiveLLMClient({retryBaseDelayMs:0}).generateCode(fixtureRequest)); assert.equal(calls,1);
    });
  }
});

test('truncated valid JSON is rejected with reported usage and without private reasoning', async () => {
  await withProviderFixture((async () => new Response(JSON.stringify({choices:[{message:{content:'{"tool":"finish"}',reasoning:'private fixture'},finish_reason:'length'}],usage:{prompt_tokens:10,completion_tokens:20}}))) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient().generateCode(fixtureRequest), (e: unknown) => {
      assert.ok(e instanceof ProviderCallError); assert.equal(e.code,'OUTPUT_LIMIT'); assert.deepEqual(e.details.usage,{inputTokens:10,outputTokens:20}); assert.doesNotMatch(JSON.stringify(e),/private fixture/); return true;
    });
  });
});

test('missing or malformed usage is explicitly unknown, never a known zero charge', async () => {
  for (const usage of [undefined, {prompt_tokens:-1,completion_tokens:'bad'}]) {
    await withProviderFixture((async () => new Response(JSON.stringify({choices:[{message:{content:'answer'}}],usage}))) as typeof fetch, async () => {
      const result = await new LiveLLMClient().generateCode(fixtureRequest);
      assert.equal(result.usageKnown,false); assert.equal(result.inputTokens,0); assert.equal(result.outputTokens,0);
    });
  }
});

test('pre-cancelled callers dispatch no provider request', async () => {
  let calls=0;
  await withProviderFixture((async () => {calls++;throw new Error('must not dispatch');}) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient().generateCode({...fixtureRequest,signal:AbortSignal.abort()}), (e: unknown)=>e instanceof ProviderCallError && e.code==='CANCELLED');assert.equal(calls,0);
  });
});

test('HTTP 200 provider errors keep the upstream status without executing content or retrying', async () => {
  let calls=0;
  await withProviderFixture((async () => {calls++;return new Response(JSON.stringify({error:{code:502,message:'private upstream dump'},choices:[{message:{content:'{"tool":"finish"}'}}]}));}) as typeof fetch, async () => {
    await assert.rejects(new LiveLLMClient().generateCode(fixtureRequest),(e: unknown)=> {
      assert.ok(e instanceof ProviderCallError);assert.equal(e.details.status,502);assert.doesNotMatch(String(e),/private upstream dump/);return true;
    });assert.equal(calls,1);
  });
});

test('malformed and oversized response bodies fail without exposing body fragments', async () => {
  for(const body of ['{"reasoning":"private fixture',JSON.stringify({content:'private fixture'.repeat(200000)})]) {
    await withProviderFixture((async () => new Response(body)) as typeof fetch,async()=>{
      await assert.rejects(new LiveLLMClient().generateCode(fixtureRequest),(e:unknown)=>{
        assert.ok(e instanceof ProviderCallError);assert.equal(e.code,'INVALID_RESPONSE');assert.doesNotMatch(String(e),/private fixture/);return true;
      });
    });
  }
});

test('provider authorization failures are terminal and are not retried', async () => {
  const original = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  try {
    process.env.OPENROUTER_API_KEY = 'fixture-only';
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? new Response('{"error":{"message":"invalid key"}}', { status: 401 })
        : new Response('{"choices":[{"message":{"content":"incorrect retry"}}]}');
    }) as typeof fetch;
    await assert.rejects(new LiveLLMClient().generateCode({modelId:'test/model', systemPrompt:'Fixture', userPrompt:'Fixture'}), /401/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; }
});

test('private reasoning cannot become the final action when content is absent', async () => {
  const original = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'fixture-only';
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices:[{message:{content:null,reasoning:'private fixture reasoning'},finish_reason:'length'}], usage:{prompt_tokens:8,completion_tokens:16} }))) as typeof fetch;
    await assert.rejects(new LiveLLMClient().generateCode({modelId:'test/model',systemPrompt:'Fixture',userPrompt:'Fixture'}), error => {
      assert.doesNotMatch(String(error), /private fixture reasoning/);
      return true;
    });
  } finally { globalThis.fetch = original; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; }
});

test('native adapters preserve requested model identity and complete multi-turn history', async () => {
  const oldFetch = globalThis.fetch;
  const keys = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY'];
  const saved = Object.fromEntries(keys.map(k => [k,process.env[k]]));
  const request: LLMRequest = { modelId: '', systemPrompt: 'Task authority', userPrompt: 'Latest observation', messages: [{role:'user',content:'Original objective'},{role:'assistant',content:'Previous action'},{role:'user',content:'Latest observation'}] };
  try {
    for (const k of keys) process.env[k]='fixture-only';
    for (const [model,host] of [['claude-haiku-4-5','api.anthropic.com'],['gpt-4.1-mini','api.openai.com'],['gemini-2.0-flash','generativelanguage.googleapis.com']]) {
      let sent: any; let url: URL | undefined;
      globalThis.fetch = (async (input: any, init: any) => {
        url = new URL(String(input)); sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ content:[{type:'text',text:'action'}], choices:[{message:{content:'action'}}], candidates:[{content:{parts:[{thought:true,text:'private'},{text:'action'}]}}], usage:{input_tokens:1,output_tokens:1,prompt_tokens:1,completion_tokens:1} }));
      }) as typeof fetch;
      const result=await new LiveLLMClient().generateCode({...request,modelId:model});
      assert.equal(url?.hostname,host);assert.equal(result.content,'action');
      if(model.startsWith('gemini')) {
        assert.match(url!.pathname,new RegExp(model));assert.equal(url!.search,'');
        assert.deepEqual(sent.contents.map((m:any)=>m.role),['user','model','user']);
        assert.equal(sent.contents[0].parts[0].text,'Original objective');assert.equal(sent.systemInstruction.parts[0].text,'Task authority');
      } else {
        assert.equal(sent.model,model);assert.deepEqual(sent.messages.filter((m:any)=>m.role!=='system'),request.messages);
      }
    }
    let wireModel='';
    globalThis.fetch=(async (_input:any,init:any)=>{wireModel=JSON.parse(init.body).model;return new Response(JSON.stringify({choices:[{message:{content:'action'}}]}));}) as typeof fetch;
    await new LiveLLMClient().generateCode({...request,modelId:'provider/exact-model:free'});assert.equal(wireModel,'provider/exact-model:free');
  } finally {
    globalThis.fetch=oldFetch;
    for(const k of keys) if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
  }
});
