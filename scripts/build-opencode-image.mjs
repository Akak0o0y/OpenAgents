#!/usr/bin/env node
/**
 * Build the OpenCode agent image on any platform.
 *
 * Replaces an npm script that hardcoded `wsl.exe -d Ubuntu-22.04 docker build`
 * with an absolute /mnt/c/... path, which only ever worked on one machine.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerArgv, resolveDockerHost } from '../dist/src/kernel/docker-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const host = resolveDockerHost();

const context = host.hostPath(path.join(repoRoot, 'docker'));
const dockerfile = host.hostPath(path.join(repoRoot, 'docker', 'opencode-agent.Dockerfile'));
const tag = process.env.OPENCODE_IMAGE ?? 'openhours/opencode-agent:1.18.28';

console.log(`Building ${tag} via ${host.describe()}`);
const argv = dockerArgv(['build', '-f', dockerfile, '-t', tag, context], host);
const res = spawnSync(argv.command, argv.args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
