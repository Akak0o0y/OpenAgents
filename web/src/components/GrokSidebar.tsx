/**
 * The bot list.
 *
 * Fixed width, always present, and the only navigation in the workspace. Two
 * things here are deliberate departures from what the previous version did:
 *
 *  - The search field OPENS THE SEARCH DIALOG rather than filtering this list.
 *    Filtering in place could only ever find bots; the dialog searches messages
 *    and routines too, on the daemon, which is where that data actually lives.
 *  - The snippet under each name is the bot's real last message, fetched for
 *    the whole fleet in one request. It is not the bot's role text dressed up
 *    as conversation.
 *
 * ONE CONTROL PER ACTION. The previous header carried a "+" beside a "New
 * conversation" button that did the same thing, and Settings and Cortex were
 * each reachable from two places in the same column. Every destination now has
 * exactly one entry point here: New conversation, Search, Cortex, Marketplace,
 * Create bot beside the list it adds to, and Settings beside the account it
 * belongs to. Usage lives in the account menu (see GrokWorkspace).
 *
 * THE SELECTION MOVES. The active row's highlight is one element shared by
 * `layoutId`, so choosing another bot slides it there on a spring instead of
 * blinking one row off and another on. It is tinted with the bot's own colour,
 * and the active avatar gets an orbit ring in that colour - the list shows
 * whose conversation is open, not just which row.
 */

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { LayoutGroup, MotionConfig, motion } from 'framer-motion';
import { BotFace } from './BotFace.js';
import { MenuItem, MenuSeparator, Popover } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { relativeDayLabel, type ChatDraft, type Teammate } from './workspaceTypes.js';
import { previewText } from '../lib/plainText.js';
import { IconButton } from './ui/Button.js';
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from '@/registry/default/ui/sidebar.js';

export type { AoraShape } from '../lib/aora-bot/shapes.js';

export interface ComputerBanner {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  /** The button's label when it does something other than retry, e.g. "Start Docker". */
  actionLabel?: string;
  busyLabel?: string;
  /** The full sentence, naming the fix, for a banner whose message is short. */
  hint?: string;
}

interface GrokSidebarProps {
  teammates: Teammate[];
  activeAgentId: string | null;
  draft: ChatDraft | null;
  connection: 'connecting' | 'open' | 'closed';
  accountName: string;
  computerBanner: ComputerBanner | null;
  updateAvailable: boolean;
  onSelectAgent: (agentId: string) => void;
  onOpenSearch: () => void;
  onNewChat: () => void;
  onSelectDraft: () => void;
  onOpenMarketplace: () => void;
  onOpenAccountMenu: (anchor: HTMLElement) => void;
  onBotAction: (agentId: string, action: BotContextAction) => void;
  onCreateBot?: () => void;
  onOpenCortex?: () => void;
  onOpenSettings?: () => void;
}

export type BotContextAction =
  | 'pin'
  | 'section'
  | 'unread'
  | 'profile'
  | 'duplicate'
  | 'copy-id'
  | 'hide'
  | 'delete';

/** Firm enough to feel physical, damped enough not to wobble past the row. */
const HIGHLIGHT_SPRING = { type: 'spring', stiffness: 520, damping: 42, mass: 0.9 } as const;

/**
 * Feeds the hover spotlight: the pointer's position inside the row, as CSS
 * variables the row's ::before gradient is centred on. Written straight to the
 * element's style so a pointer move costs no React render.
 */
function trackPointer(event: PointerEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

export function GrokSidebar({
  teammates,
  activeAgentId,
  draft,
  connection,
  accountName,
  computerBanner,
  updateAvailable,
  onSelectAgent,
  onOpenSearch,
  onNewChat,
  onSelectDraft,
  onOpenMarketplace,
  onOpenAccountMenu,
  onBotAction,
  onCreateBot,
  onOpenCortex,
  onOpenSettings,
}: GrokSidebarProps) {
  const [menu, setMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);
  const accountRef = useRef<HTMLButtonElement>(null);

  /** Pinned first, then most-recent conversation. Hidden rows drop out. */
  const sections = useMemo(() => {
    const visible = teammates.filter((t) => !t.flags.hidden);
    const ordered = [...visible].sort((a, b) => {
      if (a.flags.pinned !== b.flags.pinned) return a.flags.pinned ? -1 : 1;
      return (b.lastMessageAt ?? b.updatedAt ?? 0) - (a.lastMessageAt ?? a.updatedAt ?? 0);
    });
    const grouped = new Map<string, Teammate[]>();
    for (const mate of ordered) {
      const key = mate.flags.section ?? '';
      const list = grouped.get(key) ?? [];
      list.push(mate);
      grouped.set(key, list);
    }
    // The unsectioned group always leads; named sections follow alphabetically.
    return [...grouped.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [teammates]);

  const hiddenCount = teammates.filter((t) => t.flags.hidden).length;
  const menuTarget = menu ? teammates.find((t) => t.id === menu.agentId) ?? null : null;
  const connectionLabel =
    connection === 'open' ? 'Daemon connected' : connection === 'connecting' ? 'Connecting' : 'Daemon offline';

  return (
    <aside className="grok-sidebar" aria-label="Bots">
      {/* Coss Sidebar, on the parts of it that fit.
          SidebarHeader / SidebarContent / SidebarFooter carry the regions,
          SidebarGroup and SidebarGroupLabel the sections, and SidebarMenu /
          SidebarMenuItem the list semantics - a real <ul>/<li> where this was
          a stack of divs.

          NOT SidebarMenuButton, and this is a deliberate omission rather than
          an oversight. It is built for single-line navigation links: `h-8`, one
          icon, and `[&>span:last-child]:truncate`. A row here is a 34px bot
          face beside two lines - name with a timestamp, then a message preview
          with an unread dot. Forcing that into it would mean overriding the
          height, the truncation and the grid, which is the point at which you
          are fighting a component rather than using it. The row below stays
          this app's own.

          NOT SidebarProvider either: its wrapper is `flex min-h-svh w-full`,
          which would break the workspace grid this <aside> sits in, and it
          binds Ctrl/Cmd+B to a collapse this app does not have. */}
      {/* `flex-row items-center justify-between` is passed rather than set in
          CSS on purpose: SidebarHeader is `flex flex-col`, those utilities live
          in Tailwind's `utilities` layer, and a rule in the `app` layer cannot
          beat them whatever its specificity. Coss merges className through
          `cn()` (tailwind-merge), which DROPS the conflicting `flex-col` - so
          this is the supported way to override it. Without it the heading and
          the brand dot stacked vertically. */}
      <SidebarHeader className="grok-sidebar-header flex-row items-center justify-between">
        <span className="oh-wordmark">
          <span className="oh-brand-mark" aria-hidden="true">
            <img src="/openhours-icon.png" width={32} height={32} alt="" />
          </span>
          OpenAgents
          <span className={`oh-brand-dot ${connection}`} title={connectionLabel} />
        </span>
      </SidebarHeader>

      <div className="oh-sidebar-primary">
        <button type="button" className="oh-new-chat" onClick={onNewChat}>
          <span className="oh-new-chat-glyph" aria-hidden="true">
            <Icon name="add" size={15} />
          </span>
          <span className="oh-new-chat-label">New conversation</span>
        </button>

        <button type="button" className="grok-search-box" onClick={onOpenSearch} aria-haspopup="dialog">
          <span className="grok-search-icon" aria-hidden="true"><Icon name="search" /></span>
          <span className="grok-search-placeholder">Search workspace</span>
          <kbd>{navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>
      </div>

      <nav className="oh-workspace-nav" aria-label="Workspace">
        {onOpenCortex && (
          <button type="button" onClick={onOpenCortex}>
            <Icon name="cortex" />
            <span>Cortex</span>
            <Icon name="forward" size={13} className="oh-nav-arrow" motion={false} />
          </button>
        )}
        <button type="button" onClick={onOpenMarketplace}>
          <Icon name="marketplace" />
          <span>Marketplace</span>
          <Icon name="forward" size={13} className="oh-nav-arrow" motion={false} />
        </button>
      </nav>

      {computerBanner && (
        <div className="grok-computer-banner" role="status" title={computerBanner.hint}>
          <span>{computerBanner.message}</span>
          <button type="button" onClick={computerBanner.onRetry} disabled={computerBanner.retrying}>
            {computerBanner.retrying ? (computerBanner.busyLabel ?? 'Retrying…') : (computerBanner.actionLabel ?? 'Retry')}
          </button>
        </div>
      )}

      <div className="oh-section-label">
        <span>YOUR BOTS</span>
        <span className="oh-count">{teammates.length}</span>
        {onCreateBot && (
          <button type="button" aria-label="Create bot" title="Create bot" onClick={onCreateBot}>
            <Icon name="add" size={14} />
          </button>
        )}
      </div>
      <SidebarContent className="grok-agent-list" aria-label="Conversations">
        {/* `reducedMotion="user"` makes the sliding highlight jump instead of
            travel when the operator has asked for less motion - the same rule
            the stylesheet applies to every CSS animation in the workspace. */}
        <MotionConfig reducedMotion="user">
          <LayoutGroup id="oh-sidebar-rows">
            {draft && (
              <button
                type="button"
                className={`grok-agent-row grok-draft-row ${activeAgentId === null ? 'active' : ''}`}
                onClick={onSelectDraft}
                onPointerMove={trackPointer}
                aria-current={activeAgentId === null ? 'page' : undefined}
              >
                {activeAgentId === null && (
                  <motion.span layoutId="oh-row-highlight" className="oh-row-highlight" aria-hidden="true" transition={HIGHLIGHT_SPRING} />
                )}
                <span className="grok-draft-avatar" aria-hidden="true"><Icon name="add" size={15} motion={false} /></span>
                <span className="grok-agent-text">
                  <span className="grok-agent-topline">
                    <span className="grok-agent-name">
                      {draft.kind === 'group' ? 'New group chat' : 'New chat'}
                    </span>
                  </span>
                  <span className="grok-agent-subline">
                    <span className="grok-agent-snippet">Pick a bot to start</span>
                  </span>
                </span>
              </button>
            )}

            {sections.map(([section, rows]) => (
              <SidebarGroup key={section || '__none'} className="grok-agent-section">
                {section && (
                  <SidebarGroupLabel className="grok-agent-section-title">{section}</SidebarGroupLabel>
                )}
                <SidebarMenu>
                  {rows.map((mate, index) => {
                    const active = mate.id === activeAgentId;
                    const busy = mate.status === 'BUSY';
                    return (
                      <SidebarMenuItem key={mate.id}>
                        <button
                          type="button"
                          className={`grok-agent-row ${active ? 'active' : ''}`}
                          data-busy={busy || undefined}
                          // Each row carries its own bot's colour and its place
                          // in the entrance stagger; the stylesheet reads both.
                          style={{ '--row-color': mate.profile.color, '--i': Math.min(index, 12) } as CSSProperties}
                          onClick={() => onSelectAgent(mate.id)}
                          onPointerMove={trackPointer}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setMenu({ agentId: mate.id, x: event.clientX, y: event.clientY });
                          }}
                          onKeyDown={(event) => {
                            // Keyboard route to the same menu: the pointer-only
                            // right-click would otherwise be the only way in.
                            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                              event.preventDefault();
                              const rect = (event.target as HTMLElement).getBoundingClientRect();
                              setMenu({ agentId: mate.id, x: rect.left + 24, y: rect.bottom - 8 });
                            }
                          }}
                          aria-current={active ? 'page' : undefined}
                          aria-haspopup="menu"
                        >
                          {active && (
                            <motion.span layoutId="oh-row-highlight" className="oh-row-highlight" aria-hidden="true" transition={HIGHLIGHT_SPRING} />
                          )}
                          <span className="grok-agent-avatar-wrap">
                            <span className="oh-avatar-orbit" aria-hidden="true" />
                            <BotFace
                              size={34}
                              shape={mate.profile.shape}
                              color={mate.profile.color}
                              eyeColor={mate.profile.eyeColor}
                              eyeScale={mate.profile.eyeScale}
                              image={mate.profile.avatarImage}
                              emotion={active ? mate.profile.emotion : undefined}
                              status={mate.status}
                              idle={mate.profile.idle}
                              sketch={mate.profile.sketch}
                            />
                          </span>
                          <span className="grok-agent-text">
                            <span className="grok-agent-topline">
                              <span className="grok-agent-name">
                                {mate.flags.pinned && (
                                  <span className="grok-pin-mark" title="Pinned" aria-label="Pinned">
                                    <Icon name="pin" size={11} />
                                  </span>
                                )}
                                {mate.name}
                              </span>
                              <span className="grok-agent-time">
                                {relativeDayLabel(mate.lastMessageAt ?? mate.updatedAt)}
                              </span>
                            </span>
                            <span className="grok-agent-subline">
                              <span className="grok-agent-snippet">
                                {previewText(mate.lastMessagePreview) || (busy ? 'Working…' : 'No messages yet')}
                              </span>
                              {mate.flags.unread ? (
                                <span className="grok-unread-dot" aria-label="Unread" />
                              ) : busy ? (
                                <span className="oh-busy-dots" aria-label="Working"><i /><i /><i /></span>
                              ) : null}
                            </span>
                          </span>
                        </button>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </LayoutGroup>
        </MotionConfig>

        {!teammates.length && (
          <div className="grok-sidebar-empty">
            {connection === 'closed'
              ? 'The daemon is offline, so no conversations can be listed.'
              : 'No bots yet. Use + to start one.'}
          </div>
        )}
        {!!teammates.length && !sections.some(([, rows]) => rows.length) && (
          <div className="grok-sidebar-empty">
            Every bot is hidden from the sidebar. Unhide one from search.
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="grok-sidebar-note">
            {hiddenCount} hidden from this list. They still exist and still run.
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="grok-sidebar-footer">
        <div className="grok-user-profile">
          <button
            ref={accountRef}
            type="button"
            className="grok-user-button"
            onClick={() => accountRef.current && onOpenAccountMenu(accountRef.current)}
            aria-haspopup="menu"
          >
            <span className="grok-user-avatar" aria-hidden="true">
              {accountName.slice(0, 1).toUpperCase()}
            </span>
            <span className="grok-user-info">
              <span className="grok-user-name">{accountName}</span>
              <span className="grok-user-status">
                <i className={`grok-connection-dot ${connection}`} />
                {connectionLabel}
              </span>
            </span>
          </button>
          {updateAvailable && (
            <span className="grok-update-badge" title="An update is available" aria-label="Update available">
              <Icon name="update" />
            </span>
          )}
          {onOpenSettings && (
            <IconButton className="oh-footer-settings" onClick={onOpenSettings} aria-label="Settings" title="Settings">
              <Icon name="settings" />
            </IconButton>
          )}
        </div>
      </SidebarFooter>

      {menu && menuTarget && (
        <Popover
          point={{ x: menu.x, y: menu.y }}
          placement="point"
          label={`Actions for ${menuTarget.name}`}
          width={200}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            icon={<Icon name="pin" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'pin');
              setMenu(null);
            }}
          >
            {menuTarget.flags.pinned ? 'Unpin' : 'Pin'}
          </MenuItem>
          <MenuItem
            icon={<Icon name="section" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'section');
              setMenu(null);
            }}
          >
            {menuTarget.flags.section ? 'Change section' : 'Move to new section'}
          </MenuItem>
          <MenuItem
            icon={<Icon name="unread" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'unread');
              setMenu(null);
            }}
          >
            {menuTarget.flags.unread ? 'Mark as Read' : 'Mark as Unread'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Icon name="rename" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'profile');
              setMenu(null);
            }}
          >
            Edit Profile
          </MenuItem>
          <MenuItem
            icon={<Icon name="copy" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'duplicate');
              setMenu(null);
            }}
          >
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Icon name="copy" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'copy-id');
              setMenu(null);
            }}
          >
            Copy conversation ID
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Icon name="hide" />}
            onSelect={() => {
              onBotAction(menu.agentId, 'hide');
              setMenu(null);
            }}
          >
            {menuTarget.flags.hidden ? 'Show in sidebar' : 'Hide from sidebar'}
          </MenuItem>
          <MenuItem
            icon={<Icon name="remove" />}
            danger
            title={`Delete ${menuTarget.name} and every conversation, routine and run belonging to it`}
            onSelect={() => {
              onBotAction(menu.agentId, 'delete');
              setMenu(null);
            }}
          >
            Delete
          </MenuItem>
        </Popover>
      )}
    </aside>
  );
}
