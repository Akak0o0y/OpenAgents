// Screen recording on the bot's own desktop.
//
// The desktop could take stills and nothing else, so a request to record what it was
// doing had no answer at all. Recording spans other actions - start, work, stop - so it
// runs as a long-lived process here rather than as a command that must finish.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SECONDS = 900;
const DEFAULT_FPS = 15;
/** The monitor of the null sink the desktop creates at start-up: what the machine is
 * playing, which is what a person watching the screen would hear. */
const AUDIO_SOURCE = 'openhours.monitor';
/** Below this a file is a container header with no frames in it. */
const MIN_USABLE_BYTES = 1024;
let current;

/** Whether this desktop actually has the sink a recording would read from. */
export function audioAvailable(runFn = execFileSync) {
  try {
    return String(runFn('pactl', ['list', 'short', 'sources'], { encoding: 'utf8', timeout: 4000 })).includes(AUDIO_SOURCE);
  } catch { return false; }
}

const home = () => process.env.HOME ?? '/home/bot';
const videos = () => path.join(home(), 'Videos');

export function recordingStatus() {
  if (!current) return { recording: false };
  return {
    recording: true,
    path: path.relative(home(), current.path),
    seconds: Math.round((Date.now() - current.startedAt) / 1000),
    limitSeconds: current.limitSeconds,
  };
}

export function validateRecordInput(input) {
  if (!input || !['start', 'stop', 'status'].includes(input.operation)) {
    throw new Error('Unknown recording operation. Use start, stop or status.');
  }
  if (input.operation === 'start') {
    const seconds = input.maxSeconds ?? MAX_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > MAX_SECONDS) {
      throw new Error(`Supply maxSeconds between 5 and ${MAX_SECONDS}.`);
    }
    if (input.audio !== undefined && typeof input.audio !== 'boolean') throw new Error('audio must be true or false.');
    const fps = input.fps ?? DEFAULT_FPS;
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('Supply fps between 1 and 30.');
  }
}

export async function startRecording(input = {}, spawnFn = spawn, hasAudio = audioAvailable) {
  validateRecordInput({ ...input, operation: 'start' });
  if (current) throw new Error(`A recording is already running (${recordingStatus().seconds}s). Stop it before starting another.`);
  await fs.mkdir(videos(), { recursive: true });
  const limitSeconds = input.maxSeconds ?? MAX_SECONDS;
  const file = path.join(videos(), `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`);
  // yuv420p and faststart are what make the result playable in a browser and on the
  // sites it gets uploaded to; the defaults produce a file many players refuse.
  // Asking for sound and silently getting none is worse than being told there is none,
  // so an unavailable sink refuses here rather than producing a mute file.
  const wantsAudio = input.audio === true;
  if (wantsAudio && !hasAudio()) {
    throw new Error('This desktop has no working sound device, so audio cannot be recorded. Record without audio, or report that sound is unavailable.');
  }
  // An idle sink emits nothing, so a recorder reading its monitor starves and writes a
  // container header with no frames - measured as a 262-byte file that no player opens.
  // Feeding it silence keeps the monitor flowing; anything Chrome plays mixes on top.
  // It lives only as long as the recording that needs it.
  const silence = wantsAudio
    ? spawnFn('pacat', ['--playback', '-d', 'openhours', '--raw', '/dev/zero'], { stdio: 'ignore', env: process.env })
    : undefined;
  // The sink does not reach RUNNING the instant the feeder starts, and an ffmpeg that
  // begins first still finds an empty monitor. Waiting is what makes the audio track
  // appear at all: without it the capture held one video frame and no audio stream.
  if (silence) await new Promise(resolve => setTimeout(resolve, 500));
  const child = spawnFn('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'x11grab', '-framerate', String(input.fps ?? DEFAULT_FPS), '-i', process.env.DISPLAY ?? ':1',
    ...(wantsAudio ? ['-f', 'pulse', '-i', AUDIO_SOURCE] : []),
    '-t', String(limitSeconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ...(wantsAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    file,
  ], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':1' } });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const state = { child, silence, path: file, startedAt: Date.now(), limitSeconds, stderr: () => stderr };
  const stopSilence = () => { try { silence?.kill('SIGTERM'); } catch { /* already gone */ } };
  child.once('exit', () => { stopSilence(); if (current === state) current = { ...state, ended: true }; });
  current = state;
  return { recording: true, path: path.relative(home(), file), limitSeconds };
}

export async function stopRecording() {
  if (!current) throw new Error('No recording is running.');
  const state = current;
  const child = state.child;
  // SIGINT, never SIGKILL: ffmpeg has to write the moov atom on the way out. A killed
  // recording leaves a file that exists, has bytes, and no player will open.
  if (child.exitCode === null && child.signalCode === null) {
    // Listen first: ffmpeg can finish writing and exit before a listener attached
    // afterwards would hear it, leaving the stop to wait out its whole timeout.
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGINT');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      current = undefined;
      throw new Error('The recorder did not stop cleanly, so the video may be unplayable. Check the file before using it.');
    }
  }
  try { state.silence?.kill('SIGTERM'); } catch { /* already gone */ }
  current = undefined;
  let size = 0;
  try { size = (await fs.stat(state.path)).size; } catch { /* reported as zero below */ }
  // A zero-byte check was not enough: a failed capture still leaves a container header,
  // which was reported as a successful 262-byte recording that no player can open.
  // Anything below a kilobyte holds no frames.
  if (size < MIN_USABLE_BYTES) {
    throw new Error(`The recording produced no usable video (${size} bytes). ffmpeg reported: ${state.stderr?.() || 'no output'}`);
  }
  return {
    recording: false,
    path: path.relative(home(), state.path),
    bytes: size,
    seconds: Math.round((Date.now() - state.startedAt) / 1000),
  };
}
