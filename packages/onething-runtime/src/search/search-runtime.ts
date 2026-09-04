import type { OnethingSearchCategory } from './ipc-operations.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingSearchRuntimeAdapters<TResult = unknown> {
  searchChats(query: string, limit: number): MaybePromise<TResult[]>
  searchMessages(query: string, limit: number): MaybePromise<TResult[]>
  searchActions(query: string, limit: number): MaybePromise<TResult[]>
  searchPrompts(query: string, limit: number, includeCreateAction: boolean): MaybePromise<TResult[]>
  /**
   * 第三格 `dir` 是 S4b 加的**扫描根**:给了就**只扫那一个目录**,缺席就是
   * 今天那张根列表(`getSearchDirs()`)。旧路 `executeOnethingSearch` 不递它,
   * 所以旧行为一字不动。
   */
  searchFiles(query: string, limit: number, dir?: string): MaybePromise<TResult[]>
  searchDailyNotes(query: string, limit: number): MaybePromise<TResult[]>
}

export function normalizeOnethingSearchQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^>/, '').replace(/^\//, '').trim()
}

export function isOnethingCommandSearchQuery(query: string): boolean {
  const trimmed = query.trim()
  return trimmed.startsWith('/') || trimmed.startsWith('>')
}

export async function executeOnethingSearch<TResult = unknown>(
  query: string,
  category: OnethingSearchCategory,
  limit = 20,
  adapters: OnethingSearchRuntimeAdapters<TResult>,
): Promise<TResult[]> {
  switch (category) {
    case 'chats':
      return await adapters.searchChats(query, limit)
    case 'messages':
      return await adapters.searchMessages(query, limit)
    case 'actions':
      return await adapters.searchActions(query, limit)
    case 'prompts':
      return await adapters.searchPrompts(query, limit, true)
    case 'files':
      return await adapters.searchFiles(query, limit)
    case 'daily':
      return await adapters.searchDailyNotes(query, limit)
    case 'all': {
      const includeDaily = Boolean(normalizeOnethingSearchQuery(query))
      const actionLimit = isOnethingCommandSearchQuery(query) ? 8 : 4
      const [chats, messages, files, daily, prompts, actions] = await Promise.all([
        adapters.searchChats(query, 6),
        adapters.searchMessages(query, 5),
        adapters.searchFiles(query, 10),
        includeDaily ? adapters.searchDailyNotes(query, 6) : Promise.resolve([]),
        adapters.searchPrompts(query, 6, true),
        adapters.searchActions(query, actionLimit),
      ])
      const ordered = isOnethingCommandSearchQuery(query)
        ? [...actions, ...prompts, ...chats, ...daily, ...files, ...messages]
        : [...chats, ...prompts, ...daily, ...files, ...messages, ...actions]
      return ordered.slice(0, limit)
    }
  }
}
