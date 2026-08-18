/**
 * Prompt Service
 *
 * TypeScript prompt builders and context assembly. No Handlebars templates are used.
 */

export type {
  CoreBuildPromptOptions,
  CoreBuildPromptResult,
  CorePromptRequestMessage,
} from '@onething/core/engine'

export type {
  OSType,
  TemplateSkill,
} from './types.js'

export {
  buildContextCompactPrompt,
} from '@onething/core/engine'

export {
  buildPrompt,
  buildSystemPrompt,
  desktopPromptComposer,
  loadAgentsMdInstructions,
} from './system-prompt.js'
export type {
  BuildPromptContextOptions,
  BuildPromptOptions,
  BuildPromptResult,
  PromptRequestMessage,
} from './system-prompt.js'

export {
  registerPromptContextProvider,
  collectPluginPromptContext,
} from './plugin-context.js'
export type {
  PluginPromptContext,
  PluginPromptContextFragmentInput,
  PluginPromptContextProvider,
} from './plugin-context.js'
