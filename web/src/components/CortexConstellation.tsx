/**
 * The Cortex constellation: the bot at the centre, everything it is made of
 * linked to it.
 *
 * Replaces the 3D particle galaxy. The CONTENT is unchanged - the same twelve
 * layers, the same tools and MCP servers from galaxyNodes(), the same statuses,
 * the same focus card, the same View settings - but the picture is a map you
 * can read: every layer is a labelled node on a spiral winding out from the
 * bot, every tool hangs off its layer, and the links show what connects to what.
 *
 * WHAT MOVES, AND WHY. A link only flows when its layer has evidence in the
 * selected run; the layer that produced the newest event pulses; a new event
 * sends a spark down the link. Hollow layers and unconnected tools are dashed
 * and still, and layerVisual() - the tested function the old galaxy used -
 * still decides that, so no animation can claim a layer this runtime lacks.
 * Everything else that moves (orbits, stars, the entrance) is ambience and is
 * switched off by reduced motion, or by the View panel's Rotation switch.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ALARM_COLOR,
  HOLLOW_COLOR,
  bandT,
  galaxyNodes,
  rampColor,
  type GalaxyNode,
} from '@kernel/cortex/galaxy.js';
import { cortexView, type LayerVisual } from '@kernel/cortex/layer-view.js';
import { useCortex } from '../store.js';
import type { BotProfile } from '../lib/botProfile.js';
import {
  CORE_RADIUS,
  HALF,
  WORLD,
  curvePath,
  layerRadius,
  placeNodes,
  polar,
  spiralPath,
  starField,
  type PlacedNode,
} from '../lib/constellation.js';
import { Icon, type IconName } from './ui/icons.js';
import { CortexFace, StatusPill, botColor, rgbCss } from './CortexKit.js';

const LAYER_ICON: Record<number, IconName> = {
  1: 'template',
  2: 'chat',
  3: 'section',
  4: 'data',
  5: 'search',
  6: 'grid',
  7: 'run',
  8: 'preview',
  9: 'edit',
  10: 'computer',
  11: 'refresh',
  12: 'file',
};

function iconFor(node: GalaxyNode): IconName {
  if (node.kind === 'layer') return LAYER_ICON[node.layerId] ?? 'cortex';
  if (node.id === 'tool-test-container') return 'ok';
  if (node.id === 'tool-opencode') return 'bot';
  if (node.id === 'tool-cost-ledger') return 'usage';
  if (node.id === 'tool-obsidian') return 'attach';
  return 'link';
}

type Tone = 'live' | 'partial' | 'hollow' | 'alarm' | 'planned';

interface NodeState {
  tone: Tone;
  lit: boolean;
  pulsing: boolean;
  count: number;
  color: string;
  status: string;
}

function stateFor(placed: PlacedNode, visuals: Map<number, LayerVisual>): NodeState {
  const { node } = placed;
  const visual = visuals.get(node.layerId);
  if (node.kind === 'tool') {
    const connected = node.status === 'live';
    const lit = connected && (visual?.eventCount ?? 0) > 0 && visual?.tone !== 'hollow';
    return {
      tone: connected ? 'live' : 'planned',
      lit,
      pulsing: false,
      count: 0,
      color: rgbCss(connected ? rampColor(bandT(node.layerId)) : HOLLOW_COLOR),
      status: connected ? 'Connected' : 'Not connected',
    };
  }
  // A layer: layerVisual() has already answered hollow first.
  const tone: Tone = visual?.tone ?? 'hollow';
  const count = visual?.eventCount ?? 0;
  return {
    tone,
    lit: tone !== 'hollow' && count > 0,
    pulsing: visual?.motion === 'pulse' || visual?.motion === 'flare',
    count,
    color: rgbCss(tone === 'hollow' ? HOLLOW_COLOR : tone === 'alarm' ? ALARM_COLOR : rampColor(bandT(node.layerId))),
    status:
      tone === 'hollow'
        ? 'Not instrumented'
        : tone === 'alarm'
          ? 'Repair loop fired'
          : count > 0
            ? `${count} event${count === 1 ? '' : 's'}`
            : tone === 'partial'
              ? 'Partial'
              : 'Live',
  };
}

function labelSide(angle: number): 'left' | 'right' | 'top' | 'bottom' {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  if (Math.abs(cos) < 0.34) return sin < 0 ? 'top' : 'bottom';
  return cos > 0 ? 'right' : 'left';
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** True while the camera is gliding to a focus rather than following a drag or wheel. */
  flight: boolean;
}

const HOME: Camera = { x: 0, y: 0, zoom: 1, flight: true };

export function CortexConstellation({
  profile,
  focusId,
  hoveredId,
  onSelect,
  onHover,
}: {
  profile?: BotProfile;
  focusId: string | null;
  hoveredId: string | null;
  onSelect: (node: GalaxyNode | null) => void;
  onHover: (node: GalaxyNode | null) => void;
}) {
  const mcp = useCortex((s) => s.mcp);
  const agents = useCortex((s) => s.agents);
  const selectedAgentId = useCortex((s) => s.selectedAgentId);
  const isCapabilityLinked = useCortex((s) => s.isCapabilityLinked);
  const activity = useCortex((s) => s.activity);
  const view = useCortex((s) => s.view);
  const osReduced = useReducedMotion() ?? false;
  const reduced = osReduced || view.reducedMotion;

  const activeAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
  const accent = botColor(activeAgent, profile);

  const placed = useMemo(() => placeNodes(galaxyNodes(mcp)), [mcp]);
  const visuals = useMemo(
    () => new Map(cortexView(activity, { reducedMotion: reduced }).map((v) => [v.id, v])),
    [activity, reduced]
  );
  const stars = useMemo(() => starField(Math.round(view.particlesPerLayer / 8), view.seed), [view.particlesPerLayer, view.seed]);
  const spiral = useMemo(
    () => spiralPath(placed.filter((p) => p.node.kind === 'layer').map((p) => p.point)),
    [placed]
  );

  const agentNode = useMemo<GalaxyNode | null>(() => {
    if (!activeAgent) return null;
    return {
      id: `agent-${activeAgent.id}`,
      kind: 'agent',
      label: activeAgent.name,
      layerId: 6,
      status: 'live',
      position: [0, 0, 0],
      description: `Active bot: ${activeAgent.name} (${activeAgent.model_id}). Status: ${activeAgent.current_status}. Role: ${activeAgent.system_prompt || 'Default instructions'}.`,
      integration: `Primary intelligence nexus for ${activeAgent.name}. Every layer and tool around it is linked back here.`,
      eventTypes: ['agent.action', 'agent.dispatch', 'agent.tool_call', 'agent.thought'],
    };
  }, [activeAgent]);

  // ---------------------------------------------------------------- camera --
  const container = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0.6);
  const [camera, setCamera] = useState<Camera>(HOME);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setFit(Math.max(0.3, Math.min(width / (WORLD * 0.98), (height - 150) / (WORLD * 0.86))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom around the pointer. Non-passive, so the page itself never scrolls.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      setCamera((c) => {
        const zoom = Math.min(2.8, Math.max(0.55, c.zoom * Math.exp(-event.deltaY * 0.0014)));
        const k = zoom / c.zoom;
        return { zoom, x: px - (px - c.x) * k, y: py - (py - c.y) * k, flight: false };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Focusing a body glides it just left of centre, clear of the detail card.
  useEffect(() => {
    if (!focusId) {
      setCamera(HOME);
      return;
    }
    const target = focusId.startsWith('agent-') ? { x: 0, y: 0 } : placed.find((p) => p.node.id === focusId)?.point;
    if (!target) return;
    const zoom = 1.3;
    setCamera({ zoom, x: -target.x * fit * zoom - 170, y: -target.y * fit * zoom, flight: true });
  }, [focusId, fit, placed]);

  const zoomBy = (factor: number) =>
    setCamera((c) => {
      const zoom = Math.min(2.8, Math.max(0.55, c.zoom * factor));
      const k = zoom / c.zoom;
      return { zoom, x: c.x * k, y: c.y * k, flight: true };
    });

  // ------------------------------------------------------------- highlight --
  const related = useMemo(() => {
    if (!hoveredId) return null;
    const hovered = placed.find((p) => p.node.id === hoveredId);
    const ids = new Set<string>([hoveredId]);
    if (hovered?.node.kind === 'tool') ids.add(`layer-${hovered.node.layerId}`);
    if (hovered?.node.kind === 'layer') {
      for (const p of placed) if (p.node.kind === 'tool' && p.node.layerId === hovered.node.layerId) ids.add(p.node.id);
    }
    return ids;
  }, [hoveredId, placed]);
  const faded = (id: string) => (related && !related.has(id) ? 'is-faded' : '');

  const hasActivity = activity.activeLayer !== null;
  const sceneClass = [
    'cx-constellation',
    reduced ? 'is-reduced' : '',
    view.rotate && !reduced ? 'is-rotating' : '',
    hasActivity ? 'is-busy' : '',
    dragging ? 'is-dragging' : '',
    related ? 'has-hover' : '',
  ].join(' ');

  const scale = fit * camera.zoom;
  const showLabel = (placedNode: PlacedNode, selected: boolean) =>
    view.labels !== 'none' || selected || hoveredId === placedNode.node.id;

  return (
    <div
      ref={container}
      className={sceneClass}
      style={{ '--cx-accent': accent } as CSSProperties}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        drag.current = { startX: event.clientX, startY: event.clientY, originX: camera.x, originY: camera.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        const dx = event.clientX - d.startX;
        const dy = event.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true;
          setDragging(true);
        }
        if (d.moved) setCamera((c) => ({ ...c, x: d.originX + dx, y: d.originY + dy, flight: false }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        // A click on empty sky closes the focus, as the 3D view's did.
        if (d && !d.moved) onSelect(null);
      }}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) setCamera(HOME);
      }}
    >
      <div
        className={`cx-stage ${camera.flight ? 'is-flight' : ''}`}
        style={{
          width: WORLD,
          height: WORLD,
          transform: `translate(calc(-50% + ${camera.x}px), calc(-50% + ${camera.y}px)) scale(${scale})`,
        }}
      >
        <svg className="cx-sky" viewBox={`${-HALF} ${-HALF} ${WORLD} ${WORLD}`} width={WORLD} height={WORLD} aria-hidden="true">
          <defs>
            <radialGradient id="cx-core-glow">
              <stop offset="0%" stopColor={accent} stopOpacity="0.55" />
              <stop offset="45%" stopColor={accent} stopOpacity="0.14" />
              <stop offset="100%" stopColor={accent} stopOpacity="0" />
            </radialGradient>
            {placed.map((p) => {
              const s = stateFor(p, visuals);
              return (
                <linearGradient
                  key={p.node.id}
                  id={`cx-grad-${p.node.id}`}
                  gradientUnits="userSpaceOnUse"
                  x1={p.anchor.x}
                  y1={p.anchor.y}
                  x2={p.point.x}
                  y2={p.point.y}
                >
                  <stop offset="0%" stopColor={p.node.kind === 'layer' ? accent : s.color} stopOpacity="0.9" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0.95" />
                </linearGradient>
              );
            })}
          </defs>

          <g className="cx-stars">
            {stars.map((star, i) => (
              <circle
                key={i}
                cx={star.x}
                cy={star.y}
                r={star.r}
                style={{ '--o': star.opacity, animationDelay: `${star.delay}s`, animationDuration: `${star.duration}s` } as CSSProperties}
              />
            ))}
          </g>

          <circle className="cx-core-halo" r={CORE_RADIUS * 3.2} fill="url(#cx-core-glow)" />
          <g className="cx-orbits">
            <circle r={layerRadius(1) - 44} />
            <circle r={layerRadius(6)} className="is-mid" />
            <circle r={layerRadius(12) + 60} className="is-outer" />
          </g>

          <path className="cx-spiral" d={spiral} pathLength={1} />

          {placed.map((p, i) => {
            const s = stateFor(p, visuals);
            const inert = s.tone === 'hollow' || s.tone === 'planned';
            const d = curvePath(p.anchor, p.point, p.node.kind === 'layer' ? 0.16 : 0.1);
            return (
              <g
                key={p.node.id}
                className={`cx-link ${inert ? 'is-inert' : 'is-solid'} ${s.lit ? 'is-lit' : ''} ${faded(p.node.id)}`}
                style={{ '--i': i, '--c': s.color } as CSSProperties}
              >
                <path className="cx-link-base" d={d} pathLength={inert ? undefined : 1} stroke={inert ? undefined : `url(#cx-grad-${p.node.id})`} />
                {s.lit && !reduced && <path className="cx-link-flow" d={d} pathLength={100} />}
                {/* A spark per new event: keyed on the count, so each event remounts it and the animation replays. */}
                {s.count > 0 && !reduced && <path key={s.count} className="cx-link-spark" d={d} pathLength={1} />}
              </g>
            );
          })}

          {activeAgent &&
            placed
              .filter((p) => p.node.kind === 'tool' && isCapabilityLinked(activeAgent.id, p.node.id))
              .map((p) => (
                <path
                  key={`cap-${p.node.id}`}
                  className={`cx-cap-link ${faded(p.node.id)}`}
                  d={curvePath(polar(CORE_RADIUS, p.angle), p.point, -0.22)}
                  pathLength={100}
                />
              ))}
        </svg>

        {agentNode && activeAgent && (
          <div className={`cx-core ${focusId === agentNode.id ? 'is-selected' : ''}`} style={{ left: HALF, top: HALF }}>
            <span className="cx-core-ring is-a" aria-hidden="true" />
            <span className="cx-core-ring is-b" aria-hidden="true" />
            <span className="cx-core-pulse" aria-hidden="true" />
            <button
              type="button"
              className="cx-core-face"
              aria-label={`Focus ${activeAgent.name} in Cortex`}
              onClick={() => onSelect(agentNode)}
              onPointerEnter={() => onHover(agentNode)}
              onPointerLeave={() => onHover(null)}
            >
              <CortexFace agent={activeAgent} profile={profile} size={92} interactive />
            </button>
            <div className="cx-core-name">
              <strong>{activeAgent.name}</strong>
              <StatusPill status={activeAgent.current_status} />
            </div>
          </div>
        )}

        {placed.map((p, i) => {
          const s = stateFor(p, visuals);
          const selected = focusId === p.node.id;
          const name = p.node.kind === 'layer' ? p.node.label.replace(/^\d+\.\s*/, '') : p.node.label;
          return (
            <motion.button
              key={p.node.id}
              type="button"
              className={`cx-node is-${p.node.kind} ${s.lit ? 'is-lit' : ''} ${s.pulsing ? 'is-pulsing' : ''} ${selected ? 'is-selected' : ''} ${faded(p.node.id)}`}
              data-tone={s.tone}
              data-side={labelSide(p.angle)}
              aria-label={`${p.node.label}: ${s.status}`}
              aria-pressed={selected}
              style={{ left: HALF + p.point.x, top: HALF + p.point.y, '--c': s.color, '--i': i } as CSSProperties}
              initial={reduced ? false : { opacity: 0, x: -p.point.x * 0.9, y: -p.point.y * 0.9, scale: 0.2 }}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 170, damping: 19, delay: 0.25 + i * 0.045 }}
              onClick={() => onSelect(p.node)}
              onPointerEnter={() => onHover(p.node)}
              onPointerLeave={() => onHover(null)}
            >
              <span className="cx-node-orb">
                <Icon name={iconFor(p.node)} size={p.node.kind === 'tool' ? 15 : 17} motion={false} />
                {p.node.kind === 'layer' && <span className="cx-node-index">{p.node.layerId}</span>}
              </span>
              {s.count > 0 && (
                <span key={s.count} className="cx-node-count">
                  {s.count}
                </span>
              )}
              {showLabel(p, selected) && (
                <span className="cx-node-label">
                  <strong>{name}</strong>
                  {(view.labels === 'all' || selected || hoveredId === p.node.id || s.tone !== 'live' || s.count > 0) && (
                    <small>{s.status}</small>
                  )}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>

      <div className="cx-zoom" role="group" aria-label="Zoom">
        <button type="button" className="cx-icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}>
          <Icon name="zoomIn" />
        </button>
        <button type="button" className="cx-icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.8)}>
          <Icon name="zoomOut" />
        </button>
        <button
          type="button"
          className="cx-icon-btn"
          aria-label="Recentre"
          title="Recentre"
          onClick={() => {
            // Resetting the camera directly as well: with nothing focused,
            // clearing the focus alone would not move a panned or zoomed view.
            onSelect(null);
            setCamera(HOME);
          }}
        >
          <Icon name="recenter" />
        </button>
      </div>
    </div>
  );
}

