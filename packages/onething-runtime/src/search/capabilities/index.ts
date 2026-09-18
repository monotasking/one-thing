/**
 * 六个内置检索能力。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §4.3 注册表。
 *
 * **加一类 = 一个文件 + 一行注册;删一类 = 删文件 + 删那一行。** 下面这张清单就是
 * 那「一行」的集合;它按 manifest 的 `order` 排,因为注册顺序 = 缺省展示顺序(§4.3),
 * 而 `createGroupMerge` 用注册下标做同 order 的稳定次序。
 */

export { createActionsSearchCapability, actionsSearchManifest } from './actions.js'
export type { ActionTarget } from './actions.js'
export { createChatsSearchCapability, chatsSearchManifest, sessionTitleOf } from './sessions.js'
export type { ChatTarget } from './sessions.js'
export {
  CREATE_DAILY_ACTION,
  CREATE_NOTE_ACTION,
  LIVE_FILTER_KEY,
  LIVE_RETRIEVER_ID,
  LIVE_SEARCH_BUDGET_MS,
  NOTICE_ACTION_KIND,
  OPEN_IN_APP_ACTION,
  createLiveNotesRetriever,
  createNotesSearchCapability,
  looksLikeLiveQuery,
  notesManifestOf,
  notesSearchManifest,
  openInAppActionIdOf,
  sanitizeNoteFileName,
  todayMatchesQuery,
  wantsLiveSearch,
} from './notes.js'
export type { LiveSearchOutcome, LiveSearchSkip, NoteTarget } from './notes.js'
export { createFilesSearchCapability, filesSearchManifest } from './files.js'
export type { FileTarget } from './files.js'
export { createMessagesSearchCapability, messagesSearchManifest } from './messages.js'
export type { MessageTarget } from './messages.js'
export {
  CREATE_PROMPT_ACTION,
  createPromptsSearchCapability,
  promptsSearchManifest,
} from './prompts.js'
export type { PromptTarget } from './prompts.js'
export {
  scanBackedCapability,
  searchResultOf,
  staticBackedCapability,
} from './scan-adapter.js'
export type {
  ResultBackedCandidate,
  ResultBackedCapabilityOptions,
  SearchResultSnippetWindow,
  SearchServiceResult,
} from './scan-adapter.js'
export {
  expandPath,
  matchRangesOf,
  normalizeSearchQuery,
  scoreText,
} from './text-match.js'
export {
  configureSearchVisibilityPort,
  getSearchVisibilityPort,
  sessionScopeVisibility,
} from './visibility.js'
export type { SearchVisibilityPort } from './visibility.js'
export {
  createSessionShellLookup,
  queryRangesOf,
  snippetOf,
  snippetWindowOf,
  trackIndexGeneration,
} from './indexed.js'
export type { FieldSnippet, SearchIndexQueryFace } from './indexed.js'
export {
  PreviewUnavailableError,
  firstCandidate,
  requireStringField,
  targetPayloadOf,
} from './preview.js'
export type {
  FileExcerptPreview,
  MessageContextPreview,
  NoteExcerptPreview,
  PreviewMessage,
  SessionOverviewPreview,
} from './preview.js'

import type { SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createActionsSearchCapability } from './actions.js'
import { createChatsSearchCapability } from './sessions.js'
import { createNotesSearchCapability } from './notes.js'
import { createFilesSearchCapability } from './files.js'
import type { SearchIndexQueryFace } from './indexed.js'
import { createMessagesSearchCapability } from './messages.js'
import { createPromptsSearchCapability } from './prompts.js'

/**
 * 六个内置能力。三条索引型的多收一件 —— **索引的问答面**;它是参数而不是这个
 * 文件自己去取的单例,于是 server 每个 owner 装一份服务时仍然共用同一份索引
 * (索引是 store 级的,不按 owner 分)。
 *
 * 六件都收 `adapters`:索引答不出的那两件事(chats 的「最近几间会话」、notes 的
 * 「今天那一条」)要从取材面拿。
 */
export function createBuiltinSearchCapabilities(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
): SearchCapability[] {
  return [
    createChatsSearchCapability(adapters, index),
    createPromptsSearchCapability(adapters),
    createNotesSearchCapability(adapters, index),
    createFilesSearchCapability(adapters),
    createMessagesSearchCapability(adapters, index),
    createActionsSearchCapability(adapters),
  ]
}
