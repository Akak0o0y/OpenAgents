/**
 * Cortex rendering decisions, as pure functions.
 *
 * The panel's whole claim is that it shows the agent's real cognitive
 * architecture rather than a decorative animation. That claim lives or dies on
 * one rule:
 *
 *   A LAYER NEVER ANIMATES FROM DATA IT DOES NOT HAVE.
 *
 * Keeping the decision here - out of the React tree - means the rule is enforced
 * by the same `npm test` that guards the sandbox, instead of by a screenshot
 * nobody re-reads. `web/` imports this module; it is not a copy.
 */

import { AGENT_LAYERS, layerForEvent, type AgentLayer, type LayerId } from '../kernel/agent-layers.js';

/** What a ring is doing right now. */
export type LayerMotion = 'none' | 'pulse' | 'flare';

export type LayerTone = 'live' | 'partial' | 'hollow' | 'alarm';

export interface LayerVisual {
  id: LayerId;
  name: string;
  motion: LayerMotion;
  /** Hollow layers are drawn dashed: visibly not part of the working system. */
  stroke: 'solid' | 'dashed';
  /** Desaturated when this layer has nothing to show. */
  dimmed: boolean;
  tone: LayerTone;
  /** How many events have been attributed to this layer in this run. */
  eventCount: number;
  tooltip: string;
}

export interface CortexActivity {
  /** The layer the most recent attributable event belongs to, if any. */
  activeLayer: LayerId | null;
  /** Event totals per layer id. */
  eventCounts: Record<number, number>;
  /** True when a repair loop fired - the one thing that should look alarming. */
  alarm: boolean;
  /** Id of the newest event consumed, so a caller can resume from it. */
  latestEventId: number | null;
}

/** Minimal shape Cortex needs from an event. A subset of ExecutionEventRecord. */
export interface CortexEvent {
  id?: number | null;
  event_type: string;
  layer?: LayerId | null;
  timestamp: number;
}

/** Events that mean a repair loop ran. Layer 11 flares red for these. */
const ALARM_EVENTS = new Set(['THRASH_WARNING', 'PROTECTED_FILES_RESTAGED', 'PROVIDER_RETRY']);

/**
 * Reduce a run's events into what the panel should show.
 *
 * `layer` is read off the event when the daemon stamped it and recomputed
 * otherwise, so a Cortex fed by an older database (whose rows predate the layer
 * column) degrades to "no attribution" rather than to a wrong one.
 */
export function activityFromEvents(events: readonly CortexEvent[]): CortexActivity {
  const eventCounts: Record<number, number> = {};
  let activeLayer: LayerId | null = null;
  let alarm = false;
  let latestEventId: number | null = null;

  for (const event of events) {
    const layer = event.layer ?? layerForEvent(event.event_type);
    if (layer !== null && layer !== undefined) {
      eventCounts[layer] = (eventCounts[layer] ?? 0) + 1;
      activeLayer = layer;
    }
    if (ALARM_EVENTS.has(event.event_type)) alarm = true;
    if (typeof event.id === 'number') latestEventId = event.id;
  }

  return { activeLayer, eventCounts, alarm, latestEventId };
}

/**
 * Decide how one ring is drawn.
 *
 * The ordering of the checks is the honesty guarantee: `hollow` is answered
 * FIRST and returns unconditionally, so no later branch - not the active layer,
 * not the alarm - can give motion to a layer that has no subsystem behind it.
 */
export function layerVisual(
  layer: AgentLayer,
  activity: CortexActivity,
  options: { reducedMotion?: boolean } = {}
): LayerVisual {
  if (layer.status === 'hollow') {
    return {
      id: layer.id,
      name: layer.name,
      motion: 'none',
      stroke: 'dashed',
      dimmed: true,
      tone: 'hollow',
      eventCount: 0,
      tooltip: `Not instrumented. ${layer.evidence}`,
    };
  }

  const eventCount = activity.eventCounts[layer.id] ?? 0;
  const isActive = activity.activeLayer === layer.id;
  const isAlarming = activity.alarm && layer.id === 11;

  // Reduced motion keeps every state COLOUR and drops only the movement, so the
  // panel still says the same thing to someone who cannot tolerate animation.
  let motion: LayerMotion = 'none';
  if (!options.reducedMotion) {
    if (isAlarming) motion = 'flare';
    else if (isActive) motion = 'pulse';
  }

  return {
    id: layer.id,
    name: layer.name,
    motion,
    stroke: 'solid',
    dimmed: eventCount === 0 && !isActive,
    tone: isAlarming ? 'alarm' : layer.status === 'partial' ? 'partial' : 'live',
    eventCount,
    tooltip:
      eventCount > 0
        ? `${layer.description} (${eventCount} event${eventCount === 1 ? '' : 's'} this run)`
        : `${layer.description} - no events yet this run. ${layer.evidence}`,
  };
}

/** The whole ring set, in render order (innermost cognition -> outermost I/O). */
export function cortexView(
  activity: CortexActivity,
  options: { reducedMotion?: boolean } = {}
): LayerVisual[] {
  return AGENT_LAYERS.map((layer) => layerVisual(layer, activity, options));
}

/** An empty activity, for a panel with no run selected. */
export function emptyActivity(): CortexActivity {
  return { activeLayer: null, eventCounts: {}, alarm: false, latestEventId: null };
}

/**
 * Geometry for the concentric ring layout.
 *
 * Layer 1 (system prompt) sits innermost and layer 12 (persistence) outermost,
 * so the picture reads inside-out: cognition at the core, the world at the edge.
 */
export function ringRadius(layerId: LayerId, innerRadius = 44, gap = 26): number {
  return innerRadius + (layerId - 1) * gap;
}
