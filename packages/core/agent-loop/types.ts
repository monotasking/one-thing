import type { JsonObject, JsonValue } from '../json.js'

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * Abstract reasoning-effort scale shared across providers. Each provider maps
 * it onto its own knob (OpenAI reasoning_effort, Anthropic output_config.effort
 * or budget_tokens, Gemini thinkingLevel/thinkingBudget, DeepSeek high/max, …)
 * and clamps values it does not support to the nearest one it does.
 */
export type AgentReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentInputModality = 'text' | 'image' | 'file' | 'audio' | 'video'
export type AgentOutputModality = 'text' | 'image' | 'file' | 'audio' | 'video'

export type AgentCapability =
  | 'text-input'
  | 'text-output'
  | 'streaming'
  | 'tool-calls'
  | 'structured-tool-results'
  | 'reasoning'
  | 'vision-input'
  | 'file-input'
  | 'file-output'
  | 'image-output'
  | 'audio-input'
  | 'audio-output'
  | 'video-input'
  | 'video-output'

export interface AgentModelCapabilities {
  capabilities: AgentCapability[]
  inputModalities: AgentInputModality[]
  outputModalities: AgentOutputModality[]
  toolResultModalities?: AgentInputModality[]
  supportsTools?: boolean
  supportsStructuredToolResults?: boolean
  supportsReasoning?: boolean
  supportsStreaming?: boolean
  /**
   * Can this model be FORCED to call a tool (`toolChoice: 'required'`, or its
   * per-provider equivalent)? Opt-in: a provider that has not said yes is
   * treated as "no", and the loop silently falls back to the ordinary choice
   * instead of sending a parameter the endpoint may reject with a 400.
   */
  supportsForcedToolUse?: boolean
  maxInputTokens?: number
  maxOutputTokens?: number
}

export interface AgentTextContentPart {
  type: 'text'
  text: string
}

export interface AgentImageContentPart {
  type: 'image'
  image: string
  mediaType?: string
}

export interface AgentFileContentPart {
  type: 'file'
  data: string
  mediaType: string
  filename?: string
  /** Absolute on-disk path when known (lets providers point the model at the original file). */
  path?: string
}

export interface AgentAudioContentPart {
  type: 'audio'
  audio: string
  mediaType?: string
}

export interface AgentVideoContentPart {
  type: 'video'
  video: string
  mediaType?: string
}

export type AgentContentPart =
  | AgentTextContentPart
  | AgentImageContentPart
  | AgentFileContentPart
  | AgentAudioContentPart
  | AgentVideoContentPart

export type AgentMessageContent = string | AgentContentPart[] | null

export type AgentJsonValue = JsonValue
export type AgentJsonObject = JsonObject

export interface AgentToolCall {
  id: string
  name: string
  arguments: string
  /**
   * True when the provider itself already executed this tool (external agent
   * backends: ACP / Claude Code / Codex / pi). The loop must not execute it
   * locally, must not synthesize a tool message for it, and must not start
   * another round because of it — the provider follows up with a matching
   * `tool-result` event carrying the outcome it observed.
   */
  externallyExecuted?: boolean
}

export interface AgentMessage {
  role: AgentRole
  content: AgentMessageContent
  reasoningContent?: string
  providerData?: AgentProviderData[]
  toolCalls?: AgentToolCall[]
  toolCallId?: string
  /**
   * Tool messages only: this result is a failure. Providers with an explicit
   * error flag on their tool-result block (Anthropic `is_error`) set it from
   * here instead of guessing from the result text.
   */
  isError?: boolean
}

export interface AgentToolResult {
  content: string
  error?: string
  data?: AgentJsonValue
  requiresConfirmation?: boolean
  commandType?: 'read-only' | 'dangerous' | 'forbidden'
  aborted?: boolean
  rejected?: boolean
  rejectionReason?: string
  /**
   * N6: a tool may end the agent loop from its result. When true, the current
   * turn's sibling tools still complete normally, but the loop stops after the
   * turn instead of requesting another LLM turn (graceful wrap-up).
   */
  terminate?: boolean
}

export interface AgentProviderData extends AgentJsonObject {
  provider?: string
  type?: string
}

export interface AgentToolMetadataUpdate {
  title?: string
  metadata?: AgentJsonObject
}

export interface AgentToolResultContentPart {
  type: 'text' | 'image' | 'file'
  text?: string
  data?: string
  mimeType?: string
  path?: string
}

export interface AgentToolPartialResultUpdate {
  content: AgentToolResultContentPart[]
  details?: AgentJsonObject
  terminate?: boolean
}

export interface AgentToolExecutionContext {
  sessionId: string
  messageId: string
  toolCallId: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  onMetadata?: (update: AgentToolMetadataUpdate) => void
  onPartialResult?: (update: AgentToolPartialResultUpdate) => void
}

export interface AgentTool {
  name: string
  description?: string
  parameters: AgentJsonObject
  /**
   * 'parallel' declares this tool safe to overlap with its siblings (read-only
   * or otherwise side-effect-free for ordering purposes). Anything else —
   * including undeclared — makes the tool an execution barrier: it waits for
   * all earlier tool calls in the turn to settle and blocks later ones, so
   * e.g. a read dispatched after an edit of the same file always observes the
   * post-edit content.
   */
  executionMode?: 'parallel' | 'sequential'
  execute(args: AgentJsonObject, ctx: AgentToolExecutionContext): Promise<AgentToolResult>
}

export interface AgentToolPolicy {
  enabled?: boolean
  allowedToolNames?: string[]
  blockedToolNames?: string[]
}

export interface AgentSkillContext {
  name: string
  description?: string
  instructions?: string
  source?: string
  location?: string
  disableModelInvocation?: boolean
}

export interface AgentPromptInjectionContext {
  provider: AgentProvider
  model: string
  messages: AgentMessage[]
  tools: AgentTool[]
  skills: AgentSkillContext[]
  workingDirectory?: string
  abortSignal?: AbortSignal
}

export type AgentPromptInjector = (
  context: AgentPromptInjectionContext,
) => AgentMessage[] | Promise<AgentMessage[]>

export interface AgentTurnLifecycleContext {
  provider: AgentProvider
  model: string
  messages: AgentMessage[]
  tools: AgentTool[]
  skills: AgentSkillContext[]
  turn: number
  workingDirectory?: string
  abortSignal?: AbortSignal
}

/**
 * Rich replacement result for turn lifecycle hooks. `startNewResponse`
 * marks that the replacement injected a new user message mid-run (e.g. a
 * steering message): the loop emits a `response-boundary` event so the host
 * finalizes the current assistant response and answers the injected message
 * with a NEW response instead of continuing the interrupted tool-call loop.
 */
export interface AgentTurnHookReplacement {
  messages: AgentMessage[]
  startNewResponse?: boolean
}

export type AgentTurnHookResult = AgentMessage[] | AgentTurnHookReplacement | void

export type AgentBeforeTurnHook = (
  context: AgentTurnLifecycleContext,
) => AgentTurnHookResult | Promise<AgentTurnHookResult>

export type AgentAfterTurnHook = (
  context: AgentTurnLifecycleContext & { turnResult: AgentTurn },
) => AgentTurnHookResult | Promise<AgentTurnHookResult>

/**
 * Pure observation event fired for EVERY loop round (unlike afterTurn,
 * which only fires on the final tool-less round): the exact request the
 * model received and the response it produced. `request.messages` is the
 * live array BEFORE this round's outputs are appended — observers must
 * serialize synchronously and never mutate.
 */
export interface AgentTurnTraceEvent {
  turn: number
  sessionId: string
  messageId: string
  request: {
    model: string
    messages: AgentMessage[]
    tools?: AgentTool[]
    toolChoice?: AgentToolChoice
    temperature?: number
    maxTokens?: number
    thinking?: 'enabled' | 'disabled'
    reasoningEffort?: AgentReasoningEffort
  }
  response: AgentTurn
  /** Tool result messages produced by this round's tool calls. */
  toolResultMessages: AgentMessage[]
}

export type AgentToolChoice =
  | 'auto'
  | 'none'
  /** The model must call one of the offered tools — it may not answer in prose. */
  | 'required'
  | {
      type: 'function'
      function: { name: string }
    }

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Tokens read from a provider-side prompt cache (subset of inputTokens, not additional). */
  cacheReadTokens?: number
  /** Tokens written to a provider-side prompt cache (billed separately from inputTokens). */
  cacheWriteTokens?: number
  /** Reasoning/thinking tokens (subset of outputTokens for most providers). */
  reasoningTokens?: number
  /**
   * 厂商在响应里报的**本次请求成本**(USD)。只有少数几家给:OpenRouter
   * `usage.cost`、xAI `cost_in_usd_ticks / 1e10`。与本地价目估算**并存**
   * (账本照旧按价目表算 `costUSD`),永不互相覆盖 —— 没有这个字段的厂商
   * 一个字节都不变。
   */
  providerCostUSD?: number
}

export type AgentFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'max_turns'
  | 'unknown'

export interface AgentTurn {
  message: AgentMessage
  finishReason: AgentFinishReason
  usage?: AgentUsage
}

export type AgentStreamEvent =
  | { type: 'turn-start'; turn: number }
  /**
   * A pending user message (steering) was injected before this turn: the
   * current assistant response is over and the coming turn answers the
   * injected message as a fresh response.
   */
  | { type: 'response-boundary'; turn: number }
  | { type: 'reasoning-delta'; turn: number; delta: string }
  | { type: 'text-delta'; turn: number; delta: string }
  | { type: 'tool-call-start'; turn: number; toolCallId: string; toolName: string }
  | { type: 'tool-call-delta'; turn: number; toolCallId: string; toolName: string; argumentsDelta: string }
  | { type: 'tool-call-done'; turn: number; toolCall: AgentToolCall }
  | { type: 'finish'; turn: number; finishReason: AgentFinishReason; usage?: AgentUsage }
  | { type: 'tool-metadata'; turn: number; toolCall: AgentToolCall; update: AgentToolMetadataUpdate }
  | { type: 'tool-partial-result'; turn: number; toolCall: AgentToolCall; update: AgentToolPartialResultUpdate }
  | { type: 'provider-data'; turn: number; providerData: AgentProviderData }
  | { type: 'tool-result'; turn: number; toolCall: AgentToolCall; result: AgentToolResult }
  | { type: 'turn-end'; turn: number; finishReason: AgentFinishReason; usage?: AgentUsage }
  | { type: 'auto-retry'; turn: number; attempt: number; maxAttempts: number; delayMs: number; error: string }

/**
 * Events a provider may yield from streamTurn. The tool observation events
 * (`tool-metadata` / `tool-partial-result` / `tool-result`) are only valid for
 * tool calls marked `externallyExecuted` — for locally executed tools they are
 * emitted by the loop itself and provider-emitted ones are dropped.
 */
export type AgentTurnStreamEvent = Extract<
  AgentStreamEvent,
  | { type: 'reasoning-delta' }
  | { type: 'text-delta' }
  | { type: 'tool-call-start' }
  | { type: 'tool-call-delta' }
  | { type: 'tool-call-done' }
  | { type: 'tool-metadata' }
  | { type: 'tool-partial-result' }
  | { type: 'tool-result' }
  | { type: 'provider-data' }
  | { type: 'finish' }
>

export interface AgentTurnRequest {
  model: string
  messages: AgentMessage[]
  tools?: AgentTool[]
  toolChoice?: AgentToolChoice
  requestedOutputModalities?: AgentOutputModality[]
  temperature?: number
  maxTokens?: number
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: AgentReasoningEffort
  /**
   * Opaque, host-supplied session-level key a provider may use to route
   * server-side prompt caching (OpenAI/xAI/Kimi/OpenRouter `prompt_cache_key`).
   * It is an identifier, never content — nothing about the conversation can be
   * recovered from it. Providers that have no such knob ignore it.
   */
  cacheKey?: string
  /**
   * Two-level namespace bag for provider-specific request knobs: keyed by
   * provider id, then by knob name. A provider reads ONLY its own slot and
   * whitelists what it recognizes — an unknown key is dropped with a warning,
   * never forwarded blind.
   *
   * These are experimental or vendor-private request parameters injected by the
   * host / settings (OpenAI's `verbosity`, `image_url.detail`). core forwards
   * the bag verbatim and never looks inside: naming a vendor knob here would put
   * a provider name in the provider-agnostic layer, which is exactly the failure
   * the opaque-bag rule exists to prevent.
   */
  providerOptions?: Record<string, Record<string, unknown>>
  abortSignal?: AbortSignal
  onEvent?: (event: AgentStreamEvent) => void
  turn: number
}

export interface AgentProvider {
  id: string
  capabilities?: AgentModelCapabilities
  getModelCapabilities?: (model: string) => AgentModelCapabilities | Promise<AgentModelCapabilities>
  /**
   * This provider's capabilities come from the live backend it is attached to
   * — a connected ACP agent, an external agent CLI — not from any model
   * ledger. Hosts that overlay ledger verdicts on top of a provider's own
   * declaration must skip that overlay here: the ledger has nothing true to
   * say about a model it has never seen, and guessing produces exactly the
   * `supportsTools: false` class of bug where a capable agent is silently
   * denied its tools.
   *
   * Declared by the provider itself so that connecting another external agent
   * never means editing a list of provider ids somewhere else.
   */
  capabilitiesAreSelfDeclared?: boolean
  streamTurn?: (request: AgentTurnRequest) => AsyncIterable<AgentTurnStreamEvent>
  runTurn?: (request: AgentTurnRequest) => Promise<AgentTurn>
}

export interface AgentStreamingProvider extends AgentProvider {
  streamTurn: (request: AgentTurnRequest) => AsyncIterable<AgentTurnStreamEvent>
}

export interface AgentRunnableProvider extends AgentProvider {
  runTurn: (request: AgentTurnRequest) => Promise<AgentTurn>
}

export type AgentExecutableProvider = AgentStreamingProvider | AgentRunnableProvider

/** What a host hands back when it wants the next attempt to use another credential. */
export interface AgentCredentialRotation {
  /** The rebuilt provider, carrying the next credential. */
  provider: AgentProvider
  /** Wait before the next attempt. Defaults to 0 — a fresh key needs no backoff. */
  delayMs?: number
  /** Short human-readable reason, surfaced on the `auto-retry` event. */
  reason?: string
}

export interface AgentLoopOptions {
  provider: AgentProvider
  model: string
  messages: AgentMessage[]
  requestedOutputModalities?: AgentOutputModality[]
  tools?: AgentTool[]
  toolPolicy?: AgentToolPolicy
  selectedToolNames?: string[]
  skills?: AgentSkillContext[]
  injectSkillPrompts?: boolean
  promptInjectors?: AgentPromptInjector[]
  beforeTurn?: AgentBeforeTurnHook
  afterTurn?: AgentAfterTurnHook
  toolChoice?: AgentToolChoice
  /**
   * Tool choice for the FIRST model call of this run only; every later
   * iteration falls back to `toolChoice`.
   *
   * Why first-only, and not just `toolChoice: 'required'`: the loop sends a
   * fresh request each iteration, and a standing "required" means every one of
   * them must end in another tool call — the run can never reach a tool-less
   * round, so it only stops when maxTurns cuts it off. Forcing the opening
   * call makes the FIRST move a tool call (the caller's actual need: a choice
   * that must be expressed through the tool interface) and then lets the run
   * end naturally.
   *
   * Ignored when the model does not advertise `supportsForcedToolUse`, or when
   * the run has no tools at all.
   */
  initialToolChoice?: AgentToolChoice
  maxTurns?: number
  /**
   * Cap on tool executions running at the same time within this loop
   * (per stream; different sessions/streams are independent). Default 8.
   */
  maxConcurrentTools?: number
  temperature?: number
  maxTokens?: number
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: AgentReasoningEffort
  /**
   * Forwarded onto every `AgentTurnRequest` of this run (see
   * `AgentTurnRequest.cacheKey`). Deliberately NOT derived from `sessionId`
   * here: sending a session identifier to a provider is the host's call, so the
   * host says it out loud at its own call site rather than getting it by
   * default from a field that exists for local bookkeeping.
   */
  cacheKey?: string
  /** Forwarded onto every `AgentTurnRequest` of this run (see there). */
  providerOptions?: Record<string, Record<string, unknown>>
  sessionId: string
  messageId: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  /**
   * Backoff schedule for turn-level auto-retry of transient provider errors.
   * Defaults to 2s/4s/8s; primarily overridable for tests.
   */
  turnRetryDelaysMs?: number[]
  /**
   * Credential rotation hook, consulted at the turn-retry boundary — the ONE
   * place a different key may be swapped in (never mid-stream: this runs in
   * the catch block of a failed attempt, and the `resultsByToolCallId` guard
   * already forbids retrying past a tool side effect).
   *
   * The host classifies the error and decides; returning a provider means
   * "retry this turn against that one instead", returning undefined means
   * "nothing to rotate onto" and the ordinary retry rules take over.
   *
   * Rotation is an INDEPENDENT reason to retry, deliberately consulted before
   * `isRetryableAgentError`: quota exhaustion is fatal for the key that hit it
   * (retrying the same one is pointless) but not for the next key in the pool.
   *
   * Optional and additive — the loop behaves exactly as before when absent.
   */
  rotateCredential?: (
    error: unknown,
    attempt: number,
  ) => Promise<AgentCredentialRotation | undefined>
  /**
   * Cap on credential rotations within one run. Defaults to 3 — a pool bigger
   * than that still gets used, but one run cannot walk the whole pool while
   * the user waits.
   */
  maxCredentialRotations?: number
  onEvent?: (event: AgentStreamEvent) => void
  /** Per-round request/response observer (tracing). Must be synchronous
   * and non-throwing from the loop's perspective; errors are swallowed. */
  onTurnTrace?: (event: AgentTurnTraceEvent) => void
}

export interface AgentLoopToolResult {
  toolCall: AgentToolCall
  result: AgentToolResult
}

export interface AgentLoopResult {
  messages: AgentMessage[]
  text: string
  reasoning: string
  finishReason: AgentFinishReason
  turns: number
  toolResults: AgentLoopToolResult[]
  usage?: AgentUsage
}
