// In-memory display fixture. No daemon, provider, account, scheduler or Docker.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../web/node_modules/vite/dist/node/index.js';
import react from '../web/node_modules/@vitejs/plugin-react/dist/index.js';
import tailwindcss from '../web/node_modules/@tailwindcss/vite/dist/index.mjs';
import {createDefaultCharacterDocument,createDefaultCharacterSettings} from '../dist/src/daemon/character-schema.js';
const root=fileURLToPath(new URL('../',import.meta.url));
let requirements=[{id:'report',kind:'artifact',description:'A concise research report with source links',required:true,target:'reports/morning-brief.html',acceptance:{receipt:'created',contains:[],verifier:'artifact/1'},dependencies:[]},{id:'legacy-publication',kind:'publication',description:'Existing required publication',required:true,target:'https://x.com',acceptance:{receipt:'published',contains:[],verifier:'stage1/1'},dependencies:[]}];
const system={missions:[],memory:[],vault:{configured:false},capacity:{used:0,limit:2},pendingEffects:[],publishPolicies:[{routineId:'morning',origin:'https://x.com',required:true,source:'owner',evidenceRunId:null,createdAt:1790582400000,updatedAt:1790582400000}],browser:{enabled:true,ready:true,installing:false,error:null,active:0,limit:2,sessions:[],autonomy:'accounts',connections:[{site:'example.org',verified:false,updatedAt:1}],accounts:[]}};
const fixture={name:'workspace-preview',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url??'/','http://127.0.0.1:5191');
  if(url.pathname.startsWith('/api/')||url.pathname==='/health'||url.pathname==='/ws'){
    let body; let status=200;
    if(url.pathname==='/api/system/browser-live') body={available:false};
    else if(url.pathname==='/api/system') body=system;
    else if(url.pathname==='/api/providers') body={connections:[]};
    else if(url.pathname==='/api/docker') body={docker:null};
    else if(url.pathname==='/health') body={port:5191};
    else if(url.pathname==='/api/system/character') body={version:1,document:createDefaultCharacterDocument('Milo'),settings:createDefaultCharacterSettings(),reviewerOptions:[],versions:[]};
    else if(url.pathname==='/api/system/expected-results') {if(req.method==='POST'){let input='';for await(const chunk of req){input+=chunk;if(input.length>65536){res.writeHead(413);res.end();return;}}try{requirements=JSON.parse(input).requirements;}catch{status=400;}}body={requirements};}
    else if(url.pathname==='/api/system/routine-attention') body={held:false,code:null,reason:null};
    else if(url.pathname.startsWith('/api/routines/')&&url.pathname.endsWith('/runs')) body={runs:[{id:'demo-failed',status:'FAILED',started_at:Date.now()-3600000,actual_cost_usd:0,error_message:'The source website was unavailable. No message was sent. The report remains available for review.'},{id:'demo-done',status:'COMPLETED',started_at:Date.now()-86400000,actual_cost_usd:0.014,error_message:null}]};
    else {status=404;body={error:'This action is unavailable in the isolated preview.'};}
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));return;
  }
  if(url.pathname!=='/__workspace-preview')return next();
  const entry='/@fs/'+path.join(root,'scripts/fixtures/workspace-preview.tsx').replaceAll('\\','/');
  const html=await server.transformIndexHtml(url.pathname,`<!doctype html><html><head><title>Workspace design preview</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
  res.setHeader('Content-Type','text/html');res.end(html);
});}};
const server=await createServer({configFile:false,root:path.join(root,'web'),plugins:[fixture,react(),tailwindcss()],resolve:{dedupe:['react','react-dom'],alias:{'@kernel':path.join(root,'src'),'@':path.join(root,'web/src')}},server:{host:'127.0.0.1',port:5191,strictPort:true,proxy:{},fs:{allow:[root],deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/*.db*','**/openhours.config*.json']}}});
await server.listen();console.log('Isolated workspace UI: http://127.0.0.1:5191/__workspace-preview');
