import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{execFileSync,spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
const checker=fileURLToPath(new URL('./check-public-tree.mjs',import.meta.url));
test('publication check rejects private staged content but permits source data and binary media',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-tree-fixture-'));
 const git=(args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
 try{
  git(['init','-q']);fs.mkdirSync(path.join(dir,'web/src/data'),{recursive:true});
  fs.writeFileSync(path.join(dir,'web/src/data/example.ts'),'export const value = 1;');
  fs.writeFileSync(path.join(dir,'image.png'),Buffer.from([0,1,2,3]));git(['add','.']);
  const run=()=>spawnSync(process.execPath,[checker],{cwd:dir,encoding:'utf8'});
  assert.equal(run().status,0);
  fs.writeFileSync(path.join(dir,'.env'),'EXAMPLE=not-a-real-credential');git(['add','.env']);
  assert.equal(run().status,1);git(['rm','--cached','.env']);
  fs.writeFileSync(path.join(dir,'bad.txt'),['-----BEGIN ','PRIVATE KEY-----'].join(''));git(['add','bad.txt']);
  assert.equal(run().status,1);
  // Inspect the staged version, not a harmless replacement in the working tree.
  fs.writeFileSync(path.join(dir,'bad.txt'),'safe');assert.equal(run().status,1);
  git(['add','bad.txt']);assert.equal(run().status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
