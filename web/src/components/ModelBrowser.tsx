import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { Button, IconButton } from './ui/Button.js';
import type { ProviderConnectionRow } from '../lib/transport.js';
import { modelSelectionError, type ModelSelection } from './GrokModelSelector.js';

const MODEL_PAGE_SIZE = 60;

/** Browse the gateway's actual catalog. Selection is committed only on Apply. */
export function ModelBrowser({ value, connections, onChange, onClose, catalogError, loading = false }: {
  value: ModelSelection;
  connections: ProviderConnectionRow[];
  onChange: (value: ModelSelection) => void | Promise<void>;
  onClose: () => void;
  catalogError?: string;
  loading?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [draft, setDraft] = useState(value);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'tools' | 'vision'>('all');
  const [visibleLimit, setVisibleLimit] = useState(MODEL_PAGE_SIZE);
  const dismissed = useRef(false);
  useEffect(() => setVisibleLimit(MODEL_PAGE_SIZE), [query, filter]);
  const connection = connections.find(item => item.id === draft.connectionId);
  const model = connection?.catalog.models.find(item => item.id === draft.modelId);
  const entries = useMemo(() => connections.filter(item => item.enabled).map(provider => ({
    provider,
    models: provider.catalog.models.filter(item =>
      `${provider.name} ${item.id}`.toLowerCase().includes(query.toLowerCase().trim()) &&
      (filter === 'all' || (filter === 'ready' && item.usable === true) ||
        (filter === 'tools' && item.supportsTools === true) || (filter === 'vision' && item.supportsVision === true))),
  })).filter(item => item.models.length), [connections, query, filter]);
  const visibleEntries = useMemo(() => {
    let remaining = visibleLimit;
    return entries.map(entry => {
      const models = entry.models.slice(0, Math.max(0, remaining));
      remaining -= models.length;
      // Keep the current choice visible even when it sits below the first page.
      const selected = entry.provider.id === draft.connectionId
        ? entry.models.find(item => item.id === draft.modelId)
        : undefined;
      if (selected && !models.includes(selected)) models.push(selected);
      return { ...entry, models };
    }).filter(entry => entry.models.length);
  }, [entries, visibleLimit, draft.connectionId, draft.modelId]);
  const matchingCount = entries.reduce((count, entry) => count + entry.models.length, 0);
  const renderedCount = visibleEntries.reduce((count, entry) => count + entry.models.length, 0);
  const error = modelSelectionError(draft);
  const requestClose = () => { dismissed.current = true; onClose(); };
  return <Modal label="Choose a model" className="oh-model-browser" onClose={requestClose} initialFocusSelector="#oh-model-search">
    <header className="oh-dialog-head">
      <div><span className="oh-eyebrow">INTELLIGENCE</span><h2>Choose a model</h2></div>
      <IconButton aria-label="Close model browser" onClick={requestClose}><Icon name="close" /></IconButton>
    </header>
    <div className="oh-model-layout">
      <section className="oh-model-catalog" aria-label="Model catalog">
        <div className="oh-search-field"><Icon name="search" /><input id="oh-model-search" aria-label="Search models" placeholder="Search models or providers…" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="oh-filter-row" aria-label="Model filters">
          {(['all', 'ready', 'tools', 'vision'] as const).map(item => <button type="button" key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{({ all: 'All models', ready: 'Available', tools: 'Tools', vision: 'Vision' })[item]}</button>)}
        </div>
        <div className="oh-model-results">
          {loading && <p role="status">Loading connected providers…</p>}
          {catalogError && <p className="grok-field-error" role="alert">{catalogError}</p>}
          {visibleEntries.map(({ provider, models }) => <section key={provider.id} aria-label={provider.name}>
            <h3 className="oh-model-group">{provider.name}<span>{entries.find(entry => entry.provider.id === provider.id)?.models.length ?? models.length}</span></h3>
            {models.map(item => <button type="button" className="oh-model-option" key={item.id}
              aria-pressed={draft.connectionId === provider.id && draft.modelId === item.id}
              onClick={() => setDraft({ modelId: item.id, connectionId: provider.id, routingMode: draft.connectionId === provider.id ? draft.routingMode ?? 'pinned' : 'pinned' })}>
              <span className="oh-model-symbol"><Icon name={item.virtual ? 'cortex' : 'bot'} size={18} /></span>
              <span className="oh-model-option-text"><strong>{item.id}</strong><small>{item.virtual ? 'Automatic routing alias' : item.usable === true ? 'Available now' : item.usable === false ? 'Currently unavailable' : 'Availability not reported'}</small></span>
              {draft.connectionId === provider.id && draft.modelId === item.id && <Icon name="done" size={16} />}
            </button>)}
          </section>)}
          {renderedCount < matchingCount && <button type="button" className="oh-model-more" onClick={() => setVisibleLimit(limit => limit + MODEL_PAGE_SIZE)}>Show {Math.min(MODEL_PAGE_SIZE, matchingCount - renderedCount)} more models</button>}
          {!entries.length && <div className="oh-model-empty"><Icon name="search" size={28} /><h3>{query || filter !== 'all' ? 'No matching models' : 'Connect your intelligence'}</h3><p>{query || filter !== 'all' ? 'Try another search or filter.' : 'Add a provider in Settings to browse its models. You can also enter a model ID below.'}</p></div>}
        </div>
        <details className="oh-manual-model"><summary>Use a model ID directly</summary><label htmlFor="oh-custom-model">Model ID</label><input id="oh-custom-model" value={draft.modelId} onChange={event => setDraft({ ...draft, modelId: event.target.value })} /><button type="button" onClick={() => setDraft({ ...draft, connectionId: null, routingMode: null })}>Use inferred provider</button></details>
      </section>
      <aside className="oh-model-inspector">
        <span className="oh-model-emblem"><Icon name="cortex" size={32} /></span>
        <span className="oh-eyebrow">{connection?.name ?? 'INFERRED PROVIDER'}</span>
        <h3>{draft.modelId || 'Your next model'}</h3>
        <p>{model?.virtual ? 'Let this provider route requests across its model pool.' : 'The intelligence behind your bot’s conversations and work.'}</p>
        <dl className="oh-model-facts">
          <div><dt>Availability</dt><dd>{model?.usable === true ? 'Available now' : model?.usable === false ? 'Unavailable' : 'Not reported'}</dd></div>
          <div><dt>Context window</dt><dd>{model?.contextWindow ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(model.contextWindow)} tokens` : 'Not reported'}</dd></div>
          <div><dt>Tool use</dt><dd>{model?.supportsTools === true ? 'Supported' : model?.supportsTools === false ? 'Not supported' : 'Not reported'}</dd></div>
          <div><dt>Vision</dt><dd>{model?.supportsVision === true ? 'Supported' : model?.supportsVision === false ? 'Not supported' : 'Not reported'}</dd></div>
        </dl>
        {draft.connectionId && <fieldset className="oh-routing"><legend>Routing preference</legend>
          <button type="button" aria-pressed={draft.routingMode !== 'auto'} onClick={() => setDraft({ ...draft, routingMode: 'pinned' })}><Icon name="pin" size={15} /><span>Exact model<small>Check the model on every answer</small></span></button>
          <button type="button" aria-pressed={draft.routingMode === 'auto'} onClick={() => setDraft({ ...draft, routingMode: 'auto' })}><Icon name="cortex" size={15} /><span>Automatic<small>Allow the provider to choose</small></span></button>
        </fieldset>}
        {error && <p className="grok-field-error" role="alert">{error}</p>}
        {saveError && <p className="grok-field-error" role="alert">{saveError}</p>}
        <Button kind="primary" disabled={saving || Boolean(error) || connection?.enabled === false} onClick={async () => { setSaving(true); setSaveError(''); try { await onChange(draft); if (!dismissed.current) requestClose(); } catch (cause) { if (!dismissed.current) setSaveError(cause instanceof Error ? cause.message : 'Could not save model.'); } finally { if (!dismissed.current) setSaving(false); } }}>{saving ? 'Saving…' : 'Use this model'} <Icon name="forward" size={14} /></Button>
      </aside>
    </div>
  </Modal>;
}
