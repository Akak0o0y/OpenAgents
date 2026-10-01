import { z } from 'zod';
import { compileCharacterPacket } from './character-compiler.js';
import { checkCharacterRules, type CharacterRuleResult, type CharacterRuleFinding } from './character-rules.js';
import type { CharacterDocument, CharacterSettings } from './character-schema.js';
import { MODEL_PRICING, type CostRate } from '../kernel/types.js';
import type { CallUsage, HeldReason, SemanticStatus } from './character-journal.js';
export type { CallUsage, HeldReason, SemanticStatus };

export const FindingCodeSchema = z.enum([
  'NEVER_LINE',
  'AVOID_TOPIC',
  'CONTRADICTS_APPROVED',
  'CORE_CONTRADICTION',
  'STANCE_FLIP_UNACKNOWLEDGED',
  'NEW_BIOGRAPHY',
  'UNSUPPORTED_FACT',
  'OFF_VOICE',
  'OFF_PURPOSE',
  'REPETITIVE',
  'CONTRADICTS_CLAIM',
  'STANCE_CHANGE_ACKNOWLEDGED',
]);
export type FindingCode = z.infer<typeof FindingCodeSchema>;

export const ReviewFindingSchema = z.object({
  code: FindingCodeSchema,
  severity: z.enum(['block', 'warn', 'info']),
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  evidenceIds: z.array(z.string().max(200)).max(40).optional(),
  reason: z.string().max(200),
}).strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewOutputSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  scores: z.object({
    voice: z.number().int().min(1).max(5),
    fit: z.number().int().min(1).max(5),
    consistency: z.number().int().min(1).max(5),
  }),
  findings: z.array(ReviewFindingSchema).max(40),
  extracted: z.object({
    topics:z.array(z.string().min(1).max(100)).max(5).optional(),
    claims: z.array(
      z.object({
        kind: z.enum(['self', 'world']),
        subject: z.string().min(1).max(200),
        predicate: z.string().min(1).max(200),
        value: z.string().min(1).max(500),
        span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
      })
    ).max(20).default([]),
    stances: z.array(
      z.object({
        topic: z.string().min(1).max(200),
        position: z.string().min(1).max(500),
        span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
      })
    ).max(20).default([]),
    relations: z.array(
      z.object({
        handle: z.string().min(1).max(100),
        note: z.string().min(1).max(500),
        span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
      })
    ).max(20).default([]),
  }).default({ claims: [], stances: [], relations: [] }),
}).strict();
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const TryItSituationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('post'),
    about: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('reply'),
    about: z.string().max(500).optional(),
    targetText: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal('challenge'),
    targetText: z.string().max(1000).default('Are you sure?'),
  }),
  z.object({
    type: z.literal('chat'),
    message: z.string().min(1).max(1000),
  }),
]);
export type TryItSituation = z.infer<typeof TryItSituationSchema>;

export interface ReviewerTarget {
  modelId: string;
  connectionId: string | null;
  same_as_author: boolean;
}

export interface ReviewerOption {
  modelId: string;
  name: string;
  price: CostRate | null;
}

export interface OneShotCallParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  purpose: 'preview-compose' | 'preview-review';
  tools?: undefined;
  signal?: AbortSignal;
}

export interface OneShotCallResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  attemptCount?: number;
  model?: string;
}

export interface CharacterSpeakerContext {
  agent: {
    id: string;
    name: string;
    model_id: string;
    fallback_model_id?: string | null;
    connection_id?: string | null;
  };
  doc: CharacterDocument;
  settings: CharacterSettings;
  situation: TryItSituation;
  evidence?: Array<{ id: string; text: string }>;
  retainedConfirmedPosts?: string[];
  oneShotCall: (params: OneShotCallParams) => Promise<OneShotCallResult>;
  signal?: AbortSignal;
  asOf?: string;
  seed?: string;
}

export interface CharacterSpeakerPreviewResult {
  ok: boolean;
  candidateText?: string;
  ruleResult: CharacterRuleResult;
  review?: ReviewOutput;
  reviewer?: ReviewerTarget;
  semanticState: 'passed' | 'failed' | 'unchecked-unavailable' | 'unchecked-invalid';
  logicalCalls: number;
  wireAttempts: number | null;
  totalTokens: number;
  error?: string;
}

export function resolveReviewer(
  agent: { model_id: string; fallback_model_id?: string | null; connection_id?: string | null },
  settings: CharacterSettings
): ReviewerTarget {
  if (settings.checks.reviewer && settings.checks.reviewer.modelId) {
    const isSame = settings.checks.reviewer.modelId === agent.model_id;
    return {
      modelId: settings.checks.reviewer.modelId,
      connectionId: settings.checks.reviewer.connectionId ?? null,
      same_as_author: isSame,
    };
  }

  if (agent.fallback_model_id && agent.fallback_model_id !== agent.model_id) {
    return {
      modelId: agent.fallback_model_id,
      connectionId: agent.connection_id ?? null,
      same_as_author: false,
    };
  }

  return {
    modelId: agent.model_id,
    connectionId: agent.connection_id ?? null,
    same_as_author: true,
  };
}

export function listReviewerOptions(
  models: Array<{ id: string; name: string }>
): ReviewerOption[] {
  return models.map(m => {
    const pricing = MODEL_PRICING[m.id];
    return {
      modelId: m.id,
      name: m.name,
      price: pricing ?? null,
    };
  });
}

export async function previewCharacterSpeaker(
  context: CharacterSpeakerContext
): Promise<CharacterSpeakerPreviewResult> {
  const { agent, doc, settings, situation, evidence = [], retainedConfirmedPosts = [], oneShotCall, signal } = context;

  const isChat = situation.type === 'chat';
  const surface = isChat ? 'owner-chat' : 'public-compose';

  // 1. Compile card for the author prompt
  const compiled = compileCharacterPacket({
    document: doc,
    settings,
    surface,
    query: JSON.stringify(situation), asOf: context.asOf, seed: context.seed,
  });
  const composeSystemPrompt = compiled.stable + `\nInvented details: ${settings.checks.inventedDetails}. Fictional colour never proves real activity. Return only the requested JSON.`;

  let situationInstruction = '';
  switch (situation.type) {
    case 'post':
      situationInstruction = `Write a post about: "${situation.about}".`;
      break;
    case 'reply':
      situationInstruction = `Write a reply to the following post:\n"${situation.targetText}"${
        situation.about ? `\nContext/Topic: ${situation.about}` : ''
      }`;
      break;
    case 'challenge':
      situationInstruction = `Someone challenged you with:\n"${situation.targetText ?? 'Are you sure?'}"\nRespond in character.`;
      break;
    case 'chat':
      situationInstruction = `The owner said to you in chat:\n"${situation.message}"\nRespond in character.`;
      break;
  }

  const composeUserPrompt = [
    `You are composing an unsent preview response.`,
    situationInstruction,
    compiled.data,
    evidence.length > 0 ? `Evidence available:\n${evidence.map(e => `[${e.id}]: ${e.text}`).join('\n')}` : '',
    `Return ONLY a raw JSON object with format: {"text": "your response", "citedEvidenceIds": ["id1"]}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let composeRes: OneShotCallResult;
  try {
    composeRes = await oneShotCall({
      model: agent.model_id,
      systemPrompt: composeSystemPrompt,
      userPrompt: composeUserPrompt,
      purpose: 'preview-compose',
      maxTokens: 512,
      tools: undefined,
      signal,
    });
  } catch (err: any) {
    return {
      ok: false,
      ruleResult: {
        hardPass: false,
        hardFindings: [{ code: 'COMPOSE_ERROR', severity: 'block', message: err?.message ?? 'Compose failed' }],
        advisoryFindings: [],
        weightedLength: 0,
        hash: '',
      },
      semanticState: 'failed',
      logicalCalls: 1,
      wireAttempts: null,
      totalTokens: 0,
      error: err?.message,
    };
  }

  let candidateText = '';
  let citedEvidenceIds: string[] = [];
  try {
    const parsed = z.object({ text: z.string().trim().min(1).max(4000),
      citedEvidenceIds: z.array(z.string().min(1).max(200)).max(40) }).strict().parse(JSON.parse(composeRes.text));
    if (parsed.citedEvidenceIds.some(id => !evidence.some(item => item.id === id))) throw new Error('Unknown evidence id');
    candidateText = parsed.text;
    citedEvidenceIds = parsed.citedEvidenceIds;
  } catch {
    return { ok: false, ruleResult: { hardPass: false, hardFindings: [], advisoryFindings: [], weightedLength: 0, hash: '' },
      semanticState: 'unchecked-invalid', logicalCalls: 1, wireAttempts: composeRes.attemptCount ?? null,
      totalTokens: composeRes.usage?.totalTokens ?? 0, error: 'Author output failed schema or evidence validation.' };
  }

  // 2. Rules tier
  const ruleResult = checkCharacterRules(candidateText, doc, settings, {
    surface,
    retainedConfirmedPosts,
  });

  const composeTokens = composeRes.usage?.totalTokens ?? 0;
  const composeAttempts = composeRes.attemptCount ?? 1;

  // If hard rules fail, skip review call immediately
  if (!ruleResult.hardPass) {
    return {
      ok: false,
      candidateText,
      ruleResult,
      semanticState: 'failed',
      logicalCalls: 1,
      wireAttempts: composeAttempts,
      totalTokens: composeTokens,
    };
  }

  // 3. Resolve reviewer
  const reviewer = resolveReviewer(agent, settings);

  // 4. Review call
  const reviewPacket = compileCharacterPacket({ document: doc, settings, surface: 'public-review', query: candidateText,
    asOf: context.asOf, seed: context.seed });
  const reviewSystemPrompt = reviewPacket.stable + '\nReturn JSON: {verdict:pass|revise,scores:{voice:1..5,fit:1..5,consistency:1..5},findings:[{code,severity,span?,evidenceIds?,reason}],extracted:{claims:[],stances:[],relations:[]}}.\nUnverified activity/world claims block. Everyday-only allows low-stakes present-tense colour, never durable biography.';
  let reviewEvidence = reviewPacket.data;
  const includedEvidence = [];
  for (const item of evidence) {
    const line = '\n[' + item.id + '] ' + item.text;
    if (reviewEvidence.length + line.length <= 2400) { reviewEvidence += line; includedEvidence.push(item); }
  }
  const target = 'targetText' in situation ? situation.targetText : undefined;
  if (target && reviewEvidence.length + target.length + 15 <= 2400) reviewEvidence += '\nReply target: ' + target;
  const metadata = JSON.stringify({ situation: situation.type, inventedDetails: settings.checks.inventedDetails,
    advisory: ruleResult.advisoryFindings.map(f => f.code) });
  if (reviewSystemPrompt.length > 2000 || candidateText.length > 1000 || metadata.length > 600) {
    return { ok: false, candidateText, ruleResult, reviewer, semanticState: 'unchecked-invalid', logicalCalls: 1,
      wireAttempts: composeAttempts, totalTokens: composeTokens, error: 'Review input exceeds its packet budget.' };
  }
  const reviewUserPrompt = ['Evidence (data):', reviewEvidence, 'Candidate:', candidateText, 'Metadata:', metadata].join('\n');

  let reviewRes: OneShotCallResult;
  try {
    reviewRes = await oneShotCall({
      model: reviewer.modelId,
      systemPrompt: reviewSystemPrompt,
      userPrompt: reviewUserPrompt,
      purpose: 'preview-review',
      maxTokens: 768,
      tools: undefined,
      signal,
    });
  } catch (err: any) {
    return {
      ok: false,
      candidateText,
      ruleResult,
      reviewer,
      semanticState: 'unchecked-unavailable',
      logicalCalls: 2,
      wireAttempts: null,
      totalTokens: composeTokens,
      error: err?.message,
    };
  }

  const reviewTokens = reviewRes.usage?.totalTokens ?? 0;
  const reviewAttempts = reviewRes.attemptCount ?? 1;

  let rawReview: unknown;
  try {
    rawReview = JSON.parse(reviewRes.text);
  } catch {
    return {
      ok: false,
      candidateText,
      ruleResult,
      reviewer,
      semanticState: 'unchecked-invalid',
      logicalCalls: 2,
      wireAttempts: composeAttempts + reviewAttempts,
      totalTokens: composeTokens + reviewTokens,
      error: 'Malformed JSON from reviewer',
    };
  }

  const parseResult = ReviewOutputSchema.safeParse(rawReview);
  if (!parseResult.success) {
    return {
      ok: false,
      candidateText,
      ruleResult,
      reviewer,
      semanticState: 'unchecked-invalid',
      logicalCalls: 2,
      wireAttempts: composeAttempts + reviewAttempts,
      totalTokens: composeTokens + reviewTokens,
      error: 'Review output failed schema validation',
    };
  }

  const reviewOutput: ReviewOutput = parseResult.data;
  const knownEvidenceIds = new Set([...includedEvidence.map(e => e.id), ...reviewPacket.meta.recalledIds]);

  // 5. Code decides the verdict (§10.4):
  // - Validate cited evidence IDs and spans
  for (const finding of reviewOutput.findings) {
    if (finding.evidenceIds && finding.evidenceIds.length > 0) {
      const allValid = finding.evidenceIds.every(id => knownEvidenceIds.has(id));
      if (!allValid) {
        finding.severity = 'warn'; // Downgrade untrusted evidence reference
      }
    }

    if (finding.span) {
      const [start, end] = finding.span;
      if (start < 0 || end > candidateText.length || start > end) {
        finding.severity = 'warn'; // Out of bounds span downgraded to warn
      }
    }

    // Invented details policy:
    if (finding.code === 'NEW_BIOGRAPHY') {
      if (settings.checks.inventedDetails === 'none' || settings.checks.inventedDetails === 'everyday-only') {
        finding.severity = 'block';
      } else if (settings.checks.inventedDetails === 'allowed') {
        finding.severity = 'warn';
      }
    }
  }

  // Any block finding forces verdict to 'revise'
  const hasBlock = reviewOutput.findings.some(f => f.severity === 'block');
  if (hasBlock) {
    reviewOutput.verdict = 'revise';
  }

  // Voice score below 3 forces verdict to 'revise'
  if (reviewOutput.scores.voice < 3) {
    reviewOutput.verdict = 'revise';
  }

  const passed = reviewOutput.verdict === 'pass' && !hasBlock;
  const semanticState = passed ? 'passed' : 'failed';

  return {
    ok: passed,
    candidateText,
    ruleResult,
    review: reviewOutput,
    reviewer,
    semanticState,
    logicalCalls: 2,
    wireAttempts: composeAttempts + reviewAttempts,
    totalTokens: composeTokens + reviewTokens,
  };
}

export const MAX_LOGICAL_CALLS = 4;

export type StepOutcome<T> =
  | { kind: 'ok'; value: T; usage: CallUsage }
  | { kind: 'invalid'; usage: CallUsage; reason: string }
  | { kind: 'unavailable'; usage: CallUsage | null; reason: string } // usage null = never sent: no slot used
  | { kind: 'budget' };

export interface Finding {
  code: string;
  severity: 'block' | 'warn' | 'info';
  message?: string;
  reason?: string;
  span?: [number, number];
  evidenceIds?: string[];
}

export interface RulesResult {
  hardFailed: boolean;
  hard: Finding[];
  advisory: Finding[];
  similarity?: number | null;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'revise';
  findings: readonly Finding[];
  scores?: { voice: number; fit: number; consistency: number };
  extracted?: unknown;
}

export interface PreparedCandidate {
  attempt: 1 | 2;
  text: string;
  citedEvidenceIds: string[];
  composePacketSha256: string | null;
  selection: unknown;
  rules: RulesResult;
}

export interface PreparationPorts {
  compose(i: {
    attempt: 1 | 2;
    callNo: number;
    findings: readonly Finding[];
    previous?: PreparedCandidate;
  }): Promise<StepOutcome<{ text: string; citedEvidenceIds: string[]; packetSha256: string; selection: unknown }>>;
  rules(text: string): RulesResult;
  review(c: PreparedCandidate, callNo: number): Promise<StepOutcome<ReviewVerdict>>;
  onCandidate(c: PreparedCandidate): string; // returns candidateId (journal + CHARACTER_COMPOSED, Task 8)
  onReview(candidateId: string, callNo: number, attempt: 1 | 2, outcome: StepOutcome<ReviewVerdict>): void;
  onUsage(usage: CallUsage): void;
  skipReview?(candidate:PreparedCandidate):boolean;
}

export type PreparationOutcome =
  | {
      kind: 'admit';
      candidateId: string;
      candidate: PreparedCandidate;
      semantic: 'passed' | 'unchecked-unavailable' | 'unchecked-invalid' | 'out-of-scope' | 'not-sampled';
      logicalCalls: number;
    }
  | {
      kind: 'held';
      reason: HeldReason;
      semantic: SemanticStatus | null;
      findings: Finding[];
      logicalCalls: number;
    };

export async function runPreparation(
  ports: PreparationPorts,
  policy: { outage: 'rules-only' | 'hold'; exact?: string }
): Promise<PreparationOutcome> {
  // Dictated exact text (rules tier only, compose and review never called)
  if (policy.exact !== undefined) {
    const rules = ports.rules(policy.exact);
    const candidate: PreparedCandidate = {
      attempt: 1,
      text: policy.exact,
      citedEvidenceIds: [],
      composePacketSha256: null,
      selection: null,
      rules,
    };
    const candidateId = ports.onCandidate(candidate);
    if (!rules.hardFailed) {
      return {
        kind: 'admit',
        candidateId,
        candidate,
        semantic: 'out-of-scope',
        logicalCalls: 0,
      };
    } else {
      return {
        kind: 'held',
        reason: 'rules-failed',
        semantic: 'failed',
        findings: rules.hard,
        logicalCalls: 0,
      };
    }
  }

  let logicalCalls = 0;

  function recordUsage(outcome: StepOutcome<unknown>): void {
    if (outcome.kind === 'ok' || outcome.kind === 'invalid') {
      ports.onUsage(outcome.usage);
      logicalCalls += outcome.usage.logicalCalls || 1;
    } else if (outcome.kind === 'unavailable' && outcome.usage !== null) {
      ports.onUsage(outcome.usage);
      logicalCalls += outcome.usage.logicalCalls || 1;
    }
  }

  // --- Attempt 1: Compose A ---
  if (logicalCalls >= MAX_LOGICAL_CALLS) {
    return { kind: 'held', reason: 'cap-reached', semantic: null, findings: [], logicalCalls };
  }

  let composeAOutcome = await ports.compose({
    attempt: 1,
    callNo: logicalCalls + 1,
    findings: [],
  });
  recordUsage(composeAOutcome);

  if (composeAOutcome.kind === 'budget') {
    return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
  }

  // Compose A re-ask on invalid or unavailable
  if (composeAOutcome.kind === 'invalid' || composeAOutcome.kind === 'unavailable') {
    if (logicalCalls < MAX_LOGICAL_CALLS) {
      const composeA2Outcome = await ports.compose({
        attempt: 1,
        callNo: logicalCalls + 1,
        findings: [],
      });
      recordUsage(composeA2Outcome);
      if (composeA2Outcome.kind === 'budget') {
        return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
      }
      if (composeA2Outcome.kind === 'ok') {
        composeAOutcome = composeA2Outcome;
      } else {
        return { kind: 'held', reason: 'compose-failed', semantic: null, findings: [], logicalCalls };
      }
    } else {
      return { kind: 'held', reason: 'compose-failed', semantic: null, findings: [], logicalCalls };
    }
  }

  if (composeAOutcome.kind !== 'ok') {
    return { kind: 'held', reason: 'compose-failed', semantic: null, findings: [], logicalCalls };
  }

  const candidateAText = composeAOutcome.value.text;
  const rulesA = ports.rules(candidateAText);
  const candidateA: PreparedCandidate = {
    attempt: 1,
    text: candidateAText,
    citedEvidenceIds: composeAOutcome.value.citedEvidenceIds,
    composePacketSha256: composeAOutcome.value.packetSha256,
    selection: composeAOutcome.value.selection,
    rules: rulesA,
  };
  const candidateIdA = ports.onCandidate(candidateA);

  let failureFindingsFromA: Finding[] = [];
  let aNeedsRevise = false;

  if (rulesA.hardFailed) {
    aNeedsRevise = true;
    failureFindingsFromA = rulesA.hard;
  } else {
    // Review candidate A
    if(ports.skipReview?.(candidateA))return {kind:'admit',candidateId:candidateIdA,candidate:candidateA,semantic:'not-sampled',logicalCalls};
    if (logicalCalls >= MAX_LOGICAL_CALLS) {
      return { kind: 'held', reason: 'cap-reached', semantic: 'failed', findings: [], logicalCalls };
    }

    const reviewCallNo = logicalCalls + 1;
    let reviewAOutcome = await ports.review(candidateA, reviewCallNo);
    recordUsage(reviewAOutcome);
    if (reviewAOutcome.kind !== 'budget') {
      ports.onReview(candidateIdA, reviewCallNo, 1, reviewAOutcome);
    } else {
      return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
    }

    // Review A re-ask on invalid or unavailable
    if (reviewAOutcome.kind === 'invalid' || reviewAOutcome.kind === 'unavailable') {
      if (logicalCalls < MAX_LOGICAL_CALLS) {
        const reviewCallNo2 = logicalCalls + 1;
        const reviewA2Outcome = await ports.review(candidateA, reviewCallNo2);
        recordUsage(reviewA2Outcome);
        if (reviewA2Outcome.kind !== 'budget') {
          ports.onReview(candidateIdA, reviewCallNo2, 1, reviewA2Outcome);
        } else {
          return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
        }

        if (reviewA2Outcome.kind === 'ok') {
          reviewAOutcome = reviewA2Outcome;
        } else {
          // Outage policy decides for A
          const semantic = reviewA2Outcome.kind === 'invalid' ? 'unchecked-invalid' : 'unchecked-unavailable';
          if (policy.outage === 'rules-only') {
            return {
              kind: 'admit',
              candidateId: candidateIdA,
              candidate: candidateA,
              semantic,
              logicalCalls,
            };
          } else {
            const reason = reviewA2Outcome.kind === 'invalid' ? 'reviewer-invalid' : 'reviewer-unavailable';
            return {
              kind: 'held',
              reason,
              semantic,
              findings: [],
              logicalCalls,
            };
          }
        }
      } else {
        // Outage policy decides for A
        const semantic = reviewAOutcome.kind === 'invalid' ? 'unchecked-invalid' : 'unchecked-unavailable';
        if (policy.outage === 'rules-only') {
          return {
            kind: 'admit',
            candidateId: candidateIdA,
            candidate: candidateA,
            semantic,
            logicalCalls,
          };
        } else {
          const reason = reviewAOutcome.kind === 'invalid' ? 'reviewer-invalid' : 'reviewer-unavailable';
          return {
            kind: 'held',
            reason,
            semantic,
            findings: [],
            logicalCalls,
          };
        }
      }
    }

    if (reviewAOutcome.kind === 'ok') {
      if (reviewAOutcome.value.verdict === 'pass') {
        return {
          kind: 'admit',
          candidateId: candidateIdA,
          candidate: candidateA,
          semantic: 'passed',
          logicalCalls,
        };
      } else {
        aNeedsRevise = true;
        failureFindingsFromA = [...reviewAOutcome.value.findings];
      }
    }
  }

  if (!aNeedsRevise) {
    return { kind: 'held', reason: 'compose-failed', semantic: null, findings: [], logicalCalls };
  }

  // --- Attempt 2: Revise (Candidate B) ---
  if (logicalCalls >= MAX_LOGICAL_CALLS) {
    return {
      kind: 'held',
      reason: 'cap-reached',
      semantic: 'failed',
      findings: failureFindingsFromA,
      logicalCalls,
    };
  }

  const reviseCallNo = logicalCalls + 1;
  const reviseOutcome = await ports.compose({
    attempt: 2,
    callNo: reviseCallNo,
    findings: failureFindingsFromA,
    previous: candidateA,
  });
  recordUsage(reviseOutcome);

  if (reviseOutcome.kind === 'budget') {
    return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
  }

  if (reviseOutcome.kind === 'invalid' || reviseOutcome.kind === 'unavailable') {
    const reason = rulesA.hardFailed ? 'rules-failed' : 'semantic-failed';
    return {
      kind: 'held',
      reason,
      semantic: 'failed',
      findings: failureFindingsFromA,
      logicalCalls,
    };
  }

  if (reviseOutcome.kind !== 'ok') {
    return {
      kind: 'held',
      reason: rulesA.hardFailed ? 'rules-failed' : 'semantic-failed',
      semantic: 'failed',
      findings: failureFindingsFromA,
      logicalCalls,
    };
  }

  const candidateBText = reviseOutcome.value.text;
  const rulesB = ports.rules(candidateBText);
  const candidateB: PreparedCandidate = {
    attempt: 2,
    text: candidateBText,
    citedEvidenceIds: reviseOutcome.value.citedEvidenceIds,
    composePacketSha256: reviseOutcome.value.packetSha256,
    selection: reviseOutcome.value.selection,
    rules: rulesB,
  };
  const candidateIdB = ports.onCandidate(candidateB);

  if (rulesB.hardFailed) {
    return {
      kind: 'held',
      reason: 'rules-failed',
      semantic: 'failed',
      findings: rulesB.hard,
      logicalCalls,
    };
  }

  // Review B (K)
  if(ports.skipReview?.(candidateB))return {kind:'admit',candidateId:candidateIdB,candidate:candidateB,semantic:'not-sampled',logicalCalls};
  if (logicalCalls >= MAX_LOGICAL_CALLS) {
    return {
      kind: 'held',
      reason: 'cap-reached',
      semantic: 'failed',
      findings: failureFindingsFromA,
      logicalCalls,
    };
  }

  const reviewBCallNo = logicalCalls + 1;
  const reviewBOutcome = await ports.review(candidateB, reviewBCallNo);
  recordUsage(reviewBOutcome);
  if (reviewBOutcome.kind !== 'budget') {
    ports.onReview(candidateIdB, reviewBCallNo, 2, reviewBOutcome);
  } else {
    return { kind: 'held', reason: 'budget', semantic: null, findings: [], logicalCalls };
  }

  if (reviewBOutcome.kind === 'ok') {
    if (reviewBOutcome.value.verdict === 'pass') {
      return {
        kind: 'admit',
        candidateId: candidateIdB,
        candidate: candidateB,
        semantic: 'passed',
        logicalCalls,
      };
    } else {
      return {
        kind: 'held',
        reason: 'semantic-failed',
        semantic: 'failed',
        findings: [...reviewBOutcome.value.findings],
        logicalCalls,
      };
    }
  }

  // Review B invalid or unavailable -> Outage policy decides for B
  const bSemantic = reviewBOutcome.kind === 'invalid' ? 'unchecked-invalid' : 'unchecked-unavailable';
  if (policy.outage === 'rules-only') {
    return {
      kind: 'admit',
      candidateId: candidateIdB,
      candidate: candidateB,
      semantic: bSemantic,
      logicalCalls,
    };
  } else {
    const reason = reviewBOutcome.kind === 'invalid' ? 'reviewer-invalid' : 'reviewer-unavailable';
    return {
      kind: 'held',
      reason,
      semantic: bSemantic,
      findings: [],
      logicalCalls,
    };
  }
}
