/**
 * Which bot sits at the centre of the galaxy.
 *
 * Replaces a 180px list whose model ids wrapped onto four lines. Each bot is
 * one line - face, name, model, status - and the studio shortcut that used to
 * be a separate pill in the top bar lives here, beside the bot it edits.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentRow } from '../lib/transport.js';
import type { BotProfile } from '../lib/botProfile.js';
import { Icon } from './ui/icons.js';
import { CortexFace, StatusPill, statusTone } from './CortexKit.js';

export function CortexBotSwitcher({
  agents,
  activeAgent,
  profiles,
  open,
  onOpenChange,
  onSelect,
  onOpenStudio,
}: {
  agents: AgentRow[];
  activeAgent: AgentRow | undefined;
  profiles: Record<string, BotProfile>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (agentId: string) => void;
  onOpenStudio?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  // A menu closes when you click anywhere else, not only on its own trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open, onOpenChange]);

  return (
    <div className="cx-switcher" ref={root}>
      <button
        type="button"
        className={`cx-bar-btn cx-switcher-btn ${open ? 'is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {activeAgent ? (
          <CortexFace agent={activeAgent} profile={profiles[activeAgent.id]} size={24} idle={false} />
        ) : (
          <Icon name="bot" size={15} motion={false} />
        )}
        <span className="cx-switcher-name">{activeAgent?.name ?? 'No bot'}</span>
        {activeAgent && <span className="cx-status-dot" data-tone={statusTone(activeAgent.current_status)} aria-hidden="true" />}
        <Icon name="chevronDown" size={13} className="cx-chevron" motion={false} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="cx-menu"
            role="menu"
            aria-label="Switch bot"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 36 }}
          >
            <div className="cx-menu-head">
              <span>Switch bot</span>
              <span className="cx-count">{agents.length}</span>
            </div>
            <div className="cx-menu-list">
              {agents.map((agent, index) => {
                const on = agent.id === activeAgent?.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`cx-menu-item ${on ? 'is-on' : ''}`}
                    style={{ '--i': index } as CSSProperties}
                    onClick={() => {
                      onSelect(agent.id);
                      onOpenChange(false);
                    }}
                  >
                    <CortexFace agent={agent} profile={profiles[agent.id]} size={30} idle={false} />
                    <span className="cx-menu-text">
                      <strong>{agent.name}</strong>
                      <small>{agent.model_id}</small>
                    </span>
                    {on ? (
                      <Icon name="done" size={15} className="cx-menu-check" motion={false} />
                    ) : (
                      <StatusPill status={agent.current_status} />
                    )}
                  </button>
                );
              })}
            </div>
            {onOpenStudio && activeAgent && (
              <button
                type="button"
                role="menuitem"
                className="cx-menu-foot"
                onClick={() => {
                  onOpenChange(false);
                  onOpenStudio();
                }}
              >
                <Icon name="edit" size={14} />
                Edit {activeAgent.name}'s avatar in the studio
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
