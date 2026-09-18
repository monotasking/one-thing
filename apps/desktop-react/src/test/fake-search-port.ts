import type { SearchCapabilityManifestDto } from '@shared/ipc/search'
import type { SearchPort } from '../data/search-port'

/**
 * 检索端口的假件(S4a 立,S4b 跟着端口的形一起改)。
 *
 * 从前每个用例现搓一个 `{ ready, queryMessages }` —— 端口从一条口长到四条之后
 * 那种写法每加一条就要去改五处。这里给一份**全形**的默认件,用例只覆盖它要的那格。
 *
 * 默认这一份**成功但是空**:一台连上了、然而一条都没搜到的 core 是真实存在的状态
 * (空表 ≠ 出错)。`capabilities` 是例外 —— 它默认给**六份真自述的形**,因为
 * 「有哪些档」不给就等于「这台上什么都搜不了」,而那不是默认该模拟的处境。
 */

/**
 * 六份自述的**形**(id / labelKey / icon / order / facets / preview 与生产那六份
 * 逐字同)。
 *
 * `facets` 是 S4b 加的,而且**必须真**:过滤片画不画由它说了算(`search/filters.ts`
 * 的 `facetKeysOf`),抄漏一格用例就会守着一颗真机上根本不出现的片。
 */
export const FAKE_CAPABILITY_MANIFESTS: SearchCapabilityManifestDto[] = [
  {
    id: 'chats',
    labelKey: 'search.capability.chats',
    icon: 'MessageSquare',
    kind: 'indexed',
    budget: { default: 6, timeoutMs: 300 },
    order: 1,
    facets: [
      { key: 'sessionId', type: 'enum' },
      { key: 'spaceId', type: 'enum' },
      { key: 'archived', type: 'boolean' },
      { key: 'time', type: 'range' },
    ],
    preview: { mode: 'inline' },
    // 空词时唯一有浏览态的那一个(生产里 chats 也只有它声明 `browse`)。
    browse: true,
  },
  {
    id: 'prompts',
    labelKey: 'search.capability.prompts',
    icon: 'FileCode',
    kind: 'static',
    budget: { default: 6, timeoutMs: 0 },
    order: 2,
  },
  {
    id: 'notes',
    labelKey: 'search.capability.notes',
    icon: 'FileText',
    kind: 'indexed',
    budget: { default: 6, timeoutMs: 300 },
    order: 3,
    facets: [
      { key: 'path', type: 'enum' },
      { key: 'time', type: 'range' },
    ],
    preview: { mode: 'lazy' },
  },
  {
    id: 'files',
    labelKey: 'search.capability.files',
    icon: 'FolderTree',
    kind: 'scan',
    // 09-07 事故第二/三条修:扫描型现在有 3s 预算(从前是 0 = 不设限)。
    budget: { default: 10, timeoutMs: 3000 },
    order: 4,
    // 扫描根(S4b):壳把当前会话的工作目录当缺省递进来,「在此目录内搜」也落在它上。
    facets: [{ key: 'dir', type: 'enum' }],
    preview: { mode: 'lazy' },
  },
  {
    id: 'messages',
    labelKey: 'search.capability.messages',
    icon: 'MessagesSquare',
    kind: 'indexed',
    budget: { default: 5, timeoutMs: 300 },
    order: 5,
    facets: [
      { key: 'sessionId', type: 'enum' },
      { key: 'spaceId', type: 'enum' },
      { key: 'role', type: 'enum' },
      { key: 'archived', type: 'boolean' },
      { key: 'time', type: 'range' },
    ],
    preview: { mode: 'lazy' },
  },
  {
    id: 'actions',
    labelKey: 'search.capability.actions',
    icon: 'Command',
    kind: 'static',
    intentPrefixes: ['/', '>'],
    budget: { default: 4, timeoutMs: 0 },
    order: 6,
  },
]

/**
 * **一个设计时没想过的能力**(S4b 的反证素材)。
 *
 * 它存在的全部理由是那条硬指标(§4.0):把它塞进 `capabilities` 的回答里,
 * tab 条要自己多一格、`all` 档要自己多一组、它的行要走「缺渲染器 = 画标题行」
 * 那条路 —— 而壳里**一个字都不用改**。用例照这份形注册它。
 *
 * `order: 2.5` 是刻意的:它要落在 prompts 与 daily 之间,证明次序真的按 `order`
 * 排而不是按回答的先后。
 */
export const FAKE_EXTRA_MANIFEST: SearchCapabilityManifestDto = {
  id: 'zzz-unknown',
  labelKey: 'search.capability.unknown',
  icon: 'Sparkles',
  kind: 'remote',
  budget: { default: 3, timeoutMs: 300 },
  order: 2.5,
  facets: [{ key: 'role', type: 'enum' }],
}

/**
 * **第二个自报浏览态的能力**(S4b 的反证素材,与 `FAKE_EXTRA_MANIFEST` 同一条
 * 理由)。空词的「所有」档去问谁完全从 `browse` 这一格读,所以把它塞进自述表
 * 之后屏幕上要自己多一组 —— 壳里一个字不改。
 *
 * `order: 0.5` 让它排在 chats 前面:次序也来自自述,不是回答的先后。
 */
export const FAKE_BROWSE_MANIFEST: SearchCapabilityManifestDto = {
  id: 'zzz-browsable',
  labelKey: 'search.capability.browsable',
  icon: 'Sparkles',
  kind: 'static',
  budget: { default: 5, timeoutMs: 0 },
  order: 0.5,
  browse: true,
}

export function fakeSearchPort(overrides: Partial<SearchPort> = {}): SearchPort {
  return {
    ready: async () => undefined,
    query: async () => ({ success: true, results: [] }),
    capabilities: async () => FAKE_CAPABILITY_MANIFESTS,
    status: async () => ({ mode: 'owner', pending: 0, vector: 'off' }),
    /** 预览默认**没有** —— 「这一类还没有预览」是一台真 core 上的常态。 */
    preview: async () => ({ success: true }),
    ...overrides,
  }
}
