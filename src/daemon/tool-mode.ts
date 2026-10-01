export type ToolMode = 'native' | 'json';

export interface ResolveToolModeOptions {
  modelId: string;
  provider?: string;
  connectionId?: string;
  /** From provider_connections.tool_mode if configured */
  connectionToolMode?: ToolMode | null;
  /** From gateway catalog (e.g. FreeLLMAPI / custom gateway) */
  supportsTools?: boolean | null;
  /** From OpenRouter model catalog supported_parameters */
  supportedParameters?: string[];
}

const downgradedConnections = new Set<string>();

export function recordToolDowngrade(connectionId?: string, modelId?: string): void {
  if (connectionId) downgradedConnections.add(connectionId);
  if (modelId) downgradedConnections.add(modelId);
  if (connectionId && modelId) downgradedConnections.add(`${connectionId}:${modelId}`);
}

export function resetToolDowngrades(): void {
  downgradedConnections.clear();
}

/**
 * Resolves whether to use native tool calling or JSON-in-text action mode.
 * Priority order:
 * 1. OPENHOURS_TOOL_MODE environment variable
 * 2. In-memory downgrade set after HTTP 400 about tools
 * 3. Gemini and OpenCode use JSON
 * 4. Gateway catalog's supportsTools
 * 5. OpenRouter supported_parameters includes tools
 * 6. Explicit connection tool_mode setting
 * 7. Default to native
 */
export function resolveToolMode(options: ResolveToolModeOptions): ToolMode {
  // 1. OPENHOURS_TOOL_MODE env var
  const envMode = process.env.OPENHOURS_TOOL_MODE?.trim().toLowerCase();
  if (envMode === 'native' || envMode === 'json') {
    return envMode;
  }

  // 2. In-memory downgrade after HTTP 400
  const modelId = options.modelId.toLowerCase();
  if (
    (options.connectionId && downgradedConnections.has(options.connectionId)) ||
    downgradedConnections.has(modelId) ||
    (options.connectionId && downgradedConnections.has(`${options.connectionId}:${modelId}`))
  ) {
    return 'json';
  }

  // 3. Gemini and OpenCode use JSON
  if (
    modelId.includes('gemini') ||
    modelId.includes('opencode') ||
    options.provider === 'gemini' ||
    options.provider === 'opencode'
  ) {
    return 'json';
  }

  // 4. Gateway catalog supportsTools
  if (options.supportsTools === false) {
    return 'json';
  }
  if (options.supportsTools === true) {
    return 'native';
  }

  // 5. OpenRouter supported_parameters includes tools
  if (options.supportedParameters && Array.isArray(options.supportedParameters)) {
    return options.supportedParameters.includes('tools') ? 'native' : 'json';
  }

  // 6. Explicit connection tool_mode
  if (options.connectionToolMode === 'json' || options.connectionToolMode === 'native') {
    return options.connectionToolMode;
  }

  // Default: native for modern models
  return 'native';
}
