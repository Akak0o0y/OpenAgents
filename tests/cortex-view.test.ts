/**
 * Phase B: the hollow-layer rule, enforced.
 *
 * Risk 1 in the plan is that the panel drifts into decoration. The mitigation is
 * this file. Every assertion below is about the panel REFUSING to show something
 * it cannot justify, which is the opposite of what a normal UI test checks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LAYERS, getLayer } from '../src/kernel/agent-layers.js';
import {
  activityFromEvents,
  cortexView,
  emptyActivity,
  layerVisual,
  ringRadius,
  type CortexEvent,
} from '../src/cortex/layer-view.js';

function ev(id: number, event_type: string, layer?: number | null): CortexEvent {
  return { id, event_type, layer: layer as any, timestamp: 1_700_000_000_000 + id };
}

const RUN: CortexEvent[] = [
  ev(1, 'TASK_STARTED', 1),
  ev(2, 'PROMPT_ASSEMBLED', 1),
  ev(3, 'HISTORY_APPENDED', 2),
  ev(4, 'TURN_COMPLETED', 9),
];

describe('THE RULE: a hollow layer never animates', () => {
  it('gives every hollow layer no motion, whatever is happening', () => {
    // Drive it with the loudest possible state: an alarm firing, and each hollow
    // layer forced into activeLayer with events attached. Nothing may move.
    for (const layer of AGENT_LAYERS.map(l => ({ ...l, status: 'hollow' as const, eventTypes: [] }))) {
      const visual = layerVisual(layer, {
        activeLayer: layer.id,
        eventCounts: { [layer.id]: 999 },
        alarm: true,
        latestEventId: 1,
      });
      assert.equal(visual.motion, 'none', `layer ${layer.id} must never animate`);
      assert.equal(visual.stroke, 'dashed');
      assert.equal(visual.dimmed, true);
      assert.equal(visual.tone, 'hollow');
      assert.equal(visual.eventCount, 0, 'a hollow layer reports no events even if handed some');
      assert.match(visual.tooltip, /Not instrumented/);
    }
  });

  it('says WHY the layer is hollow, not merely that it is', () => {
    const hypothetical = layerVisual({ ...getLayer(3), status: 'hollow', evidence: 'Fixture has no memory backend.', eventTypes: [] }, emptyActivity());
    assert.match(hypothetical.tooltip, /Fixture has no memory backend/);
  });

  it('NEGATIVE CONTROL: the same drive DOES animate a live layer', () => {
    // Without this, "nothing animated" could just mean animation is broken
    // everywhere, and the test above would pass for the wrong reason.
    const live = layerVisual(getLayer(1), {
      activeLayer: 1,
      eventCounts: { 1: 3 },
      alarm: false,
      latestEventId: 1,
    });
    assert.equal(live.motion, 'pulse');
    assert.equal(live.stroke, 'solid');
  });

  it('lights memory, compaction and recall only from their recorded events', () => {
    for (const [id, event] of [[3, 'MEMORY_WRITTEN'], [4, 'CONTEXT_COMPACTED'], [5, 'MEMORY_RECALLED']] as const) {
      const view = cortexView(activityFromEvents([...RUN, ev(5,event,id)]));
      assert.equal(view.find(v=>v.id===id)?.motion,'pulse');
    }
  });
});

describe('activity is derived from events that actually happened', () => {
  it('counts per layer and tracks the most recent one as active', () => {
    const a = activityFromEvents(RUN);
    assert.equal(a.activeLayer, 9, 'the last attributable event wins');
    assert.deepEqual(a.eventCounts, { 1: 2, 2: 1, 9: 1 });
    assert.equal(a.latestEventId, 4);
    assert.equal(a.alarm, false);
  });

  it('falls back to the taxonomy for rows written before the layer column', () => {
    // An old database has layer = null. Recomputing is right; guessing is not.
    const a = activityFromEvents([ev(1, 'TASK_STARTED', null), ev(2, 'TURN_COMPLETED', null)]);
    assert.deepEqual(a.eventCounts, { 1: 1, 9: 1 });
  });

  it('attributes nothing for an event the taxonomy does not know', () => {
    const a = activityFromEvents([ev(1, 'SOME_FUTURE_EVENT', null)]);
    assert.deepEqual(a.eventCounts, {});
    assert.equal(a.activeLayer, null, 'an unknown event must not light up a ring');
  });

  it('an empty run lights nothing at all', () => {
    const view = cortexView(activityFromEvents([]));
    assert.equal(view.filter((v) => v.motion !== 'none').length, 0);
    assert.equal(view.every((v) => v.dimmed), true, 'no idle ambient motion or glow');
  });
});

describe('layer 11 flares only when a repair loop really ran', () => {
  for (const trigger of ['THRASH_WARNING', 'PROTECTED_FILES_RESTAGED', 'PROVIDER_RETRY']) {
    it(`flares on ${trigger}`, () => {
      const activity = activityFromEvents([...RUN, ev(5, trigger, 11)]);
      const repair = cortexView(activity).find((v) => v.id === 11)!;
      assert.equal(repair.motion, 'flare');
      assert.equal(repair.tone, 'alarm');
    });
  }

  it('NEGATIVE CONTROL: a clean run leaves layer 11 quiet', () => {
    const repair = cortexView(activityFromEvents(RUN)).find((v) => v.id === 11)!;
    assert.equal(repair.motion, 'none');
    assert.notEqual(repair.tone, 'alarm');
  });

  it('the alarm flares layer 11 ONLY, never a bystander', () => {
    const view = cortexView(activityFromEvents([...RUN, ev(5, 'THRASH_WARNING', 11)]));
    assert.deepEqual(view.filter((v) => v.motion === 'flare').map((v) => v.id), [11]);
  });
});

describe('prefers-reduced-motion', () => {
  it('drops all movement but keeps every state colour', () => {
    const activity = activityFromEvents([...RUN, ev(5, 'THRASH_WARNING', 11)]);
    const moving = cortexView(activity, { reducedMotion: false });
    const still = cortexView(activity, { reducedMotion: true });

    assert.ok(moving.some((v) => v.motion !== 'none'), 'fixture must animate without the flag');
    assert.equal(still.every((v) => v.motion === 'none'), true, 'reduced motion means no motion');

    // The information must survive: tone and counts are unchanged.
    assert.deepEqual(
      still.map((v) => [v.id, v.tone, v.eventCount]),
      moving.map((v) => [v.id, v.tone, v.eventCount])
    );
    assert.equal(still.find((v) => v.id === 11)!.tone, 'alarm', 'the alarm is still legible');
  });
});

describe('ring geometry', () => {
  it('orders cognition inward and I/O outward, without overlap', () => {
    const radii = AGENT_LAYERS.map((l) => ringRadius(l.id));
    for (let i = 1; i < radii.length; i++) {
      assert.ok(radii[i] > radii[i - 1], `ring ${i + 1} must sit outside ring ${i}`);
    }
    assert.ok(radii[0] > 0);
  });
});
