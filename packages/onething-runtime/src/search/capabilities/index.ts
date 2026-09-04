/**
 * 六个内置检索能力(S2)。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §4.3 注册表。
 *
 * **加一类 = 一个文件 + 一行注册;删一类 = 删文件 + 删那一行。** 下面这张清单就是
 * 那「一行」的集合;它按 manifest 的 `order` 排,因为注册顺序 = 缺省展示顺序(§4.3),
 * 而 `createGroupMerge` 用注册下标做同 order 的稳定次序。
 */

export { createActionsSearchCapability, actionsSearchManifest } from './actions.js'
export type { ActionTarget } from './actions.js'
export { createChatsSearchCapability, chatsSearchManifest } from './sessions.js'
export type { ChatTarget } from './sessions.js'
export { createDailySearchCapability, dailySearchManifest } from './daily.js'
export type { DailyTarget } from './daily.js'
export { createFilesSearchCapability, filesSearchManifest } from './files.js'
export type { FileTarget } from './files.js'
export { createMessagesSearchCapability, messagesSearchManifest } from './messages.js'
export type { MessageTarget } from './messages.js'
export { createPromptsSearchCapability, promptsSearchManifest } from './prompts.js'
export type { PromptTarget } from './prompts.js'
export {
  legacyScanCapability,
  legacyStaticCapability,
  searchResultOf,
} from './legacy.js'
export type {
  LegacyBackedCandidate,
  LegacyCapabilityOptions,
  SearchServiceResult,
} from './legacy.js'

import type { SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createActionsSearchCapability } from './actions.js'
import { createChatsSearchCapability } from './sessions.js'
import { createDailySearchCapability } from './daily.js'
import { createFilesSearchCapability } from './files.js'
import { createMessagesSearchCapability } from './messages.js'
import { createPromptsSearchCapability } from './prompts.js'

export function createBuiltinSearchCapabilities(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability[] {
  return [
    createChatsSearchCapability(adapters),
    createPromptsSearchCapability(adapters),
    createDailySearchCapability(adapters),
    createFilesSearchCapability(adapters),
    createMessagesSearchCapability(adapters),
    createActionsSearchCapability(adapters),
  ]
}
