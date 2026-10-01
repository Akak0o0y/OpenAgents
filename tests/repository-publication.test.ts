import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { RepositoryPublication, GitHubError } from '../src/daemon/repository-publication.js';
import { repositoryWorkContract, workTaskDefinition } from '../src/daemon/work-contract.js';
import { saveWorkResult, readWorkResult } from '../src/daemon/work-results.js';
const BASE = 'a'.repeat(40), TREE = 'b'.repeat(40), COMMIT = 'c'.repeat(40);

test('publication binds binary blobs and deletions to the reviewed artifact manifest',async()=>{
  const h=fixture();const old=readWorkResult(h.store,h.run.id)!;
  h.artifacts.save(h.run.id,{'openhours-review/changes.json':JSON.stringify({version:1,deleted:['obsolete.txt'],binary:['image.bin']})});
  const all=h.artifacts.saveBinary(h.run.id,{'image.bin':Buffer.from([0,255,42])});
  saveWorkResult(h.store,h.run.id,{...old,artifacts:all});let sawDelete=false,sawBinary=false;
  const call:typeof h.call=async(repo,method,endpoint,body)=>{
    if(endpoint.startsWith('/git/trees/')&&method==='GET')return{tree:[{path:'src/index.js',mode:'100755',type:'blob'},{path:'obsolete.txt',mode:'100644',type:'blob'}],truncated:false};
    if(endpoint==='/git/blobs'){assert.equal(body.encoding,'base64');assert.equal(body.content,'AP8q');sawBinary=true;return{sha:'d'.repeat(40)};}
    if(endpoint==='/git/trees'){assert(body.tree.some((e:any)=>e.path==='obsolete.txt'&&e.sha===null));assert(body.tree.some((e:any)=>e.path==='image.bin'&&e.sha==='d'.repeat(40)));sawDelete=true;return{sha:TREE};}
    return h.call(repo,method,endpoint,body);
  };
  const service=new RepositoryPublication(h.store,h.artifacts,call,()=>true);const p=await service.preview(h.run.id,'main','Binary update');assert(p.files.some(f=>f.content===null));
  await service.publish(h.run.id,p.digest);assert(sawBinary&&sawDelete);h.store.close();
});
function fixture() {
  const store = new AgentStore(':memory:'); const artifacts = new ArtifactStore(store);
  store.createAgent({ id:'bot',name:'Bot',model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE' });
  const run = store.createTaskRun({agentId:'bot',taskName:'repo'});
  store.setRunDefinition(run.id,workTaskDefinition(repositoryWorkContract({owner:'owner',repo:'repo',ref:'main',commit:BASE},'npm test','none','Fix'),'Fix'));
  store.startTaskRun(run.id,'claude-haiku-4-5');
  const files = artifacts.save(run.id, {'src/index.js':'export const value = 1;', 'openhours-review/verification.txt':'Tests passed'});
  saveWorkResult(store,run.id,{outcome:'COMPLETED',report:'Done',artifacts:files,turns:3,inputTokens:1,outputTokens:1,actualCostUsd:0,shadowCostUsd:0});
  store.finishTaskRun(run.id,'COMPLETED');
  const calls: string[] = []; let branch: string | undefined; let pulls: any[] = []; let uncertain = false; let currentBase = BASE;
  const call = async (_repo:string,method:'GET'|'POST',endpoint:string,body?:any) => {
    calls.push(`${method} ${endpoint}`);
    if (endpoint === '/git/ref/heads/main') return {object:{sha:currentBase}};
    if (endpoint.startsWith('/git/ref/heads/')) { if (!branch) throw new GitHubError(404); return {object:{sha:COMMIT}}; }
    if (endpoint.startsWith('/git/commits/') && method === 'GET') return {tree:{sha:TREE}};
    if (endpoint.startsWith('/git/trees/') && method === 'GET') return {tree:[{path:'src/index.js',mode:'100755',type:'blob'}],truncated:false};
    if (endpoint === '/git/trees') { assert.equal(body.tree[0].mode,'100755'); return {sha:TREE}; }
    if (endpoint === '/git/commits') return {sha:COMMIT};
    if (endpoint === '/git/refs') { branch = body.ref.replace('refs/heads/',''); return {ref:body.ref}; }
    if (endpoint.startsWith('/pulls?')) return pulls;
    if (endpoint === '/pulls') {
      assert.equal(body.draft,true);
      const pr = {html_url:'https://github.com/owner/repo/pull/12',head:{sha:COMMIT,ref:branch},base:{ref:'main'}};
      pulls = [pr]; if (uncertain) throw new Error('Lost response after remote commit'); return pr;
    }
    throw new Error(`Unexpected ${endpoint}`);
  };
  return {store,artifacts,run,calls,call,service:new RepositoryPublication(store,artifacts,call,()=>true),
    loseResponse:()=>{uncertain=true;},moveBase:()=>{currentBase='d'.repeat(40);},hidePull:()=>{pulls=[];}};
}
test('publication requires exact preview, preserves modes, creates one draft and replays its evidence', async () => {
  const h=fixture();
  await assert.rejects(h.service.publish(h.run.id,'bad'),/preview/);
  const p=await h.service.preview(h.run.id,'main','Fix value');
  assert(!h.calls.some(c=>c.startsWith('POST')));
  const result=await h.service.publish(h.run.id,p.digest);
  assert.equal(result.url,'https://github.com/owner/repo/pull/12');
  assert.deepEqual(await new RepositoryPublication(h.store,h.artifacts,h.call,()=>true).publish(h.run.id,p.digest),result);
  assert.equal(h.calls.filter(c=>c==='POST /pulls').length,1); h.store.close();
});
test('changed artifacts and a moved base cannot be published', async () => {
  const h=fixture(); const p=await h.service.preview(h.run.id,'main','Fix');
  h.store.getDatabase().prepare("UPDATE run_artifacts SET content='tampered' WHERE path='src/index.js'").run();
  await assert.rejects(h.service.publish(h.run.id,p.digest),/artifact changed/i);
  assert(!h.calls.some(c=>c.startsWith('POST'))); h.store.close();
  const h2=fixture(); const p2=await h2.service.preview(h2.run.id,'main','Fix'); h2.moveBase();
  await assert.rejects(h2.service.publish(h2.run.id,p2.digest),/base branch moved/); h2.store.close();
});
test('restart reconciles an uncertain PR POST and never blindly repeats it', async () => {
  const h=fixture(); h.loseResponse(); const p=await h.service.preview(h.run.id,'main','Fix');
  await assert.rejects(h.service.publish(h.run.id,p.digest),/Lost response/);
  const restarted=new RepositoryPublication(h.store,h.artifacts,h.call,()=>true);
  h.hidePull(); await assert.rejects(restarted.publish(h.run.id,p.digest),/uncertain/);
  assert.equal(h.calls.filter(c=>c==='POST /pulls').length,1); h.store.close();
  const h2=fixture(); h2.loseResponse(); const p2=await h2.service.preview(h2.run.id,'main','Fix');
  await assert.rejects(h2.service.publish(h2.run.id,p2.digest));
  const result=await new RepositoryPublication(h2.store,h2.artifacts,h2.call,()=>true).publish(h2.run.id,p2.digest);
  assert.equal(result.commit,COMMIT); assert.equal(h2.calls.filter(c=>c==='POST /pulls').length,1); h2.store.close();
});
