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
  // 建会话默认**不成功**:没有哪个用例该因为默认端口而凭空多出一条会话。
  // 要验建会话的用例自己 configureSessionsPort 换一个会给出 session 的。
  create: async () => ({ success: false, error: 'fake port' }),
  updateWorkingDirectory: async () => ({ success: true }),
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
  abort: async () => ({ success: true }),
  retryMessage: async () => ({ success: true }),
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

/**
 * 文件面的端口:同一条理由,同一手(D5)。检索面板与文件树面板都会去摸它,
 * 不装的话它们会一起动态 import 真的 `@renderer/platform`。
 *
 * 默认这一份**什么都不回**,而且回的是「不成功」而不是「成功但是空」——
 * 一个没接线的端口不该假装自己看见了一个空目录。要验取数的用例自己
 * `configureFilesPort` 换一个。
 */
import { configureFilesPort } from '../data/files-port'

configureFilesPort({
  ready: async () => undefined,
  listDirectory: async () => ({ success: false, error: 'no files port in tests' }),
  stat: async () => ({ success: false, error: 'no files port in tests' }),
  readContent: async () => ({ success: false, error: 'no files port in tests' }),
  reveal: async () => ({ success: false, error: 'no files port in tests' }),
  list: async () => ({ success: true, files: [], entries: [] }),
})

/**
 * 模型目录的端口:同一条理由,同一手(D2)。composer 在每一个渲染了外壳的
 * 用例里都在,不装的话它们会一起去摸真的 `@renderer/platform`。
 *
 * 默认这一份**成功但是空**:一个连上了、然而这台机器一个 provider 都没配的
 * core 是真实存在的状态(空表 ≠ 出错),抽屉据此画「无匹配」。要验目录的用例
 * 自己 `configureModelsPort` 换一个。
 */
import { configureModelsPort } from '../data/models-port'

configureModelsPort({
  ready: async () => undefined,
  listProviders: async () => ({ success: true, providers: [] }),
  listModels: async () => ({ success: true, models: [] }),
  readSettings: async () => ({ success: false, error: 'no models port in tests' }),
  // 切模型默认**不成功**:没有哪个用例该因为默认端口而悄悄改了一条会话的绑定。
  updateSessionModel: async () => ({ success: false, error: 'no models port in tests' }),
})

/**
 * 模型服务设置面的端口:同一条理由,同一手。
 *
 * 默认这一份**读得到但是空**(名册空、设置空、凭证空),两条写口一律
 * `success:false` —— 没有哪个用例该因为默认端口而悄悄改了这台机器的设置或者
 * 存进一把密钥。要验取数或写回的用例自己 `configureProviderSettingsPort` 换一个。
 */
import { configureProviderSettingsPort } from '../data/provider-settings-port'

configureProviderSettingsPort({
  ready: async () => undefined,
  listProviders: async () => ({ success: true, providers: [] }),
  listModels: async () => ({ success: true, models: [] }),
  readSettings: async () => ({ success: false, error: 'no provider settings port in tests' }),
  saveSettings: async () => ({ success: false, error: 'no provider settings port in tests' }),
  readCredentials: async () => ({ success: false, error: 'no provider settings port in tests' }),
  setCredential: async () => ({ success: false, error: 'no provider settings port in tests' }),
})

/**
 * 读数的端口:同一条理由,同一手。默认两口都**答不上话**(一个抛、一个
 * `success:false`),于是读数是缺席态 —— 那正是「没接线」诚实的样子,
 * 不是一张写着 0 的卡。
 */
import { configureMeterPort } from '../data/meter-port'

configureMeterPort({
  ready: async () => undefined,
  getSessionUsage: async () => {
    throw new Error('no meter port in tests')
  },
  getTokenUsage: async () => ({ success: false, error: 'no meter port in tests' }),
})

/**
 * 文字查询不看**播报口**(A11y 线 · A2)。
 *
 * `ui/a11y/live-region.ts` 在 body 末尾挂一块常驻的 visually-hidden 区,一条
 * toast 出场时会把它屏幕上那句话原样送进去(那正是「同源」的做法)。于是
 * `getByText('存好了')` 会同时命中屏幕上那一份和播报口里那一份,报「找到两个」。
 *
 * 判据不是「太吵了就静音」,而是**播报口不是屏幕**:它是说给听的人的那一路,
 * 屏幕断言不该看见它。所以把它加进 Testing Library 的默认忽略表(默认表本来
 * 就是 `script, style` —— 同一类「在文档里但不是界面」的东西)。
 * 要验播报本身的用例走 `liveRegionText()`,不经这一层。
 */
import { configure } from '@testing-library/react'

configure({ defaultIgnore: 'script, style, [data-live-region], [data-live-region] *' })
