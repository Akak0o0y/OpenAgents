import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';

const fakeDocker = (script: string) => new DockerSandbox({command:process.execPath,prefixArgs:['-e',script,'--'],hostPath:p=>p,kind:'native',describe:()=> 'Controlled Docker fixture'});
test('an unresponsive Docker CLI has a bounded total cleanup deadline', async () => {
  const started = Date.now();
  await assert.rejects(fakeDocker('setInterval(()=>{},1000)').orphanSweep({forceAll:true,timeoutMs:150}), /timed out/);
  assert.ok(Date.now()-started < 2500, 'cleanup must not wait another minute for volume listing');
});
test('failed Docker cleanup is deferred instead of being reported as a successful empty sweep', async () => {
  await assert.rejects(fakeDocker('process.exit(42)').orphanSweep({forceAll:true,timeoutMs:2000}), /cleanup failed/);
});
