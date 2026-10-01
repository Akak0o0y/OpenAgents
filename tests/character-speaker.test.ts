import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewCharacterSpeaker,
  resolveReviewer,
  listReviewerOptions,
  type CharacterSpeakerContext,
  type ReviewerTarget,
  type OneShotCallParams,
  type OneShotCallResult,
  type ReviewFinding,
  type ReviewerOption,
} from '../src/daemon/character-speaker.js';
import type { CharacterDocument, CharacterSettings } from '../src/daemon/character-schema.js';
import { createDefaultCharacterDocument } from '../src/daemon/character-schema.js';

test('malformed author output is not treated as candidate prose or sent for review', async () => {
  for (const text of ['not JSON', '{"text":""}', '{"text":"hello","citedEvidenceIds":["invented"]}',
    '{"text":"hello","citedEvidenceIds":[],"action":"publish"}']) {
    let calls = 0;
    const result = await previewCharacterSpeaker({ agent: mockAgent, doc: createMockDoc(), settings: defaultSettings,
      situation: { type: 'post', about: 'test' }, oneShotCall: async () => { calls++; return { text }; } });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.candidateText, undefined);
    assert.equal(result.semanticState, 'unchecked-invalid');
  }
});

function createMockDoc(overrides: Partial<CharacterDocument> = {}): CharacterDocument {
  return {
    ...createDefaultCharacterDocument('Milo'),
    version: 1,
    identity: {
      name: 'Milo',
      tagline: 'Autonomous AI assistant',
      avatarUrl: '',
      handle: 'milo_agent',
      timezone: 'UTC',
      languages: ['en'],
      oneLine: 'Autonomous AI assistant',
    },
    voice: {
      examples: [],
      rules: {
        casing: 'normal',
        emoji: 'sometimes',
        signatureWords: [],
        do: [],
        dont: [],
      },
      postRules: {
        length: { min: 1, max: 280 },
        hashtags: 1,
        links: 'never',
      },
      avoidPhrases: ['delve', 'testament to'],
      aiPhrasing: true,
    },
    personality: {
      sliders: {
        curious: 3,
        organised: 3,
        outgoing: 3,
        agreeable: 3,
        sensitive: 3,
      },
      traits: [],
      quirks: [],
    },
    purpose: {
      statement: 'Assist users with robust software design',
      audience: 'Engineers',
      topics: ['software'],
      success: ['helpful'],
    },
    standards: {
      never: [],
      avoidTopics: ['politics'],
    },
    commitments: [
      {
        id: 'c1',
        topic: 'Truthfulness',
        stance: 'Truthfulness above all',
        importance: 'core',
        certainty: 'high',
        keywords: ['truth'],
      },
    ],
    ...overrides,
  } as unknown as CharacterDocument;
}

const defaultSettings: CharacterSettings = {
  mode: 'character',
  checks: {
    sampling: 'all',
    reviewer: null,
    outage: 'rules-only',
    inventedDetails: 'everyday-only',
  },
  growth: {
    review: 'off',
    readEngagement: false,
  },
  retention: {
    months: 12,
  },
};

const mockAgent = {
  id: 'agent-1',
  name: 'Milo',
  model_id: 'deepseek/deepseek-chat',
  fallback_model_id: 'gpt-4o',
  connection_id: 'conn-1',
};

test('preview makes at most one compose and one review with no tools', async () => {
  const doc = createMockDoc();
  const calls: OneShotCallParams[] = [];

  const mockOneShotCall = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    calls.push(params);
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({
          text: 'Building reliable distributed systems requires thoughtful consensus protocols.',
          citedEvidenceIds: ['ev-1'],
        }),
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        attemptCount: 1,
        model: params.model,
      };
    }
    if (params.purpose === 'preview-review') {
      return {
        text: JSON.stringify({
          verdict: 'pass',
          scores: { voice: 5, fit: 5, consistency: 5 },
          findings: [],
          extracted: { claims: [], stances: [], relations: [] },
        }),
        usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
        attemptCount: 1,
        model: params.model,
      };
    }
    throw new Error(`Unexpected purpose: ${params.purpose}`);
  };

  const context: CharacterSpeakerContext = {
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'distributed systems' },
    evidence: [{ id: 'ev-1', text: 'Milo works on distributed consensus.' }],
    oneShotCall: mockOneShotCall,
  };

  // Case 1: Successful compose and review -> exactly 2 calls, tools undefined
  const res = await previewCharacterSpeaker(context);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].purpose, 'preview-compose');
  assert.equal(calls[0].tools, undefined, 'compose must not pass tools');
  assert.equal(calls[1].purpose, 'preview-review');
  assert.equal(calls[1].tools, undefined, 'review must not pass tools');
  assert.equal(res.logicalCalls, 2);

  // Case 2: Hard rule failure in compose -> review is skipped, exactly 1 call total
  calls.length = 0;
  const mockOneShotCallHardFail = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    calls.push(params);
    return {
      text: JSON.stringify({
        text: 'Let us delve into distributed systems.', // contains avoidPhrase "delve"
        citedEvidenceIds: [],
      }),
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const resHardFail = await previewCharacterSpeaker({
    ...context,
    oneShotCall: mockOneShotCallHardFail,
  });
  assert.equal(resHardFail.ok, false);
  assert.equal(resHardFail.ruleResult.hardPass, false);
  assert.equal(calls.length, 1, 'hard rule failure must skip review');
  assert.equal(resHardFail.logicalCalls, 1);
});

test('reviewer selection resolves model and connection in specified order', () => {
  const globalReviewer = resolveReviewer(mockAgent, { ...defaultSettings,
    checks: { ...defaultSettings.checks, reviewer: { modelId: 'gpt-4o', connectionId: null } } });
  assert.equal(globalReviewer.connectionId, null, 'an explicit global reviewer must not inherit the author gateway');
  // 1. Explicit settings.checks.reviewer
  const target1 = resolveReviewer(
    mockAgent,
    {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        reviewer: { modelId: 'claude-sonnet-5', connectionId: 'conn-custom' },
      },
    }
  );
  assert.equal(target1.modelId, 'claude-sonnet-5');
  assert.equal(target1.connectionId, 'conn-custom');
  assert.equal(target1.same_as_author, false);

  // Explicit reviewer with same model as author
  const target1Same = resolveReviewer(
    mockAgent,
    {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        reviewer: { modelId: mockAgent.model_id, connectionId: 'conn-1' },
      },
    }
  );
  assert.equal(target1Same.same_as_author, true);

  // 2. Unset reviewer -> fallback model if different from author
  const target2 = resolveReviewer(mockAgent, defaultSettings);
  assert.equal(target2.modelId, 'gpt-4o');
  assert.equal(target2.connectionId, 'conn-1');
  assert.equal(target2.same_as_author, false);

  // 3. Fallback model same as author (or null) -> author model itself
  const agentSame = { ...mockAgent, fallback_model_id: mockAgent.model_id };
  const target3 = resolveReviewer(agentSame, defaultSettings);
  assert.equal(target3.modelId, mockAgent.model_id);
  assert.equal(target3.connectionId, 'conn-1');
  assert.equal(target3.same_as_author, true);

  // 4. listReviewerOptions
  const options = listReviewerOptions([
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'custom/unknown-model', name: 'Custom Gateway Model' },
  ]);
  assert.ok(options.length >= 2);
  const known = options.find((o: ReviewerOption) => o.modelId === 'deepseek/deepseek-chat');
  assert.ok(known?.price !== undefined); // knows price or null
  const unknown = options.find((o: ReviewerOption) => o.modelId === 'custom/unknown-model');
  assert.equal(unknown?.price, null, 'unknown models must have null price, not 0');
});

test('code recomputes verdict and validates evidence spans', async () => {
  const doc = createMockDoc();

  // (a) Model output says verdict: 'pass', but carries a 'block' finding -> code recomputes to 'revise'
  const mockCallBlockFinding = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: 'A clean compliant text.', citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    return {
      text: JSON.stringify({
        verdict: 'pass', // Model claims pass
        scores: { voice: 5, fit: 5, consistency: 5 },
        findings: [
          { code: 'NEVER_LINE', severity: 'block', reason: 'Mentions a forbidden phrase' },
        ],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const res1 = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallBlockFinding,
  });
  assert.equal(res1.ok, false);
  assert.equal(res1.review?.verdict, 'revise', 'block finding must force verdict to revise');

  // (b) Model output says verdict: 'pass', but voice score < 3 -> code recomputes to 'revise'
  const mockCallLowVoice = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: 'A clean compliant text.', citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    return {
      text: JSON.stringify({
        verdict: 'pass',
        scores: { voice: 2, fit: 5, consistency: 5 }, // Voice score 2 < 3
        findings: [],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const res2 = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallLowVoice,
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.review?.verdict, 'revise', 'voice score < 3 must force verdict to revise');

  // (c) Invalid evidence IDs and out-of-range spans are downgraded to untrusted 'warn'
  const candidateText = 'Short candidate text.';
  const mockCallInvalidEvidence = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: candidateText, citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    return {
      text: JSON.stringify({
        verdict: 'pass',
        scores: { voice: 4, fit: 4, consistency: 4 },
        findings: [
          {
            code: 'CONTRADICTS_APPROVED',
            severity: 'block',
            evidenceIds: ['non-existent-evidence-id'], // Invalid evidence ID
            span: [100, 200], // Out of bounds for candidateText (length ~21)
            reason: 'Alleged contradiction',
          },
        ],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const res3 = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'test' },
    evidence: [{ id: 'real-ev-1', text: 'Real evidence' }],
    oneShotCall: mockCallInvalidEvidence,
  });
  // The invalid evidence ID finding is downgraded to warn, so with voice=4 and no valid block findings, it passes
  assert.equal(res3.ok, true);
  assert.equal(res3.review?.verdict, 'pass');
  const downgraded = res3.review?.findings.find((f: ReviewFinding) => f.code === 'CONTRADICTS_APPROVED');
  assert.equal(downgraded?.severity, 'warn', 'invalid evidence ID must downgrade finding to warn');

  // (d) inventedDetails policy enforcement
  // 'none' forces NEW_BIOGRAPHY to block -> revise
  const mockCallNewBiography = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: 'Candidate text with biography.', citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    return {
      text: JSON.stringify({
        verdict: 'pass',
        scores: { voice: 4, fit: 4, consistency: 4 },
        findings: [
          { code: 'NEW_BIOGRAPHY', severity: 'info', reason: 'Claim about past job' },
        ],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const resNone = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: {
      ...defaultSettings,
      checks: { ...defaultSettings.checks, inventedDetails: 'none' },
    },
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallNewBiography,
  });
  assert.equal(resNone.ok, false);
  assert.equal(resNone.review?.verdict, 'revise');
  assert.equal(resNone.review?.findings.find((f: ReviewFinding) => f.code === 'NEW_BIOGRAPHY')?.severity, 'block');

  // 'allowed' keeps NEW_BIOGRAPHY as warn -> passes
  const resAllowed = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: {
      ...defaultSettings,
      checks: { ...defaultSettings.checks, inventedDetails: 'allowed' },
    },
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallNewBiography,
  });
  assert.equal(resAllowed.ok, true);
  assert.equal(resAllowed.review?.verdict, 'pass');
  assert.equal(resAllowed.review?.findings.find((f: ReviewFinding) => f.code === 'NEW_BIOGRAPHY')?.severity, 'warn');
});

test('invalid or unavailable review never becomes a pass', async () => {
  const doc = createMockDoc();

  // (a) Reviewer returns invalid JSON
  const mockCallMalformedReview = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: 'Valid candidate text.', citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    return {
      text: 'I am a reviewer and I think this draft looks pretty good! No JSON output.',
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      attemptCount: 1,
      model: params.model,
    };
  };

  const resMalformed = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallMalformedReview,
  });
  assert.equal(resMalformed.ok, false);
  assert.notEqual(resMalformed.semanticState, 'passed', 'malformed review must never become a pass');

  // (b) Reviewer call throws provider network error
  const mockCallReviewThrows = async (params: OneShotCallParams): Promise<OneShotCallResult> => {
    if (params.purpose === 'preview-compose') {
      return {
        text: JSON.stringify({ text: 'Valid candidate text.', citedEvidenceIds: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        attemptCount: 1,
        model: params.model,
      };
    }
    throw new Error('503 Service Unavailable: Reviewer overloaded');
  };

  const resThrows = await previewCharacterSpeaker({
    agent: mockAgent,
    doc,
    settings: defaultSettings,
    situation: { type: 'post', about: 'test' },
    evidence: [],
    oneShotCall: mockCallReviewThrows,
  });
  assert.equal(resThrows.ok, false);
  assert.notEqual(resThrows.semanticState, 'passed', 'reviewer error must never become a pass');
});
