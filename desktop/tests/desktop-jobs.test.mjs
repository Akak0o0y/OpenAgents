import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-jobs-'));
process.env.HOME = home;
const { validateJobInput, startJob, listJobs, jobOutput, stopJob, resetJobsForTest } =
  await import('../../docker/bot-desktop/jobs.mjs');

/** A stand-in child. Real process behaviour is exercised in the container. */
function childSpawn({ stdout = '', stderr = '', exitAfterMs = null } = {}, seen = []) {
  return (file, args, options) => {
    seen.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 90000 + seen.length;
    child.stdout = Readable.from(stdout ? [Buffer.from(stdout)] : []);
    child.stderr = Readable.from(stderr ? [Buffer.from(stderr)] : []);
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); return true; };
    child.unref = () => {};
    if (exitAfterMs !== null) setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, exitAfterMs);
    return child;
  };
}

test('a job starts without waiting and is confined like any other command', async () => {
  resetJobsForTest();
  for (const input of [
    { operation: 'start', command: '' },
    { operation: 'start', command: 'ls', cwd: '../..' },
    { operation: 'start', command: 'ls\0rm' },
    { operation: 'output', jobId: 'nope' },
    { operation: 'stop', jobId: '../../etc' },
    { operation: 'launch' },
  ]) assert.throws(() => validateJobInput(input), `expected ${JSON.stringify(input)} to be refused`);

  const seen = [];
  const started = await startJob({ command: 'sleep 600' }, childSpawn({}, seen));
  assert.match(started.jobId, /^[a-f0-9]{8}$/);
  assert.equal(started.running, true, 'start must not wait for the command to finish');
  assert.equal(seen[0].options.cwd, path.resolve(home));
  // Its own process group, so stopping it stops what it spawned.
  assert.equal(seen[0].options.detached, true);
  assert.equal(seen[0].options.env.OPENHOURS_SECRET_PROBE, undefined);
  assert.equal(seen[0].options.env.NPM_CONFIG_PREFIX, `${home}/.npm-global`);
});

test('output is readable while the job is still running', async () => {
  resetJobsForTest();
  const started = await startJob({ command: 'build' }, childSpawn({ stdout: 'compiling\n', stderr: 'warning\n' }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const read = await jobOutput({ jobId: started.jobId });
  assert.equal(read.running, true);
  assert.match(read.output, /compiling/);
  assert.match(read.output, /warning/, 'stderr belongs in the same log a person would read');
  assert.equal(listJobs().jobs.length, 1);
  await assert.rejects(jobOutput({ jobId: 'deadbeef' }), /No job deadbeef/);
});

test('a job is asked to stop before it is killed, and the whole group is signalled', async () => {
  resetJobsForTest();
  const started = await startJob({ command: 'serve' }, childSpawn({}));
  const signals = [];
  // Stands in for the real process-group kill, which no Windows host can perform.
  const signalGroup = (job, signal) => { signals.push(signal); job.child.kill(signal); };
  const stopped = await stopJob({ jobId: started.jobId }, signalGroup);
  // SIGTERM first: a job that goes quietly is always asked before it is killed. The
  // SIGKILL that follows sweeps the process group, because the command exiting does not
  // mean the group is empty - bash execs into its last command, so anything it
  // backgrounded outlives it. Verified in a real container.
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(signals[0], 'SIGTERM', 'nothing may be killed before it is asked to stop');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.running, false);
  const again = await stopJob({ jobId: started.jobId }, signalGroup);
  assert.equal(again.stopped, false);
  assert.match(again.note, /already ended/);
});

test('a job that ignores SIGTERM is killed rather than left running', async () => {
  resetJobsForTest();
  const started = await startJob({ command: 'stubborn' }, childSpawn({}));
  const signals = [];
  const signalGroup = (job, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') job.child.kill(signal); // only the second signal lands
  };
  const stopped = await stopJob({ jobId: started.jobId }, signalGroup);
  // Escalation, then the same group sweep: asked, killed, then nothing left behind.
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
  assert.equal(stopped.stopped, true);
});

test('the number of concurrent jobs is bounded', async () => {
  resetJobsForTest();
  for (let i = 0; i < 8; i++) await startJob({ command: `job ${i}` }, childSpawn({}));
  await assert.rejects(startJob({ command: 'one too many' }, childSpawn({})), /already running/);
});

test.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
