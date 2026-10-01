// Isolated smoke fixture: production UI and services, in-memory database, no daemon or providers.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../web/node_modules/vite/dist/node/index.js';
import react from '../web/node_modules/@vitejs/plugin-react/dist/index.js';
import tailwindcss from '../web/node_modules/@tailwindcss/vite/dist/index.mjs';
import {AgentStore} from '../dist/src/daemon/agent-store.js';
import {CharacterStore} from '../dist/src/daemon/character-store.js';
import {CharacterJournal} from '../dist/src/daemon/character-journal.js';
import {CharacterProposals} from '../dist/src/daemon/character-proposals.js';
import {CharacterClaims} from '../dist/src/daemon/character-claims.js';
import {CharacterRhythm} from '../dist/src/daemon/character-rhythm.js';
import {CharacterGrowth} from '../dist/src/daemon/character-growth.js';
import {CharacterQualification} from '../dist/src/daemon/character-qualification.js';
import {CharacterAudit} from '../dist/src/daemon/character-audit.js';
import {CharacterReviewService} from '../dist/src/daemon/character-review-service.js';
import {exactSha256} from '../dist/src/daemon/character-admission.js';
import {CHARACTER_RISK_VERSION} from '../dist/src/daemon/character-risk.js';
import {RunCapacity} from '../dist/src/daemon/run-capacity.js';
import {FlowStore} from '../dist/src/daemon/flow-store.js';
import {PublishPolicy} from '../dist/src/daemon/publish-policy.js';
import {characterApi} from '../dist/src/daemon/character-api.js';
import {systemApi} from '../dist/src/daemon/system-api.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const store=new AgentStore(':memory:');
store.createAgent({id:'a',name:'Milo',model_id:'gpt-4o',current_status:'IDLE',budget_cap_usd:0});
const characters=new CharacterStore(store),journal=new CharacterJournal({store}),proposals=new CharacterProposals(store,characters);
characters.save('a',0,{settings:{mode:'voice'},document:{identity:{oneLine:'A careful writer.'},purpose:{statement:'Explain clearly.'},voice:{examples:['One clear example.','Another useful observation.','A third careful example.'].map((text,i)=>({id:`ex-${i}`,text,surface:'post',pinned:i<2,tags:[],origin:'owner'}))}}});
store.createTaskRun({id:'setup',agentId:'a',taskName:'Fixture setup',modelId:'gpt-4o'});
const proposal=proposals.create({agentId:'a',runId:'setup',kind:'change',value:{draft:{document:{identity:{oneLine:'A warmer writer.'}}},bundles:[],assumptions:[]}});
const qualification=new CharacterQualification(store),audit=new CharacterAudit(store,qualification,()=>0),reviewService=new CharacterReviewService(store);
const u=journal.createUtterance({agentId:'a',runId:'setup',op:'post',version:1});
const text='Synthetic held candidate for the isolated UI check.';
const c=journal.recordCandidate({agentId:'a',utteranceId:u.id,attempt:1,text,exactSha256:exactSha256(text),textSha256:exactSha256(text),version:1,selection:{},evidence:[],rules:{}});
qualification.stamp(c.id,{agentId:'a',authorModel:'gpt-4o',authorConnection:null,reviewerModel:'gpt-4o',reviewerConnection:null,weightsSha256:null,language:'en',surface:'public-post',characterVersion:1,riskVersion:CHARACTER_RISK_VERSION,rubricVersion:'review/1',servedModelKnown:true});
journal.hold(u.id,'semantic-failed','failed');
const capacity=new RunCapacity(1),flows=new FlowStore(store);
store.createRoutine({id:'routine',agentId:'a',name:'Paused fixture',cronExpression:'0 * * * *',promptTemplate:'Fixture only',nextRunAt:Date.now(),enabled:false});
flows.noteRejected({agentId:'a',routineId:'routine',flowKey:'fixture',origin:'https://x.com',probe:'x',runId:'setup',reason:'Synthetic trace has no reusable steps.'});
const unavailable=()=>{throw new Error('Provider calls are disabled in this fixture.');};
const growth=new CharacterGrowth({store,characters,proposals,capacity,ledger:{},llm:{chat:unavailable},notify:unavailable});
const character=characterApi({store,characters,journal,proposals,claims:new CharacterClaims(store,characters,journal),rhythm:new CharacterRhythm(store,characters),growth,audit,qualification,reviewService});
const api=systemApi({store,character,flows,currentFlowKey:()=> 'fixture',publishPolicy:new PublishPolicy(store,[]),capacity,missions:{list:()=>[]},memory:{list:()=>[],vaultStatus:()=>({})},retention:{},abort:()=>false});
const fixture={name:'isolated-character-preview',configureServer(server){
  server.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url??'/', 'http://127.0.0.1:5189');
    if(url.pathname==='/__fixture'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({proposalId:proposal.proposalId}));return;}
    if(/^\/(api|health|ws)(\/|$)/.test(url.pathname)){
      if(!url.pathname.startsWith('/api/system')){res.writeHead(404);res.end('Unavailable in isolated fixture');return;}
      try {let input='';for await(const chunk of req){input+=chunk;if(input.length>1048576)throw new Error('Body too large');}
        const result=await api(req.method,url,input?JSON.parse(input):undefined);
        res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}return;
    }
    if(url.pathname!=='/__character-preview')return next();
    const entry='/@fs/'+path.join(root,'scripts/fixtures/character-preview.tsx').replaceAll('\\','/');
    const html=await server.transformIndexHtml(url.pathname,`<!doctype html><html><head><title>Isolated character smoke check</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
    res.setHeader('Content-Type','text/html');res.end(html);
  });
}};
const server=await createServer({configFile:false,root:path.join(root,'web'),plugins:[fixture,react(),tailwindcss()],resolve:{dedupe:['react','react-dom'],alias:{'@kernel':path.join(root,'src'),'@':path.join(root,'web/src')}},server:{host:'127.0.0.1',port:5189,strictPort:true,proxy:{},fs:{allow:[root],deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/*.db*','**/openhours.config*.json']}}});
await server.listen();
console.log('Isolated character UI: http://127.0.0.1:5189/__character-preview');
