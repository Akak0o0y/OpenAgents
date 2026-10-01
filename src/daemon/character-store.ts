import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentStore } from './agent-store.js';
import {
  CHARACTER_SCHEMA_VERSION,
  CHARACTER_MAPPING_VERSION,
  MAX_DOCUMENT_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_SOURCE_TEXT_CHARS,
  CharacterInvalidError,
  CharacterConflictError,
  CharacterNotFoundError,
  validateCharacterDocument,
  validateCharacterSettings,
  mergeCharacterDocument,
  mergeCharacterSettings,
  createDefaultCharacterDocument,
  createDefaultCharacterSettings,
  type CharacterDocument,
  type CharacterSettings,
  type CharacterMode,
  type CharacterOrigin,
  type CharacterSourceKind,
  type DraftSourceEnvelope,
  type DeepPartial,
  validateDraftSourceEnvelope,
} from './character-schema.js';
import {
  compileCharacterPacket,
  checkCharacterDocumentFit,
  COMPILER_VERSION,
  EMPTY_CARD_SHA256,
  type CharacterSurface,
} from './character-compiler.js';
import type { AvailableCharacterRecords } from './character-recall.js';

export { CharacterSurface };

export interface ExecutionSurfaceContext {
  contract?: {
    kind?: string;
    repository?: unknown;
  } | null;
  kind?: string;
  repository?: unknown;
  run?: {
    routine_id?: string | null;
  } | null;
  routineId?: string | null;
  scheduled?: {
    routineId?: string | null;
  } | null;
  mission?: unknown;
  delegationDepth?: number;
  background?: unknown;
  conversation?: unknown;
  surface?: CharacterSurface;
}

export interface CharacterIdentityOptions extends ExecutionSurfaceContext {
  onActiveMode?: (mode: CharacterMode) => void;
  fallback?: string;
  query?: string;
  seed?: string;
  asOf?: string | number | null;
  records?: AvailableCharacterRecords;
  version?: number;
}

export interface CharacterIdentityMeta {
  mode: CharacterMode;
  version: number;
  surface: CharacterSurface;
  stableChars: number;
  dataChars: number;
  stableSha256: string;
  recalledIds: string[];
  omissions: string[];
  selectionSha256?: string;
}

export interface CharacterIdentityResult {
  stable: string;
  data: string;
  meta: CharacterIdentityMeta | null;
}

export function resolveExecutionSurface(context: ExecutionSurfaceContext = {}): CharacterSurface {
  if (context.surface) {
    return context.surface;
  }

  // 1. Code: contract kind is 'code' or contract.repository is set.
  // If contract is provided without kind, runtime treats absent kind as 'code'.
  const hasRepo = Boolean(context.contract?.repository || context.repository);
  const contractKind = context.contract ? (context.contract.kind ?? 'code') : context.kind;
  if (contractKind === 'code' || hasRepo) {
    return 'code';
  }

  // 2. Routine: run.routine_id || input.scheduled?.routineId resolves to task-loop
  const routineId = context.run?.routine_id || context.routineId || context.scheduled?.routineId;
  if (routineId) {
    return 'task-loop';
  }

  // 3. Mission: input.mission resolves to task-loop
  if (context.mission) {
    return 'task-loop';
  }

  // 4. Delegated or background: (delegationDepth ?? 1) >= 2 or input.background
  if ((context.delegationDepth ?? 1) >= 2 || Boolean(context.background)) {
    return 'task-loop';
  }

  // 5. Owner chat: input.conversation resolves to owner-chat
  if (context.conversation) {
    return 'owner-chat';
  }

  // 6. Anything else resolves to task-loop
  return 'task-loop';
}

export interface CharacterVersionRow {
  agent_id: string;
  version: number;
  schema_version: string;
  mode: CharacterMode;
  document_json: string;
  settings_json: string;
  document_sha256: string;
  card_sha256: string;
  compiler_version: string;
  mapping_version: string;
  origin: string;
  approval_id: string | null;
  proposal_id: string | null;
  note: string | null;
  created_at: number;
}

export interface CharacterVersionRecord {
  agent_id: string;
  version: number;
  schema_version: string;
  mode: CharacterMode;
  document: CharacterDocument;
  settings: CharacterSettings;
  document_sha256: string;
  card_sha256: string;
  compiler_version: string;
  mapping_version: string;
  origin: string;
  approval_id: string | null;
  proposal_id: string | null;
  note: string | null;
  created_at: number;
}

export interface CharacterSourceRecord {
  id: string;
  agent_id: string;
  kind: CharacterSourceKind;
  text: string;
  text_sha256: string;
  meta: Record<string, unknown>;
  created_at: number;
}

export interface SaveCharacterOptions {
  document?: DeepPartial<CharacterDocument>;
  settings?: DeepPartial<CharacterSettings>;
  sources?: DraftSourceEnvelope[];
  note?: string;
  origin?: CharacterOrigin;
  approvalId?: string | null;
  proposalId?: string | null;
}

function resolveDraftHandles(obj: unknown, handleMap: Map<string, string>): unknown {
  if (typeof obj === 'string') {
    return handleMap.has(obj) ? handleMap.get(obj)! : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => resolveDraftHandles(item, handleMap));
  }
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, resolveDraftHandles(v, handleMap)])
    );
  }
  return obj;
}

function collectReferencedSourceIds(doc: CharacterDocument): string[] {
  const ids: string[] = [];
  if (doc.voice?.examples) {
    for (const ex of doc.voice.examples) {
      if (ex.sourceId) ids.push(ex.sourceId);
    }
  }
  return ids;
}

export interface CharacterStoreOptions {
  onVersionSaved?: (agentId: string) => void;
}

export class CharacterStore {
  private db: DatabaseSync;

  constructor(
    private agentStore: AgentStore,
    private options?: CharacterStoreOptions
  ) {
    this.db = agentStore.getDatabase();
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_character_versions (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        mode TEXT NOT NULL,
        document_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        document_sha256 TEXT NOT NULL,
        card_sha256 TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        mapping_version TEXT NOT NULL,
        origin TEXT NOT NULL,
        approval_id TEXT,
        proposal_id TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, version)
      );

      CREATE TABLE IF NOT EXISTS bot_character_sources (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        text_sha256 TEXT NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS bot_character_sources_kind ON bot_character_sources(agent_id, kind);
    `);
  }

  private transaction<T>(fn: () => T): T {
    return this.agentStore.transaction(fn);
  }

  importPostSources(agentId:string,posts:readonly {postId:string;url:string;text:string;postedAt:string|null;accountHandle:string}[]) {
    if(!this.agentStore.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
    return this.transaction(()=>posts.map(post=>{
      const hash=createHash('sha256').update(post.text).digest('hex');
      const id='import-'+createHash('sha256').update(JSON.stringify([agentId,post.accountHandle.toLowerCase(),post.postId,hash])).digest('hex');
      this.db.prepare('INSERT OR IGNORE INTO bot_character_sources VALUES (?,?,\'imported-post\',?,?,?,?)').run(id,agentId,post.text,hash,JSON.stringify({platform:'x',postId:post.postId,url:post.url,postedAt:post.postedAt,accountHandle:post.accountHandle}),Date.now());
      return this.getSource(agentId,id)!;
    }));
  }

  private rowToRecord(row: CharacterVersionRow): CharacterVersionRecord {
    return {
      agent_id: row.agent_id,
      version: Number(row.version),
      schema_version: row.schema_version,
      mode: row.mode,
      document: JSON.parse(row.document_json) as CharacterDocument,
      settings: JSON.parse(row.settings_json) as CharacterSettings,
      document_sha256: row.document_sha256,
      card_sha256: row.card_sha256,
      compiler_version: row.compiler_version,
      mapping_version: row.mapping_version,
      origin: row.origin,
      approval_id: row.approval_id ?? null,
      proposal_id: row.proposal_id ?? null,
      note: row.note ?? null,
      created_at: Number(row.created_at),
    };
  }

  getLatestVersion(agentId: string): CharacterVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
      .get(agentId) as unknown as CharacterVersionRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  getLatest(agentId: string): CharacterVersionRecord | null {
    return this.getLatestVersion(agentId);
  }

  getVersion(agentId: string, version: number): CharacterVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? AND version = ?')
      .get(agentId, version) as unknown as CharacterVersionRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  getHistory(agentId: string, options?: { limit?: number; offset?: number }): CharacterVersionRecord[] {
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 50);
    const offset = Math.max(0, options?.offset ?? 0);
    const rows = this.db
      .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(agentId, limit, offset) as unknown as CharacterVersionRow[];
    return rows.map(r => this.rowToRecord(r));
  }

  getSource(agentId: string, sourceId: string): CharacterSourceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM bot_character_sources WHERE agent_id = ? AND id = ?')
      .get(agentId, sourceId) as any;
    if (!row) return null;
    return {
      id: row.id,
      agent_id: row.agent_id,
      kind: row.kind,
      text: row.text,
      text_sha256: row.text_sha256,
      meta: row.meta_json ? JSON.parse(row.meta_json) : {},
      created_at: Number(row.created_at),
    };
  }

  /** Persist proposal evidence once, before the owner reviews it. Approved versions reuse these IDs. */
  retainDraftSources(agentId:string,draft:SaveCharacterOptions):SaveCharacterOptions {
    return this.transaction(()=>{
      if(!this.agentStore.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
      const handles=new Map<string,string>();
      for(const raw of draft.sources??[]){const source=validateDraftSourceEnvelope(raw);if(handles.has(source.handle))throw new CharacterInvalidError('Duplicate source handle.');
        const id=`src-${randomUUID()}`;this.db.prepare('INSERT INTO bot_character_sources (id,agent_id,kind,text,text_sha256,meta_json,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id,agentId,source.kind,source.text,createHash('sha256').update(source.text.replace(/\r\n/g,'\n')).digest('hex'),JSON.stringify(source.meta??{}),Date.now());handles.set(source.handle,id);
      }
      return {...draft,document:resolveDraftHandles(draft.document??{},handles) as SaveCharacterOptions['document'],sources:[]};
    });
  }

  getSources(agentId: string, kind?: CharacterSourceKind): CharacterSourceRecord[] {
    let query = 'SELECT * FROM bot_character_sources WHERE agent_id = ?';
    const params: any[] = [agentId];
    if (kind) {
      query += ' AND kind = ?';
      params.push(kind);
    }
    query += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      agent_id: row.agent_id,
      kind: row.kind,
      text: row.text,
      text_sha256: row.text_sha256,
      meta: row.meta_json ? JSON.parse(row.meta_json) : {},
      created_at: Number(row.created_at),
    }));
  }

  save(agentId: string, baseVersion: number, options: SaveCharacterOptions = {}): CharacterVersionRecord {
    const saved = this.transaction(() => {
      const agent = this.agentStore.getAgent(agentId);
      if (!agent) {
        throw new CharacterNotFoundError(`Agent "${agentId}" not found.`);
      }

      const latestRow = this.db
        .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
        .get(agentId) as unknown as CharacterVersionRow | undefined;

      const currentVersion = latestRow ? Number(latestRow.version) : 0;
      if (baseVersion !== currentVersion) {
        throw new CharacterConflictError(
          `Conflict: baseVersion ${baseVersion} does not match current version ${currentVersion}.`,
          currentVersion
        );
      }

      let existingDoc: CharacterDocument;
      let existingSettings: CharacterSettings;

      if (latestRow) {
        existingDoc = JSON.parse(latestRow.document_json) as CharacterDocument;
        existingSettings = JSON.parse(latestRow.settings_json) as CharacterSettings;
      } else {
        existingDoc = createDefaultCharacterDocument(agent.name);
        existingSettings = createDefaultCharacterSettings();
      }

      // Handle draft sources
      const handleMap = new Map<string, string>();
      if (options.sources && options.sources.length > 0) {
        const insertSource = this.db.prepare(`
          INSERT INTO bot_character_sources (id, agent_id, kind, text, text_sha256, meta_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const s of options.sources) {
          if (!s.handle || !s.handle.startsWith('draft:')) {
            throw new CharacterInvalidError(`Draft source handle must start with draft:, got: ${s.handle}`);
          }
          if (s.kind !== 'description-original' && Array.from(s.text).length > MAX_SOURCE_TEXT_CHARS) {
            throw new CharacterInvalidError(
              `Source text exceeds maximum allowed length of ${MAX_SOURCE_TEXT_CHARS} characters`
            );
          }

          const allocatedId = `src-${randomUUID()}`;
          const normalizedText = s.text.replace(/\r\n/g, '\n');
          const textSha = createHash('sha256').update(normalizedText).digest('hex');

          insertSource.run(
            allocatedId,
            agentId,
            s.kind,
            s.text,
            textSha,
            JSON.stringify(s.meta ?? {}),
            Date.now()
          );

          handleMap.set(s.handle, allocatedId);
        }
      }

      // Resolve draft handles in patch document
      const rawPatchDoc = options.document ? (resolveDraftHandles(options.document, handleMap) as DeepPartial<CharacterDocument>) : {};
      const mergedDoc = mergeCharacterDocument(existingDoc, rawPatchDoc);
      const mergedSettings = mergeCharacterSettings(existingSettings, options.settings ?? {});

      // Validate merged settings
      validateCharacterSettings(mergedSettings);

      const mode = mergedSettings.mode;

      // Validate merged document
      validateCharacterDocument(mergedDoc, mode);

      // Perform fit check for enabled modes
      if (mode !== 'off') {
        checkCharacterDocumentFit(mergedDoc, mode);
      }

      // Verify that all referenced source IDs belong to this bot
      const referencedSourceIds = collectReferencedSourceIds(mergedDoc);
      if (referencedSourceIds.length > 0) {
        const checkSource = this.db.prepare('SELECT agent_id FROM bot_character_sources WHERE id = ?');
        for (const srcId of referencedSourceIds) {
          const row = checkSource.get(srcId) as { agent_id: string } | undefined;
          if (!row || row.agent_id !== agentId) {
            throw new CharacterInvalidError(
              `Source not found or belongs to another bot: ${srcId}`,
              [`Source not found or belongs to another bot: ${srcId}`]
            );
          }
        }
      }

      const docJson = JSON.stringify(mergedDoc);
      const settingsJson = JSON.stringify(mergedSettings);

      if (Buffer.byteLength(docJson, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new CharacterInvalidError(
          `Document size (${Buffer.byteLength(docJson, 'utf8')} bytes) exceeds maximum of ${MAX_DOCUMENT_BYTES} bytes`
        );
      }
      if (Buffer.byteLength(settingsJson, 'utf8') > MAX_SETTINGS_BYTES) {
        throw new CharacterInvalidError(
          `Settings size (${Buffer.byteLength(settingsJson, 'utf8')} bytes) exceeds maximum of ${MAX_SETTINGS_BYTES} bytes`
        );
      }

      const docSha = createHash('sha256').update(docJson.replace(/\r\n/g, '\n')).digest('hex');

      let cardSha: string;
      if (mode === 'off') {
        cardSha = EMPTY_CARD_SHA256;
      } else {
        const compiled = compileCharacterPacket({
          document: mergedDoc,
          settings: mergedSettings,
          surface: 'owner-chat',
        });
        cardSha = compiled.meta.stableSha256;
      }

      const newVersion = currentVersion + 1;
      const origin: string = options.origin ?? 'studio';
      const now = Date.now();
      if(origin==='studio') {
        const text='';
        this.db.prepare('INSERT INTO bot_character_sources (id,agent_id,kind,text,text_sha256,meta_json,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(`src-${randomUUID()}`,agentId,'owner-edit',text,createHash('sha256').update(text).digest('hex'),JSON.stringify({fromVersion:currentVersion,toVersion:newVersion}),now);
      }

      this.db
        .prepare(`
          INSERT INTO bot_character_versions (
            agent_id, version, schema_version, mode,
            document_json, settings_json, document_sha256, card_sha256,
            compiler_version, mapping_version, origin,
            approval_id, proposal_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          agentId,
          newVersion,
          CHARACTER_SCHEMA_VERSION,
          mode,
          docJson,
          settingsJson,
          docSha,
          cardSha,
          COMPILER_VERSION,
          CHARACTER_MAPPING_VERSION,
          origin,
          options.approvalId ?? null,
          options.proposalId ?? null,
          options.note ?? null,
          now
        );

      return {
        agent_id: agentId,
        version: newVersion,
        schema_version: CHARACTER_SCHEMA_VERSION,
        mode,
        document: mergedDoc,
        settings: mergedSettings,
        document_sha256: docSha,
        card_sha256: cardSha,
        compiler_version: COMPILER_VERSION,
        mapping_version: CHARACTER_MAPPING_VERSION,
        origin,
        approval_id: options.approvalId ?? null,
        proposal_id: options.proposalId ?? null,
        note: options.note ?? null,
        created_at: now,
      };
    });
    this.options?.onVersionSaved?.(agentId);
    return saved;
  }

  revert(agentId: string, baseVersion: number, toVersion: number, note?: string): CharacterVersionRecord {
    const reverted = this.transaction(() => {
      const agent = this.agentStore.getAgent(agentId);
      if (!agent) {
        throw new CharacterNotFoundError(`Agent "${agentId}" not found.`);
      }

      const latestRow = this.db
        .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
        .get(agentId) as unknown as CharacterVersionRow | undefined;

      const currentVersion = latestRow ? Number(latestRow.version) : 0;
      if (baseVersion !== currentVersion) {
        throw new CharacterConflictError(
          `Conflict: baseVersion ${baseVersion} does not match current version ${currentVersion}.`,
          currentVersion
        );
      }

      const targetRow = this.db
        .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? AND version = ?')
        .get(agentId, toVersion) as unknown as CharacterVersionRow | undefined;

      if (!targetRow) {
        throw new CharacterNotFoundError(`Version ${toVersion} not found for agent "${agentId}".`);
      }

      const targetDoc = JSON.parse(targetRow.document_json) as CharacterDocument;
      const targetSettings = JSON.parse(targetRow.settings_json) as CharacterSettings;

      // Re-validate against current schema and compiler
      validateCharacterSettings(targetSettings);

      const mode = targetSettings.mode;
      validateCharacterDocument(targetDoc, mode);

      if (mode !== 'off') {
        checkCharacterDocumentFit(targetDoc, mode);
      }

      const docJson = JSON.stringify(targetDoc);
      const settingsJson = JSON.stringify(targetSettings);
      const docSha = createHash('sha256').update(docJson.replace(/\r\n/g, '\n')).digest('hex');

      let cardSha: string;
      if (mode === 'off') {
        cardSha = EMPTY_CARD_SHA256;
      } else {
        const compiled = compileCharacterPacket({
          document: targetDoc,
          settings: targetSettings,
          surface: 'owner-chat',
        });
        cardSha = compiled.meta.stableSha256;
      }

      const newVersion = currentVersion + 1;
      const origin = `revert:${toVersion}`;
      const now = Date.now();
      const versionNote = note ?? `Revert to version ${toVersion}`;

      this.db
        .prepare(`
          INSERT INTO bot_character_versions (
            agent_id, version, schema_version, mode,
            document_json, settings_json, document_sha256, card_sha256,
            compiler_version, mapping_version, origin,
            approval_id, proposal_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          agentId,
          newVersion,
          CHARACTER_SCHEMA_VERSION,
          mode,
          docJson,
          settingsJson,
          docSha,
          cardSha,
          COMPILER_VERSION,
          CHARACTER_MAPPING_VERSION,
          origin,
          null,
          null,
          versionNote,
          now
        );

      return {
        agent_id: agentId,
        version: newVersion,
        schema_version: CHARACTER_SCHEMA_VERSION,
        mode,
        document: targetDoc,
        settings: targetSettings,
        document_sha256: docSha,
        card_sha256: cardSha,
        compiler_version: COMPILER_VERSION,
        mapping_version: CHARACTER_MAPPING_VERSION,
        origin,
        approval_id: null,
        proposal_id: null,
        note: versionNote,
        created_at: now,
      };
    });
    this.options?.onVersionSaved?.(agentId);
    return reverted;
  }

  identityFor(
    agent: { id: string; name?: string; system_prompt?: string | null },
    options: CharacterIdentityOptions = {}
  ): CharacterIdentityResult {
    const fallbackText =
      agent.system_prompt != null
        ? agent.system_prompt
        : (options.fallback ?? 'You are a helpful engineering assistant.');

    let surface = resolveExecutionSurface(options);
    if (surface === 'code') return { stable: fallbackText, data: '', meta: null };
    const db = this.db;
    let row: any;
    if (options.version != null) {
      row = db
        .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? AND version = ?')
        .get(agent.id, options.version);
    } else {
      row = db
        .prepare('SELECT * FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
        .get(agent.id);
    }

    options.onActiveMode?.(row?.mode ?? 'off');
    if (!row || row.mode === 'off') {
      return {
        stable: fallbackText,
        data: '',
        meta: null,
      };
    }

    let doc: CharacterDocument;
    try {
      doc = JSON.parse(row.document_json);
    } catch {
      throw new CharacterInvalidError('Invalid character document JSON in version row');
    }

    if (doc.schema !== CHARACTER_SCHEMA_VERSION) {
      throw new CharacterInvalidError(`Unknown or unsupported character schema: ${doc.schema}`);
    }

    let settings: CharacterSettings;
    try {
      settings = JSON.parse(row.settings_json);
    } catch {
      return {
        stable: fallbackText,
        data: '',
        meta: null,
      };
    }

    if ((surface === 'owner-chat' && settings.surfaces?.ownerChat === 'off') ||
        (surface === 'task-loop' && settings.surfaces?.taskLoop === 'off')) {
      return {
        stable: fallbackText,
        data: '',
        meta: null,
      };
    }

    if (surface === 'owner-chat' && settings.surfaces?.ownerChat === 'task') surface = 'task-loop';
    const packet = compileCharacterPacket({
      document: doc,
      settings,
      surface,
      query: options.query,
      seed: options.seed,
      asOf:
        options.asOf != null
          ? typeof options.asOf === 'number'
            ? new Date(options.asOf).toISOString()
            : String(options.asOf)
          : undefined,
      records: options.records,
    });

    let stable = packet.stable;
    if (agent.system_prompt && agent.system_prompt.trim().length > 0) {
      stable = stable + "\n\nYour job (the owner's Description):\n" + agent.system_prompt;
    }

    const meta: CharacterIdentityMeta = {
      mode: row.mode as CharacterMode,
      version: row.version,
      surface,
      stableChars: stable.length,
      dataChars: packet.data.length,
      stableSha256: packet.meta.stableSha256,
      recalledIds: packet.meta.recalledIds,
      omissions: packet.meta.omissions,
      ...(packet.meta.selectionSha256 ? { selectionSha256: packet.meta.selectionSha256 } : {}),
    };

    return {
      stable,
      data: packet.data,
      meta,
    };
  }
}

export function attachCharacterDataBlock(content: string, dataBlock: string): string {
  const regex = /<!-- openhours:character:data -->[\s\S]*?<!-- \/openhours:character:data -->\n*/g;
  const cleaned = content.replace(regex, '').trimStart();
  if (!dataBlock) return cleaned;
  return cleaned.length > 0 ? `${dataBlock}\n\n${cleaned}` : dataBlock;
}
