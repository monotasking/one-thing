import type {
  AgentLoopOptions,
  AgentAfterTurnHook,
  AgentBeforeTurnHook,
  AgentMessage,
  AgentOutputModality,
  AgentPromptInjector,
  AgentProvider,
  AgentReasoningEffort,
  AgentSkillContext,
  AgentTool,
  AgentToolChoice,
  AgentToolPolicy,
} from './types.js'
import { createSystemPromptInjector } from './prompts.js'

export interface AgentRuntimeToolOptions {
  tools?: AgentTool[]
  policy?: AgentToolPolicy
  selectedToolNames?: string[]
}

export interface AgentRuntimePromptOptions {
  systemPrompt?: string | (() => string | Promise<string>)
  injectors?: AgentPromptInjector[]
  injectSkills?: boolean
}

export interface BuildAgentLoopRuntimeOptions {
  provider: AgentProvider
  model: string
  messages: AgentMessage[]
  requestedOutputModalities?: AgentOutputModality[]
  sessionId: string
  messageId: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  tools?: AgentRuntimeToolOptions
  skills?: AgentSkillContext[]
  prompt?: AgentRuntimePromptOptions
  temperature?: number
  maxTokens?: number
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: AgentReasoningEffort
  /** Opaque session-level prompt-cache key (see `AgentTurnRequest.cacheKey`). */
  cacheKey?: string
  /** Per-provider request knob bag (see `AgentTurnRequest.providerOptions`). */
  providerOptions?: Record<string, Record<string, unknown>>
  /** Forced tool choice for the run's FIRST model call only (see AgentLoopOptions). */
  initialToolChoice?: AgentToolChoice
  maxTurns?: number
  beforeTurn?: AgentBeforeTurnHook
  afterTurn?: AgentAfterTurnHook
  onEvent?: AgentLoopOptions['onEvent']
  onTurnTrace?: AgentLoopOptions['onTurnTrace']
}

export async function buildAgentLoopRuntime(
  options: BuildAgentLoopRuntimeOptions,
): Promise<AgentLoopOptions> {
  const toolOptions = options.tools ?? {}
  const promptInjectors = [
    ...(options.prompt?.systemPrompt ? [createSystemPromptInjector(options.prompt.systemPrompt)] : []),
    ...(options.prompt?.injectors ?? []),
  ]

  return {
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    requestedOutputModalities: options.requestedOutputModalities,
    tools: toolOptions.tools ?? [],
    toolPolicy: toolOptions.policy,
    selectedToolNames: toolOptions.selectedToolNames,
    skills: options.skills,
    injectSkillPrompts: options.prompt?.injectSkills,
    promptInjectors,
    sessionId: options.sessionId,
    messageId: options.messageId,
    workingDirectory: options.workingDirectory,
    abortSignal: options.abortSignal,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    thinking: options.thinking,
    reasoningEffort: options.reasoningEffort,
    cacheKey: options.cacheKey,
    providerOptions: options.providerOptions,
    initialToolChoice: options.initialToolChoice,
    maxTurns: options.maxTurns,
    beforeTurn: options.beforeTurn,
    afterTurn: options.afterTurn,
    onEvent: options.onEvent,
    onTurnTrace: options.onTurnTrace,
  }
}
