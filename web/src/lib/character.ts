import { getJson, postJson } from './transport.js';
// Type-only imports are erased; no daemon code or Node dependency enters the browser bundle.
import type { CharacterDocument, CharacterSettings, DeepPartial } from '@kernel/daemon/character-schema.js';
import type { CompiledPacket } from '@kernel/daemon/character-compiler.js';
import type { CharacterPreviewResult } from '@kernel/daemon/character-preview.js';
import type { TryItSituation } from '@kernel/daemon/character-speaker.js';
import type { CharacterPostItem, CharacterPostDetail, CharacterPostMetrics } from '@kernel/daemon/character-posts.js';
export type { CharacterPostItem, CharacterPostDetail, CharacterPostMetrics };
export type { CharacterDocument, CharacterSettings, CharacterPreviewResult, TryItSituation };

export interface CharacterDraft { document?: DeepPartial<CharacterDocument>; settings?: DeepPartial<CharacterSettings> }
export interface CharacterVersion { version: number; document: CharacterDocument; settings: CharacterSettings; created_at: number; origin: string }
export interface CharacterState {
  version: number; document: CharacterDocument; settings: CharacterSettings;
  summary?: { mode: string; savedAt: number | null }; selected?: CharacterVersion;
  versions?: { version: number; origin: string; createdAt: number; note: string | null }[];
  reviewerOptions: { modelId: string; connectionId: string; label: string; availability: string; price: { inputPerMillion: number; outputPerMillion: number } | null }[];
}
export interface CharacterInspection {
  packet: CompiledPacket;
  inspection: null | { label: string; warning: string | null; description: string;
    prompts: { mode: string; system: string; messages: { role: string; content: string }[] }[] };
}
export function editableCharacter(document: CharacterDocument): DeepPartial<CharacterDocument> {
  const { schema: _schema, personality, ...rest } = document;
  const { mappingVersion: _mapping, ...editablePersonality } = personality;
  return { ...rest, personality: editablePersonality };
}
export const characterClient = {
  posts: (id: string, cursor?: string, signal?: AbortSignal) => getJson<{ items: CharacterPostItem[]; nextCursor: string | null }>(`/api/system/character-posts?agent=${encodeURIComponent(id)}&limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, signal),
  post: (id: string, utteranceId: string, signal?: AbortSignal) => getJson<CharacterPostDetail>(`/api/system/character-post?agent=${encodeURIComponent(id)}&id=${encodeURIComponent(utteranceId)}`, signal),
  metrics: (id: string, version: number, signal?: AbortSignal) => getJson<CharacterPostMetrics>(`/api/system/character-metrics?agent=${encodeURIComponent(id)}&version=${version}`, signal),
  promote: (id: string, baseVersion: number, utteranceId: string, signal?: AbortSignal) => postJson<{ version: number; exampleId: string }>('/api/system/character-promote', { agentId: id, baseVersion, utteranceId }, signal),
  get: (id: string, signal?: AbortSignal, version?: number) => getJson<CharacterState>(`/api/system/character?agent=${encodeURIComponent(id)}&versions=50${version ? `&version=${version}` : ''}`, signal),
  save: (id: string, baseVersion: number, draft: CharacterDraft, signal?: AbortSignal) => postJson<CharacterVersion>('/api/system/character-save', { agentId: id, baseVersion, ...draft }, signal),
  revert: (id: string, baseVersion: number, toVersion: number, signal?: AbortSignal) => postJson<CharacterVersion>('/api/system/character-revert', { agentId: id, baseVersion, toVersion }, signal),
  compile: (id: string, draft: CharacterDraft, surface: string, signal?: AbortSignal) => postJson<CharacterInspection>('/api/system/character-compile', { agentId: id, ...draft, surface, asOf: new Date().toISOString(), seed: 'studio' }, signal),
  preview: (id: string, draft: CharacterDraft, situation: TryItSituation, signal?: AbortSignal) => postJson<CharacterPreviewResult>('/api/system/character-preview', { agentId: id, draft, situation }, signal),
};

export const sliderPhrases = {
  curious: ['Stick to familiar topics; prefer the practical to the novel.', 'Notice odd details and ask why; connect unrelated things.'],
  organised: ["Be loose and spontaneous; it's fine to leave threads open.", "Be precise and structured; follow through on what you said you'd do."],
  outgoing: ['Say less; let a short observation stand on its own.', 'Talk to your audience directly; ask questions; share plans.'],
  agreeable: ['Say plainly when you disagree and why; argue with ideas, never with people; change your mind when shown real evidence.', "Look for what's right in other views first; disagree gently and briefly."],
  sensitive: ['Stay unbothered; answer provocation with calm.', 'Admit when things get to you; react openly to good and bad news.'],
} as const;
export function sliderPhrase(name: keyof typeof sliderPhrases, value: number) {
  if (value === 3) return 'Neutral (no added instruction).';
  return `${value === 2 || value === 4 ? 'Often: ' : ''}${sliderPhrases[name][value < 3 ? 0 : 1]}`;
}
