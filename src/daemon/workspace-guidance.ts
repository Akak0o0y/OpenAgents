import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { workspacePath } from './artifacts.js';

/** Snapshot-only discovery: never reads the daemon's home directory or executes skill scripts.
 * Design reference: DeepSeek Harness skill-filesystem, tool-skill and agent-instructions,
 * reviewed at ddefc45fbc7f8e46dd73185e68295696d1297887. Independent OpenAgents implementation.
 */
// .openhours/skills is the pre-0.6.0 folder name; workspaces that use it keep working.
const ROOTS = ['.openagents/skills/', '.openhours/skills/', '.agents/skills/', '.dsh/skills/'];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INSTRUCTION = /(^|\/)(AGENTS|CLAUDE)\.md$/;
const MAX_SKILL_BYTES = 24_000;
const MAX_INSTRUCTION_BYTES = 8_000;
const MAX_GUIDANCE_BYTES = 24_000;

export interface SkillSummary { name: string; description: string; path: string; sha256: string }
interface Skill extends SkillSummary { body: string }
export interface WorkspaceInstruction { path: string; content: string; sha256: string; truncated: boolean }

export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export class WorkspaceGuidance {
  private readonly files = new Map<string, string>();
  private readonly skills = new Map<string, Skill>();
  private readonly loaded = new Set<string>();
  private remainingBytes = MAX_GUIDANCE_BYTES;
  readonly warnings: string[] = [];

  constructor(files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      try { if (workspacePath(file) !== file) continue; } catch { continue; }
      if (INSTRUCTION.test(file) || ROOTS.some(root => file.startsWith(root))) this.files.set(file, content);
    }
    for (const root of ROOTS) {
      for (const file of [...this.files.keys()].sort()) {
        if (!file.startsWith(root)) continue;
        const entry = file.slice(root.length);
        const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/SKILL\.md|\.md)$/.exec(entry);
        if (!match) continue;
        const raw = this.files.get(file)!;
        try {
          if (Buffer.byteLength(raw) > MAX_SKILL_BYTES) throw new Error('exceeds 24000 bytes');
          const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
          if (!frontmatter) throw new Error('requires YAML frontmatter');
          const doc = parseDocument(frontmatter[1], { uniqueKeys: true });
          if (doc.errors.length) throw new Error('invalid YAML frontmatter');
          const data = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
          if (!data || typeof data !== 'object' || Array.isArray(data) ||
              typeof data.name !== 'string' || !SKILL_NAME.test(data.name) || data.name !== match[1] ||
              typeof data.description !== 'string' || !data.description.trim() || !frontmatter[2].trim()) {
            throw new Error('requires a matching name, description and nonempty body');
          }
          for (const key of ['disable-model-invocation', 'user-invocable']) {
            if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error(`${key} must be boolean`);
          }
          // A higher-priority disabled skill must not expose a lower-priority duplicate.
          if (this.skills.has(data.name)) continue;
          if (this.skills.size >= 24) throw new Error('catalogue limit reached (24)');
          this.skills.set(data.name, {
            name: data.name, description: utf8Prefix(data.description.trim(), 500), path: file,
            sha256: createHash('sha256').update(raw).digest('hex'),
            body: data['disable-model-invocation'] === true ? '' : frontmatter[2].trim(),
          });
        } catch (error) {
          if (this.warnings.length < 24) this.warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  catalog(): SkillSummary[] {
    return [...this.skills.values()].filter(skill => skill.body).map(({ body: _body, ...summary }) => summary);
  }

  loadSkill(name: string): Skill & { resourceBase: string } {
    const skill = this.skills.get(name);
    if (!skill?.body) throw new Error(`Skill "${name}" is not in this workspace's model-invocable catalogue.`);
    return { ...skill, resourceBase: skill.path.slice(0, skill.path.lastIndexOf('/')) };
  }

  instructionPaths(): string[] { return [...this.files.keys()].filter(file => INSTRUCTION.test(file)).sort(); }

  /** Load an applicable root-to-file chain once. Call before mutations so the model can revise its action. */
  discoverInstructions(target: string): WorkspaceInstruction[] {
    const parts = target === '.' ? [] : workspacePath(target).split('/').slice(0, -1);
    const directories = [''];
    for (let i = 0; i < parts.length; i++) directories.push(parts.slice(0, i + 1).join('/') + '/');
    const result: WorkspaceInstruction[] = [];
    let remainingBytes = this.remainingBytes;
    for (const directory of directories) {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const file = directory + name;
        if (this.loaded.has(file) || !this.files.has(file)) continue;
        const raw = this.files.get(file)!;
        const content = utf8Prefix(raw, Math.min(MAX_INSTRUCTION_BYTES, remainingBytes));
        if (!content && raw) throw new Error('Workspace instruction budget exhausted. Split the task into a smaller directory scope.');
        remainingBytes -= Buffer.byteLength(content);
        result.push({ path: file, content, sha256: createHash('sha256').update(raw).digest('hex'), truncated: content !== raw });
      }
    }
    // Do not mark a partial chain delivered if a later file exhausted the budget.
    this.remainingBytes = remainingBytes;
    for (const instruction of result) this.loaded.add(instruction.path);
    return result;
  }
}
