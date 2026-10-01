/**
 * Talk to a bot.
 *
 * The panel floats over the galaxy on purpose: a chat turn emits the same
 * layer events a task does, so you can watch the rings light up while the bot
 * thinks. That is the whole reason chat lives inside Cortex rather than being a
 * separate page.
 *
 * The reply is not streamed - it arrives whole. Saying so is better than a fake
 * typing indicator that implies progress nobody is measuring.
 *
 * Replies render as Markdown through the same MessageBody the workspace uses;
 * the previous version printed them raw, so every heading arrived as "###".
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type ChatMessageRow, type ChatThreadRow } from '../lib/transport.js';
import { useCortex } from '../store.js';
import type { BotProfile } from '../lib/botProfile.js';
import { MessageBody } from './MessageBody.js';
import { Icon } from './ui/icons.js';
import { CortexEmpty, CortexFace, CortexPanel } from './CortexKit.js';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ChatPanel({ profiles, onClose }: { profiles: Record<string, BotProfile>; onClose: () => void }) {
  const agents = useCortex((s) => s.agents);
  const selectedAgentId = useCortex((s) => s.selectedAgentId);
  const selectRun = useCortex((s) => s.selectRun);

  const [threads, setThreads] = useState<ChatThreadRow[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botEmotion, setBotEmotion] = useState<string>('02');
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const emotionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const agentId = threads.find((t) => t.id === threadId)?.agent_id ?? agents[0]?.id;
  const currentAgent = agents.find((a) => a.id === agentId) ?? agents[0];
  const profile = currentAgent ? profiles[currentAgent.id] : undefined;

  const triggerEmotion = (emotionId: string, durationMs?: number) => {
    if (emotionTimer.current) clearTimeout(emotionTimer.current);
    setBotEmotion(emotionId);
    if (durationMs) {
      emotionTimer.current = setTimeout(() => setBotEmotion('02'), durationMs);
    }
  };

  useEffect(() => () => {
    if (emotionTimer.current) clearTimeout(emotionTimer.current);
  }, []);

  useEffect(() => {
    api
      .chatThreads()
      .then((res) => {
        setThreads(res.threads);
        if (res.threads.length > 0) setThreadId((current) => current ?? res.threads[0].id);
      })
      .catch((err) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    if (!threadId) return;
    api
      .chatMessages(threadId)
      .then((res) => setMessages(res.messages))
      .catch((err) => setError(messageOf(err)));
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  const startThread = async () => {
    // A new conversation is with the bot at the centre of the galaxy, not
    // whichever bot happens to be first in the list.
    const target = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
    if (!target) return;
    setError(null);
    try {
      const { thread } = await api.createThread(target.id);
      setThreads((t) => [thread, ...t]);
      setThreadId(thread.id);
      setMessages([]);
      triggerEmotion('01', 2000); // Wake up!
      composer.current?.focus();
    } catch (err) {
      setError(messageOf(err));
      triggerEmotion('34', 3000); // Error
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !threadId || sending) return;

    // Show the user turn immediately; the daemon persists it before dispatching,
    // so this optimism matches what is already durable.
    setMessages((m) => [...m, { thread_id: threadId, role: 'user', content: text, created_at: Date.now() }]);
    setDraft('');
    if (composer.current) composer.current.style.height = 'auto';
    setSending(true);
    setError(null);
    triggerEmotion('30'); // Thinking with orbiting halo ribbon!

    try {
      const res = await api.sendChat(threadId, text);
      setMessages((m) => [...m, res.reply]);
      triggerEmotion('33', 3500); // Done / celebrate with ribbons & confetti!
      // Select the run this turn produced, so the galaxy shows the layers it lit.
      if (res.taskRunId) void selectRun(res.taskRunId);
      api.chatThreads().then((r) => setThreads(r.threads)).catch(() => undefined);
    } catch (err) {
      setError(messageOf(err));
      triggerEmotion('34', 3500); // Error glitch red alert
    } finally {
      setSending(false);
    }
  };

  return (
    <CortexPanel
      label="Chat"
      icon="chat"
      title={currentAgent?.name ?? 'Chat'}
      subtitle={sending ? 'Thinking…' : currentAgent?.model_id ?? 'No bot'}
      leading={
        currentAgent ? (
          <span className="cx-panel-face">
            <CortexFace agent={currentAgent} profile={profile} emotion={botEmotion} size={34} interactive />
          </span>
        ) : undefined
      }
      actions={
        <button
          type="button"
          className="cx-icon-btn"
          onClick={() => void startThread()}
          disabled={agents.length === 0}
          aria-label="New conversation"
          title="New conversation"
        >
          <Icon name="add" />
        </button>
      }
      onClose={onClose}
    >
      {threads.length > 0 && (
        <div className="cx-panel-toolbar">
          <label className="cx-select-wrap">
            <Icon name="chat" size={14} motion={false} />
            <span className="cx-sr">Conversation</span>
            <select className="cx-select" value={threadId ?? ''} onChange={(e) => setThreadId(e.target.value)}>
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="cx-panel-body cx-chat-log" aria-live="polite">
        {!threadId && (
          <CortexEmpty
            icon="chat"
            title={agents.length === 0 ? 'No bots configured' : 'No conversation yet'}
            action={
              agents.length > 0 && (
                <button type="button" className="cx-btn primary" onClick={() => void startThread()}>
                  <Icon name="add" size={14} />
                  Start a conversation
                </button>
              )
            }
          >
            {agents.length === 0
              ? 'Add one to openhours.config.json.'
              : 'Talk to your bot here and watch the layers light up while it works.'}
          </CortexEmpty>
        )}

        {messages.map((m, i) => (
          <div key={m.id ?? `local-${i}`} className={`cx-msg ${m.role}`}>
            {m.role === 'assistant' && <CortexFace agent={currentAgent} profile={profile} size={24} idle={false} />}
            <div className="cx-msg-stack">
              <div className="cx-bubble">
                <MessageBody content={m.content} markdown={m.role === 'assistant'} />
              </div>
              {m.cost_usd != null && (
                <span className="cx-msg-meta">{m.cost_usd === 0 ? 'No cost' : `$${m.cost_usd.toFixed(6)}`}</span>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="cx-msg assistant">
            <CortexFace agent={currentAgent} profile={profile} emotion="30" size={24} idle={false} />
            <div className="cx-msg-stack">
              {/* Honest: the reply arrives whole, so this reports waiting rather
                  than pretending to show progress. */}
              <div className="cx-bubble">
                <span className="cx-shimmer">Waiting for the whole reply — replies are not streamed yet</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {error && (
        <div className="cx-alert" role="alert">
          <Icon name="error" size={14} motion={false} />
          <span>{error}</span>
        </div>
      )}

      <form className="cx-chat-composer" onSubmit={(event) => void send(event)}>
        <textarea
          id="cx-chat-message-input"
          name="message"
          ref={composer}
          rows={1}
          value={draft}
          disabled={!threadId || sending}
          aria-label="Message"
          placeholder={threadId ? `Message ${currentAgent?.name ?? 'your bot'}` : 'Start a conversation first'}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="cx-composer-foot">
          <span className="cx-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
          </span>
          <button
            type="submit"
            className="cx-send"
            disabled={!threadId || sending || !draft.trim()}
            aria-label="Send message"
            title="Send message"
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </form>
    </CortexPanel>
  );
}
