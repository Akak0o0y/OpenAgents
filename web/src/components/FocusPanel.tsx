/**
 * Details of whatever body is selected.
 *
 * For a layer this is its taxonomy entry and its live event count. For a tool it
 * is the integration: how it is wired, and - for MCP and Obsidian - the trust
 * boundary that decides where it is allowed to run.
 *
 * The card takes the colour the body has on the galaxy, and slides left when a
 * panel opens rather than being covered by it.
 */

import { type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import type { GalaxyNode } from '@kernel/cortex/galaxy.js';
import type { CortexActivity } from '@kernel/cortex/layer-view.js';
import { useCortex } from '../store.js';
import type { BotProfile } from '../lib/botProfile.js';
import { Icon } from './ui/icons.js';
import { CortexFace, StatusPill, botColor, layerColor, type Tone } from './CortexKit.js';
import { NodeInsights } from './NodeInsights.js';

const STATUS: Record<GalaxyNode['status'], { label: string; tone: Tone }> = {
  live: { label: 'Live', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  hollow: { label: 'Not instrumented', tone: 'muted' },
  planned: { label: 'Not connected', tone: 'muted' },
};

export function FocusPanel({
  node,
  activity,
  profile,
  onClose,
}: {
  node: GalaxyNode;
  activity: CortexActivity;
  profile?: BotProfile;
  onClose: () => void;
}) {
  const { selectedAgentId, agents, isCapabilityLinked } = useCortex();
  const activeAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];

  const isAgent = node.kind === 'agent';
  const count = activity.eventCounts[node.layerId] ?? 0;
  const inert = node.status === 'hollow' || node.status === 'planned';
  const linked = activeAgent ? isCapabilityLinked(activeAgent.id, node.id) : false;
  const accent = isAgent ? botColor(activeAgent, profile) : inert ? 'var(--cx-muted)' : layerColor(node.layerId);
  const capabilities = activeAgent?.capabilities ?? [];

  return (
    <motion.section
      className={`cx-focus ${inert ? 'is-inert' : ''}`}
      style={{ '--cx-accent': accent } as CSSProperties}
      aria-label={`${node.label} details`}
      initial={{ opacity: 0, y: -10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97, transition: { duration: 0.14 } }}
      transition={{ type: 'spring', stiffness: 460, damping: 36 }}
    >
      <header className="cx-focus-head">
        <span className="cx-pill" data-tone={isAgent ? 'ok' : STATUS[node.status].tone}>
          <i aria-hidden="true" />
          {isAgent ? 'Active bot' : STATUS[node.status].label}
        </span>
        <span className="cx-focus-kind">
          {isAgent ? 'Band 6 · Model execution' : node.kind === 'tool' ? `Tool · Band ${node.layerId}` : `Layer ${node.layerId}`}
        </span>
        <button type="button" className="cx-icon-btn" onClick={onClose} aria-label="Close details" title="Close">
          <Icon name="close" />
        </button>
      </header>

      {isAgent ? (
        <div className="cx-focus-hero">
          {activeAgent && <CortexFace agent={activeAgent} profile={profile} size={52} interactive />}
          <div>
            <h3>{activeAgent ? activeAgent.name : node.label}</h3>
            <p className="cx-mono">{activeAgent?.model_id || 'Model core'}</p>
          </div>
          {activeAgent && <StatusPill status={activeAgent.current_status} />}
        </div>
      ) : (
        <h3 className="cx-focus-title">{node.label}</h3>
      )}

      <p className="cx-focus-desc">{node.description}</p>

      {isAgent && (
        <section className="cx-focus-section">
          <h4>Configured capabilities · {capabilities.length}</h4>
          {capabilities.length > 0 ? (
            <div className="cx-chips">
              {capabilities.map((capability) => (
                <code key={capability} className="cx-chip">
                  {capability}
                </code>
              ))}
            </div>
          ) : (
            <p className="cx-muted">No configured capabilities were reported by the daemon.</p>
          )}
        </section>
      )}

      {!isAgent && activeAgent && node.kind === 'tool' && (
        <div className="cx-link-box" data-tone={linked ? 'ok' : 'muted'}>
          <span className="cx-status-dot" aria-hidden="true" />
          <div>
            <strong>{linked ? 'Configured' : 'Not configured'}</strong>
            <small>
              {linked ? `Available to tasks for ${activeAgent.name}` : `No execution capability reported for ${activeAgent.name}`}
            </small>
          </div>
        </div>
      )}

      {!isAgent && (
        <section className="cx-focus-section">
          <h4>Integration</h4>
          <p>{node.integration}</p>
        </section>
      )}

      <NodeInsights node={node} />

      <section className="cx-focus-section">
        <h4>Evidence</h4>
        {node.eventTypes.length > 0 ? (
          <div className="cx-chips">
            {node.eventTypes.map((type) => (
              <code key={type} className="cx-chip">
                {type}
              </code>
            ))}
          </div>
        ) : (
          <p className="cx-muted">
            None. This body emits no events, so nothing about it is measured — which is exactly why it is drawn unlit.
          </p>
        )}
      </section>

      <footer className="cx-focus-foot">
        {isAgent
          ? 'Primary intelligence nexus'
          : inert
            ? `Band ${node.layerId} · nothing observed`
            : `Band ${node.layerId} · ${count} event${count === 1 ? '' : 's'} in the selected run`}
      </footer>
    </motion.section>
  );
}
