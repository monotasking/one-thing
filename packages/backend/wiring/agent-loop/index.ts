export { createACPAgentProvider } from '@onething/runtime/agent-loop/providers/acp-manager-bound'
export type { ACPAgentProviderOptions } from '@onething/runtime/agent-loop/providers/acp-manager-bound'

export { createClaudeAgentProvider } from './providers/claude.js'
export type { ClaudeAgentProviderOptions } from './providers/claude.js'

export { createCodexAgentProvider } from './providers/codex.js'
export type { CodexAgentProviderOptions } from './providers/codex.js'

export { createDeepSeekAgentProvider } from './providers/deepseek.js'
export type {
  AgentProviderRequestDump,
  DeepSeekAgentProviderOptions,
} from './providers/deepseek.js'

export { createGeminiAgentProvider } from './providers/gemini.js'
export type { GeminiAgentProviderOptions } from './providers/gemini.js'

export { createOpenAICompatibleAgentProvider } from './providers/openai-compatible.js'
export type { OpenAICompatibleAgentProviderOptions } from './providers/openai-compatible.js'

export {
  createAgentProviderFromRuntime,
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
  registerAgentProviderRuntime,
} from './providers/factory.js'
export type {
  AgentProviderRuntimeConfig,
  AgentProviderRuntimeFactory,
  CreateAgentProviderFromRuntimeOptions,
  RegisterAgentProviderRuntimeOptions,
} from './providers/factory.js'
