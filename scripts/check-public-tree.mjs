#!/usr/bin/env node
// No secret values are printed. This complements a dedicated secret scanner.
import { execFileSync, spawnSync } from 'node:child_process';
const all=process.argv.includes('--all');
const run=(args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
const files=run(all?['ls-files','-z']:['diff','--cached','--name-only','--diff-filter=ACMR','-z']).split('\0').filter(Boolean);
const forbidden=/(?:^|\/)(?:node_modules|grokbot-reference)(?:\/|$)|^(?:data|scratch|output|\.planning|\.claude|\.superpowers|\.playwright-mcp)(?:\/|$)|(^|\/)\.env(?!\.example$)|(?:^|\/)openhours\.config(?:\.dev)?\.json$|\.(?:db(?:-wal|-shm)?|sqlite3?|auth\.json|log|pem|p12|pfx|key)$|\.timestamp-.*\.mjs$/i;
const markers=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['personal-home-path',/[A-Z]:[\\/]+Users[\\/]+(?!me\b|user\b|example\b|test\b|runneradmin\b|Public\b|YourName\b|you\b|someone\b|x\b|<)[A-Za-z0-9._-]+[\\/]/i],['signed-download-url',/[?&](?:X-Amz-Signature|X-Goog-Signature)=/i]];
const findings=[];
const batch=spawnSync('git',['cat-file','--batch'],{input:files.map(file=>`:${file}`).join('\n')+'\n',maxBuffer:96*1024*1024});
if(batch.status!==0)throw new Error('Could not inspect Git index');
let offset=0;
for(const file of files){
 if(forbidden.test(file))findings.push(`${file}: excluded private/generated path`);
 const end=batch.stdout.indexOf(10,offset),header=batch.stdout.subarray(offset,end).toString();
 const size=Number(header.split(' ')[2]);
 if(!Number.isFinite(size))throw new Error(`Could not inspect ${file}`);
 const b=batch.stdout.subarray(end+1,end+1+size);offset=end+size+2;
 if(b.includes(0))continue;
 const lines=b.toString('utf8').split(/\r?\n/);
 lines.forEach((line,i)=>{for(const [kind,re]of markers)if(re.test(line))findings.push(`${file}:${i+1}: ${kind}`);});
}
if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}else console.log(`Public-tree check passed for ${files.length} staged/tracked files. Run a dedicated secret scanner too.`);
