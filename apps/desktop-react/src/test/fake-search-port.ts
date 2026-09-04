import type { SearchCapabilityManifestDto } from '@shared/ipc/search'
import type { SearchPort } from '../data/search-port'

/**
 * 检索端口的假件(S4a)。
 *
 * 从前每个用例现搓一个 `{ ready, queryMessages }` —— 端口从一条口长到四条之后
 * 那种写法每加一条就要去改五处。这里给一份**全形**的默认件,用例只覆盖它要的那格。
 *
 * 默认这一份**成功但是空**:一台连上了、然而一条都没搜到的 core 是真实存在的状态
 * (空表 ≠ 出错)。`capabilities` 是例外 —— 它默认给**六份真自述的形**,因为
 * 「有哪些档」不给就等于「这台上什么都搜不了」,而那不是默认该模拟的处境。
 */

/** 六份自述的**形**(id / labelKey / icon / order 与生产那六份逐字同)。 */
export const FAKE_CAPABILITY_MANIFESTS: SearchCapabilityManifestDto[] = [
  { id: 'chats', labelKey: 'search.capability.chats', icon: 'MessageSquare', kind: 'indexed', budget: { default: 6, timeoutMs: 300 }, order: 1, preview: { mode: 'inline' } },
  { id: 'prompts', labelKey: 'search.capability.prompts', icon: 'FileCode', kind: 'static', budget: { default: 6, timeoutMs: 0 }, order: 2 },
  { id: 'daily', labelKey: 'search.capability.daily', icon: 'FileText', kind: 'indexed', budget: { default: 6, timeoutMs: 300 }, order: 3, preview: { mode: 'lazy' } },
  { id: 'files', labelKey: 'search.capability.files', icon: 'FolderTree', kind: 'scan', budget: { default: 10, timeoutMs: 0 }, order: 4, preview: { mode: 'lazy' } },
  { id: 'messages', labelKey: 'search.capability.messages', icon: 'MessagesSquare', kind: 'indexed', budget: { default: 5, timeoutMs: 300 }, order: 5, preview: { mode: 'lazy' } },
  { id: 'actions', labelKey: 'search.capability.actions', icon: 'Command', kind: 'static', intentPrefixes: ['/', '>'], budget: { default: 4, timeoutMs: 0 }, order: 6 },
]

export function fakeSearchPort(overrides: Partial<SearchPort> = {}): SearchPort {
  return {
    ready: async () => undefined,
    queryMessages: async () => ({ success: true, results: [] }),
    query: async () => ({ success: true, results: [] }),
    capabilities: async () => FAKE_CAPABILITY_MANIFESTS,
    status: async () => ({ mode: 'owner', pending: 0, vector: 'off' }),
    ...overrides,
  }
}
