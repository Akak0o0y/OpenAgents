/**
 * Marketplace.
 *
 * Two tabs, two very different honesty problems, both handled explicitly.
 *
 * BOTS. Importing a template really creates a bot: POST /api/agents, then the
 * fleet reloads. The button reports the server's answer - "Imported", or the
 * daemon's own error - and never flips to a success state on its own.
 *
 * PLUGINS. Adding one is real: the daemon writes the MCP server into
 * openhours.config.json and answers with the path it wrote. It does NOT start
 * the process - the daemon spawns MCP servers at boot - so the UI reports that
 * a restart is required rather than flipping the row to "Connected". The
 * connected/not-connected state shown per row is the daemon's live MCP status,
 * never a guess made here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BotFace } from './BotFace.js';
import { Modal } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import {
  BOT_CATEGORIES,
  BOT_TEMPLATES,
  FEATURED_TEMPLATE_IDS,
  PLUGIN_CATALOG,
  PLUGIN_CATEGORIES,
  type MarketplaceBotTemplate,
  type PluginEntry,
} from '../data/marketplace.js';
import { api, type PluginRow } from '../lib/transport.js';
import { FormError } from './ui/FormError.js';
import { Button, IconButton } from './ui/Button.js';
import { Input } from '@/registry/default/ui/input.js';
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '@/registry/default/ui/accordion.js';

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  callsUsed: number;
  quota: number;
  error?: string;
}

interface GrokMarketplaceModalProps {
  onClose: () => void;
  onImportBot: (template: MarketplaceBotTemplate) => Promise<void>;
  /** Bot ids that already exist, so an imported template says so. */
  existingBotIds: string[];
}

type Route =
  | { name: 'catalog' }
  | { name: 'installed' }
  | { name: 'plugin'; pluginId: string }
  | { name: 'bot'; templateId: string };

const TEMPLATE_TABS = [
  { id: 'instructions', label: 'Instructions', hint: 'How this Bot should work' },
  { id: 'memories', label: 'Memories', hint: 'Facts it already knows' },
  { id: 'skills', label: 'Skills', hint: 'Playbooks it can run' },
  { id: 'routines', label: 'Routines', hint: 'Jobs that run on their own' },
  { id: 'integrations', label: 'Integrations', hint: 'Tools it can use' },
] as const;

type TemplateTab = (typeof TEMPLATE_TABS)[number]['id'];

export function GrokMarketplaceModal({ onClose, onImportBot, existingBotIds }: GrokMarketplaceModalProps) {
  const [tab, setTab] = useState<'plugins' | 'bots'>('plugins');
  const [route, setRoute] = useState<Route>({ name: 'catalog' });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null);
  const [mcpError, setMcpError] = useState('');
  const [mcpLoading, setMcpLoading] = useState(true);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState('');
  const [restartNotice, setRestartNotice] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState('');
  const [imported, setImported] = useState<string[]>([]);
  const [templateTab, setTemplateTab] = useState<TemplateTab>('instructions');

  const loadPlugins = useCallback(async () => {
    setMcpLoading(true);
    setMcpError('');
    try {
      const body = await api.plugins();
      setPlugins(body.plugins);
    } catch (cause) {
      setPlugins(null);
      setMcpError(cause instanceof Error ? cause.message : 'Plugin status is unavailable.');
    } finally {
      setMcpLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  async function install(entry: PluginEntry) {
    setPluginBusy(entry.id);
    setPluginError('');
    setRestartNotice('');
    try {
      const result = await api.installPlugin({
        name: entry.id,
        command: entry.installCommand,
        args: entry.installArgs,
      });
      await loadPlugins();
      setRestartNotice(
        result.restartRequired ? `${entry.name} was written to ${result.configPath}. Restart the daemon to start it, or retry Reload plugins after active calls finish.` : `${entry.name} is configured and connected. No restart is needed.`
      );
    } catch (cause) {
      setPluginError(cause instanceof Error ? cause.message : 'The daemon refused the install.');
    } finally {
      setPluginBusy(null);
    }
  }

  async function uninstall(name: string) {
    setPluginBusy(name);
    setPluginError('');
    setRestartNotice('');
    try {
      const result = await api.uninstallPlugin(name);
      await loadPlugins();
      setRestartNotice(result.restartRequired ? `${name} was removed from the config file. Restart the daemon to stop it, or retry Reload plugins after active calls finish.` : `${name} was removed and disconnected.`);
    } catch (cause) {
      setPluginError(cause instanceof Error ? cause.message : 'The daemon refused the removal.');
    } finally {
      setPluginBusy(null);
    }
  }

  useEffect(() => {
    setSearch('');
    setCategory('All');
    setRoute({ name: 'catalog' });
  }, [tab]);

  const installedCount = plugins?.length ?? 0;

  const filteredPlugins = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return PLUGIN_CATALOG.filter((plugin) => {
      const matches =
        !needle ||
        plugin.name.toLowerCase().includes(needle) ||
        plugin.description.toLowerCase().includes(needle);
      if (!matches) return false;
      if (category === 'All') return true;
      if (category === 'Featured') return plugin.featured;
      return plugin.category === category;
    });
  }, [search, category]);

  const filteredBots = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return BOT_TEMPLATES.filter((template) => {
      const matches =
        !needle ||
        template.name.toLowerCase().includes(needle) ||
        template.author.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle);
      if (!matches) return false;
      if (category === 'All' || category === 'From OpenAgents') return true;
      return template.category === category;
    });
  }, [search, category]);

  async function importTemplate(template: MarketplaceBotTemplate) {
    setImporting(template.id);
    setImportError('');
    try {
      await onImportBot(template);
      setImported((current) => [...current, template.id]);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : 'The daemon refused the import.');
    } finally {
      setImporting(null);
    }
  }

  const detailPlugin =
    route.name === 'plugin' ? PLUGIN_CATALOG.find((p) => p.id === route.pluginId) ?? null : null;
  const detailTemplate =
    route.name === 'bot' ? BOT_TEMPLATES.find((t) => t.id === route.templateId) ?? null : null;

  return (
    <Modal label="Marketplace" className="grok-marketplace-modal" onClose={onClose}>
      <header className="grok-mp-header">
        {route.name === 'catalog' ? (
          <h2 className="grok-mp-title">Marketplace</h2>
        ) : (
          <IconButton aria-label="Back to marketplace" title="Back to marketplace" onClick={() => setRoute({ name: 'catalog' })}
          >
            <Icon name="back" />
          </IconButton>
        )}

        {route.name === 'catalog' && (
          <div className="grok-mp-pill-toggle" role="tablist" aria-label="Marketplace section">
            {(['plugins', 'bots'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`grok-mp-pill-btn ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                {id === 'plugins' ? 'Plugins' : 'Bots'}
              </button>
            ))}
          </div>
        )}

        {route.name !== 'catalog' && (
          <h2 className="grok-mp-title centered">
            {detailPlugin?.name ?? detailTemplate?.name ?? 'Your plugins'}
          </h2>
        )}

        <IconButton onClick={onClose} aria-label="Close marketplace" title="Close">
          <Icon name="close" />
        </IconButton>
      </header>

      <div className="grok-mp-content">
        {route.name === 'catalog' && <div className="oh-market-intro"><div><span className="oh-eyebrow">BUILT FOR YOUR NEXT IDEA</span><h3>{tab === 'plugins' ? 'More possibilities.' : 'Meet your next collaborator.'}</h3><p>{tab === 'plugins' ? 'Connect your tools. Extend what your bots can do.' : 'Start with a purpose. Make every bot your own.'}</p></div><span className="oh-market-orbit" aria-hidden="true"><Icon name={tab === 'plugins' ? 'marketplace' : 'bot'} size={40} /></span></div>}
        {importError && (
          <FormError>
            {importError}
          </FormError>
        )}

        {route.name === 'installed' && (
          <InstalledView
            loading={mcpLoading}
            error={mcpError}
            servers={plugins}
            busy={pluginBusy}
            onRemove={(name) => void uninstall(name)}
          />
        )}

        {route.name === 'plugin' && detailPlugin && (
          <PluginDetail
            plugin={detailPlugin}
            servers={plugins}
            busy={pluginBusy !== null}
            onInstall={() => void install(detailPlugin)}
            onRemove={() => void uninstall(detailPlugin.id)}
          />
        )}

        {route.name === 'bot' && detailTemplate && (
          <TemplateDetail
            template={detailTemplate}
            tab={templateTab}
            onTab={setTemplateTab}
            busy={importing === detailTemplate.id}
            done={imported.includes(detailTemplate.id)}
            onImport={() => void importTemplate(detailTemplate)}
          />
        )}

        {route.name === 'catalog' && tab === 'plugins' && (
          <>
            <button
              type="button"
              className="grok-mp-installed-link"
              onClick={() => setRoute({ name: 'installed' })}
            >
              {mcpLoading ? 'Checking installed…' : `${installedCount} installed`}
              <Icon name="forward" />
            </button>

            <SearchAndChips
              placeholder="Search plugins"
              value={search}
              onChange={setSearch}
              categories={PLUGIN_CATEGORIES}
              category={category}
              onCategory={setCategory}
            />

            <p className="grok-mp-note">
              Plugins connect after they are added. Existing bot permissions remain unchanged.
            </p>
            {restartNotice && (
              <p className="grok-mp-restart" role="status">
                {restartNotice}
              </p>
            )}
            <button type="button" disabled={pluginBusy!==null} onClick={async()=>{setPluginBusy('reload');setPluginError('');try{await api.reloadPlugins();await loadPlugins();setRestartNotice('Plugins reloaded.');}catch(e){setPluginError(e instanceof Error?e.message:String(e));}finally{setPluginBusy(null);}}}>Reload plugins</button>
            {pluginError && (
              <FormError>
                {pluginError}
              </FormError>
            )}

            <section className="grok-mp-section">
              <h3 className="grok-mp-section-title">{category === 'All' ? 'Catalog' : category}</h3>
              <div className="grok-mp-list-grid">
                {filteredPlugins.map((plugin) => {
                  const server = plugins?.find((s) => s.name === plugin.id);
                  return (
                    <div key={plugin.id} className="grok-mp-list-item">
                      <button
                        type="button"
                        className="grok-mp-item-main"
                        onClick={() => setRoute({ name: 'plugin', pluginId: plugin.id })}
                      >
                        <span className="grok-mp-item-logo" aria-hidden="true">
                          {plugin.name.slice(0, 1)}
                        </span>
                        <span className="grok-mp-item-info">
                          <span className="grok-mp-item-name">{plugin.name}</span>
                          <span className="grok-mp-item-desc">{plugin.description}</span>
                        </span>
                      </button>
                      {server ? (
                        <button
                          type="button"
                          className="grok-mp-add-btn"
                          disabled={pluginBusy !== null}
                          title={
                            server.connected
                              ? 'Remove this server from openhours.config.json. It keeps running until the daemon restarts.'
                              : 'Remove this server from openhours.config.json.'
                          }
                          onClick={() => void uninstall(plugin.id)}
                        >
                          {pluginBusy === plugin.id ? 'Removing…' : 'Remove'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="grok-mp-add-btn"
                          disabled={pluginBusy !== null}
                          title="Write this server into openhours.config.json. A daemon restart starts it."
                          onClick={() => void install(plugin)}
                        >
                          {pluginBusy === plugin.id ? 'Adding…' : 'Add'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {filteredPlugins.length === 0 && (
                <p className="grok-mp-empty">No plugins match that search.</p>
              )}
            </section>
          </>
        )}

        {route.name === 'catalog' && tab === 'bots' && (
          <>
            <section className="grok-mp-section">
              <h3 className="grok-mp-section-title">Featured</h3>
              <div className="grok-mp-featured-grid">
                {FEATURED_TEMPLATE_IDS.map((id) => {
                  const template = BOT_TEMPLATES.find((t) => t.id === id);
                  if (!template) return null;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className="grok-mp-featured-card"
                      onClick={() => {
                        setTemplateTab('instructions');
                        setRoute({ name: 'bot', templateId: template.id });
                      }}
                    >
                      <BotFace size={56} shape={template.shape} color={template.color} idle={false} />
                      <span className="grok-mp-featured-creator">{template.author}</span>
                      <span className="grok-mp-featured-name">{template.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <SearchAndChips
              placeholder="Search by creator or Bot name"
              value={search}
              onChange={setSearch}
              categories={BOT_CATEGORIES}
              category={category}
              onCategory={setCategory}
            />

            <section className="grok-mp-section">
              <h3 className="grok-mp-section-title">From OpenAgents</h3>
              <div className="grok-mp-list-grid">
                {filteredBots.map((template) => {
                  const exists = existingBotIds.includes(template.id) || imported.includes(template.id);
                  return (
                    <div key={template.id} className="grok-mp-list-item">
                      <button
                        type="button"
                        className="grok-mp-item-main"
                        onClick={() => {
                          setTemplateTab('instructions');
                          setRoute({ name: 'bot', templateId: template.id });
                        }}
                      >
                        <BotFace size={34} shape={template.shape} color={template.color} idle={false} />
                        <span className="grok-mp-item-info">
                          <span className="grok-mp-item-name">
                            {template.name} <em>by {template.author}</em>
                          </span>
                          <span className="grok-mp-item-desc">{template.description}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="grok-mp-add-btn"
                        disabled={exists || importing !== null}
                        onClick={() => void importTemplate(template)}
                      >
                        {exists ? 'Added' : importing === template.id ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  );
                })}
              </div>
              {filteredBots.length === 0 && <p className="grok-mp-empty">No bots match that search.</p>}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

function SearchAndChips({
  placeholder,
  value,
  onChange,
  categories,
  category,
  onCategory,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  categories: string[];
  category: string;
  onCategory: (value: string) => void;
}) {
  return (
    <>
      <label className="grok-mp-search-wrap">
        <Icon name="search" />
        <Input
          type="search"
          className="grok-mp-search-input"
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="grok-mp-categories" role="group" aria-label="Categories">
        {categories.map((entry) => (
          <button
            key={entry}
            type="button"
            className={`grok-mp-category-pill ${category === entry ? 'active' : ''}`}
            aria-pressed={category === entry}
            onClick={() => onCategory(entry)}
          >
            {entry}
          </button>
        ))}
      </div>
    </>
  );
}

function InstalledView({
  loading,
  error,
  servers,
  busy,
  onRemove,
}: {
  loading: boolean;
  error: string;
  servers: PluginRow[] | null;
  busy: string | null;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="grok-mp-installed">
      <section>
        <h3 className="grok-mp-section-title">Installed</h3>
        {loading && <p className="grok-mp-empty">Reading MCP status…</p>}
        {!loading && error && (
          <FormError>
            {error}
          </FormError>
        )}
        {!loading && !error && servers?.length === 0 && (
          <p className="grok-mp-empty">
            Nothing installed yet. Add one from the catalog, then restart the daemon.
          </p>
        )}
        {!loading &&
          !error &&
          servers?.map((server) => (
            <div key={server.name} className="grok-mp-list-item static">
              <span className="grok-mp-item-logo" aria-hidden="true">
                {server.name.slice(0, 1)}
              </span>
              <span className="grok-mp-item-info">
                <span className="grok-mp-item-name">{server.name}</span>
                <span className="grok-mp-item-desc">
                  {server.connected
                    ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'} · ${server.callsUsed ?? 0}/${server.quota ?? 0} calls used`
                    : server.error ?? 'Configured, but not connected — restart the daemon to start it.'}
                </span>
              </span>
              <span className={`grok-mp-state ${server.connected ? 'ok' : 'bad'}`}>
                {server.connected ? 'Connected' : 'Not connected'}
              </span>
              <button
                type="button"
                className="grok-mp-add-btn"
                disabled={busy !== null}
                onClick={() => onRemove(server.name)}
              >
                {busy === server.name ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
      </section>

      <section>
        <h3 className="grok-mp-section-title">Private</h3>
        <p className="grok-mp-empty">
          Private skills are bot-authored tools. This daemon has no skill-authoring
          surface, so there is nothing here and nothing that could appear here yet.
        </p>
      </section>
    </div>
  );
}

function PluginDetail({
  plugin,
  servers,
  busy,
  onInstall,
  onRemove,
}: {
  plugin: PluginEntry;
  servers: PluginRow[] | null;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const server = servers?.find((s) => s.name === plugin.id);

  return (
    <div className="grok-plugin-detail">
      <div className="grok-plugin-head">
        <span className="grok-mp-item-logo large" aria-hidden="true">
          {plugin.name.slice(0, 1)}
        </span>
        <div className="grok-plugin-headings">
          <h3>{plugin.name}</h3>
          <a href={plugin.sourceUrl} target="_blank" rel="noreferrer">
            View Source
            <Icon name="open" size={13} />
          </a>
        </div>
        <div className="grok-plugin-head-actions">
          <Button kind="secondary" onClick={() => {
              void navigator.clipboard
                .writeText(plugin.configExample)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Config copied' : 'Copy config'}
          </Button>
          {server ? (
            <Button kind="secondary" disabled={busy} onClick={onRemove}>
              {busy ? 'Working…' : 'Remove'}
            </Button>
          ) : (
            <Button kind="primary" disabled={busy} title="Write this server into openhours.config.json. A daemon restart starts it." onClick={onInstall}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
          )}
        </div>
      </div>

      <p className="grok-plugin-desc">{plugin.description}</p>

      {server && (
        <p className={`grok-mp-state inline ${server.connected ? 'ok' : 'bad'}`}>
          {server.connected
            ? `Connected. ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'} available.`
            : `Configured but not connected: ${server.error ?? 'no reason reported'}`}
        </p>
      )}

      <h4 className="grok-mp-subheading">Connectors</h4>
      {/* Coss Accordion, on Base UI. The hand-rolled version was a button with
          `aria-expanded` and a conditionally rendered list: correct as far as
          it went, but the button was not tied to the region it controlled
          (`aria-controls`), the panel had no role, and the chevron direction
          was maintained by hand. This carries all three, and the open state is
          the component's rather than a `useState` in this file. */}
      <Accordion className="grok-connector-accordion">
        <AccordionItem>
          <AccordionTrigger>
            {plugin.connectors.length} connector{plugin.connectors.length === 1 ? '' : 's'}
          </AccordionTrigger>
          <AccordionPanel>
            <ul>
              {plugin.connectors.map((connector) => (
                <li key={connector.id}>
                  <span>{connector.id}</span>
                  <span className="grok-connector-type">{connector.type}</span>
                </li>
              ))}
            </ul>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <h4 className="grok-mp-subheading">Configuration</h4>
      <pre className="grok-config-block">{plugin.configExample}</pre>
    </div>
  );
}

function TemplateDetail({
  template,
  tab,
  onTab,
  busy,
  done,
  onImport,
}: {
  template: MarketplaceBotTemplate;
  tab: TemplateTab;
  onTab: (tab: TemplateTab) => void;
  busy: boolean;
  done: boolean;
  onImport: () => void;
}) {
  return (
    <div className="grok-bot-detail">
      <div className="grok-bot-detail-head">
        <BotFace size={72} shape={template.shape} color={template.color} idle={false} />
        <Button kind="primary" disabled={busy || done} onClick={onImport}>
          {done ? 'Imported' : busy ? 'Importing…' : 'Import Bot'}
        </Button>
      </div>
      <h3 className="grok-bot-detail-name">{template.name}</h3>
      <p className="grok-bot-detail-author">By {template.author}</p>
      <p className="grok-bot-detail-summary">{template.description}</p>

      <div className="grok-bot-detail-columns">
        <nav className="grok-bot-detail-nav" aria-label="Template content">
          {TEMPLATE_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'active' : ''}
              aria-current={tab === entry.id ? 'true' : undefined}
              onClick={() => onTab(entry.id)}
            >
              <span className="grok-bot-detail-nav-title">{entry.label}</span>
              <span className="grok-bot-detail-nav-hint">{entry.hint}</span>
            </button>
          ))}
        </nav>
        <div className="grok-bot-detail-panel">
          {tab === 'instructions' && <p>{template.content.instructions}</p>}
          {tab === 'memories' && <p>{template.content.memories}</p>}
          {tab === 'skills' && (
            <ul>
              {template.content.skills.map((skill) => (
                <li key={skill.name}>
                  <strong>{skill.name}</strong>
                  <span>{skill.summary}</span>
                </li>
              ))}
            </ul>
          )}
          {tab === 'routines' && (
            <ul>
              {template.content.routines.map((routine) => (
                <li key={routine.name}>
                  <strong>{routine.name}</strong>
                  <span>{routine.schedule}</span>
                </li>
              ))}
              <li className="grok-detail-note">
                Suggested schedules. Importing does not create them; add them in the
                routine editor.
              </li>
            </ul>
          )}
          {tab === 'integrations' && (
            <ul>
              {template.content.integrations.map((integration) => (
                <li key={integration.name}>
                  <strong>{integration.name}</strong>
                  <span>{integration.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
