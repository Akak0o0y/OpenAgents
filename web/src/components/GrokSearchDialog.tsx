/**
 * Cross-content search.
 *
 * A centred command dialog, not a sidebar filter. Bots, messages, routines and
 * files come from `GET /api/search` on the daemon; Actions are navigation
 * targets in this app and are matched locally, because they are not data the
 * daemon has.
 *
 * Every query is debounced and the previous request is ABORTED. Without that,
 * a slow response for "de" can land after the fast one for "deploy" and leave
 * the operator staring at results for a query they no longer have typed.
 *
 * A tab whose kind the daemon cannot search says so - "Groups" is not an empty
 * list, it is a category this runtime does not have.
 */

import { useEffect, useMemo, useState } from 'react';
import { BotFace } from './BotFace.js';
import { Modal } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { api, type SearchKind, type SearchResultRow } from '../lib/transport.js';
import type { Teammate } from './workspaceTypes.js';
import { Tabs, TabsList, TabsTab } from '@/registry/default/ui/tabs.js';
import { Skeleton } from '@/registry/default/ui/skeleton.js';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/registry/default/ui/command.js';

export type SearchTab = 'all' | SearchKind;

const TABS: Array<{ id: SearchTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'message', label: 'Messages' },
  { id: 'bot', label: 'Bots' },
  { id: 'group', label: 'Groups' },
  { id: 'file', label: 'Files' },
  { id: 'link', label: 'Links' },
  { id: 'routine', label: 'Routines' },
  { id: 'action', label: 'Actions' },
];

const KIND_LABELS: Record<SearchKind, string> = {
  bot: 'Bot',
  message: 'Message',
  routine: 'Routine',
  file: 'File',
  link: 'Link',
  group: 'Group',
  action: 'Action',
};

export interface WorkspaceAction {
  id: string;
  title: string;
  subtitle: string;
  run: () => void;
}

interface GrokSearchDialogProps {
  teammates: Teammate[];
  actions: WorkspaceAction[];
  onClose: () => void;
  onOpenResult: (result: SearchResultRow) => void;
}

export function GrokSearchDialog({ teammates, actions, onClose, onOpenResult }: GrokSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('all');
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [unsupported, setUnsupported] = useState<Array<{ kind: SearchKind; reason: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const matchingActions = useMemo<SearchResultRow[]>(() => {
    const needle = query.trim().toLowerCase();
    return actions
      .filter((action) => !needle || action.title.toLowerCase().includes(needle))
      .map((action) => ({
        kind: 'action' as const,
        id: action.id,
        title: action.title,
        subtitle: action.subtitle,
      }));
  }, [actions, query]);

  useEffect(() => {
    const controller = new AbortController();
    const kinds: SearchKind[] | undefined =
      tab === 'all' ? undefined : tab === 'action' ? [] : [tab];

    if (tab === 'action') {
      setResults([]);
      setUnsupported([]);
      setLoading(false);
      setError('');
      return () => controller.abort();
    }

    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      api
        .search(query, kinds, 20, controller.signal)
        .then((body) => {
          setResults(body.results);
          setUnsupported(body.unsupported);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setError(cause instanceof Error ? cause.message : 'Search failed.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
      // A short debounce: long enough to skip a keystroke, short enough that
      // the dialog never feels like it is thinking.
    }, 160);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, tab]);

  const combined = useMemo(() => {
    if (tab === 'action') return matchingActions;
    if (tab === 'all') return [...results, ...matchingActions];
    return results;
  }, [results, matchingActions, tab]);

  function activate(result: SearchResultRow) {
    if (result.kind === 'action') {
      actions.find((action) => action.id === result.id)?.run();
      onClose();
      return;
    }
    onOpenResult(result);
    onClose();
  }

  const tabUnsupported = tab !== 'all' && tab !== 'action'
    ? unsupported.find((entry) => entry.kind === tab)
    : undefined;

  return (
    <Modal
      label="Search"
      className="grok-search-dialog"
      onClose={onClose}
      // The field is Coss's CommandInput now, which is a combobox
      // rather than `type="search"` - the old selector matched nothing and the
      // dialog opened with focus on its container instead of the field.
      initialFocusSelector="[role=combobox], input"
    >
      {/* Coss Command, on Base UI's Autocomplete.

          WHAT IT REPLACES: a `<input type=search>` next to a `role="listbox"`
          div, with the highlight tracked in a `cursor` number and ArrowUp,
          ArrowDown and Enter handled by hand. That worked, but the input and
          the list were not connected to each other in any way a screen reader
          could see - no `role="combobox"`, no `aria-activedescendant` - so the
          highlighted row was visible and unannounced.

          `filteredItems` is the important prop: results here come from the
          daemon's search endpoint, so Autocomplete must NOT filter them again
          against the query. Given `filteredItems` it renders what it is handed
          and confines itself to the highlight and the keyboard. */}
      <Command
        filteredItems={combined}
        items={combined}
        value={query}
        onValueChange={(next) => setQuery(next)}
      >
        <div className="grok-search-field">
          <Icon name="search" />
          <CommandInput placeholder="Search" aria-label="Search bots, messages and routines" />
        </div>

        {/* Coss Tabs, on Base UI.
          What this replaces declared role="tablist" and role="tab" but handled
          no keyboard at all - so a screen reader announced "tab, 1 of 8" and
          then Left and Right did nothing. A partial ARIA implementation is
          worse than none: it promises an interaction that is not there. Base UI
          supplies the roving focus, the arrow keys, Home/End and the
          aria-controls wiring. */}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as SearchTab)}
        className="grok-search-tabs"
      >
        <TabsList aria-label="Result type">
          {TABS.map((entry) => (
            <TabsTab key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>

      <CommandList className="grok-search-results" aria-label="Search results">
        {loading && (
          <div className="grok-search-skeletons" aria-label="Searching" role="status">
            {[0, 1, 2, 3, 4].map((row) => (
              // Coss Skeleton. The shimmer this replaces was hand-built from a
              // ::after sweep in theme.css; Coss draws the same effect with a
              // moving gradient, and the two ragged widths stay because a
              // placeholder row of uniform width reads as a loading BAR rather
              // than as text that has not arrived.
              <div className="grok-skeleton-row" key={row}>
                <Skeleton className="grok-skeleton-avatar" />
                <span className="grok-skeleton-lines">
                  <Skeleton style={{ width: `${55 + ((row * 13) % 35)}%` }} />
                  <Skeleton style={{ width: `${35 + ((row * 17) % 25)}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <p className="grok-search-message" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && tabUnsupported && (
          <p className="grok-search-message">{tabUnsupported.reason}</p>
        )}

        {!loading && !error && !tabUnsupported && combined.length === 0 && (
          <p className="grok-search-message">No results</p>
        )}

        {!loading &&
          !error &&
          combined.map((result, index) => {
            const mate = result.agentId ? teammates.find((t) => t.id === result.agentId) : undefined;
            return (
              <CommandItem
                key={`${result.kind}-${result.id}`}
                index={index}
                value={result}
                className="grok-search-row"
                // Fires for a pointer click AND for Enter on the highlighted
                // row, which is why the keydown handler above could go.
                onClick={() => activate(result)}
              >
                <span className="grok-search-row-icon">
                  {mate ? (
                    <BotFace
                      size={22}
                      shape={mate.profile.shape}
                      color={mate.profile.color}
                      eyeColor={mate.profile.eyeColor}
                      image={mate.profile.avatarImage}
                      idle={false}
                    />
                  ) : (
                    <span className="grok-search-glyph" aria-hidden="true">
                      <Icon
                        name={
                          result.kind === 'routine'
                            ? 'schedule'
                            : result.kind === 'link'
                              ? 'link'
                              : result.kind === 'file'
                                ? 'file'
                                : 'settings'
                        }
                      />
                    </span>
                  )}
                </span>
                <span className="grok-search-row-text">
                  <span className="grok-search-row-title">{result.title}</span>
                  {result.subtitle && <span className="grok-search-row-sub">{result.subtitle}</span>}
                </span>
                <span className="grok-search-row-kind">{KIND_LABELS[result.kind]}</span>
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </Modal>
  );
}
