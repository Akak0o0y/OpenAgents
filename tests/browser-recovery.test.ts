import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/daemon/agent-store.js';
import {CostLedger} from '../src/kernel/cost-ledger.js';
import {ArtifactStore} from '../src/daemon/artifacts.js';
import {WorkRuntime} from '../src/daemon/work-runtime.js';
import {ChatService} from '../src/daemon/chat.js';
import {ApprovalGate} from '../src/daemon/control-plane.js';
import type {LLMRequest} from '../src/evals/llm-client.js';
import {BrowserTools, browserAction, browserTargetProblem} from '../src/daemon/browser-tools.js';
import {MemorySecretStore} from '../src/daemon/secret-store.js';
import type {WebResearch} from '../src/daemon/web-research.js';

type Action = {tool: string; [key: string]: unknown};
const navigate=(n:number):Action=>({tool:'browser',action:'navigate',url:`https://example.test/${n}`});
const answer:Action={tool:'answer',text:'Checked fixture evidence.',citations:[{sourceId:'source-1',quote:'Fixture evidence 0'}]};
function harness(steps:Array<Action|Action[]>, native=false, humanResponse?:string) {
  const store=new AgentStore(':memory:');const ledger=new CostLedger(store.getDatabase());
  store.createAgent({id:'alpha',name:'Milo',model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE'});
  const requests:LLMRequest[]=[], browserCalls:Action[]=[];let current=0,webCalls=0,operatorActed=0;
  const llm={async generateCode(req:LLMRequest){
    requests.push({...req,messages:req.messages?.map(m=>({...m}))});
    const step=steps.shift();assert.ok(step,'Unexpected extra model turn');
    const actions=Array.isArray(step)?step:[step];
    return native?{content:'',toolCalls:actions.map(({tool,...args},i)=>({id:`c${requests.length}_${i}`,name:tool,arguments:JSON.stringify(args)})),inputTokens:10,outputTokens:10,attemptCount:1}
      :{content:JSON.stringify(step),inputTokens:10,outputTokens:10,attemptCount:1};
  }};
  const browser={status:()=>({enabled:true}),waitForOperator:async()=>{},endRun:async()=>{},markOperatorActed:()=>{operatorActed++;},
    call:async(_agent:string,_run:string,action:Action)=>{browserCalls.push(action);if(action.action==='navigate')current=Number(String(action.url).split('/').pop());
      return {url:`https://example.test/${current}`,title:`Changing title ${browserCalls.length}`,snapshot:action.action==='fill'?'Changed form':`Fixture evidence ${current}`,tabs:[]};}
  } as unknown as BrowserTools;
  const read=async(url:string)=>{webCalls++;await new Promise<void>(r=>setImmediate(r));return {url,title:'Fixture',text:`Fixture evidence ${url.split('/').pop()}`,capturedAt:new Date().toISOString(),truncated:false,links:[]};};
  const web={enabled:true,capabilities:()=>({internet:'fixture'}),read,search:read,githubIssues:read} as unknown as WebResearch;
  const forbidden=async()=>{throw Error('This fixture must not call Docker');};
  const sandbox={createWorkspaceVolume:forbidden,stageWorkspaceFiles:forbidden,readWorkspaceFile:forbidden,executeTask:forbidden,destroyWorkspaceVolume:forbidden};
  const approvals=new ApprovalGate(store);approvals.onDecision('human-assist',()=>{});
  if(humanResponse!==undefined)approvals.request=async()=>({status:'APPROVED',reason:humanResponse});
  const runtime=new WorkRuntime({store,ledger,llm,browser,web,approvals,sandbox:sandbox as never,artifacts:new ArtifactStore(store)});
  const chat=new ChatService({agentStore:store,ledger,llmClient:llm,workRuntime:runtime,agenticChat:true});
  return {requests,browserCalls,run:()=>chat.send(chat.createThread('alpha').id,'Review the fixture and report only verified facts.','recovery-test'),
    observations:()=>store.getTaskEvents(store.listTaskRuns()[0].id).filter(e=>e.event_type==='TOOL_CALL').map(e=>JSON.parse(e.payload_json!)),
    sources:()=>JSON.parse((store.getDatabase().prepare("SELECT content FROM run_artifacts WHERE path = 'sources.json'").get() as {content:string}).content),
    webCalls:()=>webCalls,operatorActed:()=>operatorActed,close:()=>{ledger.close();store.close();}};
}

for(const native of [false,true]){
  const mode=native?'native':'JSON';
  test(`${mode}: repeated browser captures ignore title churn and retain changed evidence`,async()=>{
    const h=harness([navigate(0),{tool:'browser',action:'snapshot'},{tool:'browser',action:'fill',target:{role:'textbox',name:'Draft'},value:'New value'},answer],native);
    try{const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content + JSON.stringify(h.observations().slice(-3)));const captures=h.observations().filter(o=>o.tool==='browser');
      assert.equal(captures[1].source.id,captures[0].source.id);assert.notEqual(captures[2].source.id,captures[0].source.id);assert.equal(h.sources().find((s:any)=>s.id===captures[0].source.id).text,'Fixture evidence 0');
    }finally{h.close();}
  });
  test(`${mode}: full citation storage does not prevent fresh research or browser observations`,async()=>{
    const h=harness([...Array.from({length:12},(_,n)=>navigate(n)),{tool:'web_search',query:'https://example.test/12'},answer],native);
    try{const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content + JSON.stringify(h.observations().slice(-3)));assert.equal(h.webCalls(),1);assert.equal(h.sources().length,12);
      const obs=h.observations().find(o=>o.tool==='web_search');assert.equal(obs.code,'CAPTURE_BUDGET_EXHAUSTED');assert.equal(obs.status,'warning');assert.equal(obs.source,null);assert.match(obs.summary,/Fixture evidence 12/);assert.ok(obs.retainedSources.some((s:any)=>s.id==='source-1'));
    }finally{h.close();}
  });
  test(`${mode}: missing targets get an actionable correction before any browser call`,async()=>{
    const h=harness([{tool:'browser',action:'fill',value:'draft'},navigate(0),{tool:'browser',action:'fill',target:{ref:'e4'},value:'draft'},answer],native);
    try{const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content + JSON.stringify(h.observations().slice(-3)));assert.equal(h.browserCalls.length,2);
      const obs=h.observations()[0];assert.equal(obs.code,'BROWSER_TARGET_REQUIRED');assert.equal(obs.notRun,true);assert.match(JSON.stringify(obs.next_actions),/target/);
    }finally{h.close();}
  });
  test(`${mode}: intervening snapshots do not reset repeated missing-target failures`,async()=>{
    const h=harness([navigate(0),{tool:'browser',action:'fill',value:'a'},{tool:'browser',action:'snapshot'},{tool:'browser',action:'fill',value:'b'},{tool:'browser',action:'snapshot'},{tool:'browser',action:'fill',value:'c'},answer],native);
    try{const r=await h.run();assert.notEqual(r.work?.outcome,'COMPLETED');assert.match(r.reply.content,/target/i);assert.equal(h.browserCalls.length,3);assert.equal(h.requests.length,6);
    }finally{h.close();}
  });
  test(`${mode}: human reply reaches the resumed model and requires fresh observation`,async()=>{
    const h=harness([{tool:'request_human',what:'Which section should I use?',why:'The owner chooses the destination.'},{tool:'answer',text:'I will use the preview section.',citations:[]}],native,'Use the preview section; I have not submitted anything.');
    try{const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content + JSON.stringify(h.observations().slice(-3)));assert.match(JSON.stringify(h.requests[1].messages),/Use the preview section; I have not submitted anything/);assert.equal(h.operatorActed(),1);
      assert.doesNotMatch(JSON.stringify(h.requests[1].messages),/operator reports this is done/i);
    }finally{h.close();}
  });
}

test('parallel research never exceeds the retained-source limit',async()=>{
  const reads=Array.from({length:14},(_,n):Action=>({tool:'web_read',url:`https://example.test/${n}`}));
  const h=harness([reads.slice(0,4),reads.slice(4,8),reads.slice(8,12),reads.slice(12),answer],true);
  try{const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content + JSON.stringify(h.observations().slice(-3)));assert.equal(h.webCalls(),14);assert.equal(h.sources().length,12);assert.equal(new Set(h.sources().map((s:any)=>s.id)).size,12);
    assert.ok(h.observations().some(o=>o.citationUnavailable&&o.source===null));
  }finally{h.close();}
});

test('concurrent identical research reuses one immutable source',async()=>{
  const h=harness([[{tool:'web_read',url:'https://example.test/0'},{tool:'web_search',query:'https://example.test/0'}],answer],true);
  try {
    const r=await h.run();assert.equal(r.work?.outcome,'COMPLETED',r.reply.content);
    assert.equal(h.webCalls(),2);assert.equal(h.sources().length,2);
    const reads=h.observations().filter(o=>o.tool.startsWith('web_'));
    assert.equal(reads[0].source.id,reads[1].source.id);assert.equal(reads[1].sourceReused,true);
  } finally {h.close();}
});

test('browser target validation covers element actions and drag destinations before acquiring a session',async()=>{
  const store=new AgentStore(':memory:');
  const browser=new BrowserTools({store,artifacts:new ArtifactStore(store),secrets:new MemorySecretStore(),approvals:new ApprovalGate(store)});
  try {
    for(const action of ['click','double_click','right_click','hover','drag','press','select','check','fill','download','upload']) {
      const parsed=browserAction.parse({tool:'browser',action});
      assert.match(browserTargetProblem(parsed)!,/requires target/);
      await assert.rejects(browser.call('missing-agent','missing-run',parsed,new AbortController().signal),/requires target/);
    }
    assert.equal(browser.status().active,0);
    assert.match(browserTargetProblem(browserAction.parse({tool:'browser',action:'fill',target:{role:'textbox'}}))!,/requires target/);
    assert.match(browserTargetProblem(browserAction.parse({tool:'browser',action:'drag',target:{ref:'e1'}}))!,/requires destination/);
    assert.equal(browserTargetProblem(browserAction.parse({tool:'browser',action:'drag',target:{ref:'e1'},destination:{role:'button',name:'Drop'}})),null);
    assert.equal(browserTargetProblem(browserAction.parse({tool:'browser',action:'snapshot'})),null);
  } finally {await browser.stop();store.close();}
});
