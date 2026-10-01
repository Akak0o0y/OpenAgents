import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceGuidance } from '../src/daemon/workspace-guidance.js';
import { contextChars, pruneToolResult } from '../src/daemon/context-budget.js';
import { availableTools } from '../src/daemon/tool-schemas.js';

const skill = (name: string, body = 'Read src/app.ts before editing.', extra = '') =>
  `---\nname: ${name}\ndescription: >-\n  Safely review\n  the application.\n${extra}---\n${body}`;

test('catalogue discovers bounded summaries and loads exact snapshot bodies on demand', () => {
  const files = { '.agents/skills/review/SKILL.md': skill('review') };
  const guidance = new WorkspaceGuidance(files);
  files['.agents/skills/review/SKILL.md'] = 'changed after snapshot';
  assert.equal(guidance.catalog()[0].description, 'Safely review the application.');
  assert.ok(!JSON.stringify(guidance.catalog()).includes('src/app.ts'));
  assert.equal(guidance.loadSkill('review').body, 'Read src/app.ts before editing.');
  assert.equal(guidance.loadSkill('review').resourceBase, '.agents/skills/review');
  assert.match(guidance.loadSkill('review').sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => guidance.loadSkill('../outside'), /not in this workspace/);
  assert.ok(!availableTools({}).some(t => t.name === 'skill'));
  assert.ok(availableTools({ hasSkills: true }).some(t => t.name === 'skill'));
});

test('priority, disabled invocation, flat skills and invalid metadata are handled explicitly', () => {
  const guidance = new WorkspaceGuidance({
    '.openhours/skills/review/SKILL.md': skill('review', 'private', 'disable-model-invocation: true\n'),
    '.agents/skills/review/SKILL.md': skill('review'),
    '.dsh/skills/build.md': skill('build', 'Run the existing tests.'),
    '.agents/skills/bad/SKILL.md': skill('different'),
    '.agents/skills/invalid/SKILL.md': skill('invalid', 'body', 'disable-model-invocation: "false"\n'),
    '.agents/skills/huge/SKILL.md': skill('huge', 'a'.repeat(24_001)),
    '.agents/skills/nested/extra/SKILL.md': skill('extra'),
    '../.agents/skills/escape/SKILL.md': skill('escape'),
  });
  assert.deepEqual(guidance.catalog().map(s => s.name), ['build']);
  assert.throws(() => guidance.loadSkill('review'), /not in this workspace/);
  assert.equal(guidance.warnings.length, 3);
});

test('skills load from .openagents/skills, ahead of the pre-0.6.0 .openhours/skills folder', () => {
  const guidance = new WorkspaceGuidance({
    '.openagents/skills/release/SKILL.md': skill('release', 'New folder.'),
    '.openhours/skills/release/SKILL.md': skill('release', 'Old folder.'),
    '.openhours/skills/deploy/SKILL.md': skill('deploy', 'Still read.'),
  });
  assert.deepEqual(guidance.catalog().map(s => s.name).sort(), ['deploy', 'release']);
  assert.equal(guidance.loadSkill('release').body, 'New folder.');
  assert.equal(guidance.loadSkill('release').resourceBase, '.openagents/skills/release');
});

test('instructions follow directory boundaries, root first, and only load once', () => {
  const guidance = new WorkspaceGuidance({
    'AGENTS.md': 'Root rules', 'CLAUDE.md': 'Additional root rules',
    'src/AGENTS.md': 'Source rules', 'src/ui/AGENTS.md': 'UI rules',
    'src-other/AGENTS.md': 'Wrong scope', 'tests/AGENTS.md': 'Test rules',
  });
  assert.deepEqual(guidance.discoverInstructions('.').map(f => f.path), ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(guidance.discoverInstructions('src/ui/app.ts').map(f => f.path), ['src/AGENTS.md', 'src/ui/AGENTS.md']);
  assert.deepEqual(guidance.discoverInstructions('src/ui/other.ts'), []);
  assert.throws(() => guidance.discoverInstructions('../../secret'), /path/i);
});

test('instruction and catalogue bounds are explicit and do not split Unicode', () => {
  const files: Record<string, string> = { 'AGENTS.md': '😀'.repeat(4000) };
  for (let i = 0; i < 30; i++) files[`.agents/skills/task-${i}/SKILL.md`] = skill(`task-${i}`);
  const guidance = new WorkspaceGuidance(files);
  const [root] = guidance.discoverInstructions('.');
  assert.equal(root.truncated, true);
  assert.ok(Buffer.byteLength(root.content) <= 8000);
  assert.ok(!root.content.includes('\ufffd'));
  assert.equal(guidance.catalog().length, 24);
  assert.ok(guidance.warnings.some(w => w.includes('catalogue limit')));
});

test('context estimates include large native arguments and exposed schemas', () => {
  const messages = [{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'x', name: 'write', arguments: 'x'.repeat(65_000) }] }];
  assert.ok(contextChars('system', messages) > 65_000);
  const tools = [{ name: 'write', description: 'description', parameters: { enum: ['x'.repeat(5000)] } }];
  assert.ok(contextChars('system', messages, tools) > 70_000);
});

test('exhausting instruction budget never marks an undisclosed partial chain as loaded', () => {
  const guidance = new WorkspaceGuidance({
    'AGENTS.md': 'a'.repeat(8000), 'CLAUDE.md': 'b'.repeat(8000),
    'src/AGENTS.md': 'c'.repeat(8000), 'src/deep/AGENTS.md': 'Must still be seen',
  });
  guidance.discoverInstructions('.');
  assert.throws(() => guidance.discoverInstructions('src/deep/file.ts'), /budget exhausted/);
  assert.equal(guidance.discoverInstructions('src/file.ts')[0].content, 'c'.repeat(8000));
  assert.throws(() => guidance.discoverInstructions('src/deep/file.ts'), /budget exhausted/);
});

test('duplicate YAML keys and aliases cannot produce loadable skill definitions', () => {
  const guidance = new WorkspaceGuidance({
    '.agents/skills/review/SKILL.md': '---\nname: review\nname: review\ndescription: duplicate\n---\nbody',
    '.agents/skills/alias/SKILL.md': '---\nname: alias\ndescription: &d text\nmetadata: *d\n---\nbody',
  });
  assert.deepEqual(guidance.catalog(), []);
  assert.equal(guidance.warnings.length, 2);
});

test('pruning bounds single-line Unicode output and preserves diagnostic tails', () => {
  const content = 'HEADER ' + '😀'.repeat(20_000) + ' FAILED: expected 5, received 4';
  const pruned = pruneToolResult(content);
  assert.ok(Buffer.byteLength(pruned) <= 2048);
  assert.ok(pruned.startsWith('HEADER '));
  assert.ok(pruned.endsWith('FAILED: expected 5, received 4'));
  assert.ok(pruned.includes('bytes pruned from earlier turn'));
  assert.ok(!pruned.includes('\ufffd'));
  assert.equal(pruneToolResult(pruned), pruned);
});
