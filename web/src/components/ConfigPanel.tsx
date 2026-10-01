/**
 * Page-level view settings.
 *
 * Every control here changes how the galaxy is DRAWN. None of them change what
 * it claims: there is deliberately no "show all layers as active" or "simulate
 * activity" switch, because a view toggle that fabricates evidence would undo
 * the whole point of the panel.
 */

import { type CSSProperties } from 'react';
import { useCortex } from '../store.js';
import { Icon } from './ui/icons.js';
import { CortexPanel, Segmented, Switch } from './CortexKit.js';

const DENSITY = { min: 200, max: 2600, step: 200 };

const LABEL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' },
] as const;

export function ConfigPanel({ onClose }: { onClose: () => void }) {
  const view = useCortex((s) => s.view);
  const setView = useCortex((s) => s.setView);
  const fill = ((view.particlesPerLayer - DENSITY.min) / (DENSITY.max - DENSITY.min)) * 100;

  return (
    <CortexPanel icon="settings" title="View" subtitle="How the galaxy is drawn" onClose={onClose}>
      <div className="cx-panel-body cx-stack">
        <div className="cx-setting">
          <div className="cx-setting-head">
            <div className="cx-setting-text">
              <strong>Particle density</strong>
              <small>Stars drawn in each layer</small>
            </div>
            <output className="cx-value">{view.particlesPerLayer}</output>
          </div>
          <input
            type="range"
            className="cx-range"
            aria-label="Particle density"
            min={DENSITY.min}
            max={DENSITY.max}
            step={DENSITY.step}
            value={view.particlesPerLayer}
            style={{ '--fill': `${fill}%` } as CSSProperties}
            onChange={(e) => setView({ particlesPerLayer: Number(e.target.value) })}
          />
        </div>

        <div className="cx-setting is-inline">
          <div className="cx-setting-text">
            <strong>Rotation</strong>
            <small>{view.rotate ? 'The galaxy turns slowly' : 'Stopped'}</small>
          </div>
          <Switch checked={view.rotate} label="Rotation" onChange={(rotate) => setView({ rotate })} />
        </div>

        <div className="cx-setting is-inline">
          <div className="cx-setting-text">
            <strong>Reduce motion</strong>
            <small>{view.reducedMotion ? 'No animation anywhere in Cortex' : 'Follows your system setting'}</small>
          </div>
          <Switch checked={view.reducedMotion} label="Reduce motion" onChange={(reducedMotion) => setView({ reducedMotion })} />
        </div>

        <div className="cx-setting">
          <div className="cx-setting-text">
            <strong>Labels</strong>
            <small>Which bodies show their name</small>
          </div>
          <Segmented id="labels" label="Labels" value={view.labels} options={LABEL_OPTIONS} onChange={(labels) => setView({ labels })} />
        </div>

        <div className="cx-setting is-inline">
          <div className="cx-setting-text">
            <strong>Seed</strong>
            <small>Rearranges the stars, never the data</small>
          </div>
          <div className="cx-seed">
            <input
              type="number"
              className="cx-input"
              aria-label="Seed"
              value={view.seed}
              onChange={(e) => setView({ seed: Number(e.target.value) || 0 })}
            />
            <button
              type="button"
              className="cx-icon-btn"
              aria-label="Random seed"
              title="Random seed"
              onClick={() => setView({ seed: Math.floor(Math.random() * 0xffff) + 1 })}
            >
              <Icon name="rotate" />
            </button>
          </div>
        </div>

        <p className="cx-note">
          These change how the galaxy is drawn, never what it reports. There is no switch that lights a layer the
          daemon has no evidence for — that is the one thing this panel exists to make impossible.
        </p>
      </div>
    </CortexPanel>
  );
}
