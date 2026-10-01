/**
 * Phase 1 Security & Containment Eval Suite
 * Verifies the uncompromised Docker sandbox profile with strict positive
 * and negative controls for every security boundary:
 * 1. Fork-bomb / PID limit containment (--pids-limit 100) with deterministic process tracking
 * 2. Strict network egress blocking (--network none) vs unhardened bridge
 * 3. Read-only root filesystem (--read-only) vs unhardened mutable rootfs
 * 4. Capability drop (--cap-drop ALL) vs unhardened root capabilities
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';

test('Security Eval: Fork-bomb / PID limit containment (--pids-limit 100) with deterministic negative control', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `sec-fork-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Deterministic process spawner that awaits each spawn event
    const script = `
      import { spawn } from 'node:child_process';

      async function run() {
        let spawned = 0;
        let hitLimit = false;
        const children = [];

        for (let i = 0; i < 150; i++) {
          const p = spawn('sleep', ['60']);
          children.push(p);

          const res = await new Promise((resolve) => {
            p.on('spawn', () => resolve({ ok: true }));
            p.on('error', (err) => resolve({ ok: false, err }));
          });

          if (res.ok) {
            spawned++;
          } else {
            if (res.err && res.err.code === 'EAGAIN') {
              hitLimit = true;
            }
            break;
          }
        }

        // Clean up spawned children
        for (const c of children) {
          try { c.kill(); } catch (_) {}
        }

        if (hitLimit && spawned <= 100) {
          console.log('CONTAINED_PIDS_LIMIT_HIT: spawned=' + spawned);
          process.exit(0); // Pass: hit cgroup PID ceiling cleanly
        } else {
          console.error('INSECURE_NO_PID_LIMIT: spawned=' + spawned + ', hitLimit=' + hitLimit);
          process.exit(1); // Fail: process table unconstrained
        }
      }

      run();
    `;

    await sandbox.stageWorkspaceFiles(volumeName, { 'pid-test.mjs': script });

    // 1. Positive Control: Hardened profile (--pids-limit 100)
    const hardenedRes = await sandbox.executeTask(volumeName, 'node pid-test.mjs', { timeoutMs: 15000 });
    assert.equal(
      hardenedRes.exitCode,
      0,
      `Hardened profile must contain fork spawning. Got stdout: ${hardenedRes.stdout}, stderr: ${hardenedRes.stderr}`
    );
    assert.ok(hardenedRes.stdout.includes('CONTAINED_PIDS_LIMIT_HIT'));

    // 2. Negative Control: Deliberately unhardened profile (no pids limit)
    const unhardenedRes = await sandbox.executeTask(volumeName, 'node pid-test.mjs', {
      timeoutMs: 15000,
      _unhardenedOverrides: { pidsLimit: null }
    });
    // Negative control MUST fail containment (exit code 1)
    assert.equal(
      unhardenedRes.exitCode,
      1,
      `Negative control without --pids-limit must fail containment! Got exitCode: ${unhardenedRes.exitCode}`
    );
    assert.ok(unhardenedRes.stderr.includes('INSECURE_NO_PID_LIMIT'));
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('Security Eval: Outbound network egress blocked via --network none with negative control', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `sec-net-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Node.js script connecting to raw IP 1.1.1.1 on port 80
    const script = `
      import net from 'node:net';
      const socket = net.connect(80, '1.1.1.1');
      
      socket.on('connect', () => {
        console.error('INSECURE_NETWORK_CONNECTED');
        socket.destroy();
        process.exit(1); // Insecure: network connection succeeded!
      });

      socket.on('error', (err) => {
        console.log('CONTAINED_EGRESS_BLOCKED: ' + err.code);
        process.exit(0); // Secure: network blocked at socket layer
      });

      socket.setTimeout(3000, () => {
        console.error('TIMEOUT_UNREACHED');
        socket.destroy();
        process.exit(2);
      });
    `;
    await sandbox.stageWorkspaceFiles(volumeName, { 'net-test.mjs': script });

    // 1. Positive Control: Hardened profile (--network none)
    const hardenedRes = await sandbox.executeTask(volumeName, 'node net-test.mjs', { timeoutMs: 10000 });
    assert.equal(
      hardenedRes.exitCode,
      0,
      `Hardened profile must block egress. Got stdout: ${hardenedRes.stdout}, stderr: ${hardenedRes.stderr}`
    );
    assert.ok(
      hardenedRes.stdout.includes('CONTAINED_EGRESS_BLOCKED: ENETUNREACH') ||
      hardenedRes.stdout.includes('CONTAINED_EGRESS_BLOCKED: EHOSTUNREACH'),
      `Expected ENETUNREACH or EHOSTUNREACH, got: ${hardenedRes.stdout}`
    );
    assert.ok(!hardenedRes.stderr.includes('INSECURE_NETWORK_CONNECTED'));

    // 2. Negative Control: Deliberately unhardened profile (--network bridge)
    const unhardenedRes = await sandbox.executeTask(volumeName, 'node net-test.mjs', {
      timeoutMs: 10000,
      _unhardenedOverrides: { network: 'bridge' }
    });
    assert.equal(
      unhardenedRes.exitCode,
      1,
      `Negative control with bridge network must connect and exit 1! Got: ${unhardenedRes.exitCode}, out: ${unhardenedRes.stdout}`
    );
    assert.ok(unhardenedRes.stderr.includes('INSECURE_NETWORK_CONNECTED'));
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('Security Eval: Read-only root filesystem prevents modification with negative control', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `sec-ro-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Attempt to write outside /workspace and /tmp (e.g. /usr/pwned.txt)
    const script = `
      import fs from 'node:fs';
      try {
        fs.writeFileSync('/usr/pwned.txt', 'evil');
        console.error('INSECURE_WRITE_SUCCEEDED');
        process.exit(1); // Insecure: write to rootfs succeeded!
      } catch (err) {
        if (err.code === 'EROFS') {
          console.log('CONTAINED_EROFS_BLOCKED: EROFS');
          process.exit(0); // Secure: read-only rootfs blocked write
        } else {
          console.error('UNEXPECTED_ERROR: ' + err.code);
          process.exit(2);
        }
      }
    `;
    await sandbox.stageWorkspaceFiles(volumeName, { 'ro-test.mjs': script });

    // 1. Positive Control: Hardened profile (--read-only)
    const hardenedRes = await sandbox.executeTask(volumeName, 'node ro-test.mjs', { timeoutMs: 10000 });
    assert.equal(
      hardenedRes.exitCode,
      0,
      `Hardened profile must block write with EROFS. Got: ${hardenedRes.stdout}, stderr: ${hardenedRes.stderr}`
    );
    assert.ok(hardenedRes.stdout.includes('CONTAINED_EROFS_BLOCKED: EROFS'));

    // 2. Negative Control: Deliberately unhardened profile (mutable rootfs)
    const unhardenedRes = await sandbox.executeTask(volumeName, 'node ro-test.mjs', {
      timeoutMs: 10000,
      _unhardenedOverrides: { readOnly: false }
    });
    assert.equal(
      unhardenedRes.exitCode,
      1,
      `Negative control with mutable rootfs must permit write and exit 1! Got exitCode: ${unhardenedRes.exitCode}`
    );
    assert.ok(unhardenedRes.stderr.includes('INSECURE_WRITE_SUCCEEDED'));
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('Security Eval: Dropped capabilities prevent chown with negative control', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `sec-caps-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Attempt privileged chown operation inside /tmp
    const script = `
      import fs from 'node:fs';
      fs.writeFileSync('/tmp/caps_target.txt', 'test');
      try {
        fs.chownSync('/tmp/caps_target.txt', 1000, 1000);
        console.error('INSECURE_CHOWN_ALLOWED');
        process.exit(1); // Insecure: CAP_CHOWN permitted!
      } catch (err) {
        if (err.code === 'EPERM') {
          console.log('CONTAINED_EPERM_BLOCKED: EPERM');
          process.exit(0); // Secure: CAP_CHOWN dropped!
        } else {
          console.error('UNEXPECTED_ERROR: ' + err.code);
          process.exit(2);
        }
      }
    `;
    await sandbox.stageWorkspaceFiles(volumeName, { 'caps-test.mjs': script });

    // 1. Positive Control: Hardened profile (--cap-drop ALL)
    const hardenedRes = await sandbox.executeTask(volumeName, 'node caps-test.mjs', { timeoutMs: 10000 });
    assert.equal(
      hardenedRes.exitCode,
      0,
      `Hardened profile must drop CAP_CHOWN and return EPERM. Got: ${hardenedRes.stdout}`
    );
    assert.ok(hardenedRes.stdout.includes('CONTAINED_EPERM_BLOCKED: EPERM'));
    assert.ok(!hardenedRes.stderr.includes('INSECURE_CHOWN_ALLOWED'));

    // 2. Negative Control: Deliberately unhardened profile (default root capabilities)
    const unhardenedRes = await sandbox.executeTask(volumeName, 'node caps-test.mjs', {
      timeoutMs: 10000,
      _unhardenedOverrides: { capDrop: null }
    });
    assert.equal(
      unhardenedRes.exitCode,
      1,
      `Negative control with default capabilities must succeed chown and exit 1! Got: ${unhardenedRes.exitCode}`
    );
    assert.ok(unhardenedRes.stderr.includes('INSECURE_CHOWN_ALLOWED'));
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});
