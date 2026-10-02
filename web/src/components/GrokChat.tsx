/**
 * The conversation.
 *
 * The one rule this file exists to enforce: NOTHING ON SCREEN IS INVENTED.
 * Every bubble is a row the daemon persisted, every question card is a blocked
 * approval, and the only optimistic element is the operator's own message,
 * which is rolled back if the send fails.
 *
 * AGENT SWITCHING. A reply can take many seconds. If the operator moves to
 * another bot while one is in flight, the reply must not be appended to the
 * conversation they are now looking at. Every async result is therefore stamped
 * with the agent and thread it belongs to and discarded on arrival if the
 * workspace has moved on. Composer text and reply targets are likewise kept per
 * agent, so switching away and back restores the draft that belongs there
 * rather than carrying one bot's half-written message to another.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UI_LOCALE } from '../lib/numbers.js';
import { BotFace } from './BotFace.js';
import { GrokEmojiPicker, QUICK_REACTIONS } from './GrokEmojiPicker.js';
import { MessageBody } from './MessageBody.js';
import { GrokQuestionCard, parseApproval, type ParsedApproval } from './GrokQuestionCard.js';
import { WorkQuestions } from './WorkQuestions.js';
import { BackgroundTasks } from './BackgroundTasks.js';
import { useCortex } from '../store.js';
import { TOOL_LABELS as PROGRESS_LABEL } from '@kernel/cortex/run-steps.js';
import { RunActivityCard } from './RunActivityCard.js';
import {ActiveBotRuns} from './ActiveBotRuns.js';
import { WorkedSteps } from './WorkedSteps.js';
import { COMPOSE_EVENT, type ComposeDetail } from '../lib/compose.js';
import { MenuItem, MenuSeparator, Popover } from './ui/Overlay.js';
import { type ModelSelection } from './GrokModelSelector.js';
import { ModelBrowser } from './ModelBrowser.js';
import { Icon, type IconName } from './ui/icons.js';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useOpenAgentsRuntime } from '../lib/assistantRuntime.js';
import { GrokThreadView } from './GrokThreadView.js';
import { api, type ApprovalRow, type ChatMessageRow, type ProviderConnectionRow } from '../lib/transport.js';
import { needsSeparator, transcriptDayLabel, type ChatDraft, type Teammate } from './workspaceTypes.js';
import {
  MAX_ATTACHMENTS,
  composeWithAttachments,
  formatBytes,
  readAttachments,
  type Attachment,
} from '../lib/attachments.js';
import { SPEECH_UNSUPPORTED_REASON, useSpeechInput } from '../lib/useSpeechInput.js';
import { IconButton } from './ui/Button.js';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/registry/default/ui/empty.js';

interface GrokChatProps {
  navigationTarget?: { threadId: string; messageId?: string; key: number };
  activeAgent: Teammate | null;
  draft: ChatDraft | null;
  teammates: Teammate[];
  approvals: ApprovalRow[];
  approvalBusyId: string | null;
  onAnswerApproval: (approvalId: string, decision: 'approve' | 'deny', reason?: string) => void;
  onOpenDetails: () => void;
  onOpenSettings: () => void;
  onToggleDetails: () => void;
  isDetailsOpen: boolean;
  onCancelDraft: () => void;
  onDraftKindChange: (kind: 'direct' | 'group') => void;
  onDraftRecipient: (agentId: string) => void;
  onCreateBot: () => void;
  onReactionsChange: (agentId: string, reactions: Record<string, string[]>) => void;
  onThreadActivity: () => void;
  onShareAsTemplate: () => void;
  onNotify: (message: string) => void;
  onSaveModel?: (selection: ModelSelection) => Promise<void>;
  onOpenFile?: (file: { path: string; runId?: string | null; content?: string | null; artifactUrl?: string | null }) => void;
  /**
   * Render the experimental assistant-ui transcript instead of the classic one.
   *
   * Both are real and talk to the same daemon through the same send, but the
   * classic view carries features not yet ported - reactions, reply quoting,
   * attachments, dictation, and approval cards interleaved by time - so it is
   * the default. Nothing in the workspace turns it on any more: the header
   * button and then the Settings switch were both removed, and the view is
   * kept, tested, until it reaches parity or is deleted.
   */
  assistantView?: boolean;
  initialCompose?:{agentId:string;text:string};
}

interface ComposerState {
  text: string;
  replyTo: { id: string; content: string } | null;
  /** Text files read into memory, folded into the message on send. */
  attachments: Attachment[];
}

const EMPTY_COMPOSER: ComposerState = { text: '', replyTo: null, attachments: [] };

/** How the header describes the bot while nothing is in flight. */
const STATUS_LABEL: Record<Teammate['status'], string> = {
  IDLE: 'Ready',
  BUSY: 'Running a task',
  PAUSED: 'Paused',
  DISABLED: 'Disabled',
};

const STARTERS: ReadonlyArray<{ icon: IconName; title: string; prompt: string }> = [
  { icon: 'search', title: 'Explore an idea', prompt: 'Help me explore an idea. Ask me what I have in mind, then work through the possibilities with me.' },
  { icon: 'detail', title: 'Make a plan', prompt: 'Help me turn a goal into a clear, practical plan. Start by asking what I want to achieve.' },
  { icon: 'edit', title: 'Build something', prompt: 'I want to build something. Help me define the scope and choose the first useful step.' },
];

function ChatModelDialog({ agent, onSave, onClose }: { agent: Teammate; onSave: (value: ModelSelection) => Promise<void>; onClose: () => void }) {
  const [connections, setConnections] = useState<ProviderConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.providers().then(body => { if (!cancelled) setConnections(body.connections); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load providers.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return <ModelBrowser value={{ modelId: agent.model, connectionId: agent.connectionId ?? null, routingMode: agent.routingMode ?? null }} connections={connections} loading={loading} catalogError={error} onChange={onSave} onClose={onClose} />;
}

type TranscriptItem =
  | { kind: 'message'; at: number; message: ChatMessageRow; key: string }
  | { kind: 'approval'; at: number; approval: ParsedApproval; key: string };

export function GrokChat({
  activeAgent,
  draft,
  teammates,
  approvals,
  approvalBusyId,
  onAnswerApproval,
  onOpenDetails,
  onOpenSettings,
  onToggleDetails,
  isDetailsOpen,
  onCancelDraft,
  onDraftKindChange,
  onDraftRecipient,
  onCreateBot,
  onReactionsChange,
  onThreadActivity,
  onShareAsTemplate,
  onNotify,
  onSaveModel,
  onOpenFile,
  assistantView = false,
  initialCompose,
  navigationTarget,
}: GrokChatProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);

  const [progress, setProgress] = useState<{ taskRunId?: string; tool: string | null; turn: number; steps: string[] } | null>(null);
  const [stopping, setStopping] = useState(false);

  const [loading, setLoading] = useState(false);
  const [sendingThreads, setSendingThreads] = useState<Set<string>>(() => new Set());
  const sending = threadId !== null && sendingThreads.has(threadId);
  const [error, setError] = useState('');
  const [composers, setComposers] = useState<Record<string, ComposerState>>({});
  const [messageMenu, setMessageMenu] = useState<{ key: string; message: ChatMessageRow; x: number; y: number } | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientQuery, setRecipientQuery] = useState('');
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [attachError, setAttachError] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const templateBtnRef = useRef<HTMLButtonElement>(null);
  const emojiAnchorRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The agent the view is currently showing; read inside async callbacks. */
  const activeAgentIdRef = useRef<string | null>(activeAgent?.id ?? null);

  useEffect(() => {
    activeAgentIdRef.current = activeAgent?.id ?? null;
  }, [activeAgent?.id]);

  const agentId = activeAgent?.id ?? null;
  const composer = (agentId && composers[agentId]) || EMPTY_COMPOSER;

  const setComposer = useCallback(
    (id: string, patch: Partial<ComposerState>) => {
      setComposers((current) => ({
        ...current,
        [id]: { ...(current[id] ?? EMPTY_COMPOSER), ...patch },
      }));
    },
    []
  );

  // Open (or create) the conversation for whichever bot is selected.
  useEffect(() => {
    if (!agentId || !activeAgent) {
      setThreadId(null);
      setMessages([]);
      setError('');
      setLoading(false);
      return;
    }
    let cancelled = false;
    const requestedAgentId = agentId;
    setThreadId(null);
    setMessages([]);
    setError('');
    setLoading(true);

    void (async () => {
      try {
        const { threads } = await api.chatThreads(requestedAgentId);
        const requestedThread = navigationTarget?.threadId ? threads.find(t => t.id === navigationTarget.threadId) : undefined;
        if (navigationTarget?.threadId && !requestedThread) throw new Error('The searched conversation no longer belongs to this bot or was deleted.');
        const thread = requestedThread ?? threads[0] ?? (await api.createThread(requestedAgentId, `${activeAgent.name} chat`)).thread;
        const result = await api.chatMessages(thread.id);
        // The operator may have switched bots while this was in flight.
        if (cancelled || activeAgentIdRef.current !== requestedAgentId) return;
        setThreadId(thread.id);
        setMessages(result.messages);
      } catch (cause) {
        if (cancelled || activeAgentIdRef.current !== requestedAgentId) return;
        setError(cause instanceof Error ? cause.message : 'Could not open this conversation.');
      } finally {
        if (!cancelled && activeAgentIdRef.current === requestedAgentId) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, activeAgent?.name, navigationTarget?.threadId, navigationTarget?.key]);

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  // Declared before any early return: hooks must run in the same order on every
  // render, and this component returns early for the draft and no-agent cases.
  const speech = useSpeechInput(
    useCallback(
      (phrase: string) => {
        const id = activeAgentIdRef.current;
        if (!id || !phrase) return;
        setComposers((current) => {
          const existing = current[id] ?? EMPTY_COMPOSER;
          const joined = existing.text ? `${existing.text.replace(/\s+$/, '')} ${phrase}` : phrase;
          return { ...current, [id]: { ...existing, text: joined } };
        });
      },
      []
    )
  );

  /**
   * Follow the conversation only while the reader is at the bottom of it.
   *
   * The old behaviour scrolled to the end on every change unconditionally,
   * which is the single most irritating thing a chat can do: scroll up to read
   * what a bot said ten minutes ago, a reply lands, and you are yanked back to
   * the bottom mid-sentence with no way to stop it.
   *
   * So: stick to the bottom while you are already there, and when you are not,
   * stay exactly where you are and say that something arrived.
   */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(false);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // A tolerance, not equality: sub-pixel layout and momentum scrolling both
    // leave a scroller a fraction short of its own bottom.
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom(bottom);
    if (bottom) setMissed(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    setMissed(false);
  }, [reducedMotion]);

  const focusedSearch = useRef<number>();
  const skipAutoScroll = useRef(false);
  useEffect(() => {
    if (!navigationTarget?.messageId || loading || threadId !== navigationTarget.threadId || focusedSearch.current === navigationTarget.key) return;
    const node = [...(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(el => el.dataset.messageId === navigationTarget.messageId);
    if (node) {
      focusedSearch.current = navigationTarget.key;
      skipAutoScroll.current = true;
      node.scrollIntoView({ block: 'center', behavior: 'auto' }); node.focus({ preventScroll: true }); setAtBottom(false);
    } else if (messages.length) setError('The searched message is no longer available in this conversation.');
  }, [navigationTarget, loading, messages, threadId]);

  useEffect(() => {
    if (skipAutoScroll.current) { skipAutoScroll.current = false; return; }
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    } else if (messages.length > 0) {
      setMissed(true);
    }
    // `atBottom` is deliberately NOT a dependency: this runs when the
    // transcript changes, and reads the current position at that moment.
    // Including it would scroll on every scroll event that crosses the
    // threshold, which is the behaviour being removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, sending, reducedMotion]);

  /** Switching bots is a fresh conversation: start at its end. */
  useEffect(() => {
    setAtBottom(true);
    setMissed(false);
  }, [agentId]);

  /**
   * Send, as the assistant-ui runtime needs it: text in, promise out.
   *
   * It reuses the SAME daemon call and the same optimistic-then-reconcile
   * behaviour as the hand-written composer, including the agent-switch check -
   * a reply that arrives after the operator has moved to another bot must not
   * be appended to the conversation they are now looking at.
   */
  const pendingRequests = useRef(new Map<string, { text: string; id: string; taskId?: string }>());
  const sendText = useCallback(
    async (text: string) => {
      const targetThreadId = threadId;
      const targetAgentId = agentId;
      if (!targetThreadId || !targetAgentId) return;
      const pending = pendingRequests.current.get(targetThreadId);
      const taskId = undefined;
      const request = pending?.text === text && pending.taskId === taskId ? pending : { text, id: crypto.randomUUID(), taskId };
      pendingRequests.current.set(targetThreadId, request);

      const optimistic: ChatMessageRow = {
        thread_id: targetThreadId,
        role: 'user',
        content: text,
        created_at: Date.now(),
      };
      setMessages((current) => [...current, optimistic]);
      setError('');
      setSendingThreads(current => new Set(current).add(targetThreadId));
      try {
        const result = await api.sendChat(targetThreadId, text, request.id, request.taskId);
        pendingRequests.current.delete(targetThreadId);
        if (activeAgentIdRef.current !== targetAgentId) {
          onThreadActivity();
          return;
        }
        setMessages((current) => (current.some((row) => row.id === result.reply.id) ? current : [...current, result.reply]));
        onThreadActivity();
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'The daemon could not send this message.';
        if (activeAgentIdRef.current !== targetAgentId) {
          onNotify(`Message to that bot failed: ${message}`);
          return;
        }
        setMessages((current) => current.filter((row) => row !== optimistic));
        setError(message);
        // Rethrown so assistant-ui's composer keeps the text rather than
        // clearing it into nothing.
        throw cause instanceof Error ? cause : new Error(message);
      } finally {
        setSendingThreads(current => { const next = new Set(current); next.delete(targetThreadId); return next; });
      }
    },
    [threadId, agentId, onThreadActivity, onNotify]
  );

  const stopRequest = useCallback(async () => {
    const pending = threadId && pendingRequests.current.get(threadId);
    if (!pending || !threadId) return;
    setStopping(true);
    try { await api.cancelChat(threadId, pending.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop this request.'); }
    finally { setStopping(false); }
  }, [threadId]);

  const [followUpQueue, setFollowUpQueue] = useState<string[]>([]);
  const [steerBusy, setSteerBusy] = useState(false);

  useEffect(() => {
    setFollowUpQueue([]);
  }, [agentId, threadId]);

  useEffect(() => {
    if (!sending && followUpQueue.length > 0 && threadId) {
      const nextMessage = followUpQueue[0];
      setFollowUpQueue((current) => current.slice(1));
      void sendText(nextMessage);
    }
  }, [sending, followUpQueue, threadId, sendText]);

  const steerActiveRequest = useCallback(async (instruction: string) => {
    const pending = threadId && pendingRequests.current.get(threadId);
    if (!pending || !threadId || !instruction.trim()) return;
    setSteerBusy(true);
    try {
      const res = await api.steerChat(threadId, pending.id, instruction.trim());
      if (res.success) {
        onNotify('Instruction sent to active task.');
        if (activeAgent?.id) {
          setComposer(activeAgent.id, EMPTY_COMPOSER);
        }
      } else {
        setError(res.message || 'Could not steer active task.');
      }
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Failed to steer task.');
    } finally {
      setSteerBusy(false);
    }
  }, [threadId, activeAgent?.id, setComposer, onNotify]);

  const runForRequest = useCortex((state) => state.runForRequest);
  const pendingReq = threadId ? pendingRequests.current.get(threadId) : null;
  const requestKey = threadId && pendingReq ? `${threadId}:${pendingReq.id}` : null;
  const activeRunId = (requestKey ? runForRequest[requestKey] : null) || progress?.taskRunId || null;

  useEffect(() => {
    const pending = threadId && pendingRequests.current.get(threadId);
    if (!sending || !threadId || !pending) { setProgress(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const pollKey = `${threadId}:${pending.id}`;
    const poll = async () => {
      try { const result = await api.chatProgress(threadId, pending.id); if (!cancelled) setProgress(result.progress); }
      catch { /* The POST remains authoritative; its error is shown by sendText. */ }
      if (!cancelled) {
        const knownRunId = useCortex.getState().runForRequest[pollKey] || progress?.taskRunId;
        timer = setTimeout(poll, knownRunId ? 5000 : 1000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sending, threadId, progress?.taskRunId]);

  // A message the daemon posted by itself - a routine result, a mission step,
  // the outcome of a decided proposal - appears without a reload. Skipped while
  // this conversation has a request in flight: that request's reply arrives with
  // it, and a reload mid-send would duplicate the optimistic message.
  const chatActivity = useCortex((state) => state.chatActivity);
  useEffect(() => {
    if (!chatActivity || !threadId || chatActivity.threadId !== threadId) return;
    if (pendingRequests.current.has(threadId)) return;
    let cancelled = false;
    void api
      .chatMessages(threadId)
      .then((result) => {
        if (!cancelled && !pendingRequests.current.has(threadId)) setMessages(result.messages);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chatActivity, threadId]);

  // Chat content expires in the daemon after 24 hours. Refresh an open
  // transcript even when no new reply event arrives.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState === 'hidden' || pendingRequests.current.has(threadId)) return;
      void api.chatMessages(threadId)
        .then((result) => {
          if (!cancelled && !pendingRequests.current.has(threadId)) setMessages(result.messages);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [threadId]);

  // Example requests from the details panel fill this bot's composer (see
  // lib/compose.ts). Nothing is sent: the person edits it and presses Send.
  useEffect(() => {
    const onCompose = (event: Event) => {
      const detail = (event as CustomEvent<ComposeDetail>).detail;
      if (!detail || detail.agentId !== activeAgentIdRef.current) return;
      setComposers((current) => ({ ...current, [detail.agentId]: { ...(current[detail.agentId] ?? EMPTY_COMPOSER), text: detail.text } }));
      requestAnimationFrame(() => {
        const field = composerRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(detail.text.length, detail.text.length);
      });
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);
  useEffect(()=>{const initial=initialCompose;if(initial&&initial.agentId===activeAgent?.id)setComposers(current=>({...current,[initial.agentId]:{...(current[initial.agentId]??EMPTY_COMPOSER),text:initial.text}}));},[initialCompose]);

  const assistantRuntime = useOpenAgentsRuntime({
    messages,
    isRunning: sending,
    isLoading: loading,
    onSend: sendText,
    onCancel: stopRequest,
    canSend: Boolean(threadId && agentId),
  });

  /** Messages and blocked approvals, interleaved by time. */
  const transcript = useMemo<TranscriptItem[]>(() => {
    const items: TranscriptItem[] = messages.map((message, index) => ({
      kind: 'message',
      at: message.created_at,
      message,
      key: message.id !== undefined ? `m${message.id}` : `t${message.created_at}-${index}`,
    }));
    for (const row of approvals) {
      items.push({ kind: 'approval', at: row.created_at, approval: parseApproval(row), key: `a${row.id}` });
    }
    return items.sort((a, b) => a.at - b.at);
  }, [messages, approvals]);

  /**
   * Put a previous question back in the composer, ready to send again.
   *
   * Deliberately NOT called "regenerate", and deliberately not sent on click.
   *
   * "Regenerate" implies the old answer is replaced. This daemon has no notion
   * of alternative branches for a turn - sending again appends a new exchange
   * and leaves the previous one exactly where it is. And it dispatches a real
   * run against a real provider, so a menu item that spends money on a single
   * click is a trap. Loading the composer puts the decision back with the
   * person about to pay for it.
   */
  function askAgain(userContent: string) {
    if (!agentId || sending) return;
    setComposer(agentId, { ...composer, text: userContent });
    composerRef.current?.focus();
    onNotify('Put back in the composer. Send it to ask again — this runs the model afresh.');
  }

  async function send() {
    const content = composer.text.trim();
    const attachments = composer.attachments;
    if ((!content && attachments.length === 0) || !threadId || !agentId || sending) return;
    const targetAgentId = agentId;
    const quoted = composer.replyTo;
    // A reply is sent as a quote so the bot sees what it is answering; the
    // daemon has no reply-to column, and pretending otherwise would lose it.
    const quotedContent = quoted
      ? `> ${quoted.content.replace(/\n/g, ' ').slice(0, 200)}\n\n${content}`
      : content;
    // Attachment text is inlined, so the bubble shows exactly what was sent.
    const outgoing = composeWithAttachments(quotedContent, attachments);

    setComposer(targetAgentId, EMPTY_COMPOSER);
    if (composerRef.current) composerRef.current.style.height = 'auto';
    try { await sendText(outgoing); }
    catch { setComposer(targetAgentId, { text: content, replyTo: quoted, attachments }); }
  }

  function messageKeyFor(message: ChatMessageRow, index: number): string {
    return message.id !== undefined ? `m${message.id}` : `t${message.created_at}-${index}`;
  }

  function toggleReaction(key: string, emoji: string) {
    if (!activeAgent) return;
    const current = activeAgent.reactions[key] ?? [];
    const next = current.includes(emoji)
      ? current.filter((e) => e !== emoji)
      : [...current, emoji].slice(0, 12);
    const updated = { ...activeAgent.reactions };
    if (next.length) updated[key] = next;
    else delete updated[key];
    onReactionsChange(activeAgent.id, updated);
  }

  async function attachFiles(files: FileList | File[] | null | undefined) {
    if (!files || !agentId) return;
    setAttachError('');
    const { attachments, rejected } = await readAttachments(
      Array.from(files),
      composer.attachments.length,
      async file => {
        if(!threadId)throw new Error('Open a conversation before attaching a binary file.');
        const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read file.'));reader.readAsDataURL(file);});
        return await api.systemAction('attachment-upload',{agentId,threadId,name:file.name,data});
      }
    );
    if (attachments.length > 0) {
      setComposer(agentId, { attachments: [...composer.attachments, ...attachments] });
    }
    if (rejected.length > 0) {
      setAttachError(rejected.map((r) => `${r.name}: ${r.reason}`).join(' · '));
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(`${label} copied.`);
    } catch {
      onNotify('This browser blocked clipboard access.');
    }
  }

  // ---------------------------------------------------------------- draft ---
  if (draft) {
    const chosen = draft.recipients
      .map((id) => teammates.find((mate) => mate.id === id))
      .filter((mate): mate is Teammate => Boolean(mate));
    const available = teammates.filter(
      (mate) =>
        !draft.recipients.includes(mate.id) &&
        mate.name.toLowerCase().includes(recipientQuery.trim().toLowerCase())
    );

    return (
      <main className="grok-chat-pane">
        <header className="grok-chat-header grok-draft-header">
          <span className="grok-draft-to">To:</span>
          {chosen.map((mate) => (
            <span key={mate.id} className="grok-recipient-chip">
              <BotFace
                size={18}
                shape={mate.profile.shape}
                color={mate.profile.color}
                eyeColor={mate.profile.eyeColor}
                image={mate.profile.avatarImage}
                idle={false}
              />
              {mate.name}
              <button
                type="button"
                aria-label={`Remove ${mate.name}`}
                onClick={() => onDraftRecipient(mate.id)}
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
          <input
            ref={recipientRef}
            className="grok-recipient-input"
            type="text"
            value={recipientQuery}
            placeholder={draft.kind === 'group' ? 'Add bots to the group' : 'Search or create Bots'}
            aria-label={draft.kind === 'group' ? 'Add bots to the group' : 'Search or create Bots'}
            aria-expanded={recipientOpen}
            aria-haspopup="listbox"
            onFocus={() => setRecipientOpen(true)}
            onChange={(event) => {
              setRecipientQuery(event.target.value);
              setRecipientOpen(true);
            }}
          />
          <IconButton onClick={onCancelDraft} aria-label="Discard this draft" title="Discard this draft">
            <Icon name="close" />
          </IconButton>
        </header>

        {recipientOpen && (
          <Popover
            anchorRef={recipientRef}
            placement="bottom-start"
            label="Choose a recipient"
            role="listbox"
            width={560}
            onClose={() => setRecipientOpen(false)}
            autoFocus={false}
          >
            {draft.kind === 'direct' && (
              <>
                <MenuItem icon={<Icon name="add" />} onSelect={onCreateBot}>
                  Create new Bot
                </MenuItem>
                <MenuItem
                  icon={<Icon name="group" />}
                  onSelect={() => {
                    onDraftKindChange('group');
                    setRecipientOpen(false);
                  }}
                >
                  Create group chat
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            {available.map((mate) => (
              <button
                key={mate.id}
                type="button"
                role="option"
                aria-selected={false}
                className="grok-menu-item grok-recipient-option"
                onClick={() => {
                  onDraftRecipient(mate.id);
                  setRecipientQuery('');
                  if (draft.kind === 'direct') setRecipientOpen(false);
                }}
              >
                <BotFace
                  size={22}
                  shape={mate.profile.shape}
                  color={mate.profile.color}
                  eyeColor={mate.profile.eyeColor}
                  image={mate.profile.avatarImage}
                  idle={false}
                />
                <span className="grok-menu-label">{mate.name}</span>
                {draft.kind === 'group' && <span className="grok-menu-hint">Add to group chat</span>}
              </button>
            ))}
            {available.length === 0 && (
              <p className="grok-menu-empty">
                {teammates.length === 0 ? 'No bots yet.' : 'No bots match that name.'}
              </p>
            )}
          </Popover>
        )}

        <div className="grok-messages-container grok-draft-body">
          <p className="grok-draft-hint">
            {draft.kind === 'group'
              ? 'Group conversations are not supported by this daemon yet: a conversation belongs to exactly one bot. Adding recipients here is a draft only and will not create a group.'
              : 'Pick a bot to start a conversation. Nothing is saved until you do.'}
          </p>
        </div>

        <footer className="grok-chat-footer">
          {/* Inert until a bot is chosen, but the SAME shape as the live
              composer - text on top, toolbar beneath. The previous version put
              its three controls straight into the capsule's column, so they
              stacked vertically. */}
          <form className="grok-input-capsule oh-composer is-inert" onSubmit={(event) => event.preventDefault()}>
            <textarea
              id="grok-chat-inert-input"
              name="message"
              rows={1}
              className="grok-capsule-input"
              placeholder={draft.kind === 'group' ? 'Group conversations are not available yet' : 'Choose a bot above to start writing'}
              aria-label="Message"
              disabled
            />
            <div className="grok-capsule-row oh-composer-toolbar">
              <button type="button" className="grok-capsule-btn oh-tool-btn" disabled aria-label="Attach file" title="Choose a bot before attaching files.">
                <Icon name="attach" />
              </button>
              <span className="oh-composer-spacer" />
              <button type="button" className="grok-capsule-btn oh-tool-btn grok-voice-btn" disabled aria-label="Voice input" title="Choose a bot before dictating.">
                <Icon name="dictate" />
              </button>
              <button type="button" className="grok-capsule-btn grok-send-btn" disabled aria-label="Send message" title="Choose a bot first.">
                <Icon name="send" />
              </button>
            </div>
          </form>
        </footer>
      </main>
    );
  }

  // ------------------------------------------------------------ no agent ---
  if (!activeAgent) {
    return (
      <main className="grok-chat-pane">
        {/* Coss Empty. This is a whole pane with nothing in it, which is what
            the component is for - the one-line notes elsewhere in the app stay
            plain text, because an Empty inside a table row would be a panel
            pretending to be a sentence. */}
        <Empty className="grok-empty-conversation">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="bot" motion={false} />
            </EmptyMedia>
            <EmptyTitle>No conversation open</EmptyTitle>
            <EmptyDescription>Select a bot to open its conversation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  const canSend =
    (Boolean(composer.text.trim()) || composer.attachments.length > 0) && !sending && Boolean(threadId);
  let previousAt: number | null = null;

  const modelParts = activeAgent.model.split('/');
  const modelName = modelParts[modelParts.length - 1] || activeAgent.model;
  const modelVendor =
    modelParts.length > 1 && !modelName.toLowerCase().startsWith(modelParts[0].toLowerCase()) ? modelParts[0] : '';


  /**
   * What the bot is doing right now, from the daemon's own progress report.
   *
   * In the classic view the send button turns into the stop control while a
   * request is out, so the strip carries no second one - two "Stop request"
   * buttons would be two controls for one action. The assistant-ui composer
   * has no such button, so there the strip carries it.
   */
  const runStatus = sending ? (
    <div className="oh-run-status">
      <span className="oh-run-orb" aria-hidden="true" />
      <span role="status" className="oh-run-label">
        {progress?.tool ? (PROGRESS_LABEL[progress.tool] ?? 'Working') : 'Waiting for the bot'}
        {progress?.turn ? ` · Turn ${progress.turn}` : ''}
      </span>
      {!!progress?.steps.length && (
        <details className="oh-run-plan">
          <summary>Task plan</summary>
          <ol>{progress.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        </details>
      )}
      {assistantView && (
        <button type="button" className="oh-run-stop" disabled={stopping} onClick={() => void stopRequest()}>
          {stopping ? 'Stopping…' : 'Stop request'}
        </button>
      )}
    </div>
  ) : null;

  /** Mode and model are properties of the message being written, so they sit in its toolbar. */
  const composerTools = (
    <>
      {onSaveModel && (
        <button
          type="button"
          className="oh-chip oh-chat-model"
          disabled={sending}
          aria-label="Choose chat model"
          aria-haspopup="dialog"
          title={activeAgent.model}
          onClick={() => setModelOpen(true)}
        >
          <Icon name="bot" size={14} motion={false} />
          <span className="oh-chip-label">{modelName}</span>
          {modelVendor && <span className="oh-chip-vendor">{modelVendor}</span>}
          <Icon name="chevronDown" size={13} className="oh-chip-chevron" motion={false} />
        </button>
      )}
    </>
  );

  return (
    <main className="grok-chat-pane">
      <header className="grok-chat-header">
        <button type="button" className="grok-chat-identity" onClick={onOpenDetails} title="Open details">
          <BotFace
            size={32}
            shape={activeAgent.profile.shape}
            color={activeAgent.profile.color}
            eyeColor={activeAgent.profile.eyeColor}
            eyeScale={activeAgent.profile.eyeScale}
            image={activeAgent.profile.avatarImage}
            emotion={sending ? '30' : activeAgent.profile.emotion}
            idle={activeAgent.profile.idle}
            sketch={activeAgent.profile.sketch}
            interactive
          />
          <span className="oh-chat-heading">
            <span className="grok-chat-title">{activeAgent.name}</span>
            <small className="oh-chat-status" data-state={sending ? 'working' : activeAgent.status.toLowerCase()}>
              <i aria-hidden="true" />
              {sending ? 'Working on your request' : (STATUS_LABEL[activeAgent.status] ?? 'Ready')}
            </small>
          </span>
          {activeAgent.profile.label && (
            <span className="grok-chat-label-chip">{activeAgent.profile.label}</span>
          )}
        </button>
        <div className="grok-chat-header-actions">

          <IconButton ref={templateBtnRef} onClick={() => setTemplateMenuOpen(true)}
            aria-haspopup="menu"
            aria-label="Template actions"
            title="Template actions"
          >
            <Icon name="template" />
          </IconButton>
          <IconButton onClick={onOpenSettings} aria-label="Bot settings" title="Bot settings">
            <Icon name="settings" />
          </IconButton>
          <IconButton onClick={onToggleDetails} aria-label={isDetailsOpen ? 'Hide details' : 'Show details'} aria-expanded={isDetailsOpen} title={isDetailsOpen ? 'Hide details' : 'Show details'}>
            <Icon name={isDetailsOpen ? 'expand' : 'collapse'} />
          </IconButton>
        </div>
      </header>

      {modelOpen && onSaveModel && <ChatModelDialog key={`model-${activeAgent.id}`} agent={activeAgent} onSave={onSaveModel} onClose={() => setModelOpen(false)} />}

      {templateMenuOpen && (
        <Popover
          anchorRef={templateBtnRef}
          placement="bottom-end"
          label="Template actions"
          width={200}
          onClose={() => setTemplateMenuOpen(false)}
        >
          <MenuItem
            icon={<Icon name="upload" />}
            onSelect={() => {
              setTemplateMenuOpen(false);
              onShareAsTemplate();
            }}
          >
            Share as template
          </MenuItem>
        </Popover>
      )}

      {/* Mode, model and run progress used to sit in a bar of their own here,
          between the header and the transcript. They describe the message
          being written, so they live in the composer now. */}
      {assistantView && approvals.filter(row => row.status === 'PENDING').map(row => <GrokQuestionCard key={row.id} approval={parseApproval(row)} busy={approvalBusyId === row.id} onAnswer={onAnswerApproval} />)}
      {agentId && <WorkQuestions key={`${agentId}:${threadId}`} agentId={agentId} threadId={threadId} />}
      {agentId && <BackgroundTasks key={agentId} agentId={agentId} />}

      {assistantView && (
        <AssistantRuntimeProvider runtime={assistantRuntime}>
          <GrokThreadView
            agent={activeAgent}
            placeholder={`Message ${activeAgent.name}`}
            tools={composerTools}
            status={<>{runStatus}</>}
          />
        </AssistantRuntimeProvider>
      )}

      {!assistantView && (
      <div
        ref={scrollerRef}
        className="grok-messages-container"
        role="log"
        aria-live="polite"
        aria-label={`Conversation with ${activeAgent.name}`}
        onScroll={onScroll}
      >
        {loading && (
          // Switching bots is a navigation, not a wait, so this is shaped like
          // the conversation about to appear - the bot's own face and a
          // transcript outline - instead of a spinner parked in a corner. It
          // fades in only after a short delay (workspace-design.css), so a
          // quick daemon goes straight from one transcript to the next with no
          // loader flashing in between.
          <div className="oh-conversation-loading" role="status">
            <div className="oh-loading-identity">
              <span className="oh-loading-orbit" aria-hidden="true" />
              <BotFace
                size={40}
                shape={activeAgent.profile.shape}
                color={activeAgent.profile.color}
                eyeColor={activeAgent.profile.eyeColor}
                image={activeAgent.profile.avatarImage}
                emotion="02"
                idle={false}
              />
            </div>
            <p className="oh-shimmer-text">Opening conversation with {activeAgent.name}…</p>
            <div className="oh-skeleton-transcript" aria-hidden="true">
              <span className="oh-skeleton-line user" style={{ width: '42%' }} />
              <span className="oh-skeleton-line" style={{ width: '86%' }} />
              <span className="oh-skeleton-line" style={{ width: '74%' }} />
              <span className="oh-skeleton-line" style={{ width: '52%' }} />
              <span className="oh-skeleton-line user" style={{ width: '30%' }} />
              <span className="oh-skeleton-line" style={{ width: '80%' }} />
              <span className="oh-skeleton-line" style={{ width: '64%' }} />
            </div>
          </div>
        )}

        {!loading && transcript.length === 0 && !error && (
          <div className="grok-welcome">
            <div className="oh-welcome-avatar">
              <span className="oh-welcome-orbit" aria-hidden="true"><i /></span>
              <BotFace
                size={86}
                shape={activeAgent.profile.shape}
                color={activeAgent.profile.color}
                eyeColor={activeAgent.profile.eyeColor}
                eyeScale={activeAgent.profile.eyeScale}
                image={activeAgent.profile.avatarImage}
                emotion="03"
                idle={activeAgent.profile.idle}
                sketch={activeAgent.profile.sketch}
                interactive
              />
            </div>
            <h1>What should {activeAgent.name} work on?</h1>
            <p>{activeAgent.description || 'This bot has no description yet.'}</p>
            <div className="oh-starter-prompts" aria-label="Conversation starters">
              {STARTERS.map((item) => (
                <button
                  type="button"
                  key={item.title}
                  onClick={() => {
                    setComposer(activeAgent.id, { text: item.prompt });
                    composerRef.current?.focus();
                  }}
                >
                  <span className="oh-starter-icon"><Icon name={item.icon} size={15} /></span>
                  <span>{item.title}</span>
                  <Icon name="forward" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grok-chat-content">
          {transcript.map((item, index) => {
            const separator = needsSeparator(previousAt, item.at);
            previousAt = item.at;

            if (item.kind === 'approval') {
              return (
                <div key={item.key}>
                  {separator && (
                    <div className="grok-timestamp-divider">
                      <span>{transcriptDayLabel(item.at)}</span>
                    </div>
                  )}
                  <div className="grok-message-row assistant-row">
                    <div className="grok-message-content">
                      <GrokQuestionCard
                        approval={item.approval}
                        busy={approvalBusyId === item.approval.row.id}
                        onAnswer={onAnswerApproval}
                      />
                    </div>
                  </div>
                </div>
              );
            }

            const message = item.message;
            const key = messageKeyFor(message, index);
            const isUser = message.role === 'user';
            const reactions = activeAgent.reactions[key] ?? [];

            return (
              <div key={item.key} data-message-id={message.id} tabIndex={-1}>
                {separator && (
                  <div className="grok-timestamp-divider">
                    <span>{transcriptDayLabel(item.at)}</span>
                  </div>
                )}
                <div
                  className={`grok-message-row ${isUser ? 'user-row' : 'assistant-row'}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMessageMenu({ key, message, x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className="grok-message-content">
                    <div
                      className={`grok-bubble ${isUser ? 'grok-bubble-user' : 'grok-bubble-assistant'}`}
                      title={new Date(message.created_at).toLocaleString(UI_LOCALE, { dateStyle: 'full', timeStyle: 'short' })}
                    >
                      <MessageBody
                        content={message.content}
                        markdown={!isUser}
                        onOpenFile={onOpenFile}
                        runId={message.task_run_id}
                      />
                    </div>
                    {!isUser && message.task_run_id && (
                      <WorkedSteps runId={message.task_run_id} onOpenFile={onOpenFile} />
                    )}
                    <div className="grok-message-actions" role="group" aria-label="Message actions">
                      <button
                        type="button"
                        aria-label="Add reaction"
                        title="Add reaction"
                        onClick={(event) => {
                          emojiAnchorRef.current = event.currentTarget;
                          setEmojiFor(key);
                        }}
                      >
                        <Icon name="react" />
                      </button>
                      <button
                        type="button"
                        aria-label="Reply to this message"
                        title="Reply"
                        onClick={() => {
                          setComposer(activeAgent.id, {
                            replyTo: { id: key, content: message.content },
                          });
                          composerRef.current?.focus();
                        }}
                      >
                        <Icon name="reply" />
                      </button>
                      <button
                        type="button"
                        aria-label="More message actions"
                        title="More"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMessageMenu({ key, message, x: rect.left, y: rect.bottom + 4 });
                        }}
                      >
                        <Icon name="more" />
                      </button>
                    </div>
                    {reactions.length > 0 && (
                      <div className="grok-reaction-row">
                        {reactions.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="grok-reaction-chip"
                            aria-label={`Remove ${emoji} reaction`}
                            onClick={() => toggleReaction(key, emoji)}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <ActiveBotRuns agent={activeAgent} threadId={threadId} exclude={sending?activeRunId:null} onOpenFile={onOpenFile}/>
          {sending && (
            <RunActivityCard runId={activeRunId} agent={activeAgent} onOpenFile={onOpenFile} />
          )}

          {error && (
            <div className="grok-chat-error" role="alert">
              <strong>Could not complete the request</strong>
              <span>{error}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Only while the reader is away from the bottom AND something arrived
            while they were. A jump button that is always there is furniture;
            one that appears when it has something to say is information. */}
        {!atBottom && missed && (
          // A zero-height sticky anchor, so the pill pins to the bottom of the
          // SCROLLPORT rather than to the end of the content. Absolute
          // positioning inside a scroller scrolls away with the very content it
          // is offering to reach.
          <div className="grok-jump-anchor">
            <button type="button" className="grok-jump-latest" onClick={jumpToLatest}>
              <Icon name="chevronDown" size={14} />
              New messages
            </button>
          </div>
        )}
      </div>
      )}

      {emojiFor && (
        <GrokEmojiPicker
          anchorRef={emojiAnchorRef}
          onClose={() => setEmojiFor(null)}
          onSelect={(emoji) => {
            toggleReaction(emojiFor, emoji);
            setEmojiFor(null);
          }}
        />
      )}

      {messageMenu && (
        <Popover
          point={{ x: messageMenu.x, y: messageMenu.y }}
          placement="point"
          label="Message actions"
          width={252}
          className="grok-message-menu"
          onClose={() => setMessageMenu(null)}
        >
          <div className="grok-quick-reactions" role="group" aria-label="Quick reactions">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                onClick={() => {
                  toggleReaction(messageMenu.key, emoji);
                  setMessageMenu(null);
                }}
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              className="grok-quick-more"
              aria-label="More emoji"
              title="More emoji"
              onClick={(event) => {
                emojiAnchorRef.current = event.currentTarget;
                const key = messageMenu.key;
                setMessageMenu(null);
                setEmojiFor(key);
              }}
            >
              <Icon name="react" />
            </button>
          </div>
          <MenuItem
            icon={<Icon name="reply" />}
            onSelect={() => {
              setComposer(activeAgent.id, {
                replyTo: { id: messageMenu.key, content: messageMenu.message.content },
              });
              setMessageMenu(null);
              composerRef.current?.focus();
            }}
          >
            Reply
          </MenuItem>
          <MenuItem
            icon={<Icon name="copy" />}
            onSelect={() => {
              void copyText(messageMenu.message.content, 'Message');
              setMessageMenu(null);
            }}
          >
            Copy
          </MenuItem>
          {messageMenu.message.role === 'user' && (
            <MenuItem
              icon={<Icon name="refresh" />}
              title="Puts this back in the composer. Sending it runs the model again and spends again."
              onSelect={() => {
                void askAgain(messageMenu.message.content);
                setMessageMenu(null);
              }}
            >
              Ask again
            </MenuItem>
          )}
          <MenuItem
            icon={<Icon name="copy" />}
            disabled={!messageMenu.message.task_run_id}
            title={
              messageMenu.message.task_run_id
                ? 'Copy the run id this reply was produced by'
                : 'This message has no run id: it was never dispatched to a model.'
            }
            onSelect={() => {
              if (messageMenu.message.task_run_id) {
                void copyText(messageMenu.message.task_run_id, 'Request ID');
              }
              setMessageMenu(null);
            }}
          >
            Copy request ID
          </MenuItem>
        </Popover>
      )}

      {!assistantView && (
      <footer className="grok-chat-footer">
        {runStatus}
        <form
          className={`grok-input-capsule oh-composer ${composer.replyTo ? 'replying' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {/* The light that travels the capsule's edge while it has focus.
              Decoration only; reduced motion removes it in the stylesheet. */}
          <span className="oh-composer-glow" aria-hidden="true" />
          {composer.replyTo && (
            <div className="grok-reply-strip">
              <span className="grok-reply-icon" aria-hidden="true"><Icon name="reply" /></span>
              <span className="grok-reply-quote">{composer.replyTo.content}</span>
              <button
                type="button"
                aria-label="Cancel reply"
                title="Cancel reply"
                onClick={() => setComposer(activeAgent.id, { replyTo: null })}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {composer.attachments.length > 0 && (
            <ul className="grok-attachment-list" aria-label="Attached files">
              {composer.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <Icon name="file" size={14} motion={false} />
                  <span className="grok-attachment-name">{attachment.name}</span>
                  <span className="grok-attachment-size">{formatBytes(attachment.bytes)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() =>
                      setComposer(activeAgent.id, {
                        attachments: composer.attachments.filter((a) => a.id !== attachment.id),
                      })
                    }
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachError && (
            <p className="grok-attachment-error" role="alert">
              {attachError}
            </p>
          )}
          {speech.listening && (
            <p className="grok-dictation-strip" role="status">
              <span className="grok-dictation-dot" aria-hidden="true" />
              Listening — speech is transcribed by your browser.
              {speech.transcript && <em> {speech.transcript}</em>}
            </p>
          )}
          {speech.error && (
            <p className="grok-attachment-error" role="alert">
              {speech.error}
            </p>
          )}
          

          {followUpQueue.length > 0 && (
            <div className="oh-followup-queue-dock" data-testid="followup-queue-dock">
              <div className="oh-followup-queue-header">
                <span>Queued follow-up ({followUpQueue.length})</span>
              </div>
              <ul className="oh-followup-queue-list">
                {followUpQueue.map((item, idx) => (
                  <li key={idx} className="oh-followup-queue-item">
                    <span className="oh-followup-item-text">{item}</span>
                    <button
                      type="button"
                      className="oh-followup-remove-btn"
                      aria-label="Remove queued message"
                      onClick={() => setFollowUpQueue((q) => q.filter((_, i) => i !== idx))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <textarea
            id="grok-chat-message-input"
            name="message"
            ref={composerRef}
            rows={1}
            className="grok-capsule-input"
            placeholder={
              sending
                ? `Steer ${activeAgent.name} or queue follow-up…`
                : composer.replyTo
                  ? 'Reply'
                  : `Message ${activeAgent.name}`
            }
            aria-label={composer.replyTo ? 'Reply' : `Message ${activeAgent.name}`}
            value={composer.text}
            disabled={!threadId}
            onChange={(event) => {
              setComposer(activeAgent.id, { text: event.target.value });
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                void attachFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (sending) {
                  if (composer.text.trim()) {
                    void steerActiveRequest(composer.text);
                  }
                } else {
                  void send();
                }
              }
            }}
          />

          <div className="grok-capsule-row oh-composer-toolbar">
            <button
              type="button"
              className="grok-capsule-btn oh-tool-btn"
              aria-label="Attach file"
              title={`Attach a text file (up to ${MAX_ATTACHMENTS}). Its text is added to your message.`}
              disabled={sending || composer.attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="attach" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void attachFiles(event.target.files);
                event.target.value = '';
              }}
            />
            {composerTools}
            <span className="oh-composer-hint" aria-hidden="true">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
            </span>
            <button
              type="button"
              className={`grok-capsule-btn oh-tool-btn grok-voice-btn ${speech.listening ? 'listening' : ''}`}
              disabled={!speech.supported || sending}
              aria-label={speech.listening ? 'Stop dictation' : 'Dictate a message'}
              aria-pressed={speech.listening}
              title={
                speech.supported
                  ? 'Dictate a message. Your browser performs the recognition, which may send audio to its speech service.'
                  : SPEECH_UNSUPPORTED_REASON
              }
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
            >
              <Icon name="dictate" />
            </button>
            {/* One slot, two jobs: send while composing, stop while the bot
                works. The same place on screen is the same kind of action. */}
            {sending ? (
              <div className="oh-active-actions" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {composer.text.trim().length > 0 && (
                  <>
                    <button
                      type="button"
                      className="grok-capsule-btn oh-steer-btn"
                      disabled={steerBusy}
                      aria-label="Steer active task"
                      title="Send instruction to active task at next turn"
                      onClick={() => void steerActiveRequest(composer.text)}
                    >
                      Steer
                    </button>
                    <button
                      type="button"
                      className="grok-capsule-btn oh-queue-btn"
                      aria-label="Queue follow-up"
                      title="Queue message to run after current task finishes"
                      onClick={() => {
                        const txt = composer.text.trim();
                        if (txt) {
                          setFollowUpQueue((q) => [...q, txt]);
                          if (activeAgent?.id) {
                            setComposer(activeAgent.id, EMPTY_COMPOSER);
                          }
                        }
                      }}
                    >
                      Queue
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="grok-capsule-btn oh-stop-btn"
                  disabled={stopping}
                  aria-label="Stop request"
                  title={stopping ? 'Stopping…' : 'Stop this request'}
                  onClick={() => void stopRequest()}
                >
                  <Icon name="stop" size={12} />
                </button>
              </div>
            ) : (
              <button
                type="submit"
                className="grok-capsule-btn grok-send-btn"
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </form>
      </footer>
      )}
    </main>
  );
}
