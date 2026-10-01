import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveEvidence,
  targetExcerpt,
  briefEvidence,
  evidenceSnapshot,
  ownerDictation,
  EXACT_NOT_OWNER,
  type RunEvidenceContext,
  type TypedEvidence,
} from '../src/daemon/character-evidence.js';
import { evidenceSource, type EvidenceSource } from '../src/daemon/deliverable-checks.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/character/phase2/evidence.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  statusPage: string;
  timeline: string;
};

test('run sources become typed evidence with origin and trust set by code', () => {
  const reqRoutine = evidenceSource('req-1', 'User instruction and supplied material', 'Post an update');
  const reqChat = evidenceSource('req-2', 'User instruction and supplied material', 'Hello chat');
  const reqMission = evidenceSource('req-3', 'Mission step context (unverified)', 'Mission step');
  const objective = evidenceSource('obj-1', 'Mission objective supplied by the operator', 'Launch 1.0');
  const memorySource = evidenceSource('memory-note-1', 'Bot memory note key (unverified note)', 'Remember XYZ');
  const browserSource = evidenceSource('src-browser', 'Browser https://x.com/u3/status/123 | Status', 'Post text');
  const webSource = evidenceSource('src-web', 'Web https://example.com | Title', 'Page text');
  const mcpSource = evidenceSource('src-mcp', 'MCP github.search_issues', 'Issue data');
  const restoredSource = evidenceSource('src-restored', 'Browser https://x.com/u3/status/456', 'Old post');

  // 1. Routine run
  const routineCtx: RunEvidenceContext = {
    runId: 'run-routine',
    kind: 'routine',
    sources: [reqRoutine, memorySource, browserSource, webSource, mcpSource, restoredSource],
    captures: new Map([
      ['src-browser', { url: 'https://x.com/u3/status/123', capturedAt: '2026-09-25T10:00:00Z' }],
    ]),
    restoredIds: new Set(['src-restored']),
    requestId: 'req-1',
    sourceLimit: 20,
  };

  const resRoutine = resolveEvidence(routineCtx, {
    op: 'post',
    evidence: ['req-1', 'memory-note-1', 'src-browser', 'src-web', 'src-mcp', 'src-restored'],
  });
  assert.equal(resRoutine.ok, true);
  if (!resRoutine.ok) return;

  const items = resRoutine.items;
  const reqItem = items.find(i => i.sourceId === 'req-1')!;
  assert.equal(reqItem.origin, 'owner');
  assert.equal(reqItem.trust, 'owner');

  const memItem = items.find(i => i.sourceId === 'memory-note-1')!;
  assert.equal(memItem.origin, 'memory');
  assert.equal(memItem.trust, 'unverified');

  const browserItem = items.find(i => i.sourceId === 'src-browser')!;
  assert.equal(browserItem.origin, 'page');
  assert.equal(browserItem.trust, 'unverified');
  assert.equal(browserItem.postId, '123');

  const webItem = items.find(i => i.sourceId === 'src-web')!;
  assert.equal(webItem.origin, 'page');
  assert.equal(webItem.trust, 'unverified');

  const mcpItem = items.find(i => i.sourceId === 'src-mcp')!;
  assert.equal(mcpItem.origin, 'page');
  assert.equal(mcpItem.trust, 'unverified');

  const restoredItem = items.find(i => i.sourceId === 'src-restored')!;
  assert.equal(restoredItem.origin, 'page');
  assert.equal(restoredItem.trust, 'unverified');

  // Verify trust is never 'verified' and origin is never 'verified-result'
  for (const item of items) {
    assert.notEqual(item.trust, 'verified');
    assert.notEqual(item.origin, 'verified-result');
  }

  // 2. Owner-chat run
  const chatCtx: RunEvidenceContext = {
    runId: 'run-chat',
    kind: 'owner-chat',
    sources: [reqChat],
    captures: new Map(),
    restoredIds: new Set(),
    requestId: 'req-2',
    sourceLimit: 20,
  };
  const resChat = resolveEvidence(chatCtx, { op: 'post', evidence: ['req-2'] });
  assert.equal(resChat.ok, true);
  if (resChat.ok) {
    assert.equal(resChat.items[0].origin, 'owner');
    assert.equal(resChat.items[0].trust, 'owner');
  }

  // 3. Mission run
  const missionCtx: RunEvidenceContext = {
    runId: 'run-mission',
    kind: 'mission',
    sources: [reqMission, objective],
    captures: new Map(),
    restoredIds: new Set(),
    requestId: 'req-3',
    objectiveId: 'obj-1',
    sourceLimit: 20,
  };
  const resMission = resolveEvidence(missionCtx, { op: 'post', evidence: ['req-3', 'obj-1'] });
  assert.equal(resMission.ok, true);
  if (resMission.ok) {
    const mReq = resMission.items.find(i => i.sourceId === 'req-3')!;
    assert.equal(mReq.origin, 'mission');
    assert.equal(mReq.trust, 'unverified');

    const mObj = resMission.items.find(i => i.sourceId === 'obj-1')!;
    assert.equal(mObj.origin, 'owner');
    assert.equal(mObj.trust, 'owner');
  }
});

test("a reply binds only to this run's capture of the target's status page", () => {
  const statusSource = evidenceSource('src-status', 'Browser https://x.com/u3/status/123456789', fixtures.statusPage);
  const timelineSource = evidenceSource('src-timeline', 'Browser https://x.com/home', fixtures.timeline);
  const otherSource = evidenceSource('src-other', 'Browser https://x.com/explore', 'Explore page');

  const ctx: RunEvidenceContext = {
    runId: 'run-reply',
    kind: 'routine',
    sources: [statusSource, timelineSource, otherSource],
    captures: new Map([
      ['src-status', { url: 'https://x.com/u3/status/123456789', capturedAt: '2026-09-25T10:00:00Z' }],
      ['src-timeline', { url: 'https://x.com/home', capturedAt: '2026-09-25T10:00:01Z' }],
      ['src-other', { url: 'https://x.com/explore', capturedAt: '2026-09-25T10:00:02Z' }],
    ]),
    restoredIds: new Set(),
    requestId: 'req-reply',
    sourceLimit: 20,
  };

  // Status page binds successfully
  const resStatus = resolveEvidence(ctx, {
    op: 'reply',
    replyTo: { sourceId: 'src-status', url: 'https://x.com/u3/status/123456789' },
  });
  assert.equal(resStatus.ok, true);
  if (resStatus.ok) {
    assert.ok(resStatus.target);
    assert.equal(resStatus.target.postId, '123456789');
    assert.equal(resStatus.target.sourceId, 'src-status');
  }

  // Timeline capture that merely shows /url: /u3/status/123456789 does NOT bind
  const resTimeline = resolveEvidence(ctx, {
    op: 'reply',
    replyTo: { sourceId: 'src-timeline', url: 'https://x.com/home' },
  });
  assert.equal(resTimeline.ok, false);
  if (!resTimeline.ok) {
    assert.equal(resTimeline.held, 'target-unbound');
  }

  // URL without status id gives target-unbound
  const resOther = resolveEvidence(ctx, {
    op: 'reply',
    replyTo: { sourceId: 'src-other', url: 'https://x.com/explore' },
  });
  assert.equal(resOther.ok, false);
  if (!resOther.ok) {
    assert.equal(resOther.held, 'target-unbound');
  }
});

test('restored sources and unknown ids never bind a reply target', () => {
  const restoredSource = evidenceSource('src-restored', 'Browser https://x.com/u3/status/999', fixtures.statusPage);
  const normalSource = evidenceSource('src-normal', 'Browser https://x.com/u3/status/111', fixtures.statusPage);

  const ctx: RunEvidenceContext = {
    runId: 'run-restored',
    kind: 'routine',
    sources: [restoredSource, normalSource],
    captures: new Map([
      ['src-restored', { url: 'https://x.com/u3/status/999', capturedAt: '2026-09-25T10:00:00Z' }],
      ['src-normal', { url: 'https://x.com/u3/status/111', capturedAt: '2026-09-25T10:00:00Z' }],
    ]),
    restoredIds: new Set(['src-restored']),
    requestId: 'req-test',
    sourceLimit: 20,
  };

  // Restored id gives target-unbound
  const resRestored = resolveEvidence(ctx, {
    op: 'reply',
    replyTo: { sourceId: 'src-restored', url: 'https://x.com/u3/status/999' },
  });
  assert.equal(resRestored.ok, false);
  if (!resRestored.ok) {
    assert.equal(resRestored.held, 'target-unbound');
  }

  // Unknown id for reply target gives target-unbound
  const resUnknownReply = resolveEvidence(ctx, {
    op: 'reply',
    replyTo: { sourceId: 'src-nonexistent', url: 'https://x.com/u3/status/777' },
  });
  assert.equal(resUnknownReply.ok, false);
  if (!resUnknownReply.ok) {
    assert.equal(resUnknownReply.held, 'target-unbound');
  }

  // Unknown evidence id gives evidence-missing and lists the ids
  const resUnknownEv = resolveEvidence(ctx, {
    op: 'post',
    evidence: ['src-missing-1', 'src-missing-2', 'src-normal'],
  });
  assert.equal(resUnknownEv.ok, false);
  if (!resUnknownEv.ok) {
    assert.equal(resUnknownEv.held, 'evidence-missing');
    assert.deepEqual(resUnknownEv.missing, ['src-missing-1', 'src-missing-2']);
  }
});

test('a full source store yields evidence-unavailable and never invents an id', () => {
  const sources: EvidenceSource[] = [
    evidenceSource('s1', 'page', 'Text 1'),
    evidenceSource('s2', 'page', 'Text 2'),
    evidenceSource('s3', 'page', 'Text 3'),
  ];

  const ctx: RunEvidenceContext = {
    runId: 'run-full',
    kind: 'routine',
    sources,
    captures: new Map(),
    restoredIds: new Set(),
    requestId: 'req-full',
    sourceLimit: 3, // Full store!
  };

  const res = resolveEvidence(ctx, {
    op: 'post',
    evidence: ['s-invented-4'],
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.held, 'evidence-unavailable');
    assert.deepEqual(res.missing, ['s-invented-4']);
  }

  // No id was generated, sources array untouched
  assert.equal(ctx.sources.length, 3);
});

test("exact text must equal a span of the owner's own messages", () => {
  assert.equal(EXACT_NOT_OWNER, "exact text must be the owner's own words");

  const owner = {
    request: 'Please tweet "Ship early, ship often" today with great care.',
    history: [
      { role: 'user', content: 'Also remember to test thoroughly on staging first.' },
      { role: 'assistant', content: 'I will prepare the deployment tweet now.' },
    ],
  };

  // 1. A span of the request passes
  assert.equal(ownerDictation('Ship early, ship often', owner), true);
  assert.equal(ownerDictation('with great care', owner), true);

  // 2. A history user span passes
  assert.equal(ownerDictation('test thoroughly on staging first', owner), true);

  // 3. An assistant span fails
  assert.equal(ownerDictation('prepare the deployment tweet', owner), false);

  // 4. Attachment text appended after operatorRequest fails
  // (owner.request is operatorRequest alone, without attachment text)
  assert.equal(ownerDictation('Attached specs from PDF', owner), false);

  // 5. CRLF in the message against LF in exact passes
  const crlfOwner = {
    request: 'Line one\r\nLine two\r\nLine three',
    history: [],
  };
  assert.equal(ownerDictation('Line one\nLine two', crlfOwner), true);

  // 6. NFD against NFC passes
  const nfdOwner = {
    request: 'Caf\u0065\u0301 au lait', // e + combining acute
    history: [],
  };
  assert.equal(ownerDictation('Caf\u00E9 au lait', nfdOwner), true); // single precomposed é

  // 7. Doubled interior spaces must match exactly
  const doubleSpaceOwner = {
    request: 'Release  v2.0  is ready',
    history: [],
  };
  assert.equal(ownerDictation('Release v2.0 is ready', doubleSpaceOwner), false);
  assert.equal(ownerDictation('Release  v2.0  is ready', doubleSpaceOwner), true);

  // 8. Surrounding quotes excluded from exact pass; changed quote characters fail
  assert.equal(ownerDictation('Ship early, ship often', owner), true);
  assert.equal(ownerDictation('"Ship early, ship often"', owner), true);
  assert.equal(ownerDictation("'Ship early, ship often'", owner), false);

  // 9. Outer whitespace passes (trimmed)
  assert.equal(ownerDictation('   Ship early, ship often   ', owner), true);
});

test('excerpts stay within the brief and snapshot budgets at whole-line boundaries', () => {
  // 1. targetExcerpt: first article block, <= 1000 characters
  const statusSnapshot = fixtures.statusPage;
  const excerpt = targetExcerpt(statusSnapshot, 1000);
  assert.ok(excerpt.length <= 1000);
  assert.ok(excerpt.includes("Milo's latest update"));
  // Does not include second article ("Reply from user")
  assert.ok(!excerpt.includes('Reply from user'));

  // 2. Truncation at whole-line boundary ending with …
  const longMultiLine = Array.from({ length: 40 }, (_, i) => `Line number ${i}: detailed status report content`).join('\n');
  const shortTarget = targetExcerpt(longMultiLine, 250);
  assert.ok(shortTarget.length <= 250, `length ${shortTarget.length} <= 250`);
  assert.ok(shortTarget.endsWith('…'), 'ends with ellipsis');
  // Check that every line except the last is a complete intact line
  const lines = shortTarget.slice(0, -1).split('\n');
  for (const l of lines) {
    assert.match(l, /^Line number \d+: detailed status report content$/);
  }

  // 3. Arabic and emoji are never split
  const arabicText = 'مَرْحَبًا بِكُمْ\nفِي هَذَا التَّطْبِيقِ الجَدِيدِ\nمَعَ تَحِيَّاتِ فَرِيقِ العَمَلِ';
  const truncatedArabic = targetExcerpt(arabicText, 35);
  assert.ok(truncatedArabic.length <= 35);
  assert.ok(truncatedArabic.endsWith('…'));

  const emojiText = 'Line 1: 👨‍👩‍👧‍👦 Family emoji test\nLine 2: 🎉 Celebration party\nLine 3: 👋🏽 Hand with skin tone';
  const truncatedEmoji = targetExcerpt(emojiText, 60);
  assert.ok(truncatedEmoji.length <= 60);
  assert.ok(truncatedEmoji.endsWith('…'));

  // 4. briefEvidence: total length of excerpts <= 600
  const ev1: TypedEvidence = {
    sourceId: 'ev-1',
    origin: 'page',
    text: Array.from({ length: 20 }, (_, i) => `Evidence 1 Line ${i}: information`).join('\n'),
    capturedAt: '2026-09-25T10:00:00Z',
    runId: 'r1',
    trust: 'unverified',
  };
  const ev2: TypedEvidence = {
    sourceId: 'ev-2',
    origin: 'page',
    text: Array.from({ length: 20 }, (_, i) => `Evidence 2 Line ${i}: details`).join('\n'),
    capturedAt: '2026-09-25T10:00:00Z',
    runId: 'r1',
    trust: 'unverified',
  };

  const brief = briefEvidence([ev1, ev2], 600);
  assert.equal(brief.length, 2);
  const totalBriefLen = brief.reduce((sum, b) => sum + b.excerpt.length, 0);
  assert.ok(totalBriefLen <= 600, `totalBriefLen ${totalBriefLen} <= 600`);
  assert.ok(brief[0].excerpt.endsWith('…'));
  assert.ok(brief[1].excerpt.endsWith('…'));

  // 5. evidenceSnapshot: total length <= 2400
  const targetEv: TypedEvidence = {
    sourceId: 'target-1',
    origin: 'page',
    text: Array.from({ length: 50 }, (_, i) => `Target Line ${i}: reply context`).join('\n'),
    capturedAt: '2026-09-25T10:00:00Z',
    runId: 'r1',
    trust: 'unverified',
  };

  const snap = evidenceSnapshot(targetEv, [ev1, ev2]);
  assert.equal(snap.length, 3);
  const totalSnapLen = snap.reduce((sum, s) => sum + s.text.length, 0);
  assert.ok(totalSnapLen <= 2400, `totalSnapLen ${totalSnapLen} <= 2400`);
});
