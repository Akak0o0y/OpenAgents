/**
 * The workspace shell.
 *
 * Owns the three columns and everything that spans them: which bot is active,
 * the unsent draft, the details panel's view, the modals, and the per-bot UI
 * state that lives in the daemon's agent_data store.
 *
 * The rules this file exists to hold:
 *
 *  - PROFILE STATE IS SERVER STATE. Appearance, label, notifications, sidebar
 *    flags and reactions are loaded from the daemon and written back to it. The
 *    old localStorage blob is migrated once, on first load, and reported.
 *  - NOTHING IS OPTIMISTIC ABOUT THE SERVER. A profile edit paints immediately
 *    because it is cheap and reversible, and a failed write is rolled back and
 *    surfaced, not swallowed.
 *  - A DRAFT IS NOT A BOT. "New chat" opens an unsent draft in the sidebar and
 *    creates nothing until a recipient is picked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useCortex } from '../store.js';
import { api, sendCommand, type ApprovalRow, type ChatThreadPreviewRow, type SearchResultRow } from '../lib/transport.js';
import {
  loadWorkspaceUiState,
  saveFlags,
  saveProfile,
  saveReactions,
  type BotProfile,
  type ConversationFlags,
  type ReactionMap,
  type WorkspaceUiState,
} from '../lib/botProfile.js';
import { applyTheme, applyCodeTheme, readPreferences, writePreferences, type Preferences } from '../lib/preferences.js';
import { desktopBridge, useSystemTheme } from '../lib/desktop.js';
import { useHotkey } from '../lib/useHotkey.js';
import { TooltipLayer } from './ui/TooltipLayer.js';
import { useComputerSession } from '../lib/useComputerSession.js';
import { dockerBanner, useDockerStatus } from '../lib/useDockerStatus.js';
import { useProviderSetup } from '../lib/useProviderSetup.js';
import { GrokSidebar, type BotContextAction } from './GrokSidebar.js';
import { GrokChat } from './GrokChat.js';
import { GrokScreen } from './GrokScreen.js';
import { GrokNewBotScreen, type NewBotInput } from './GrokNewBotScreen.js';
import { GrokMarketplaceModal } from './GrokMarketplaceModal.js';
import { GrokSearchDialog, type WorkspaceAction } from './GrokSearchDialog.js';
import { GrokSettingsModal, type SettingsSection } from './GrokSettingsModal.js';
import { GrokTemplateDialog } from './GrokTemplateDialog.js';
import { MenuItem, MenuSeparator, Modal, Popover } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import type { RoutineDraft } from './GrokRoutineEditor.js';
import type { MarketplaceBotTemplate } from '../data/marketplace.js';
import type { ChatDraft, DetailsState, Teammate } from './workspaceTypes.js';
import { ToastProvider, toastManager } from '@/registry/default/ui/toast.js';
import { FormError } from './ui/FormError.js';
import { Button } from './ui/Button.js';
import { AvatarStudio } from './AvatarStudio.js';
import { inkOn } from '../lib/color.js';

interface GrokWorkspaceProps {
  onToggleGalaxyView: () => void;
  initialStudioOpen?: boolean;
}

const EMPTY_UI_STATE: WorkspaceUiState = { profiles: {}, flags: {}, reactions: {} };

/** The default bot colour, used as the accent when no bot is open. */
const DEFAULT_ACCENT = '#2C86F0';


export function GrokWorkspace({ onToggleGalaxyView, initialStudioOpen = false }: GrokWorkspaceProps) {
  const agents = useCortex((state) => state.agents);
  const taskRuns = useCortex((state) => state.taskRuns);
  const routines = useCortex((state) => state.routines);
  const connection = useCortex((state) => state.connection);
  const executor = useCortex((state) => state.executor);
  const refreshState = useCortex((state) => state.refreshState);
  const refreshRoutines = useCortex((state) => state.refreshRoutines);

  const [ui, setUi] = useState<WorkspaceUiState>(EMPTY_UI_STATE);
  const [uiLoaded, setUiLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ChatThreadPreviewRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(() => useCortex.getState().selectedAgentId);
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [details, setDetails] = useState<DetailsState>({ open: false, view: 'details', routineId: null });
  const [studioOpen, setStudioOpen] = useState(initialStudioOpen);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [creatingBot, setCreatingBot] = useState(false);
  const [duplicateBot, setDuplicateBot] = useState<Omit<NewBotInput, 'id'> | undefined>();
  const [characterSetupRequest,setCharacterSetupRequest]=useState<{agentId:string;text:string}|undefined>();
  const [chatTarget, setChatTarget] = useState<{ agentId: string; threadId: string; messageId?: string; key: number }>();
  const searchNavigation = useRef(0);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  /**
   * Notices go to the toast manager rather than into state.
   *
   * The manager owns queueing, timing and stacking, which the previous single
   * string could not: setting it twice in quick succession lost the first
   * message entirely.
   */
  const notify = useCallback((message: string) => {
    toastManager.add({ description: message });
  }, []);
  const [pendingDelete, setPendingDelete] = useState<Teammate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const accountAnchorRef = useRef<HTMLElement | null>(null);
  accountAnchorRef.current = accountAnchor;

  // The shell's answer, where there is a shell. Null in a browser, and
  // applyTheme falls back to the stylesheet's media query there.
  const systemTheme = useSystemTheme();

  /**
   * Search on the modifier key, the way every application of this kind opens
   * it. Suppressed while it is already open so a second press does not toggle
   * the dialog shut from inside its own input.
   */
  useHotkey({ key: 'k', mod: true }, () => setSearchOpen(true), !searchOpen);

  useEffect(() => {
    applyTheme(preferences.theme, systemTheme);
  }, [preferences.theme, systemTheme]);

  useEffect(() => {
    void desktopBridge()?.theme.setPreference?.(preferences.theme).catch(error => console.warn('Could not save startup theme.', error));
  }, [preferences.theme]);

  useEffect(() => {
    applyCodeTheme(preferences.codeTheme ?? 'openhours');
  }, [preferences.codeTheme]);

  useEffect(() => {
    writePreferences(preferences);
  }, [preferences]);

  // ------------------------------------------------------- server UI state --
  useEffect(() => {
    if (agents.length === 0) {
      setUi(EMPTY_UI_STATE);
      setUiLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { state, migrated, error } = await loadWorkspaceUiState(agents);
      if (cancelled) return;
      setUi(state);
      setUiLoaded(true);
      setProfileError(error);
      if (migrated.length > 0) {
        notify(
          `Moved saved appearance for ${migrated.length} bot${migrated.length === 1 ? '' : 's'} from this browser to the daemon.`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Reload only when the fleet's membership changes, not on every field edit.
  }, [agents.map((a) => a.id).join(',')]);

  const loadPreviews = useCallback(async () => {
    try {
      const { threads } = await api.chatThreadPreviews();
      setPreviews(threads);
    } catch {
      // A daemon without previews still lists bots; the snippet is simply
      // absent rather than faked from the bot's role text.
      setPreviews([]);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    try {
      const { approvals: rows } = await api.approvals();
      setApprovals(rows);
    } catch {
      setApprovals([]);
    }
  }, []);

  useEffect(() => {
    void loadPreviews();
    void loadApprovals();
  }, [loadPreviews, loadApprovals, agents.length]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void loadPreviews();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [loadPreviews]);

  useEffect(() => {
    setRoutinesLoading(true);
    void refreshRoutines()
      .then(() => setRoutinesError(null))
      .catch((cause: unknown) =>
        setRoutinesError(cause instanceof Error ? cause.message : 'Routines could not be loaded.')
      )
      .finally(() => setRoutinesLoading(false));
  }, [refreshRoutines, agents.length]);

  // ------------------------------------------------------------- teammates --
  const teammates = useMemo<Teammate[]>(
    () =>
      agents.map((agent) => {
        const thread = previews.find((row) => row.agent_id === agent.id) ?? null;
        return {
          id: agent.id,
          name: agent.name,
          description: agent.system_prompt ?? '',
          model: agent.model_id,
          connectionId: agent.connection_id ?? null,
          routingMode: agent.routing_mode ?? null,
          status: agent.current_status,
          budgetCapUsd: agent.budget_cap_usd,
          profile:
            ui.profiles[agent.id] ??
            ({
              shape: 'blob',
              color: '#2C86F0',
              eyeColor: '#FFFFFF',
              eyeScale: 1,
              emotion: '02',
              idle: true,
              sketch: false,
              label: '',
              notifications: false,
              avatarImage: null,
            } satisfies BotProfile),
          flags: ui.flags[agent.id] ?? { pinned: false, unread: false, hidden: false, section: null },
          reactions: ui.reactions[agent.id] ?? {},
          updatedAt: agent.updated_at,
          threadId: thread?.id ?? null,
          lastMessagePreview: thread?.last_message_preview ?? null,
          lastMessageAt: thread?.last_message_at ?? thread?.updated_at ?? null,
        };
      }),
    [agents, previews, ui]
  );

  useEffect(() => {
    if (draft) return;
    if (!activeAgentId || !agents.some((agent) => agent.id === activeAgentId)) {
      setActiveAgentId(agents[0]?.id ?? null);
    }
  }, [agents, activeAgentId, draft]);

  const activeAgent = teammates.find((mate) => mate.id === activeAgentId) ?? null;
  const modelSource = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const defaultSelection = {
    modelId: modelSource?.model_id ?? 'openrouter/auto',
    connectionId: modelSource?.connection_id ?? null,
    routingMode: modelSource?.routing_mode ?? null,
  };

  useEffect(() => {
    if (activeAgentId && useCortex.getState().selectedAgentId !== activeAgentId) useCortex.getState().selectAgent(activeAgentId);
  }, [activeAgentId]);

  const latestRun = useMemo(
    () => taskRuns.find((run) => run.agent_id === activeAgentId) ?? null,
    [taskRuns, activeAgentId]
  );
  const computer = useComputerSession(activeAgentId, latestRun);
  // Docker is optional for the daemon to run and required for tasks that run
  // code; the sidebar says which fix applies before a task fails for it.
  const docker = useDockerStatus(true);
  const providerSetup = useProviderSetup();
  // A routine result or mission step posted by the daemon moves its bot's
  // conversation to the top of the sidebar with the new preview.
  const chatActivity = useCortex((state) => state.chatActivity);
  const handledActivity = useRef<typeof chatActivity>(null);
  useEffect(() => {
    if (!chatActivity) return;
    void loadPreviews();
    void loadApprovals();
  }, [chatActivity, loadPreviews, loadApprovals]);

  useEffect(() => {
    if (!chatActivity || handledActivity.current === chatActivity) return;
    if (chatActivity.source === 'routine' || chatActivity.source === 'mission') {
      const targetAgentId =
        chatActivity.agentId ?? previews.find((p) => p.id === chatActivity.threadId)?.agent_id;
      // Older events may omit agentId; wait for the refreshed thread list.
      if (!targetAgentId) return;
      if (targetAgentId && (targetAgentId !== activeAgentId || draft !== null)) {
        setUi((current) => {
          const prev = current.flags[targetAgentId] ?? { pinned: false, unread: false, hidden: false, section: null };
          if (prev.unread) return current;
          return {
            ...current,
            flags: { ...current.flags, [targetAgentId]: { ...prev, unread: true } },
          };
        });
      }
    }
    // Switching away after reading must not replay the old unread event.
    handledActivity.current = chatActivity;
  }, [chatActivity, activeAgentId, draft, previews]);

  const agentRoutines = useMemo(
    () => routines.filter((routine) => routine.agent_id === activeAgentId),
    [routines, activeAgentId]
  );

  const agentApprovals = useMemo(
    () => approvals.filter((row) => row.agent_id === activeAgentId),
    [approvals, activeAgentId]
  );

  // ------------------------------------------------------------- mutations --
  const patchProfile = useCallback(
    (agentId: string, patch: Partial<BotProfile>) => {
      const previous = ui.profiles[agentId];
      if (!previous) return;
      const next = { ...previous, ...patch };
      setUi((current) => ({ ...current, profiles: { ...current.profiles, [agentId]: next } }));
      setProfileError(null);
      void saveProfile(agentId, next).catch((cause) => {
        setUi((current) => ({ ...current, profiles: { ...current.profiles, [agentId]: previous } }));
        setProfileError(
          cause instanceof Error ? `Could not save: ${cause.message}` : 'Could not save this change.'
        );
      });
    },
    [ui.profiles]
  );

  const patchFlags = useCallback(
    (agentId: string, patch: Partial<ConversationFlags>) => {
      const previous = ui.flags[agentId] ?? { pinned: false, unread: false, hidden: false, section: null };
      const next = { ...previous, ...patch };
      setUi((current) => ({ ...current, flags: { ...current.flags, [agentId]: next } }));
      void saveFlags(agentId, next).catch(() => {
        setUi((current) => ({ ...current, flags: { ...current.flags, [agentId]: previous } }));
        notify('That sidebar change could not be saved to the daemon.');
      });
    },
    [ui.flags]
  );

  const setReactions = useCallback(
    (agentId: string, reactions: ReactionMap) => {
      const previous = ui.reactions[agentId] ?? {};
      setUi((current) => ({ ...current, reactions: { ...current.reactions, [agentId]: reactions } }));
      void saveReactions(agentId, reactions).catch(() => {
        setUi((current) => ({ ...current, reactions: { ...current.reactions, [agentId]: previous } }));
        notify('That reaction could not be saved to the daemon.');
      });
    },
    [ui.reactions]
  );

  /**
   * Delete a bot, for real.
   *
   * The daemon refuses while a run is QUEUED or RUNNING and answers 409 with
   * the reason; that reason is shown as-is, because "wait for the run" and "the
   * daemon is broken" call for completely different responses.
   */
  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const result = await api.deleteAgent(pendingDelete.id);
      await refreshState();
      await loadPreviews();
      await loadApprovals();
      setUi((current) => {
        const profiles = { ...current.profiles };
        const flags = { ...current.flags };
        const reactions = { ...current.reactions };
        delete profiles[pendingDelete.id];
        delete flags[pendingDelete.id];
        delete reactions[pendingDelete.id];
        return { profiles, flags, reactions };
      });
      if (activeAgentId === pendingDelete.id) setActiveAgentId(null);
      setDetails({ open: true, view: 'details', routineId: null });
      notify(
        `Deleted ${pendingDelete.name}: ${result.threads} conversation(s), ` +
          `${result.messages} message(s), ${result.routines} routine(s), ${result.taskRuns} run(s).`
      );
      setPendingDelete(null);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'The daemon refused the delete.');
    } finally {
      setDeleting(false);
    }
  }

  async function saveAgent(
    id: string,
    patch: {
      name?: string;
      modelId?: string;
      systemPrompt?: string;
      budgetCapUsd?: number;
      connectionId?: string | null;
      routingMode?: 'pinned' | 'auto' | null;
    }
  ) {
    const { agent } = await api.updateAgent(id, patch);
    // The PATCH response already contains the authoritative row. Painting that
    // response directly lets the model browser close immediately instead of
    // blocking on a second full-state request. The background refresh still
    // reconciles any server-side changes outside this row.
    useCortex.setState((state) => ({
      agents: state.agents.map((item) => item.id === agent.id ? agent : item),
    }));
    notify('Bot settings saved.');
    void refreshState().catch(() => undefined);
  }

  async function createBot(input: NewBotInput) {
    await api.createAgent({
      id: input.id,
      name: input.name,
      modelId: input.modelId,
      systemPrompt: input.description,
      budgetCapUsd: input.budgetCapUsd,
      connectionId: input.connectionId,
      routingMode: input.routingMode,
    });
    await refreshState();
    // Write the chosen appearance to the daemon so it is the bot's, not this
    // browser's. Failure is reported rather than leaving a mismatch.
    try {
      await saveProfile(input.id, {
        shape: input.shape,
        color: input.color,
        eyeColor: input.eyeColor,
        eyeScale: 1,
        emotion: input.emotion,
        idle: true,
        sketch: input.sketch,
        label: '',
        notifications: false,
        avatarImage: null,
      });
    } catch {
      setProfileError('The bot was created, but its appearance could not be saved.');
    }
    setActiveAgentId(input.id);
    setCharacterSetupRequest(input.characterSetup&&input.characterSetup!=='off'?{agentId:input.id,text:`Help me set up this bot in ${input.characterSetup} mode. Use propose_character for a quick draft and five unsent previews; show me the approval card before activating anything.`}:undefined);
    setDraft(null);
    setCreatingBot(false);
    setDuplicateBot(undefined);
    notify(`${input.name} is ready.`);
  }

  async function importTemplate(template: MarketplaceBotTemplate) {
    const id = template.id.replace(/[^a-z0-9-]/g, '-').slice(0, 60);
    await createBot({
      id,
      name: template.name,
      ...defaultSelection,
      description: template.content.instructions,
      budgetCapUsd: 10,
      shape: template.shape,
      color: template.color,
      eyeColor: '#FFFFFF',
      emotion: '02',
      sketch: false,
    });
  }

  async function answerApproval(approvalId: string, decision: 'approve' | 'deny', reason?: string) {
    setApprovalBusyId(approvalId);
    try {
      const result = await sendCommand(decision, approvalId, reason ? { reason } : undefined);
      if (result && result.success === false) throw new Error(result.error ?? 'The daemon refused that answer.');
      await loadApprovals();
      if (result?.message) notify(result.message);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'That answer could not be delivered.');
    } finally {
      setApprovalBusyId(null);
    }
  }

  const handleOpenFile = useCallback(
    (file: { path: string; runId?: string | null; content?: string | null; artifactUrl?: string | null }) => {
      setDetails({
        open: true,
        view: 'file',
        routineId: null,
        selectedFile: file,
      });
    },
    []
  );

  async function saveRoutine(routineDraft: RoutineDraft, cron: string) {
    if (!activeAgentId) throw new Error('No bot is selected.');
    const payload = {
      agentId: activeAgentId,
      name: routineDraft.name,
      schedule: cron,
      timezone: routineDraft.timezone || preferences.routineTimezone,
      prompt: routineDraft.instruction,
      taskName: routineDraft.taskName,
      enabled: routineDraft.enabled,
      webhookEnabled: routineDraft.webhookEnabled,
      scheduleEnabled: routineDraft.scheduleEnabled,
    };
    const result = routineDraft.id
      ? await sendCommand('update_routine', routineDraft.id, payload)
      : await sendCommand('create_routine', activeAgentId, payload);
    if (!result?.success) throw new Error(result?.error ?? 'The daemon refused the routine.');
    await refreshRoutines();
    setDetails((current) => ({ ...current, view: 'routine', routineId: result.data?.id ?? routineDraft.id }));
    notify(routineDraft.id ? 'Routine saved.' : 'Routine created.');
  }

  async function deleteRoutine(routineId: string) {
    const result = await sendCommand('delete_routine', routineId);
    if (!result?.success) throw new Error(result?.error ?? 'The daemon refused the delete.');
    await refreshRoutines();
    setDetails({ open: true, view: 'details', routineId: null });
    notify('Routine deleted.');
  }

  async function testRunRoutine(routineId: string) {
    const result = await sendCommand('run_routine_now', routineId);
    if (!result?.success) throw new Error(result?.error ?? 'The daemon refused the run.');
    await refreshRoutines();
    await refreshState();
    notify(result.message ?? 'Run queued.');
  }

  /**
   * Issue, rotate or revoke a routine's webhook token.
   *
   * Rotating replaces the token, which immediately invalidates any URL already
   * handed out - that is the point of offering it.
   */
  async function setRoutineWebhook(routineId: string, enabled: boolean, rotate = false) {
    const result = await sendCommand('update_routine', routineId, {
      webhookEnabled: enabled,
      ...(rotate ? { rotateWebhook: true } : {}),
    });
    if (!result?.success) throw new Error(result?.error ?? 'The daemon refused the change.');
    await refreshRoutines();
    notify(rotate ? 'Webhook URL rotated. The previous URL no longer works.' : enabled ? 'Webhook URL issued.' : 'Webhook URL revoked.');
  }

  async function setRoutineEnabled(routineId: string, enabled: boolean) {
    const result = await sendCommand('update_routine', routineId, { enabled });
    if (!result?.success) throw new Error(result?.error ?? 'The daemon refused the change.');
    await refreshRoutines();
  }

  function handleBotAction(agentId: string, action: BotContextAction) {
    const mate = teammates.find((t) => t.id === agentId);
    if (!mate) return;
    switch (action) {
      case 'pin':
        patchFlags(agentId, { pinned: !mate.flags.pinned });
        break;
      case 'unread':
        patchFlags(agentId, { unread: !mate.flags.unread });
        break;
      case 'hide':
        patchFlags(agentId, { hidden: !mate.flags.hidden });
        break;
      case 'section': {
        const name = window.prompt('Section name (leave blank to remove)', mate.flags.section ?? '');
        if (name === null) return;
        patchFlags(agentId, { section: name.trim() ? name.trim().slice(0, 40) : null });
        break;
      }
      case 'profile':
        setActiveAgentId(agentId);
        setDraft(null);
        setDetails({ open: true, view: 'settings', routineId: null });
        break;
      case 'duplicate':
        setActiveAgentId(agentId);
        setDuplicateBot({ name: `${mate.name} copy`, description: mate.description, modelId: mate.model,
          connectionId: mate.connectionId, routingMode: mate.routingMode, budgetCapUsd: mate.budgetCapUsd,
          shape: mate.profile.shape, color: mate.profile.color, eyeColor: mate.profile.eyeColor, emotion: mate.profile.emotion, sketch: mate.profile.sketch });
        setCreatingBot(true);
        notify(`Duplicating ${mate.name}: adjust the name and create.`);
        break;
      case 'delete':
        setDeleteError('');
        setPendingDelete(mate);
        break;
      case 'copy-id':
        void navigator.clipboard
          .writeText(mate.threadId ?? mate.id)
          .then(() => notify('Conversation ID copied.'))
          .catch(() => notify('This browser blocked clipboard access.'));
        break;
      default:
        break;
    }
  }

  const workspaceActions = useMemo<WorkspaceAction[]>(
    () => [
      {
        id: 'chat-settings',
        title: 'Chat Settings',
        subtitle: 'Current chat',
        run: () => setDetails({ open: true, view: 'settings', routineId: null }),
      },
      { id: 'settings-general', title: 'Settings: General', subtitle: 'Settings', run: () => setSettings('general') },
      { id: 'settings-computer', title: 'Settings: Computer', subtitle: 'Settings', run: () => setSettings('computer') },
      { id: 'settings-usage', title: 'Settings: Usage', subtitle: 'Settings', run: () => setSettings('usage') },
      { id: 'settings-updates', title: 'Settings: Updates', subtitle: 'Settings', run: () => setSettings('updates') },
      { id: 'open-marketplace', title: 'Open Marketplace', subtitle: 'Navigation', run: () => setMarketplaceOpen(true) },
      { id: 'create-routine', title: 'Create Routine', subtitle: 'Current bot', run: () => setDetails({ open: true, view: 'routine', routineId: null }) },
      { id: 'open-cortex', title: 'Open Cortex view', subtitle: 'Navigation', run: onToggleGalaxyView },
    ],
    [onToggleGalaxyView]
  );

  const accent = activeAgent?.profile.color ?? DEFAULT_ACCENT;

  async function openSearchResult(result: SearchResultRow) {
    const request = ++searchNavigation.current;
    if (result.kind === 'link') {
      try {
        const url = new URL(result.title);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe link');
        window.open(url.href, '_blank', 'noopener,noreferrer');
      } catch { notify('This result is not a valid web link.'); }
      return;
    }
    if (!result.agentId) return;
    setActiveAgentId(result.agentId); setDraft(null);
    if (result.kind === 'routine') { setDetails({ open: true, view: 'routine', routineId: result.id }); return; }
    if (result.kind === 'message' && result.threadId) {
      setChatTarget({ agentId: result.agentId, threadId: result.threadId, messageId: result.id.replace(/^msg-/, ''), key: request });
      setDetails(current => ({ ...current, open: false }));
      return;
    }
    if (result.kind === 'file') {
      try {
        const { data } = await api.agentData(result.agentId);
        if (request !== searchNavigation.current) return;
        const record = data.find(row => row.id === result.id);
        if (!record) throw new Error('This saved record no longer exists.');
        // Search's file category contains saved agent-data records, not live
        // container paths. Display the actual record read-only as JSON.
        handleOpenFile({ path: `${record.key}.json`, content: JSON.stringify(JSON.parse(record.data_json), null, 2) });
      } catch (error) { if (request === searchNavigation.current) notify(error instanceof Error ? error.message : 'Could not open this record.'); }
    }
  }

  if (creatingBot) {
    return (
      <GrokNewBotScreen
        onGetStarted={createBot}
        onBackToExisting={() => { setCreatingBot(false); setDuplicateBot(undefined); }}
        hasExistingAgents={teammates.length > 0}
        defaultSelection={defaultSelection}
        initialBot={duplicateBot}
        existingIds={agents.map((agent) => agent.id)}
      />
    );
  }

  return (
    <div
      className={`grok-workspace-container ${mobileNavOpen ? 'oh-nav-open' : ''}`}
      // The open bot's colour is the workspace accent: the composer's edge
      // light, the send button and the ambient glows all read it, so moving to
      // another bot visibly moves you into its room.
      style={{ '--oh-bot': accent, '--oh-bot-ink': inkOn(accent) } as CSSProperties}
    >
      <button type="button" className="oh-mobile-nav-toggle" aria-label="Toggle workspace navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(open => !open)}><Icon name="menu" /></button>
      <div className={`grok-workspace-window ${details.open && activeAgent ? '' : 'panel-closed'}`}>
        <GrokSidebar
          teammates={teammates}
          activeAgentId={draft ? null : activeAgentId}
          draft={draft}
          connection={connection}
          accountName={preferences.accountName}
          updateAvailable={false}
          computerBanner={
            dockerBanner(docker) ?? (computer.state === 'unreachable'
              ? {
                  message: 'Task workspace unavailable',
                  hint: computer.reason ?? undefined,
                  onRetry: computer.retry,
                  retrying: computer.retrying,
                }
              : providerSetup.needed
                ? {
                    message: 'Connect a model provider',
                    hint: 'Your bots need a model provider to answer. Add one in Settings, Providers.',
                    actionLabel: 'Set up',
                    busyLabel: 'Opening…',
                    onRetry: () => setSettings('providers'),
                    retrying: false,
                  }
                : null)
          }
          onSelectAgent={(id) => {
            searchNavigation.current++; setChatTarget(undefined);
            setMobileNavOpen(false);
            setActiveAgentId(id);
            setDraft(null);
            if (ui.flags[id]?.unread) patchFlags(id, { unread: false });
          }}
          onOpenSearch={() => setSearchOpen(true)}
          onNewChat={() => {
            // With a single bot there is nobody to choose: go straight to its
            // conversation instead of a picker listing one name.
            if (agents.length === 1) {
              setMobileNavOpen(false);
              setDraft(null);
              setActiveAgentId(agents[0].id);
              window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.grok-chat-footer textarea:not([disabled])')?.focus(), 0);
              return;
            }
            setDraft({ kind: 'direct', recipients: [] });
            setActiveAgentId(null);
          }}
          onSelectDraft={() => setActiveAgentId(null)}
          onOpenMarketplace={() => setMarketplaceOpen(true)}
          onOpenAccountMenu={(anchor) => setAccountAnchor(anchor)}
          onBotAction={handleBotAction}
          onCreateBot={() => setCreatingBot(true)}
          onOpenCortex={onToggleGalaxyView}
          onOpenSettings={() => setSettings('general')}
        />

        <GrokChat
          initialCompose={characterSetupRequest}
          navigationTarget={chatTarget?.agentId === activeAgent?.id ? chatTarget : undefined}
          activeAgent={draft ? null : activeAgent}
          draft={draft}
          teammates={teammates}
          approvals={agentApprovals}
          approvalBusyId={approvalBusyId}
          onAnswerApproval={(id, decision, reason) => void answerApproval(id, decision, reason)}
          onOpenDetails={() => setDetails({ open: true, view: 'details', routineId: null })}
          onOpenSettings={() => setDetails({ open: true, view: 'settings', routineId: null })}
          onToggleDetails={() => setDetails((current) => ({ ...current, open: !current.open }))}
          isDetailsOpen={details.open}
          onCancelDraft={() => {
            setDraft(null);
            setActiveAgentId(agents[0]?.id ?? null);
          }}
          onDraftKindChange={(kind) => setDraft({ kind, recipients: [] })}
          onDraftRecipient={(id) => {
            setDraft((current) => {
              if (!current) return current;
              if (current.kind === 'group') {
                const recipients = current.recipients.includes(id)
                  ? current.recipients.filter((r) => r !== id)
                  : [...current.recipients, id];
                return { ...current, recipients };
              }
              // A direct draft resolves the moment a recipient is chosen: the
              // conversation already exists, so there is nothing to create.
              setActiveAgentId(id);
              return null;
            });
          }}
          onCreateBot={() => setCreatingBot(true)}
          onReactionsChange={setReactions}
          onThreadActivity={() => void loadPreviews()}
          onShareAsTemplate={() => setTemplateOpen(true)}
          onNotify={notify}
          onSaveModel={(selection) => saveAgent(activeAgent!.id, selection)}
          onOpenFile={handleOpenFile}
        />

        {details.open && activeAgent && !draft && (
          <GrokScreen
            agent={activeAgent}
            details={details}
            computer={computer}
            routines={agentRoutines}
            routinesError={routinesError}
            routinesLoading={routinesLoading}
            profileError={profileError}
            codeTheme={preferences.codeTheme ?? 'openhours'}
            onOpenStudio={() => setStudioOpen(true)}
            onClose={() => setDetails((current) => ({ ...current, open: false }))}
            onSetView={(view, routineId) =>
              setDetails({ open: true, view, routineId: routineId ?? null })
            }
            onUpdateProfile={(patch) => patchProfile(activeAgent.id, patch)}
            onSaveAgent={(patch) => saveAgent(activeAgent.id, patch)}
            onSaveRoutine={saveRoutine}
            onDeleteRoutine={deleteRoutine}
            onTestRunRoutine={testRunRoutine}
            onSetRoutineEnabled={setRoutineEnabled}
            onSetRoutineWebhook={setRoutineWebhook}
            onOpenFile={handleOpenFile}
          />
        )}
      </div>

      {!teammates.length && uiLoaded && !draft && (
        <div className="grok-first-run" role="status">
          <h1>{connection === 'closed' ? 'The OpenAgents daemon is offline' : 'No bots configured'}</h1>
          <p>
            {connection === 'closed'
              ? 'Start the daemon to load your fleet and conversations.'
              : 'Create a bot to start a durable OpenAgents conversation.'}
          </p>
          <Button kind="primary" onClick={() => setCreatingBot(true)}>
            Create bot
          </Button>
          <Button kind="secondary" onClick={onToggleGalaxyView}>
            Open Cortex view
          </Button>
        </div>
      )}

      {studioOpen && activeAgent && <AvatarStudio key={activeAgent.id} name={activeAgent.name} profile={activeAgent.profile} onClose={() => setStudioOpen(false)} onSave={async profile => {
        await saveProfile(activeAgent.id, profile);
        setUi(current => ({ ...current, profiles: { ...current.profiles, [activeAgent.id]: profile } }));
        notify('Identity saved across your workspace.');
      }} />}

      {accountAnchor && (
        <Popover
          anchorRef={accountAnchorRef}
          placement="top-start"
          label="Account"
          width={224}
          onClose={() => setAccountAnchor(null)}
        >
          <p className="grok-menu-empty">
            No account: the daemon runs locally under your own credentials.
          </p>
          <MenuSeparator />
          {/* Settings and Cortex are deliberately NOT repeated here: each has
              its own button in the sidebar, one step away from this menu.
              Usage is the one account-level destination without one. */}
          <MenuItem
            icon={<Icon name="usage" />}
            onSelect={() => {
              setSettings('usage');
              setAccountAnchor(null);
            }}
          >
            Usage and costs
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Icon name="update" />} disabled title="OpenAgents has no updater. Pull the repository and restart.">
            Check for updates
          </MenuItem>
          <MenuItem icon={<Icon name="mobile" />} disabled title="There is no mobile build.">
            Get OpenAgents for mobile
          </MenuItem>
        </Popover>
      )}

      {marketplaceOpen && (
        <GrokMarketplaceModal
          onClose={() => setMarketplaceOpen(false)}
          onImportBot={importTemplate}
          existingBotIds={agents.map((agent) => agent.id)}
        />
      )}

      {searchOpen && (
        <GrokSearchDialog
          teammates={teammates}
          actions={workspaceActions}
          onClose={() => setSearchOpen(false)}
          onOpenResult={result => void openSearchResult(result)}
        />
      )}

      {settings && (
        <GrokSettingsModal
          section={settings}
          onSection={setSettings}
          onClose={() => {
            setSettings(null);
            // A provider may have just been added; the banner should go at once.
            providerSetup.refresh();
          }}
          theme={preferences.theme}
          onTheme={(theme) => setPreferences((current) => ({ ...current, theme }))}
          codeTheme={preferences.codeTheme ?? 'openhours'}
          onCodeTheme={(codeTheme) => setPreferences((current) => ({ ...current, codeTheme }))}
          accountName={preferences.accountName}
          onAccountName={(accountName) => setPreferences((current) => ({ ...current, accountName }))}
          routineTimezone={preferences.routineTimezone}
          onRoutineTimezone={(routineTimezone) =>
            setPreferences((current) => ({ ...current, routineTimezone }))
          }
          executor={executor}
          connection={connection}
          sandboxReason={computer.state === 'unreachable' ? computer.reason : null}
        />
      )}

      {templateOpen && activeAgent && (
        <GrokTemplateDialog
          agent={activeAgent}
          authorName={preferences.accountName}
          onClose={() => setTemplateOpen(false)}
        />
      )}

      {pendingDelete && (
        <Modal
          label={`Delete ${pendingDelete.name}`}
          className="grok-confirm-dialog"
          onClose={() => (deleting ? undefined : setPendingDelete(null))}
        >
          <h2>Delete {pendingDelete.name}?</h2>
          <p>
            This removes the bot’s conversations, messages, routines, run history
            and saved app data. It cannot be undone from here. Its desktop is
            stopped and its files and Chrome profile are retained separately;
            a new bot will not inherit them.
          </p>
          <p className="grok-field-hint">
            The bot may also be defined in openhours.config.json. If it is, it
            will be recreated the next time the daemon boots — remove it there
            too to keep it gone.
          </p>
          {deleteError && (
            <FormError>
              {deleteError}
            </FormError>
          )}
          <div className="grok-confirm-actions">
            <Button kind="secondary" disabled={deleting} onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <button
              type="button"
              className="grok-danger-btn"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? 'Deleting…' : `Delete ${pendingDelete.name}`}
            </button>
          </div>
        </Modal>
      )}

      {/* One layer for the whole workspace: it upgrades every `title` in the
          tree, including ones added later. See TooltipLayer. */}
      <TooltipLayer />

      {/* Coss Toast, on Base UI. The plain <div> it replaces announced itself
          once via role="status" and then sat there: two notices in a row
          overwrote each other, nothing timed out, and a screen reader heard the
          second only if the text differed from the first. This one stacks,
          expires, pauses on hover and is dismissible by keyboard. */}
      <ToastProvider position="bottom-center" />
    </div>
  );
}
