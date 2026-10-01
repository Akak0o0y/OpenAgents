import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runPreparation,
  previewCharacterSpeaker,
  MAX_LOGICAL_CALLS,
  type PreparationPorts,
  type PreparedCandidate,
  type StepOutcome,
  type RulesResult,
  type ReviewVerdict,
  type CallUsage,
} from '../src/daemon/character-speaker.js';
import { createDefaultCharacterDocument, type CharacterSettings } from '../src/daemon/character-schema.js';

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

const stdUsage: CallUsage = {
  logicalCalls: 1,
  wireAttempts: 1,
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: null,
  costUsd: 0.001,
};

const okCompose = (text = 'Candidate prose'): StepOutcome<{ text: string; citedEvidenceIds: string[]; packetSha256: string; selection: unknown }> => ({
  kind: 'ok',
  value: { text, citedEvidenceIds: [], packetSha256: 'packet-hash', selection: {} },
  usage: { ...stdUsage },
});

const invalidCompose: StepOutcome<any> = {
  kind: 'invalid',
  reason: 'Malformed JSON',
  usage: { ...stdUsage },
};

const unavailableComposeSent: StepOutcome<any> = {
  kind: 'unavailable',
  reason: '503 Service Unavailable',
  usage: { ...stdUsage },
};

const unavailableComposeUnsent: StepOutcome<any> = {
  kind: 'unavailable',
  reason: 'Network refused',
  usage: null,
};

const okReviewPass: StepOutcome<ReviewVerdict> = {
  kind: 'ok',
  value: { verdict: 'pass', findings: [] },
  usage: { ...stdUsage },
};

const okReviewRevise: StepOutcome<ReviewVerdict> = {
  kind: 'ok',
  value: { verdict: 'revise', findings: [{ code: 'OFF_VOICE', severity: 'block', reason: 'Too formal' }] },
  usage: { ...stdUsage },
};

const invalidReview: StepOutcome<ReviewVerdict> = {
  kind: 'invalid',
  reason: 'Bad review format',
  usage: { ...stdUsage },
};

const unavailableReview: StepOutcome<ReviewVerdict> = {
  kind: 'unavailable',
  reason: 'Model overloaded',
  usage: { ...stdUsage },
};

const budgetOutcome: StepOutcome<any> = {
  kind: 'budget',
};

function makeMockPorts(options: {
  composeQueue: Array<StepOutcome<{ text: string; citedEvidenceIds: string[]; packetSha256: string; selection: unknown }>>;
  rulesFn?: (text: string) => RulesResult;
  reviewQueue: Array<StepOutcome<ReviewVerdict>>;
}) {
  const candidates: PreparedCandidate[] = [];
  const reviews: Array<{ candidateId: string; callNo: number; attempt: 1 | 2; outcome: StepOutcome<ReviewVerdict> }> = [];
  const usages: CallUsage[] = [];
  let composeCalls = 0;
  let reviewCalls = 0;

  const defaultRules = (_text: string): RulesResult => ({
    hardFailed: false,
    hard: [],
    advisory: [],
  });

  const ports: PreparationPorts = {
    compose: async () => {
      composeCalls++;
      if (options.composeQueue.length === 0) {
        throw new Error('Unexpected compose call');
      }
      return options.composeQueue.shift()!;
    },
    rules: options.rulesFn ?? defaultRules,
    review: async () => {
      reviewCalls++;
      if (options.reviewQueue.length === 0) {
        throw new Error('Unexpected review call');
      }
      return options.reviewQueue.shift()!;
    },
    onCandidate: (c) => {
      candidates.push(c);
      return `cand-${candidates.length}`;
    },
    onReview: (candidateId, callNo, attempt, outcome) => {
      reviews.push({ candidateId, callNo, attempt, outcome });
    },
    onUsage: (u) => {
      usages.push(u);
    },
  };

  return { ports, candidates, reviews, usages, getCalls: () => composeCalls + reviewCalls };
}

test('the call state machine follows the P2-C5 table', async () => {
  assert.equal(MAX_LOGICAL_CALLS, 4);

  // Row 1: C ok · rules pass · R pass -> admit A (Calls: 2, passed, 1/1)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'A');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 2);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 1);
  }

  // Row 2: C ok · pass · R revise · V ok · pass · K pass -> admit B (Calls: 4, passed, 2/2)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'B');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 4);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 2);
  }

  // Row 3: C ok · pass · R revise · V ok · pass · K revise -> held semantic-failed (Calls: 4, failed, 2/2)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, okReviewRevise] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'semantic-failed');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 4);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 2);
  }

  // Row 4: C ok · hard · V ok · pass · K pass -> admit B (Calls: 3, passed, 2/1)
  {
    const m = makeMockPorts({
      composeQueue: [okCompose('A'), okCompose('B')],
      rulesFn: (text) => text === 'A' ? { hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] } : { hardFailed: false, hard: [], advisory: [] },
      reviewQueue: [okReviewPass],
    });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'B');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 3);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 1);
  }

  // Row 5: C ok · hard · V ok · hard -> held rules-failed (Calls: 2, failed, 2/0)
  {
    const m = makeMockPorts({
      composeQueue: [okCompose('A'), okCompose('B')],
      rulesFn: () => ({ hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] }),
      reviewQueue: [],
    });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'rules-failed');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 2);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 0);
  }

  // Row 6: C invalid · C ok · pass · R pass -> admit A (Calls: 3, passed, 1/1)
  {
    const m = makeMockPorts({ composeQueue: [invalidCompose, okCompose('A')], reviewQueue: [okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'A');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 3);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 1);
  }

  // Row 7: C invalid · C invalid -> held compose-failed (Calls: 2, null, 0/0)
  {
    const m = makeMockPorts({ composeQueue: [invalidCompose, invalidCompose], reviewQueue: [] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'compose-failed');
      assert.equal(res.semantic, null);
      assert.equal(res.logicalCalls, 2);
    }
    assert.equal(m.candidates.length, 0);
    assert.equal(m.reviews.length, 0);
  }

  // Row 8: C unavailable (sent) · C ok · pass · R pass -> admit A (Calls: 3, passed, 1/1)
  {
    const m = makeMockPorts({ composeQueue: [unavailableComposeSent, okCompose('A')], reviewQueue: [okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'A');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 3);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 1);
  }

  // Row 9: C ok · pass · R invalid · R pass -> admit A (Calls: 3, passed, 1/2)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [invalidReview, okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'A');
      assert.equal(res.semantic, 'passed');
      assert.equal(res.logicalCalls, 3);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 2);
  }

  // Row 10: C ok · pass · R invalid · R invalid
  // rules-only: admit A; hold: held reviewer-invalid (Calls: 3, unchecked-invalid, 1/2)
  {
    const m1 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [invalidReview, invalidReview] });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') {
      assert.equal(res1.semantic, 'unchecked-invalid');
      assert.equal(res1.logicalCalls, 3);
    }
    assert.equal(m1.candidates.length, 1);
    assert.equal(m1.reviews.length, 2);

    const m2 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [invalidReview, invalidReview] });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'reviewer-invalid');
      assert.equal(res2.semantic, 'unchecked-invalid');
      assert.equal(res2.logicalCalls, 3);
    }
    assert.equal(m2.candidates.length, 1);
    assert.equal(m2.reviews.length, 2);
  }

  // Row 11: C ok · pass · R unavailable · R unavailable
  // rules-only: admit A; hold: held reviewer-unavailable (Calls: 3, unchecked-unavailable, 1/2)
  {
    const m1 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [unavailableReview, unavailableReview] });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') {
      assert.equal(res1.semantic, 'unchecked-unavailable');
      assert.equal(res1.logicalCalls, 3);
    }
    assert.equal(m1.candidates.length, 1);
    assert.equal(m1.reviews.length, 2);

    const m2 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [unavailableReview, unavailableReview] });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'reviewer-unavailable');
      assert.equal(res2.semantic, 'unchecked-unavailable');
      assert.equal(res2.logicalCalls, 3);
    }
    assert.equal(m2.candidates.length, 1);
    assert.equal(m2.reviews.length, 2);
  }

  // Row 12a: C ok · pass · R revise · V ok · pass · K unavailable
  // rules-only: admit B; hold: held reviewer-unavailable (Calls: 4, unchecked-unavailable, 2/2)
  {
    const m1 = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, unavailableReview] });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') {
      assert.equal(res1.candidate.text, 'B');
      assert.equal(res1.semantic, 'unchecked-unavailable');
      assert.equal(res1.logicalCalls, 4);
    }
    assert.equal(m1.candidates.length, 2);
    assert.equal(m1.reviews.length, 2);

    const m2 = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, unavailableReview] });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'reviewer-unavailable');
      assert.equal(res2.semantic, 'unchecked-unavailable');
      assert.equal(res2.logicalCalls, 4);
    }
    assert.equal(m2.candidates.length, 2);
    assert.equal(m2.reviews.length, 2);
  }

  // Row 12b: same, with K invalid
  // rules-only: admit B; hold: held reviewer-invalid (Calls: 4, unchecked-invalid, 2/2)
  {
    const m1 = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, invalidReview] });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') {
      assert.equal(res1.candidate.text, 'B');
      assert.equal(res1.semantic, 'unchecked-invalid');
      assert.equal(res1.logicalCalls, 4);
    }
    assert.equal(m1.candidates.length, 2);
    assert.equal(m1.reviews.length, 2);

    const m2 = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, invalidReview] });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'reviewer-invalid');
      assert.equal(res2.semantic, 'unchecked-invalid');
      assert.equal(res2.logicalCalls, 4);
    }
    assert.equal(m2.candidates.length, 2);
    assert.equal(m2.reviews.length, 2);
  }

  // Row 13: C invalid · C ok · pass · R revise · V ok · pass -> held cap-reached (B unreviewed) (Calls: 4, failed, 2/1)
  {
    const m = makeMockPorts({ composeQueue: [invalidCompose, okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'cap-reached');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 4);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 1);
  }

  // Row 14: C ok · pass · R revise · V invalid -> held semantic-failed (no revise re-ask) (Calls: 3, failed, 1/1)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A'), invalidCompose], reviewQueue: [okReviewRevise] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'semantic-failed');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 3);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 1);
  }

  // Row 15: C ok · pass · R budget -> held budget (Calls: 1, null, 1/0)
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [budgetOutcome] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'budget');
      assert.equal(res.semantic, null);
      assert.equal(res.logicalCalls, 1);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 0);
  }

  // Row 16: C unavailable (unsent) · C unavailable (unsent) -> held compose-failed (Calls: 0, null, 0/0)
  {
    const m = makeMockPorts({ composeQueue: [unavailableComposeUnsent, unavailableComposeUnsent], reviewQueue: [] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'compose-failed');
      assert.equal(res.semantic, null);
      assert.equal(res.logicalCalls, 0);
    }
    assert.equal(m.candidates.length, 0);
    assert.equal(m.reviews.length, 0);
  }

  // Row 17: exact · rules pass -> admit (dictated) (Calls: 0, out-of-scope, 1/0)
  {
    const m = makeMockPorts({ composeQueue: [], reviewQueue: [] });
    const res = await runPreparation(m.ports, { outage: 'hold', exact: 'Dictated statement' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') {
      assert.equal(res.candidate.text, 'Dictated statement');
      assert.equal(res.semantic, 'out-of-scope');
      assert.equal(res.logicalCalls, 0);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 0);
  }

  // Row 18: exact · rules hard -> held rules-failed (Calls: 0, failed, 1/0)
  {
    const m = makeMockPorts({
      composeQueue: [],
      rulesFn: () => ({ hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] }),
      reviewQueue: [],
    });
    const res = await runPreparation(m.ports, { outage: 'hold', exact: 'Dictated statement' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'rules-failed');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 0);
    }
    assert.equal(m.candidates.length, 1);
    assert.equal(m.reviews.length, 0);
  }

  // Row 19: C ok · pass · R invalid · R revise · V ok · pass -> held cap-reached (Calls: 4, failed, 2/2)
  {
    const m = makeMockPorts({
      composeQueue: [okCompose('A'), okCompose('B')],
      reviewQueue: [invalidReview, okReviewRevise],
    });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'cap-reached');
      assert.equal(res.semantic, 'failed');
      assert.equal(res.logicalCalls, 4);
    }
    assert.equal(m.candidates.length, 2);
    assert.equal(m.reviews.length, 2);
  }
});

test('release policy follows the section 10.5 table under both outage settings', async () => {
  // 1. Rules hard failure after cap -> held rules-failed, semantic failed
  {
    const m1 = makeMockPorts({
      composeQueue: [okCompose('A'), okCompose('B')],
      rulesFn: () => ({ hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] }),
      reviewQueue: [],
    });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'held');
    if (res1.kind === 'held') {
      assert.equal(res1.reason, 'rules-failed');
      assert.equal(res1.semantic, 'failed');
    }

    const m2 = makeMockPorts({
      composeQueue: [okCompose('A'), okCompose('B')],
      rulesFn: () => ({ hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] }),
      reviewQueue: [],
    });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'rules-failed');
      assert.equal(res2.semantic, 'failed');
    }
  }

  // 2. Valid pass -> admit, semantic passed
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [okReviewPass] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'admit');
    if (res.kind === 'admit') assert.equal(res.semantic, 'passed');
  }

  // 3. Valid semantic fail -> held semantic-failed, semantic failed
  {
    const m = makeMockPorts({ composeQueue: [okCompose('A'), okCompose('B')], reviewQueue: [okReviewRevise, okReviewRevise] });
    const res = await runPreparation(m.ports, { outage: 'hold' });
    assert.equal(res.kind, 'held');
    if (res.kind === 'held') {
      assert.equal(res.reason, 'semantic-failed');
      assert.equal(res.semantic, 'failed');
    }
  }

  // 4. Reviewer unavailable after cap:
  // rules-only: admit, unchecked-unavailable
  // hold: held reviewer-unavailable, unchecked-unavailable
  {
    const m1 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [unavailableReview, unavailableReview] });
    const res1 = await runPreparation(m1.ports, { outage: 'rules-only' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') assert.equal(res1.semantic, 'unchecked-unavailable');

    const m2 = makeMockPorts({ composeQueue: [okCompose('A')], reviewQueue: [unavailableReview, unavailableReview] });
    const res2 = await runPreparation(m2.ports, { outage: 'hold' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'reviewer-unavailable');
      assert.equal(res2.semantic, 'unchecked-unavailable');
    }
  }

  // 5. Dictated exact -> admit out-of-scope; hard rules fail -> held rules-failed, semantic failed
  {
    const m1 = makeMockPorts({ composeQueue: [], reviewQueue: [] });
    const res1 = await runPreparation(m1.ports, { outage: 'hold', exact: 'Owner dictation' });
    assert.equal(res1.kind, 'admit');
    if (res1.kind === 'admit') assert.equal(res1.semantic, 'out-of-scope');

    const m2 = makeMockPorts({
      composeQueue: [],
      rulesFn: () => ({ hardFailed: true, hard: [{ code: 'NEVER_LINE', severity: 'block' }], advisory: [] }),
      reviewQueue: [],
    });
    const res2 = await runPreparation(m2.ports, { outage: 'hold', exact: 'Bad words' });
    assert.equal(res2.kind, 'held');
    if (res2.kind === 'held') {
      assert.equal(res2.reason, 'rules-failed');
      assert.equal(res2.semantic, 'failed');
    }
  }
});

test('no call starts after the fourth logical call and transport retries do not count', async () => {
  // An ok outcome with wireAttempts: 4 counts as 1 logical call
  const multiWireUsage: CallUsage = {
    logicalCalls: 1,
    wireAttempts: 4,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: null,
    costUsd: 0.001,
  };
  const multiWireCompose: StepOutcome<{ text: string; citedEvidenceIds: string[]; packetSha256: string; selection: unknown }> = {
    kind: 'ok',
    value: { text: 'Candidate text', citedEvidenceIds: [], packetSha256: 'h', selection: {} },
    usage: multiWireUsage,
  };

  const m = makeMockPorts({
    composeQueue: [multiWireCompose],
    reviewQueue: [okReviewPass],
  });

  const res = await runPreparation(m.ports, { outage: 'hold' });
  assert.equal(res.kind, 'admit');
  if (res.kind === 'admit') {
    assert.equal(res.logicalCalls, 2); // 1 compose + 1 review
  }

  // Spy check: calls count is never > 4
  assert.ok(m.getCalls() <= 4);
});

test('a revised candidate never inherits a pass and a known failure never becomes unavailable', async () => {
  // A fails review (known failure). B is composed.
  // B's review is unavailable. Under hold, B is held as reviewer-unavailable, NOT passed.
  const m = makeMockPorts({
    composeQueue: [okCompose('A'), okCompose('B')],
    reviewQueue: [okReviewRevise, unavailableReview],
  });

  const res = await runPreparation(m.ports, { outage: 'hold' });
  assert.equal(res.kind, 'held');
  if (res.kind === 'held') {
    assert.equal(res.reason, 'reviewer-unavailable');
    assert.equal(res.semantic, 'unchecked-unavailable');
  }

  // If A failed rules, and B is composed, but cap is reached before B is reviewed:
  // result is held cap-reached with semantic failed (never unchecked-*).
  const m2 = makeMockPorts({
    composeQueue: [invalidCompose, okCompose('A'), okCompose('B')],
    reviewQueue: [okReviewRevise],
  });
  const res2 = await runPreparation(m2.ports, { outage: 'hold' });
  assert.equal(res2.kind, 'held');
  if (res2.kind === 'held') {
    assert.equal(res2.reason, 'cap-reached');
    assert.equal(res2.semantic, 'failed');
  }
});

test('dictated exact text gets the rules tier only', async () => {
  let composeCalled = false;
  let reviewCalled = false;

  const ports: PreparationPorts = {
    compose: async () => { composeCalled = true; throw new Error('Must not be called'); },
    rules: () => ({ hardFailed: false, hard: [], advisory: [] }),
    review: async () => { reviewCalled = true; throw new Error('Must not be called'); },
    onCandidate: () => 'cand-dictated',
    onReview: () => {},
    onUsage: () => {},
  };

  const res = await runPreparation(ports, { outage: 'hold', exact: 'Literal user text' });
  assert.equal(res.kind, 'admit');
  assert.equal(composeCalled, false);
  assert.equal(reviewCalled, false);
});

test('invented-detail settings change only NEW_BIOGRAPHY severity', async () => {
  // Test using previewCharacterSpeaker with different inventedDetails settings
  const doc = createDefaultCharacterDocument('Milo');
  const agent = { id: 'bot-1', name: 'Milo', model_id: 'gpt-4o' };

  // Review output containing NEW_BIOGRAPHY and UNSUPPORTED_FACT
  const mockReview = JSON.stringify({
    verdict: 'pass',
    scores: { voice: 4, fit: 4, consistency: 4 },
    findings: [
      { code: 'NEW_BIOGRAPHY', severity: 'warn', reason: 'Unverified background' },
      { code: 'UNSUPPORTED_FACT', severity: 'block', reason: 'False claim' },
    ],
    extracted: { claims: [], stances: [], relations: [] },
  });

  // 1. everyday-only -> NEW_BIOGRAPHY upgraded to block
  {
    const settings: CharacterSettings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        outage: 'hold',
        reviewer: null,
        inventedDetails: 'everyday-only',
      },
    };
    const res = await previewCharacterSpeaker({
      agent,
      doc,
      settings,
      situation: { type: 'post', about: 'test' },
      oneShotCall: async (p) => {
        if (p.purpose === 'preview-compose') return { text: '{"text":"Hello world","citedEvidenceIds":[]}' };
        return { text: mockReview };
      },
    });
    const bioFinding = res.review?.findings.find(f => f.code === 'NEW_BIOGRAPHY');
    assert.equal(bioFinding?.severity, 'block');
  }

  // 2. allowed -> NEW_BIOGRAPHY stays warn
  {
    const settings: CharacterSettings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        outage: 'hold',
        reviewer: null,
        inventedDetails: 'allowed',
      },
    };
    const res = await previewCharacterSpeaker({
      agent,
      doc,
      settings,
      situation: { type: 'post', about: 'test' },
      oneShotCall: async (p) => {
        if (p.purpose === 'preview-compose') return { text: '{"text":"Hello world","citedEvidenceIds":[]}' };
        return { text: mockReview };
      },
    });
    const bioFinding = res.review?.findings.find(f => f.code === 'NEW_BIOGRAPHY');
    assert.equal(bioFinding?.severity, 'warn');
  }

  // 3. none -> NEW_BIOGRAPHY upgraded to block
  {
    const settings: CharacterSettings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        outage: 'hold',
        reviewer: null,
        inventedDetails: 'none',
      },
    };
    const res = await previewCharacterSpeaker({
      agent,
      doc,
      settings,
      situation: { type: 'post', about: 'test' },
      oneShotCall: async (p) => {
        if (p.purpose === 'preview-compose') return { text: '{"text":"Hello world","citedEvidenceIds":[]}' };
        return { text: mockReview };
      },
    });
    const bioFinding = res.review?.findings.find(f => f.code === 'NEW_BIOGRAPHY');
    assert.equal(bioFinding?.severity, 'block');
  }
});

test('the Try it preview path keeps its two-call cap', async () => {
  let callCount = 0;
  const doc = createDefaultCharacterDocument('Milo');
  const agent = { id: 'bot-1', name: 'Milo', model_id: 'gpt-4o' };
  const settings: CharacterSettings = {
    ...defaultSettings,
    checks: {
      ...defaultSettings.checks,
      outage: 'hold',
      reviewer: null,
      inventedDetails: 'everyday-only',
    },
  };

  const res = await previewCharacterSpeaker({
    agent,
    doc,
    settings,
    situation: { type: 'post', about: 'test' },
    oneShotCall: async (p) => {
      callCount++;
      if (p.purpose === 'preview-compose') return { text: '{"text":"Preview post","citedEvidenceIds":[]}' };
      return {
        text: JSON.stringify({
          verdict: 'revise', // Even if revise is returned, preview stops at 2 calls
          scores: { voice: 2, fit: 2, consistency: 2 },
          findings: [{ code: 'OFF_VOICE', severity: 'block', reason: 'Failed voice' }],
          extracted: { claims: [], stances: [], relations: [] },
        }),
      };
    },
  });

  assert.equal(callCount, 2);
  assert.equal(res.logicalCalls, 2);
  assert.equal(res.ok, false);
});
