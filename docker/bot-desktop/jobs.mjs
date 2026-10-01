// Work the bot starts and comes back to.
//
// A one-shot command waits for its own exit and is killed at five minutes, so anything
// that outlives a single step - a server, a long download, a render, a screen recording
// running while other work happens - was impossible. A person starts those and walks
// away; these do the same. A job belongs to this container, not to the run that started
// it, so it survives the bot finishing its turn and dies only when the desktop stops.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveInHome, childEnv } from './exec.mjs';

const MAX_JOBS = 8;
const MAX_LOG = 2 * 1024 * 1024;
const MAX_TAIL = 100000;
const MAX_COMMAND = 8000;

/** id -> { id, command, child, log, startedAt, endedAt, exitCode, signal, bytes, truncated } */
const jobs = new Map();

const home = () => process.env.HOME ?? '/home/bot';
const logDir = () => path.join(home(), '.openhours', 'jobs');
const running = (job) => job.child.exitCode === null && job.child.signalCode === null;

function describe(job) {
  return {
    jobId: job.id,
    command: job.command.slice(0, 200),
    running: running(job),
    exitCode: running(job) ? undefined : job.child.exitCode,
    signal: job.child.signalCode ?? undefined,
    seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    logBytes: job.bytes,
    truncated: job.truncated || undefined,
  };
}

export function validateJobInput(input) {
  if (!input || !['start', 'list', 'output', 'stop'].includes(input.operation)) {
    throw new Error('Unknown job operation. Use start, list, output or stop.');
  }
  if (input.operation === 'start') {
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('Supply a command to run.');
    if (input.command.length > MAX_COMMAND) throw new Error(`Commands are limited to ${MAX_COMMAND} characters.`);
    if (input.command.includes('\0')) throw new Error('A command may not contain a null byte.');
    resolveInHome(input.cwd);
  }
  if ((input.operation === 'output' || input.operation === 'stop') && !/^[a-f0-9]{8}$/.test(String(input.jobId ?? ''))) {
    throw new Error('Supply a jobId from the start or list operation.');
  }
}

export async function startJob(input, spawnFn = spawn) {
  validateJobInput({ ...input, operation: 'start' });
  const live = [...jobs.values()].filter(running);
  if (live.length >= MAX_JOBS) {
    throw new Error(`${MAX_JOBS} background jobs are already running. Stop one before starting another.`);
  }
  await fsp.mkdir(logDir(), { recursive: true });
  const id = randomBytes(4).toString('hex');
  const log = path.join(logDir(), `${id}.log`);
  const handle = await fsp.open(log, 'w');
  const child = spawnFn('/bin/bash', ['-lc', input.command], {
    cwd: resolveInHome(input.cwd),
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping the job stops what it spawned too.
    detached: true,
  });
  const job = { id, command: input.command, child, log, startedAt: Date.now(), bytes: 0, truncated: false, handle };
  const append = (chunk) => {
    if (job.bytes >= MAX_LOG) { job.truncated = true; return; }
    const room = MAX_LOG - job.bytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (slice.length < chunk.length) job.truncated = true;
    job.bytes += slice.length;
    handle.write(slice).catch(() => {});
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('exit', () => {
    job.endedAt = Date.now();
    handle.close().catch(() => {});
  });
  child.once('error', () => { job.endedAt = Date.now(); });
  child.unref();
  jobs.set(id, job);
  return { ...describe(job), log: path.relative(home(), log) };
}

export function listJobs() {
  return { jobs: [...jobs.values()].map(describe) };
}

export async function jobOutput(input) {
  validateJobInput({ ...input, operation: 'output' });
  const job = jobs.get(input.jobId);
  if (!job) throw new Error(`No job ${input.jobId}. Use the list operation to see current jobs.`);
  let output = '';
  try {
    const stat = await fsp.stat(job.log);
    const start = Math.max(0, stat.size - MAX_TAIL);
    const handle = await fsp.open(job.log, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_TAIL));
      await handle.read(buffer, 0, buffer.length, start);
      output = buffer.toString('utf8');
    } finally { await handle.close(); }
    if (start > 0) output = `[earlier output omitted]\n${output}`;
  } catch { output = ''; }
  return { ...describe(job), output };
}

/** Signal the job's whole process group: a shell that started children would otherwise
 * leave them running with nothing left to report what happened to them. Injectable
 * because process-group signals do not exist on every host these tests run on. */
function signalProcessGroup(job, signal) {
  try { process.kill(-job.child.pid, signal); }
  catch { try { job.child.kill(signal); } catch { /* already gone */ } }
}

export async function stopJob(input, signalGroupFn = signalProcessGroup) {
  validateJobInput({ ...input, operation: 'stop' });
  const job = jobs.get(input.jobId);
  if (!job) throw new Error(`No job ${input.jobId}. Use the list operation to see current jobs.`);
  if (!running(job)) return { ...describe(job), stopped: false, note: 'That job had already ended.' };
  const signalGroup = (signal) => signalGroupFn(job, signal);
  // Listen first. A process that exits promptly emits before a listener attached
  // afterwards could hear it, and the stop would then wait out its whole timeout and
  // SIGKILL something that had already gone.
  const exited = new Promise(resolve => job.child.once('exit', resolve));
  signalGroup('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (running(job)) signalGroup('SIGKILL');
  // The command exiting does not mean its group is empty: a shell that backgrounded
  // something leaves those children running, and nothing would ever reap them. This
  // sweep is harmless when the group is already gone.
  signalGroup('SIGKILL');
  return { ...describe(job), stopped: true };
}

/** Stop everything on shutdown so no job outlives the desktop that owns it. */
export function stopAllJobs() {
  for (const job of jobs.values()) {
    if (!running(job)) continue;
    try { process.kill(-job.child.pid, 'SIGKILL'); } catch { try { job.child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

export function executeJob(input) {
  validateJobInput(input);
  if (input.operation === 'start') return startJob(input);
  if (input.operation === 'list') return listJobs();
  if (input.operation === 'output') return jobOutput(input);
  return stopJob(input);
}

/** Only for tests: forget every job without touching real processes. */
export function resetJobsForTest() { jobs.clear(); }
