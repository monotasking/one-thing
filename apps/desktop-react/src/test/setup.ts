/**
 * 测试环境的一处环境补丁,不是产品代码。
 *
 * 这台 node 自带一个残缺的全局 localStorage(有对象、没有 setItem),它盖掉了 jsdom
 * 提供的那一份;于是任何经过 zustand persist 的 setState 都炸在 storage.setItem。
 * 这里在**缺方法时**补一个内存实现 —— 生产代码一行不改,store 的持久化配置也不动。
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage
}

const broken =
  typeof globalThis.localStorage !== 'object' ||
  typeof globalThis.localStorage?.setItem !== 'function'

if (broken) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  })
}

/**
 * jsdom 不排版,于是也没有 `Element.prototype.scrollIntoView`(那是个布局动作)。
 * 会话卡在拿到键盘焦点时会调它一次(SessionCard 的 focused 副作用),
 * 所以任何「按方向键走卡」的用例都会炸在这里。补一个空实现:
 * 真正要验的是**焦点落在哪张卡**,滚动到视野里是浏览器的事,不是这一层的断言对象。
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

/**
 * 会话数据源的端口:测试里默认是**一个什么都不回的假端口**。
 *
 * 不装这一手的话,任何渲染了会话侧的用例都会经 `sessionsPort()` 动态 import
 * 真的 `@renderer/platform`,进而在 jsdom 里发出 fetch / SSE ——
 * 单元测试**不该碰网**。要验取数的用例自己 `configureSessionsPort` 换一个。
 */
import { configureSessionsPort } from '../data/sessions-port'

configureSessionsPort({
  ready: async () => undefined,
  listMeta: async () => ({ success: true, sessions: [] }),
  getSegments: async () => ({ success: true, segments: [] }),
  getMessagesPage: async () => ({ success: true, messages: [] }),
  getUserMarkers: async () => ({ success: true, markers: [] }),
  onSessionEvent: () => () => undefined,
  onSessionLifecycle: () => () => undefined,
})

/**
 * 聊天数据源的端口:同一条理由,同一手 —— 默认是**一个什么都不回的假端口**。
 *
 * 不装的话,任何渲染了聊天区的用例都会经 `chatPort()` 动态 import 真的
 * `@renderer/platform`,进而在 jsdom 里发出 fetch / SSE。要验折叠的用例
 * 自己 `configureChatPort` 换一个。
 */
import { configureChatPort } from '../data/chat-port'

configureChatPort({
  ready: async () => undefined,
  listRaw: async () => ({ events: [] }),
  readBlob: async () => ({}),
  onSessionEvent: () => () => undefined,
  onSessionStream: () => () => undefined,
  sendMessage: async () => ({ success: true }),
})

/**
 * agent 名册的端口:同一条理由,同一手。顶栏在每一个渲染了外壳的用例里都在,
 * 不装的话它们会一起去摸真的 `@renderer/platform`。
 */
import { configureAgentsPort } from '../data/agents-port'

configureAgentsPort({
  ready: async () => undefined,
  list: async () => ({ success: true, agents: [] }),
  updateSessionAgent: async () => ({ success: true }),
})
