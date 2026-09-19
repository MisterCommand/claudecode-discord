/**
 * Types for Gemini Business Pool
 */

// ============================================================================
// Account Types
// ============================================================================

export interface ServerConfig {
  host: string;                 // default '127.0.0.1'
  port: number;                 // default 8000
  api_keys: string[];           // empty array disables auth
  default_model: string;        // upstream Gemini model used for every /v1/messages request
}

export interface PoolSettings {
  rotation_strategy: 'round-robin' | 'least-used' | 'random';
  max_retries: number;
  retry_delay: number;          // ms between retries
  error_threshold: number;      // consecutive errors before an account is disabled
}

/**
 * One Gemini Business account as the runtime store holds it.
 *
 * `team_id` is the configured `workspace_id` the capture belongs to, written at
 * capture time rather than read back from the session: the deployment serves one
 * fixed workspace.
 */
export interface ConfiguredAccount {
  name: string;
  team_id: string;
  cookies: { secure_c_ses: string; host_c_oses: string };
  csesidx: string;
  user_agent?: string;
  enabled?: boolean;            // default true
}

export interface AppConfig {
  server: ServerConfig;
  pool: PoolSettings;
  /** Automated re-login settings, used by the startup refresh and `gemini login`. */
  sso?: SsoConfig;
  accounts: ConfiguredAccount[];
}

/**
 * Settings for the browser re-login flow. The workspace is not here: it is the
 * deployment's fixed `workspace_id` in `proxy.yaml`.
 */
export interface SsoConfig {
  /** Provider name, `locations/<location>/workforcePools/<pool>/providers/<provider>` */
  provider?: string;
}

/** An account as the running pool holds it: config fields plus runtime cache/health state. */
export interface GeminiBusinessAccount {
  name: string;
  team_id: string;
  cookies: { secure_c_ses: string; host_c_oses: string };
  csesidx: string;
  user_agent?: string;
  enabled: boolean;
  cached_jwt?: string;
  cached_jwt_expires?: number;
  session_id?: string;
  session_expires?: number;
  last_used?: number;
  error_count?: number;
  last_error?: string;
}

// ============================================================================
// Gemini Business API Types
// ============================================================================

export interface GeminiBusinessSession {
  session_id: string;
  expires_at: number;
}

export interface XSRFTokenResponse {
  token: string;
  expires: number;
}

export interface WidgetCreateSessionRequest {
  team_id: string;
  csesidx: string;
}

export interface WidgetStreamAssistRequest {
  session_id: string;
  prompt: string;
  model: string;
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface WidgetStreamAssistResponse {
  text?: string;
  content?: string;
  model: string;
  finish_reason?: string;
}

// ============================================================================
// OpenAI-Compatible Types (for compatibility)
// ============================================================================

export interface ToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments object, as required by the OpenAI schema */
    arguments: string;
  };
}

/** Streamed fragment of a tool call: `index` groups fragments of the same call. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string }
  }> | null;
  /** Assistant messages: tool calls the model asked for. */
  tool_calls?: ToolCall[];
  /** Tool messages: id of the assistant tool call this message answers. */
  tool_call_id?: string;
  /** Tool messages: name of the tool that produced the result. */
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

// ============================================================================
// Anthropic Messages API Types
// ============================================================================

export interface AnthropicTextBlock { type: 'text'; text: string }

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

/** `thinking`, `document`, `redacted_thinking` and any future block land in the open member. */
export type AnthropicContentBlock =
  | AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | { type: string };

export interface AnthropicMessage { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

export interface AnthropicToolDefinition { name: string; description?: string; input_schema?: Record<string, unknown> }

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages?: AnthropicMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
}

export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface AnthropicResponseTextBlock { type: 'text'; text: string }
export interface AnthropicResponseToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export type AnthropicResponseBlock = AnthropicResponseTextBlock | AnthropicResponseToolUseBlock;
export interface AnthropicUsage { input_tokens: number; output_tokens: number }

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicError { type: string; message: string }

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicMessageResponse }
  | { type: 'content_block_start'; index: number; content_block: AnthropicResponseBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: AnthropicStopReason; stop_sequence: null }; usage: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: AnthropicError };

// ============================================================================
// Browser Auth Types
// ============================================================================

export interface BrowserAuthOptions {
  /** Overall timeout in ms (default: 600000 = 10 min) */
  timeout?: number;
  /** Inactivity reminder delay in ms after login detected (default: 300000 = 5 min) */
  reminderDelay?: number;
  /** Cookie poll interval in ms (default: 2000) */
  pollInterval?: number;
  /** Account name (optional, auto-generated if not provided) */
  name?: string;
  /** Drive the Workforce Identity Federation sign-in instead of leaving it to the user */
  sso?: SsoOptions;
  /** Run Chrome without a visible window (default: false). */
  headless?: boolean;
  /** Chrome/Chromium binary to launch; falls back to a detected installation, then `CHROME_PATH`. */
  executablePath?: string;
  /** Do not drive the identity-provider form; leave every step to the person at the window. */
  disableSso?: boolean;
}

/** Automated sign-in through a Google Workforce Identity Federation provider. */
export interface SsoOptions {
  /** Provider name, `locations/<location>/workforcePools/<pool>/providers/<provider>` */
  provider?: string;
  /** IdP account email; falls back to `GEMINI_SSO_EMAIL` */
  email?: string;
  /** IdP password; falls back to `GEMINI_SSO_PASSWORD` */
  password?: string;
  /** Base32 authenticator-app secret for the MFA prompt; falls back to `GEMINI_SSO_TOTP_SECRET` */
  totpSecret?: string;
  /**
   * Workspace id (`/home/cid/<workspace_id>`), used to open the app after
   * sign-in so it reports its own `configId`. Supplied from the deployment's
   * configured `workspace_id`.
   */
  teamId?: string;
  /** How long to wait for sign-in to finish, in ms */
  timeout?: number;
}

export interface CapturedCredentials {
  cookies: {
    secure_c_ses: string;
    host_c_oses: string;
  };
  csesidx: string;
  team_id: string;
  user_agent: string;
}
