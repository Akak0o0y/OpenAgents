/**
 * Template detail.
 *
 * A compact dialog describing what sharing this bot as a template WOULD carry:
 * its name, its description and its instructions - which is the whole of what
 * this daemon stores about a bot's behaviour.
 *
 * PUBLISH IS DISABLED. There is no template registry, no publish endpoint and
 * no share link in OpenAgents. The button stays visible because it is part of
 * the observed layout, and it carries the reason so nobody waits for something
 * to happen. "Copy template JSON" is offered instead, because that is a real
 * thing this app can do with the same data.
 */

import { useState } from 'react';
import { BotFace } from './BotFace.js';
import { Modal } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import type { Teammate } from './workspaceTypes.js';
import { Button, IconButton } from './ui/Button.js';

interface GrokTemplateDialogProps {
  agent: Teammate;
  authorName: string;
  onClose: () => void;
}

export function GrokTemplateDialog({ agent, authorName, onClose }: GrokTemplateDialogProps) {
  const [view, setView] = useState<'summary' | 'context'>('summary');
  const [copied, setCopied] = useState(false);

  const templateJson = JSON.stringify(
    {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      label: agent.profile.label || undefined,
      appearance: { shape: agent.profile.shape, color: agent.profile.color },
    },
    null,
    2
  );

  return (
    <Modal label={`${agent.name} template`} className="grok-template-dialog" onClose={onClose}>
      {view === 'summary' ? (
        <div className="grok-template-body">
          <div className="grok-template-avatar">
            <BotFace
              size={72}
              shape={agent.profile.shape}
              color={agent.profile.color}
              eyeColor={agent.profile.eyeColor}
              image={agent.profile.avatarImage}
              idle={false}
            />
          </div>
          <h2 className="grok-template-name">{agent.name}</h2>
          <p className="grok-template-author">By {authorName}</p>
          <p className="grok-template-desc">
            {agent.description || 'This bot has no description yet.'}
          </p>

          <button type="button" className="grok-template-row" onClick={() => setView('context')}>
            <span>
              <strong>Context</strong>
              <em>Instructions</em>
            </span>
            <Icon name="forward" />
          </button>

          <p className="grok-template-status">
            <span className="grok-status-pill">Unpublished</span>
          </p>
        </div>
      ) : (
        <div className="grok-template-body">
          <header className="grok-template-subhead">
            <IconButton onClick={() => setView('summary')}
              aria-label="Back to template"
              title="Back"
            >
              <Icon name="back" />
            </IconButton>
            <h2>Instructions</h2>
          </header>
          <pre className="grok-template-instructions">
            {agent.description || 'No instructions have been written for this bot.'}
          </pre>
        </div>
      )}

      <footer className="grok-template-footer">
        <Button kind="secondary" onClick={() => {
            void navigator.clipboard
              .writeText(templateJson)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy template JSON'}
        </Button>
        <Button kind="primary" disabled title="OpenAgents has no template registry to publish to.">
          Publish
        </Button>
      </footer>
    </Modal>
  );
}
