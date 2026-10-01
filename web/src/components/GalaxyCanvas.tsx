/**
 * The Cortex view: the bot at the centre of a constellation of its own
 * architecture.
 *
 * Drag to pan, scroll to zoom, click a body for its details. The legend always
 * states how many layers this runtime cannot observe, so the view cannot be
 * mistaken for a picture of a complete system.
 *
 * The status bar at the bottom answers "what am I looking at": the selected
 * run, or an offer to pick one, and - while the pointer is over a body - what
 * that body is.
 */

import { useEffect, useState } from 'react';
import { runLabel } from '../lib/runLabels.js';
import { AnimatePresence, motion } from 'framer-motion';
import { CORE_COLOR, HOLLOW_COLOR, RIM_COLOR, rampColor, type GalaxyNode } from '@kernel/cortex/galaxy.js';
import { AGENT_LAYERS } from '@kernel/kernel/agent-layers.js';
import { useCortex } from '../store.js';
import { CortexConstellation } from './CortexConstellation.js';
import { FocusPanel } from './FocusPanel.js';
import { StatusPill, rgbCss, statusTone } from './CortexKit.js';
import type { BotProfile } from '../lib/botProfile.js';

const HOLLOW_COUNT = AGENT_LAYERS.filter((l) => l.status === 'hollow').length;
const RAMP = `linear-gradient(90deg, ${rgbCss(CORE_COLOR)}, ${rgbCss(rampColor(0.5))}, ${rgbCss(RIM_COLOR)})`;
const HOLLOW = rgbCss(HOLLOW_COLOR);

export function GalaxyCanvas({ profile, onOpenFleet }: { profile?: BotProfile; onOpenFleet?: () => void }) {
  const activity = useCortex((s) => s.activity);
  const run = useCortex((s) => s.taskRuns.find((r) => r.id === s.selectedRunId) ?? null);

  const [focus, setFocus] = useState<GalaxyNode | null>(null);
  const [hover, setHover] = useState<GalaxyNode | null>(null);

  useEffect(() => {
    (window as any).__setCortexFocus = (node: GalaxyNode | null) => setFocus(node);
    return () => {
      delete (window as any).__setCortexFocus;
    };
  }, []);

  return (
    <div className="galaxy">
      <CortexConstellation
        profile={profile}
        focusId={focus?.id ?? null}
        hoveredId={hover?.id ?? null}
        onSelect={setFocus}
        onHover={setHover}
      />

      <AnimatePresence>
        {focus && (
          <FocusPanel key={focus.id} node={focus} activity={activity} profile={profile} onClose={() => setFocus(null)} />
        )}
      </AnimatePresence>

      <div className="cx-statusbar">
        <div className="cx-status-run">
          {run ? (
            <>
              <span className="cx-status-dot" data-tone={statusTone(run.status)} aria-hidden="true" />
              <span className="cx-status-label">Run</span>
              <strong title={run.task_name}>{runLabel(run.task_name)}</strong>
              <StatusPill status={run.status} />
            </>
          ) : (
            <>
              <span className="cx-status-dot" data-tone="muted" aria-hidden="true" />
              <span>No run selected</span>
              {onOpenFleet && (
                <button type="button" className="cx-link-btn" onClick={onOpenFleet}>
                  Pick a run
                </button>
              )}
            </>
          )}
        </div>
        <span className="cx-status-sep" aria-hidden="true" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={hover?.id ?? 'hint'}
            className="cx-status-hint"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.15 }}
          >
            {hover ? (
              <>
                <strong>{hover.label}</strong>
                {hover.description}
              </>
            ) : (
              'Drag to pan · Scroll to zoom · Click any node for details'
            )}
          </motion.p>
        </AnimatePresence>
      </div>

      <aside className="cx-legend" aria-label="Legend">
        <div>
          <span className="cx-legend-ramp" style={{ background: RAMP }} aria-hidden="true" />
          <span>Layers, inner → outer</span>
          <small>1 → 12</small>
        </div>
        <div>
          <span className="cx-legend-flow" aria-hidden="true" />
          <span>Flowing link: evidence this run</span>
        </div>
        <div>
          <span className="cx-legend-hollow" style={{ borderColor: HOLLOW }} aria-hidden="true" />
          <span>Dashed: not instrumented or connected</span>
        </div>
        <p>
          {HOLLOW_COUNT === 0
            ? 'No layer is hollow in this runtime; partial ones are marked.'
            : `${HOLLOW_COUNT} of ${AGENT_LAYERS.length} layers cannot be observed by this runtime.`}
        </p>
      </aside>
    </div>
  );
}
