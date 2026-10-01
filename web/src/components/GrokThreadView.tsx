/**
 * The transcript, rendered with assistant-ui's primitives.
 *
 * assistant-ui ships behaviour, not appearance: `ThreadPrimitive.Messages`
 * knows about virtualisation and ordering, `ThreadPrimitive.Viewport` knows
 * that a chat should follow new messages only while you are at the bottom of
 * it, and `ComposerPrimitive` knows Enter-to-send and Shift+Enter-for-newline.
 * None of them impose a look - they render unstyled elements and take a
 * className.
 *
 * That is what makes this possible without giving up the Grok Bot design: every
 * class below is the same `grok-*` class the hand-written transcript used, the
 * avatar is the same `BotFace`, and the Markdown goes through the same
 * `MessageBody`. What changes is who owns the mechanics.
 *
 * THE AVATAR IS THE POINT. A bot's face is the one thing that must survive this
 * swap, so it is rendered from the agent passed in rather than from anything
 * assistant-ui knows about - it has no concept of a per-bot character, and it
 * does not need one.
 */

import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { BotFace } from './BotFace.js';
import { MessageBody } from './MessageBody.js';
import type { ReactNode } from 'react';
import { Icon } from './ui/icons.js';
import type { Teammate } from './workspaceTypes.js';

interface GrokThreadViewProps {
  agent: Teammate;
  /** Shown in the composer's placeholder, as the hand-written one did. */
  placeholder: string;
  /** Composer controls the caller owns - mode and model - shown in the toolbar. */
  tools?: ReactNode;
  /** Rendered above the composer: run progress and the verified-task brief. */
  status?: ReactNode;
}

/**
 * One message.
 *
 * `MessagePrimitive.If` branches on role without the component having to read
 * the message itself, which is what keeps the user and assistant bubbles as two
 * plainly separate blocks rather than one with conditionals threaded through
 * it.
 */
function ThreadMessage({ agent }: { agent: Teammate }) {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.If user>
        <div className="grok-message-row user-row">
          <div className="grok-message-content">
            <div className="grok-bubble grok-bubble-user">
              {/* User text is never treated as Markdown - see MessageBody. */}
              <MessagePrimitive.Parts components={{ Text: UserText }} />
            </div>
          </div>
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="grok-message-row assistant-row">
          <div className="grok-message-avatar" aria-hidden="true">
            <BotFace
              size={22}
              shape={agent.profile.shape}
              color={agent.profile.color}
              eyeColor={agent.profile.eyeColor}
              image={agent.profile.avatarImage}
              status={agent.status}
              idle={false}
            />
          </div>
          <div className="grok-message-content">
            <div className="grok-bubble grok-bubble-assistant">
              <MessagePrimitive.Parts components={{ Text: AssistantText }} />
            </div>
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function UserText({ text }: { text: string }) {
  return <MessageBody content={text} markdown={false} />;
}

function AssistantText({ text }: { text: string }) {
  return <MessageBody content={text} markdown />;
}

export function GrokThreadView({ agent, placeholder, tools, status }: GrokThreadViewProps) {
  return (
    <ThreadPrimitive.Root className="grok-thread">
      {/* Viewport owns the scrolling, including the stick-to-bottom behaviour
          the hand-written transcript had to implement itself. */}
      <ThreadPrimitive.Viewport className="grok-messages-container" autoScroll>
        <ThreadPrimitive.Empty>
          <div className="grok-chat-state">
            <p>No messages yet. Say something to {agent.name}.</p>
          </div>
        </ThreadPrimitive.Empty>

        <div className="grok-chat-content">
          <ThreadPrimitive.Messages components={{ Message: () => <ThreadMessage agent={agent} /> }} />

          {/* Only while a reply is outstanding. assistant-ui tracks this from
              the runtime's `isRunning`, so it cannot disagree with the send. */}
          <ThreadPrimitive.If running>
            <div className="grok-thinking-message" role="status">
              <i />
              <i />
              <i />
              <span className="grok-visually-hidden">{agent.name} is working</span>
            </div>
          </ThreadPrimitive.If>
        </div>

        {/* Rendered only when the reader has scrolled away from the end. */}
        <ThreadPrimitive.ScrollToBottom className="grok-jump-latest">
          <Icon name="chevronDown" size={14} />
          Jump to latest
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <div className="grok-chat-footer">
        {status}
        {/* The same composer shape as the classic transcript's - text on top,
            a toolbar beneath - so switching views does not move the controls.
            The send button lights from `:not(:disabled)`, which assistant-ui
            sets itself while the input is empty. */}
        <ComposerPrimitive.Root className="grok-input-capsule oh-composer">
          <span className="oh-composer-glow" aria-hidden="true" />
          <ComposerPrimitive.Input
            className="grok-capsule-input"
            placeholder={placeholder}
            // Enter sends, Shift+Enter is a newline - the convention every
            // chat uses, and one assistant-ui implements rather than this
            // component having to.
            submitOnEnter
            rows={1}
          />
          <div className="grok-capsule-row oh-composer-toolbar">
            {tools}
            <span className="oh-composer-hint" aria-hidden="true">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
            </span>
            <ComposerPrimitive.Send className="grok-capsule-btn grok-send-btn" aria-label="Send message">
              <Icon name="send" />
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
