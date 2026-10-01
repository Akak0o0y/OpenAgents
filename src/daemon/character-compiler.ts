import { createHash } from 'node:crypto';
import {
  CharacterDocument,
  CharacterSettings,
  CharacterMode,
  CharacterInvalidError,
  CHARACTER_PRECEDENCE_LINE,
  CHARACTER_DISAGREEMENT_LINE,
  CHARACTER_MAPPING_VERSION,
  compileSliderPhrase,
  SliderName,
} from './character-schema.js';
import {
  recallCharacterData,
  AvailableCharacterRecords,
} from './character-recall.js';

export const COMPILER_VERSION = 'openhours.compiler/1';
export const EMPTY_CARD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type CharacterSurface =
  | 'owner-chat'
  | 'task-loop'
  | 'code'
  | 'public-compose'
  | 'public-review'
  | 'preview';

export interface CompileOptions {
  document: CharacterDocument;
  settings: CharacterSettings;
  surface: CharacterSurface;
  query?: string;
  seed?: string;
  asOf?: string;
  records?: AvailableCharacterRecords;
  exampleSurface?: 'post' | 'reply' | 'chat';
}

export interface CompiledPacketMeta {
  mode: CharacterMode;
  surface: CharacterSurface;
  version?: number;
  compilerVersion: string;
  mappingVersion: string;
  stableChars: number;
  dataChars: number;
  stableSha256: string;
  selectionSha256?: string;
  recalledIds: string[];
  omissions: string[];
}

export interface CompiledPacket {
  surface: CharacterSurface;
  mode: CharacterMode;
  stable: string;
  data: string;
  meta: CompiledPacketMeta;
}

export function hashCharacterCore(stableText: string): string {
  if (!stableText) return EMPTY_CARD_SHA256;
  return createHash('sha256').update(stableText, 'utf8').digest('hex');
}

function formatHeader(doc: CharacterDocument): string {
  const handlePart = doc.identity.handle ? ` (@${doc.identity.handle.replace(/^@/, '')})` : '';
  const oneLinePart = doc.identity.oneLine ? ` ${doc.identity.oneLine}` : '';
  return `You are ${doc.identity.name}${handlePart}.${oneLinePart}`;
}

function formatLines(doc: CharacterDocument): string {
  const parts: string[] = [];
  if (doc.standards.never && doc.standards.never.length > 0) {
    parts.push(`Never: ${doc.standards.never.join('; ')}.`);
  }
  if (doc.standards.avoidTopics && doc.standards.avoidTopics.length > 0) {
    parts.push(`Avoid topics: ${doc.standards.avoidTopics.join(', ')}`);
  }
  if (parts.length === 0) return '';
  return `Lines:\n${parts.join('\n')}`;
}

function formatCoreCommitments(doc: CharacterDocument, mode: CharacterMode): string {
  const coreList = doc.commitments.filter((c) => c.importance === 'core');
  if (mode !== 'character') return '';

  const parts: string[] = [];
  if (coreList.length > 0) {
    const list = coreList.map((c) => `- ${c.topic}: ${c.stance}`).join('\n');
    parts.push(`Core commitments:\n${list}`);
  }
  parts.push(CHARACTER_DISAGREEMENT_LINE);
  return parts.join('\n');
}

export function checkCharacterDocumentFit(doc: CharacterDocument, mode: CharacterMode): void {
  const issues: string[] = [];

  // 1. Header fit check (150 chars for owner-chat, 160 for compose)
  const headerText = formatHeader(doc);
  if (headerText.length > 150) {
    issues.push(`header length (${headerText.length}) exceeds 150 character owner-chat allocation`);
  }

  // 2. Lines fit check (350 chars)
  const linesText = formatLines(doc);
  if (linesText.length > 350) {
    issues.push(`standards lines length (${linesText.length}) exceeds 350 character allocation`);
  }

  // 3. Core commitments fit check (330 chars in Character mode)
  if (mode === 'character') {
    const coreText = formatCoreCommitments(doc, mode);
    if (coreText.length > 330) {
      issues.push(`core commitments section length (${coreText.length}) exceeds 330 character allocation`);
    }
  }

  if (issues.length > 0) {
    throw new CharacterInvalidError(`Character document mandatory section fit failed: ${issues.join('; ')}`, issues);
  }
}

function formatVoiceRules(doc: CharacterDocument, budget: number): { text: string; omissions: string[] } {
  const rules = doc.voice?.rules;
  if (!rules) return { text: '', omissions: [] };
  const lines: string[] = [];
  lines.push(`- Casing: ${rules.casing}`);
  lines.push(`- Emoji: ${rules.emoji}`);
  if (rules.signatureWords && rules.signatureWords.length > 0) {
    lines.push(`- Signature words: ${rules.signatureWords.join(', ')}`);
  }
  if (rules.do && rules.do.length > 0) {
    lines.push(`- Do: ${rules.do.join('; ')}`);
  }
  if (rules.dont && rules.dont.length > 0) {
    lines.push(`- Don't: ${rules.dont.join('; ')}`);
  }

  const heading = 'Voice rules:';
  let assembled = `${heading}\n${lines.join('\n')}`;
  const omissions: string[] = [];

  if (assembled.length > budget) {
    // Trim from optional rules
    while (lines.length > 2 && assembled.length > budget) {
      const removed = lines.pop();
      omissions.push(`voice rule ${removed} omitted to fit budget`);
      assembled = `${heading}\n${lines.join('\n')}`;
    }
  }

  return { text: assembled, omissions };
}

function formatBehaviour(doc: CharacterDocument, budget: number): { text: string; omissions: string[] } {
  const lines: string[] = [];
  const omissions: string[] = [];

  const sliderNames: SliderName[] = ['curious', 'organised', 'outgoing', 'agreeable', 'sensitive'];
  for (const name of sliderNames) {
    const level = doc.personality.sliders[name] ?? 3;
    const phrase = compileSliderPhrase(name, level);
    if (phrase) {
      lines.push(`- ${phrase}`);
    }
  }

  if (doc.personality.humour && doc.personality.humour !== 'none') {
    lines.push(`- Humour: ${doc.personality.humour}`);
  }

  if (doc.personality.quirks && doc.personality.quirks.length > 0) {
    lines.push(`- Quirks: ${doc.personality.quirks.join('; ')}`);
  }

  if (doc.personality.dispositions && doc.personality.dispositions.length > 0) {
    for (const d of doc.personality.dispositions) {
      lines.push(`- When ${d.when}, then ${d.then}`);
    }
  }

  if (lines.length === 0) return { text: '', omissions: [] };

  const heading = 'Behaviour:';
  let assembled = `${heading}\n${lines.join('\n')}`;

  while (lines.length > 0 && assembled.length > budget) {
    const removed = lines.pop();
    omissions.push(`behaviour item ${removed} omitted to fit budget`);
    assembled = `${heading}\n${lines.join('\n')}`;
  }

  return { text: assembled, omissions };
}

function formatPinnedExamples(doc: CharacterDocument, budget: number): { text: string; omissions: string[] } {
  const pinned = doc.voice.examples.filter((e) => e.pinned).slice(0, 2);
  // Sort stably by id
  pinned.sort((a, b) => a.id.localeCompare(b.id));

  const items: string[] = [];
  const omissions: string[] = [];

  for (const ex of pinned) {
    const item = `Example: "${ex.text}"`;
    const cost = item.length + (items.length > 0 ? 1 : 0);
    const currentLen = items.join('\n').length;
    if (currentLen + cost <= budget) {
      items.push(item);
    } else {
      omissions.push(`pinned example ${ex.id} omitted to fit ${budget} budget`);
    }
  }

  return { text: items.join('\n'), omissions };
}

function formatSalientBiography(doc: CharacterDocument, budget: number): { text: string; omissions: string[] } {
  const salient = (doc.biography ?? []).filter((b) => b.salient).slice(0, 3);
  if (salient.length === 0) return { text: '', omissions: [] };

  const lines: string[] = [];
  const omissions: string[] = [];

  for (const b of salient) {
    const line = `- ${b.text}`;
    lines.push(line);
  }

  const heading = 'Life:';
  let assembled = `${heading}\n${lines.join('\n')}`;

  while (lines.length > 0 && assembled.length > budget) {
    const removed = lines.pop();
    omissions.push(`salient biography ${removed} omitted to fit budget`);
    assembled = lines.length > 0 ? `${heading}\n${lines.join('\n')}` : '';
  }

  return { text: assembled, omissions };
}

export function compileCharacterPacket(options: CompileOptions): CompiledPacket {
  const { document: doc, settings, surface } = options;
  const mode = settings.mode;

  if (mode === 'off' || surface === 'code') {
    return {
      surface,
      mode,
      stable: '',
      data: '',
      meta: {
        mode,
        surface,
        compilerVersion: COMPILER_VERSION,
        mappingVersion: CHARACTER_MAPPING_VERSION,
        stableChars: 0,
        dataChars: 0,
        stableSha256: EMPTY_CARD_SHA256,
        recalledIds: [],
        omissions: [],
      },
    };
  }

  const omissions: string[] = [];
  const sections: string[] = [];

  if (surface === 'task-loop') {
    // Task packet <= 320 chars
    const baseFixed = 'Public posts and replies are written with prepare_post; never type post text yourself.';
    const namePart = doc.identity?.name ? `Name: ${doc.identity.name}.` : '';
    const statement = doc.purpose?.statement?.trim() || '';
    const topics = doc.purpose?.topics?.length ? doc.purpose.topics.join(', ') : '';
    const cleanStatement = statement ? (statement.endsWith('.') ? statement : `${statement}.`) : '';
    const topicsPart = topics ? (topics.endsWith('.') ? ` Topics: ${topics}` : ` Topics: ${topics}.`) : '';

    const parts: string[] = [];
    if (namePart) parts.push(namePart);
    if (cleanStatement) parts.push(`Purpose: ${cleanStatement}`);
    if (topicsPart) parts.push(topicsPart.trim());
    parts.push(baseFixed);

    let candidate = parts.join(' ').replace(/\s+/g, ' ');
    if (candidate.length > 320 && topics) {
      omissions.push('topics trimmed in task packet');
      const withoutTopics = [namePart, cleanStatement ? `Purpose: ${cleanStatement}` : '', baseFixed].filter(Boolean);
      candidate = withoutTopics.join(' ').replace(/\s+/g, ' ');
    }
    if (candidate.length > 320) {
      omissions.push('purpose trimmed in task packet');
      const fixedOverhead = `${namePart ? namePart + ' ' : ''}Purpose: ... ${baseFixed}`.length;
      const allowedStatementChars = Math.max(0, 320 - fixedOverhead);
      const trimmedStatement = statement.slice(0, allowedStatementChars);
      candidate = `${namePart ? namePart + ' ' : ''}Purpose: ${trimmedStatement}... ${baseFixed}`.replace(/\s+/g, ' ');
    }

    return {
      surface,
      mode,
      stable: candidate,
      data: '',
      meta: {
        mode,
        surface,
        compilerVersion: COMPILER_VERSION,
        mappingVersion: CHARACTER_MAPPING_VERSION,
        stableChars: candidate.length,
        dataChars: 0,
        stableSha256: hashCharacterCore(candidate),
        recalledIds: [],
        omissions,
      },
    };
  }

  if (surface === 'owner-chat') {
    // 1. Header (max 150)
    const header = formatHeader(doc);
    sections.push(header);

    // 2. Purpose (Character mode only, max 100)
    if (mode === 'character' && doc.purpose?.statement) {
      const pText = `Purpose: ${doc.purpose.statement}`;
      if (pText.length <= 100) {
        sections.push(pText);
      } else {
        sections.push(`Purpose: ${doc.purpose.statement.slice(0, 85)}...`);
        omissions.push('purpose statement trimmed to fit 100 char chat allocation');
      }
    }

    // 3. Voice rules (Voice max 200, Character max 180)
    const vrBudget = mode === 'voice' ? 200 : 180;
    const { text: vrText, omissions: vrOmissions } = formatVoiceRules(doc, vrBudget);
    if (vrText) sections.push(vrText);
    omissions.push(...vrOmissions);

    // 4. Behaviour (Character mode only, max 160)
    if (mode === 'character') {
      const { text: behText, omissions: behOmissions } = formatBehaviour(doc, 160);
      if (behText) sections.push(behText);
      omissions.push(...behOmissions);
    }

    // 5. Core commitments + disagreement line (Character mode only, max 330)
    if (mode === 'character') {
      const coreText = formatCoreCommitments(doc, mode);
      if (coreText) sections.push(coreText);
    }

    // 6. Lines (max 350)
    const linesText = formatLines(doc);
    if (linesText) sections.push(linesText);

    // 7. Pinned examples (Voice max 200, Character max 230)
    const exBudget = mode === 'voice' ? 200 : 230;
    const { text: exText, omissions: exOmissions } = formatPinnedExamples(doc, exBudget);
    if (exText) sections.push(exText);
    omissions.push(...exOmissions);

    // 8. Precedence line (max 100)
    sections.push(CHARACTER_PRECEDENCE_LINE);

    const stable = sections.join('\n\n');
    const recallResult = recallCharacterData(options);
    omissions.push(...recallResult.omissions);

    return {
      surface,
      mode,
      stable,
      data: recallResult.data,
      meta: {
        mode,
        surface,
        compilerVersion: COMPILER_VERSION,
        mappingVersion: CHARACTER_MAPPING_VERSION,
        stableChars: stable.length,
        dataChars: recallResult.data.length,
        stableSha256: hashCharacterCore(stable),
        selectionSha256: recallResult.selectionSha256,
        recalledIds: recallResult.recalledIds,
        omissions,
      },
    };
  }

  if (surface === 'public-review') {
    const core = compileCharacterPacket({ ...options, surface: 'owner-chat' });
    const stable = 'Review voice, fit, standards and evidence. Style examples never prove real activity.\n\n' + core.stable;
    const recalled = mode === 'character' ? recallCharacterData(options) : { data: '', recalledIds: [], omissions: [] };
    if (stable.length > 2000) throw new CharacterInvalidError('Review rubric and core exceed 2000 characters.');
    return { surface, mode, stable, data: recalled.data, meta: { ...core.meta, surface,
      stableChars: stable.length, dataChars: recalled.data.length, stableSha256: hashCharacterCore(stable),
      selectionSha256: hashCharacterCore(recalled.data), recalledIds: recalled.recalledIds,
      omissions: [...core.meta.omissions, ...recalled.omissions] } };
  }

  if (surface === 'public-compose' || surface === 'preview') {
    // 1. Header (max 160)
    const header = formatHeader(doc);
    sections.push(header);

    // 2. Purpose (Character mode only, max 180)
    if (mode === 'character' && doc.purpose?.statement) {
      const pText = `Purpose: ${doc.purpose.statement}`;
      if (pText.length <= 180) {
        sections.push(pText);
      } else {
        sections.push(`Purpose: ${doc.purpose.statement.slice(0, 165)}...`);
        omissions.push('purpose statement trimmed to fit 180 char compose allocation');
      }
    }

    // 3. Life (salient biography, Character mode only, max 650)
    if (mode === 'character') {
      const { text: bioText, omissions: bioOmissions } = formatSalientBiography(doc, 650);
      if (bioText) sections.push(bioText);
      omissions.push(...bioOmissions);
    }

    // 4. Voice rules (max 220)
    const { text: vrText, omissions: vrOmissions } = formatVoiceRules(doc, 220);
    if (vrText) sections.push(vrText);
    omissions.push(...vrOmissions);

    // 5. Behaviour (Character mode only, max 200)
    if (mode === 'character') {
      const { text: behText, omissions: behOmissions } = formatBehaviour(doc, 200);
      if (behText) sections.push(behText);
      omissions.push(...behOmissions);
    }

    // 6. Core commitments + disagreement line (Character mode only, max 350)
    if (mode === 'character') {
      const coreText = formatCoreCommitments(doc, mode);
      if (coreText) sections.push(coreText);
    }

    // 7. Lines (max 350)
    const linesText = formatLines(doc);
    if (linesText) sections.push(linesText);

    // 8. Pinned examples (max 290)
    const { text: exText, omissions: exOmissions } = formatPinnedExamples(doc, 290);
    if (exText) sections.push(exText);
    omissions.push(...exOmissions);

    // 9. Precedence line (max 100)
    sections.push(CHARACTER_PRECEDENCE_LINE);

    const stable = sections.join('\n\n');
    const recallResult = recallCharacterData(options);
    omissions.push(...recallResult.omissions);

    return {
      surface,
      mode,
      stable,
      data: recallResult.data,
      meta: {
        mode,
        surface,
        compilerVersion: COMPILER_VERSION,
        mappingVersion: CHARACTER_MAPPING_VERSION,
        stableChars: stable.length,
        dataChars: recallResult.data.length,
        stableSha256: hashCharacterCore(stable),
        selectionSha256: recallResult.selectionSha256,
        recalledIds: recallResult.recalledIds,
        omissions,
      },
    };
  }

  // Fallback for any other surface
  return {
    surface,
    mode,
    stable: '',
    data: '',
    meta: {
      mode,
      surface,
      compilerVersion: COMPILER_VERSION,
      mappingVersion: CHARACTER_MAPPING_VERSION,
      stableChars: 0,
      dataChars: 0,
      stableSha256: EMPTY_CARD_SHA256,
      recalledIds: [],
      omissions: [],
    },
  };
}
