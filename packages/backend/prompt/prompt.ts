/**
 * prompt —— 系统提示词:把内置段落、工具自带的说明、登记的片段与插件提供的上下文组装成一回合的提示词,
 * 以及用户自己存的提示词库。
 *
 * 对外交出四类东西:
 * - 组装:`buildOnethingPrompt` / `buildOnethingSystemPrompt`、组装器 `PromptComposer` 与它读的
 *   `PromptSource`、内置段落源、默认组装器、片段登记表、变量看板源、把回合尾块贴到最后一条用户消息上;
 * - 默认文本:缺省系统提示词与「已知项目」说明;
 * - 提示词库:仓库类 `OnethingPromptStore`、装配后直接可用的增 / 列两只函数、把 `@prompt` 引用展开;
 * - 快照:调试面板与评估要的「这一回合的系统提示词长什么样」。
 * 依赖 agent-loop、provider、reference、storage、logging。
 */

// 组装一回合的提示词。
export {
  buildOnethingPrompt,
  buildOnethingSystemPrompt,
  builtinPromptSource,
  defaultOnethingPromptComposer,
  loadAgentsMdInstructions,
} from './prompt-builder.js'
export type { BuildOnethingPromptContextOptions, OnethingPromptHostAdapters } from './prompt-builder.js'
export { PROMPT_BLOCK_TOOL_GUIDELINES, PROMPT_BLOCK_TOOL_WORKSPACE_RULES, PromptComposer } from './prompt-composer.js'
export type { ComposedPrompt, PromptSource } from './prompt-composer.js'
export { promptFragments, registerPromptFragment } from './prompt-fragments.js'
export { VariableBoardSource } from './prompt-variable-board.js'
export type { VariableBoardRenderer } from './prompt-variable-board.js'
export { attachTurnBlocksToLastUserMessage } from './prompt-turn-delivery.js'

// 默认文本。
export { ONETHING_DEFAULT_SYSTEM_PROMPT, ONETHING_KNOWN_PROJECTS_INSTRUCTIONS } from './prompt-default-texts.js'

// 用户存的提示词库。
export { OnethingPromptStore } from './prompt-store.js'
export type { OnethingPromptStoreAdapters } from './prompt-store.js'
export { createPrompt, listPrompts } from './prompt-store-bound.js'
export { resolvePromptReferences } from './prompt-stored-resolver.js'

// 系统提示词快照(调试面板、评估)。
export {
  buildOnethingSystemPromptSnapshotForIpc,
  buildSystemPromptSnapshotWithAdapters,
  mcpToolSnapshot,
  nativeToolSnapshot,
  providerConfigForPrompt,
  skillForInit,
  skillSnapshot,
  toolSnapshot,
} from './prompt-system-snapshot.js'
export type {
  BuildOnethingSystemPromptSnapshotForIpcLogger,
  BuildSystemPromptSnapshotWithAdaptersOptions,
  CoreSystemPromptSnapshot,
} from './prompt-system-snapshot.js'
export type { OnethingPromptIpcLogger } from './prompt-ipc-operations.js'
