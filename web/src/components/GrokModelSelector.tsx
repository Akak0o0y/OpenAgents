/**
 * A bot's provider, model and routing.
 *
 * Without a connection the model ID keeps today's meaning: its provider is inferred from the ID. With a provider
 * connection the ID is that gateway's exact wire ID, slashes included, and nothing is inferred from it. Catalog
 * presence is not availability, and a routing alias is not evidence that any upstream key works, so the list keeps
 * those apart.
 */

import { useEffect, useState } from 'react';
import { api, type ProviderCatalogModel, type ProviderConnectionRow, type RoutingMode } from '../lib/transport.js';
import { Input } from '@/registry/default/ui/input.js';
import { ModelBrowser } from './ModelBrowser.js';
import { Icon } from './ui/icons.js';

export interface ModelSelection {
  modelId: string;
  connectionId: string | null;
  routingMode: RoutingMode | null;
}

const isAlias = (id: string) => id === 'auto' || id.startsWith('auto:');

export function modelSelectionError(selection: ModelSelection): string {
  const modelId = selection.modelId.trim();
  if (!modelId) return 'A model id is required.';
  if (selection.connectionId && selection.routingMode !== 'auto' && isAlias(modelId)) {
    return 'Routing aliases need automatic routing. Choose Automatic, or pick a concrete model to pin.';
  }
  return '';
}

function label(model: ProviderCatalogModel): string {
  const reported = [model.supportsTools === true ? 'tools' : null, model.supportsVision === true ? 'vision' : null].filter(Boolean);
  return reported.length ? `${model.id} (${reported.join(', ')})` : model.id;
}

export function GrokModelSelector({ value, onChange, compact = false }: { value: ModelSelection; onChange: (next: ModelSelection) => void; compact?: boolean }) {
  const [connections, setConnections] = useState<ProviderConnectionRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((body) => {
        if (!cancelled) setConnections(body.connections);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Provider connections are unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connection = connections?.find((entry) => entry.id === value.connectionId) ?? null;
  const models = connection?.catalog.models ?? [];
  const ready = models.filter((model) => !model.virtual && model.usable === true);
  const unreported = models.filter((model) => !model.virtual && model.usable === null);
  const unusable = models.filter((model) => !model.virtual && model.usable === false);
  const aliases = models.filter((model) => model.virtual);
  const inCatalog = models.some((model) => model.id === value.modelId);
  const error = modelSelectionError(value);
  const errorProps = { 'aria-invalid': Boolean(error), 'aria-describedby': error ? 'bot-model-error' : undefined };

  return (
    <>
      <button type="button" className="oh-model-launcher" aria-haspopup="dialog" onClick={() => setBrowseOpen(true)}>
        <span className="oh-model-symbol"><Icon name="cortex" size={20} /></span>
        <span><small>INTELLIGENCE</small><strong>{value.modelId || 'Choose your model'}</strong></span>
        <Icon name="forward" size={16} />
      </button>
      {browseOpen && <ModelBrowser value={value} connections={connections ?? []} catalogError={loadError} loading={connections === null && !loadError} onChange={onChange} onClose={() => setBrowseOpen(false)} />}
      {compact && <span className="grok-field-hint">{connection?.name ?? 'Provider inferred from model'}{value.routingMode === 'auto' ? ' · Automatic routing' : value.connectionId ? ' · Exact model' : ''}</span>}
      {!compact && <>
      <div className="grok-form-group">
        <label className="grok-form-label" htmlFor="bot-connection">Provider</label>
        <select
          id="bot-connection"
          className="grok-form-input"
          value={value.connectionId ?? ''}
          onChange={(event) => {
            const connectionId = event.target.value || null;
            // A newly chosen connection starts pinned; automatic routing is always an explicit choice.
            onChange({ modelId: value.modelId, connectionId, routingMode: connectionId ? 'pinned' : null });
          }}
        >
          <option value="">Inferred from the model ID</option>
          {value.connectionId && !connection && <option value={value.connectionId}>{value.connectionId} (not loaded)</option>}
          {(connections ?? []).map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.enabled && entry.id !== value.connectionId}>
              {entry.name}
              {entry.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
        {loadError && <span className="grok-field-hint">Provider connections could not be read: {loadError}</span>}
      </div>

      <div className="grok-form-group">
        <label className="grok-form-label" htmlFor="bot-model">Model</label>
        {value.connectionId && models.length > 0 ? (
          <select
            id="bot-model"
            className="grok-form-input"
            value={value.modelId}
            {...errorProps}
            onChange={(event) => onChange({ ...value, modelId: event.target.value })}
          >
            {!inCatalog && (
              <option value={value.modelId}>{value.modelId ? `${value.modelId} (not in this gateway's list)` : 'Choose a model'}</option>
            )}
            {ready.length > 0 && (
              <optgroup label="Can serve now">
                {ready.map((model) => <option key={model.id} value={model.id}>{label(model)}</option>)}
              </optgroup>
            )}
            {unreported.length > 0 && (
              <optgroup label="Listed, availability not reported">
                {unreported.map((model) => <option key={model.id} value={model.id}>{label(model)}</option>)}
              </optgroup>
            )}
            {unusable.length > 0 && (
              <optgroup label="Listed but not usable now">
                {unusable.map((model) => (
                  <option key={model.id} value={model.id}>
                    {label(model)}
                    {model.executionStatus ? ` [${model.executionStatus}]` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {aliases.length > 0 && (
              <optgroup label="Routing aliases (automatic routing only)">
                {aliases.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
              </optgroup>
            )}
          </select>
        ) : (
          <Input
            id="bot-model"
            className="grok-form-input"
            value={value.modelId}
            {...errorProps}
            onChange={(event) => onChange({ ...value, modelId: event.target.value })}
          />
        )}
        {value.connectionId && connection && models.length === 0 && (
          <span className="grok-field-hint">
            No model list is cached for this connection. Test it or refresh its models in Settings, or enter the gateway's exact model ID.
          </span>
        )}
        {error && <span className="grok-field-error" id="bot-model-error">{error}</span>}
      </div>

      {value.connectionId && (
        <div className="grok-form-group">
          <label className="grok-form-label" htmlFor="bot-routing">Routing</label>
          <select
            id="bot-routing"
            className="grok-form-input"
            value={value.routingMode ?? 'pinned'}
            onChange={(event) => onChange({ ...value, routingMode: event.target.value === 'auto' ? 'auto' : 'pinned' })}
          >
            <option value="pinned">Pinned: refuse answers from any other model</option>
            <option value="auto">Automatic: the gateway may route to another model in its pool</option>
          </select>
          <span className="grok-field-hint">
            {value.routingMode === 'auto'
              ? 'Each turn records the model you requested and the model that actually answered.'
              : 'This gateway does not guarantee exact-model pinning. OpenAgents checks the model it reports on every turn and discards answers from any other model.'}
          </span>
        </div>
      )}
      </>}
    </>
  );
}
