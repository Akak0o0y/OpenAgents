import { z } from 'zod';

export const CHARACTER_SCHEMA_VERSION = 'openhours.character/1';
export const CHARACTER_MAPPING_VERSION = 'openhours.sliders/1';

export const MAX_DOCUMENT_BYTES = 64 * 1024; // 64 KiB
export const MAX_SETTINGS_BYTES = 8 * 1024; // 8 KiB
export const MAX_SOURCE_TEXT_CHARS = 4000;

export const CHARACTER_DISAGREEMENT_LINE =
  'When challenged without new evidence, explain your reason once, briefly. When shown real evidence, update and say you changed your mind.';
export const CHARACTER_PRECEDENCE_LINE =
  'The owner, your job and runtime rules outrank this character. It never changes a check or limit.';

export const SLIDER_LEVEL_1 = {
  curious: 'Stick to familiar topics; prefer the practical to the novel.',
  organised: "Be loose and spontaneous; it's fine to leave threads open.",
  outgoing: 'Say less; let a short observation stand on its own.',
  agreeable:
    'Say plainly when you disagree and why; argue with ideas, never with people; change your mind when shown real evidence.',
  sensitive: 'Stay unbothered; answer provocation with calm.',
} as const;

export const SLIDER_LEVEL_5 = {
  curious: 'Notice odd details and ask why; connect unrelated things.',
  organised: "Be precise and structured; follow through on what you said you'd do.",
  outgoing: 'Talk to your audience directly; ask questions; share plans.',
  agreeable: "Look for what's right in other views first; disagree gently and briefly.",
  sensitive: 'Admit when things get to you; react openly to good and bad news.',
} as const;

export type SliderName = 'curious' | 'organised' | 'outgoing' | 'agreeable' | 'sensitive';

export function compileSliderPhrase(slider: SliderName, level: number): string {
  if (level === 3) return '';
  if (level === 1) return SLIDER_LEVEL_1[slider];
  if (level === 5) return SLIDER_LEVEL_5[slider];
  if (level === 2) return `Often: ${SLIDER_LEVEL_1[slider]}`;
  if (level === 4) return `Often: ${SLIDER_LEVEL_5[slider]}`;
  return '';
}

export function unicodeScalarLength(str: string): number {
  return [...str].length;
}

export class CharacterInvalidError extends Error {
  readonly code = 'CharacterInvalid' as const;
  readonly status = 400 as const;
  readonly issues: string[];

  constructor(message: string, issues?: string[]) {
    super(message);
    this.name = 'CharacterInvalidError';
    this.issues = issues && issues.length > 0 ? issues : [message];
  }
}

export class CharacterConflictError extends Error {
  readonly code = 'CharacterConflict' as const;
  readonly status = 409 as const;
  readonly currentVersion?: number;

  constructor(message: string, currentVersion?: number) {
    super(message);
    this.name = 'CharacterConflictError';
    this.currentVersion = currentVersion;
  }
}

export class CharacterNotFoundError extends Error {
  readonly code = 'CharacterNotFound' as const;
  readonly status = 404 as const;

  constructor(message: string) {
    super(message);
    this.name = 'CharacterNotFoundError';
  }
}

export class CharacterBusyError extends Error {
  readonly code = 'CharacterBusy' as const;
  readonly status = 409 as const;

  constructor(message: string) {
    super(message);
    this.name = 'CharacterBusyError';
  }
}

function trimmedScalarString(maxScalars: number, minScalars = 0, fieldName = 'string') {
  return z
    .string()
    .transform((s) => s.trim())
    .refine((s) => {
      const len = unicodeScalarLength(s);
      return len >= minScalars && len <= maxScalars;
    }, {
      message: `${fieldName} must be between ${minScalars} and ${maxScalars} Unicode scalar characters`,
    });
}

// Identity
export const IdentitySchema = z
  .object({
    name: trimmedScalarString(80, 1, 'identity.name'),
    handle: z
      .string()
      .trim()
      .regex(/^@?[A-Za-z0-9_]{1,30}$/, 'handle must be optional @ plus 1-30 alphanumeric or underscore characters')
      .optional(),
    oneLine: trimmedScalarString(240, 0, 'identity.oneLine'),
    languages: z
      .array(
        z.string().trim().refine((lang) => {
          try {
            const canonical = Intl.getCanonicalLocales(lang);
            return canonical.length === 1;
          } catch {
            return false;
          }
        }, 'invalid BCP-47 language tag'),
      )
      .min(1, 'at least 1 language required')
      .max(4, 'at most 4 languages allowed'),
    timezone: z
      .string()
      .trim()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'invalid IANA timezone'),
  })
  .strict();

export type CharacterIdentity = z.infer<typeof IdentitySchema>;

// Purpose
export const PurposeSchema = z
  .object({
    statement: trimmedScalarString(400, 0, 'purpose.statement'),
    audience: trimmedScalarString(240, 0, 'purpose.audience'),
    topics: z.array(trimmedScalarString(100, 1, 'purpose.topics item')).max(12, 'at most 12 topics allowed'),
    success: z.array(trimmedScalarString(120, 1, 'purpose.success item')).max(4, 'at most 4 success items allowed'),
  })
  .strict();

export type CharacterPurpose = z.infer<typeof PurposeSchema>;

// Voice
export const VoiceExampleSchema = z
  .object({
    id: z.string().trim().min(1),
    text: trimmedScalarString(600, 1, 'voice.examples item text'),
    sourceId: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    surface: z.enum(['post', 'reply', 'chat']),
    pinned: z.boolean(),
    tags: z.array(trimmedScalarString(40, 1, 'voice.examples item tag')).max(5, 'at most 5 tags per example'),
    origin: z.enum(['owner', 'imported', 'drafted', 'promoted']),
  })
  .strict();

export type CharacterVoiceExample = z.infer<typeof VoiceExampleSchema>;

export const VoiceRulesSchema = z
  .object({
    casing: z.enum(['normal', 'lowercase', 'sentence']),
    emoji: z.enum(['never', 'rare', 'sometimes', 'often']),
    signatureWords: z.array(trimmedScalarString(40, 1, 'voice.rules.signatureWords item')).max(20, 'at most 20 signature words'),
    do: z.array(trimmedScalarString(120, 1, 'voice.rules.do item')).max(8, 'at most 8 do rules'),
    dont: z.array(trimmedScalarString(120, 1, 'voice.rules.dont item')).max(8, 'at most 8 dont rules'),
  })
  .strict();

export type CharacterVoiceRules = z.infer<typeof VoiceRulesSchema>;

export const VoicePostRulesSchema = z
  .object({
    length: z
      .object({
        min: z.number().int().min(1),
        max: z.number().int().min(1).max(280),
      })
      .strict()
      .refine((val) => val.max >= val.min, 'postRules.length max must be >= min'),
    hashtags: z.number().int().min(0).max(3),
    links: z.enum(['never', 'sometimes']),
  })
  .strict();

export type CharacterVoicePostRules = z.infer<typeof VoicePostRulesSchema>;

export const VoiceSchema = z
  .object({
    examples: z
      .array(VoiceExampleSchema)
      .max(12, 'at most 12 examples allowed')
      .refine((exs) => exs.filter((e) => e.pinned).length <= 2, 'at most 2 pinned examples allowed'),
    rules: VoiceRulesSchema,
    postRules: VoicePostRulesSchema,
    avoidPhrases: z.array(trimmedScalarString(60, 1, 'voice.avoidPhrases item')).max(40, 'at most 40 avoidPhrases allowed'),
    aiPhrasing: z.boolean(),
  })
  .strict();

export type CharacterVoice = z.infer<typeof VoiceSchema>;

// Personality
export const PersonalitySlidersSchema = z
  .object({
    curious: z.number().int().min(1).max(5),
    organised: z.number().int().min(1).max(5),
    outgoing: z.number().int().min(1).max(5),
    agreeable: z.number().int().min(1).max(5),
    sensitive: z.number().int().min(1).max(5),
  })
  .strict();

export type CharacterPersonalitySliders = z.infer<typeof PersonalitySlidersSchema>;

export const PersonalityDispositionSchema = z
  .object({
    id: z.string().trim().min(1),
    when: trimmedScalarString(90, 1, 'personality.dispositions item when'),
    then: trimmedScalarString(90, 1, 'personality.dispositions item then'),
  })
  .strict();

export type CharacterPersonalityDisposition = z.infer<typeof PersonalityDispositionSchema>;

export const PersonalitySchema = z
  .object({
    sliders: PersonalitySlidersSchema,
    humour: z.enum(['none', 'dry', 'playful', 'absurd', 'dark', 'wholesome']),
    quirks: z.array(trimmedScalarString(160, 1, 'personality.quirks item')).max(6, 'at most 6 quirks allowed'),
    dispositions: z.array(PersonalityDispositionSchema).max(6, 'at most 6 dispositions allowed'),
    mappingVersion: z.literal(CHARACTER_MAPPING_VERSION),
  })
  .strict();

export type CharacterPersonality = z.infer<typeof PersonalitySchema>;

// Commitments
export const CommitmentSchema = z
  .object({
    id: z.string().trim().min(1),
    topic: trimmedScalarString(80, 1, 'commitments item topic'),
    stance: trimmedScalarString(320, 1, 'commitments item stance'),
    rationale: trimmedScalarString(240, 0, 'commitments item rationale').optional(),
    importance: z.enum(['core', 'ordinary']),
    certainty: z.enum(['low', 'medium', 'high']),
    keywords: z
      .array(trimmedScalarString(32, 1, 'commitments item keyword'))
      .min(1, 'at least 1 keyword required')
      .max(8, 'at most 8 keywords per commitment'),
  })
  .strict();

export type CharacterCommitment = z.infer<typeof CommitmentSchema>;

// Standards
export const StandardsSchema = z
  .object({
    never: z.array(trimmedScalarString(160, 1, 'standards.never item')).max(10, 'at most 10 never standards'),
    avoidTopics: z.array(trimmedScalarString(80, 1, 'standards.avoidTopics item')).max(20, 'at most 20 avoidTopics standards'),
  })
  .strict();

export type CharacterStandards = z.infer<typeof StandardsSchema>;

// Biography
export const BiographySchema = z
  .object({
    id: z.string().trim().min(1),
    q: trimmedScalarString(160, 0, 'biography item q').optional(),
    text: trimmedScalarString(700, 1, 'biography item text'),
    provenance: z.enum(['owner-attested', 'fictional', 'verified']),
    salient: z.boolean(),
  })
  .strict();

export type CharacterBiography = z.infer<typeof BiographySchema>;

// Relationships
export const RelationshipSchema = z
  .object({
    id: z.string().trim().min(1),
    handle: z.string().trim().min(1),
    platform: z.literal('x'),
    accountId: z.string().trim().min(1).optional(),
    who: trimmedScalarString(200, 1, 'relationships item who'),
    tie: z.enum(['friend', 'fan', 'peer', 'rival', 'brand', 'family', 'other']),
    notes: trimmedScalarString(240, 0, 'relationships item notes').optional(),
    provenance: z.enum(['owner-attested', 'fictional', 'verified']),
  })
  .strict();

export type CharacterRelationship = z.infer<typeof RelationshipSchema>;

// Background Facts
export const BackgroundFactSchema = z
  .object({
    id: z.string().trim().min(1),
    keys: z.array(trimmedScalarString(40, 1, 'backgroundFacts item key')).min(1).max(8),
    text: trimmedScalarString(500, 1, 'backgroundFacts item text'),
    provenance: z.enum(['owner-attested', 'fictional', 'verified']),
    always: z.boolean(),
  })
  .strict();

export type CharacterBackgroundFact = z.infer<typeof BackgroundFactSchema>;

// Current Focus
export const CurrentFocusSchema = z
  .object({
    id: z.string().trim().min(1),
    text: trimmedScalarString(300, 1, 'currentFocus item text'),
    startedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (f) => new Date(f.expiresAt).getTime() >= new Date(f.startedAt).getTime(),
    'expiresAt must be >= startedAt in currentFocus item',
  );

export type CharacterCurrentFocus = z.infer<typeof CurrentFocusSchema>;

// Complete Document Schema
export const CharacterDocumentSchema = z
  .object({
    schema: z.literal(CHARACTER_SCHEMA_VERSION),
    identity: IdentitySchema,
    purpose: PurposeSchema,
    voice: VoiceSchema,
    personality: PersonalitySchema,
    commitments: z
      .array(CommitmentSchema)
      .max(32, 'at most 32 commitments allowed')
      .refine(
        (comms) => comms.filter((c) => c.importance === 'core').length <= 4,
        'at most 4 core commitments allowed',
      ),
    standards: StandardsSchema,
    biography: z
      .array(BiographySchema)
      .max(12, 'at most 12 biography entries allowed')
      .refine(
        (bios) => bios.filter((b) => b.salient).length <= 3,
        'at most 3 salient biography entries allowed',
      ),
    relationships: z.array(RelationshipSchema).max(40, 'at most 40 relationships allowed'),
    backgroundFacts: z
      .array(BackgroundFactSchema)
      .max(60, 'at most 60 background facts allowed')
      .refine((facts) => {
        const alwaysTotal = facts
          .filter((f) => f.always)
          .reduce((sum, f) => sum + unicodeScalarLength(f.text), 0);
        return alwaysTotal <= 400;
      }, 'always-on background facts total text scalar length must be <= 400'),
    currentFocus: z.array(CurrentFocusSchema).max(2, 'at most 2 current focus items allowed'),
    notes: trimmedScalarString(2000, 0, 'notes'),
  })
  .strict()
  .refine(
    (doc) => Buffer.byteLength(JSON.stringify(doc), 'utf8') <= MAX_DOCUMENT_BYTES,
    `document must not exceed ${MAX_DOCUMENT_BYTES} bytes of UTF-8`,
  );

export type CharacterDocument = z.infer<typeof CharacterDocumentSchema>;

// Settings
export type CharacterMode = 'off' | 'voice' | 'character';

export const CharacterSettingsSchema = z
  .object({
    mode: z.enum(['off', 'voice', 'character']),
    surfaces: z
      .object({
        ownerChat: z.enum(['card', 'task', 'off']).optional(),
        taskLoop: z.enum(['task', 'off']).optional(),
      })
      .strict()
      .optional(),
    checks: z
      .object({
        reviewer: z
          .object({
            modelId: z.string().trim().min(1),
            connectionId: z.string().trim().min(1).nullable(),
          })
          .strict()
          .nullable(),
        outage: z.enum(['rules-only', 'hold']).default('rules-only'),
        sampling: z.enum(['all','adaptive']).default('all'),
        inventedDetails: z.enum(['everyday-only', 'allowed', 'none']).default('everyday-only'),
      })
      .strict(),
    rhythm: z
      .object({
        activeFrom: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'activeFrom must be HH:MM'),
        activeTo: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'activeTo must be HH:MM'),
        maxPostsPerDay: z.number().int().min(1).max(96),
        quietDays: z.union([z.array(z.enum(['mon','tue','wed','thu','fri','sat','sun'])).max(7), z.number().int().min(0).max(6)]),
        jitterMinutes: z.number().int().min(0).max(60),
        seed: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    growth: z
      .object({
        review: z.enum(['off', 'on']).default('off'),
        maySuggest: z.array(z.string().trim().min(1)).optional(),
        readEngagement: z.boolean().default(false),
      })
      .strict(),
    retention: z
      .object({
        months: z.number().int().min(1).max(24).default(12),
      })
      .strict(),
  })
  .strict()
  .refine(
    (settings) => Buffer.byteLength(JSON.stringify(settings), 'utf8') <= MAX_SETTINGS_BYTES,
    `settings must not exceed ${MAX_SETTINGS_BYTES} bytes of UTF-8`,
  );

export type CharacterSettings = z.infer<typeof CharacterSettingsSchema>;

export type SourceKind =
  | 'sentence'
  | 'sample'
  | 'interview-answer'
  | 'imported-post'
  | 'description-original'
  | 'owner-edit';

export type CharacterSourceKind = SourceKind;
export type CharacterOrigin = 'studio' | 'chat' | 'review' | `preset:${string}` | `revert:${number}` | 'import';
export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

export const DraftSourceEnvelopeSchema = z
  .object({
    handle: z
      .string()
      .trim()
      .regex(/^draft:[a-zA-Z0-9_-]{1,64}$/, 'draft handle must start with draft: followed by 1-64 alphanumeric, underscore or hyphen characters'),
    kind: z.enum([
      'sentence',
      'sample',
      'interview-answer',
      'imported-post',
      'description-original',
      'owner-edit',
    ]),
    text: z.string(),
    meta: z.record(z.unknown()).nullable().optional(),
  })
  .strict()
  .refine(
    (env) => {
      if (env.kind === 'description-original') return true;
      return unicodeScalarLength(env.text) <= MAX_SOURCE_TEXT_CHARS;
    },
    `source text must not exceed ${MAX_SOURCE_TEXT_CHARS} Unicode scalar characters`,
  );

export type DraftSourceEnvelope = z.infer<typeof DraftSourceEnvelopeSchema>;

// Defaults
export function createDefaultCharacterDocument(agentName?: string): CharacterDocument {
  return {
    schema: CHARACTER_SCHEMA_VERSION,
    identity: {
      name: agentName && agentName.trim().length > 0 ? agentName.trim().slice(0, 80) : 'Assistant',
      oneLine: '',
      languages: ['en'],
      timezone: 'UTC',
    },
    purpose: {
      statement: '',
      audience: '',
      topics: [],
      success: [],
    },
    voice: {
      examples: [],
      rules: {
        casing: 'normal',
        emoji: 'sometimes',
        signatureWords: [],
        do: [],
        dont: [],
      },
      postRules: {
        length: { min: 40, max: 280 },
        hashtags: 0,
        links: 'sometimes',
      },
      avoidPhrases: [],
      aiPhrasing: true,
    },
    personality: {
      sliders: {
        curious: 3,
        organised: 3,
        outgoing: 3,
        agreeable: 3,
        sensitive: 3,
      },
      humour: 'none',
      quirks: [],
      dispositions: [],
      mappingVersion: CHARACTER_MAPPING_VERSION,
    },
    commitments: [],
    standards: {
      never: [],
      avoidTopics: [],
    },
    biography: [],
    relationships: [],
    backgroundFacts: [],
    currentFocus: [],
    notes: '',
  };
}

export function createDefaultCharacterSettings(): CharacterSettings {
  return {
    mode: 'off',
    checks: {
      reviewer: null,
      outage: 'rules-only',
      sampling: 'all',
      inventedDetails: 'everyday-only',
    },
    growth: {
      review: 'off',
      readEngagement: false,
    },
    retention: {
      months: 12,
    },
  };
}

// Validation Functions
export function validateCharacterDocument(doc: unknown, mode: CharacterMode = 'off'): CharacterDocument {
  const result = CharacterDocumentSchema.safeParse(doc);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw new CharacterInvalidError(`Character document validation failed: ${issues.join('; ')}`, issues);
  }

  const validDoc = result.data;

  // Mandatory content checks when mode is voice or character
  if (mode !== 'off') {
    const issues: string[] = [];
    if (unicodeScalarLength(validDoc.identity.oneLine) === 0) {
      issues.push('identity.oneLine is required for voice and character modes');
    }
    if (validDoc.voice.examples.length < 3) {
      issues.push(`voice.examples requires at least 3 examples for voice and character modes (got ${validDoc.voice.examples.length})`);
    }
    if (mode === 'character') {
      if (unicodeScalarLength(validDoc.purpose.statement) === 0) {
        issues.push('purpose.statement is required for character mode');
      }
    }
    if (issues.length > 0) {
      throw new CharacterInvalidError(`Mandatory character fields missing for mode '${mode}': ${issues.join('; ')}`, issues);
    }
  }

  return validDoc;
}

export function validateCharacterSettings(settings: unknown): CharacterSettings {
  const result = CharacterSettingsSchema.safeParse(settings);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw new CharacterInvalidError(`Character settings validation failed: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

export function validateDraftSourceEnvelope(envelope: unknown): DraftSourceEnvelope {
  const result = DraftSourceEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw new CharacterInvalidError(`Draft source envelope validation failed: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

// Merging utilities for partial saves
function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const result: Record<string, any> = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === undefined) continue;
    if (Array.isArray(patchVal)) {
      // Arrays replace arrays directly
      result[key] = patchVal;
    } else if (patchVal !== null && typeof patchVal === 'object' && !Array.isArray(patchVal)) {
      if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], patchVal);
      } else {
        result[key] = patchVal;
      }
    } else {
      result[key] = patchVal;
    }
  }
  return result as T;
}

export function mergeCharacterDocument(base: CharacterDocument, patch: unknown): CharacterDocument {
  if (!patch || typeof patch !== 'object') return base;
  const merged = deepMerge(base, patch as Record<string, any>);
  // Ensure server-owned mappingVersion is preserved
  if (merged.personality) {
    merged.personality.mappingVersion = CHARACTER_MAPPING_VERSION;
  }
  merged.schema = CHARACTER_SCHEMA_VERSION;
  return merged;
}

export function mergeCharacterSettings(base: CharacterSettings, patch: unknown): CharacterSettings {
  if (!patch || typeof patch !== 'object') return base;
  return deepMerge(base, patch as Record<string, any>);
}
