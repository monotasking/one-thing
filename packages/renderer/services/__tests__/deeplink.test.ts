/**
 * H4 深链的渲染侧 —— **确认之后,ask 走的是普通消息那条路**。
 *
 * 这一套盯三件事:队列不吞卡、取消不投递、确认之后新建会话 + 绑 agent + 发消息
 * 用的全是既有函数(一个新入口都不开)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({
  onDeepLinkRequest: vi.fn(),
  deepLinkReady: vi.fn(),
  respondDeepLink: vi.fn(),
}))
const sessionsStore = vi.hoisted(() => ({
  createSession: vi.fn(),
  updateSessionAgent: vi.fn(),
}))
const chatStore = vi.hoisted(() => ({ sendMessage: vi.fn() }))
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }))

vi.mock('@/platform', () => ({ platformApi: platform }))
// A1-a:深链的两条请求面走宿主壳路由(deeplinkRouter),推来的那张卡仍是推送。
vi.mock('@/platform/deeplink-client', () => ({
  deeplinkApi: {
    ready: (request: unknown) => platform.deepLinkReady(request),
    respond: (request: unknown) => platform.respondDeepLink(request),
  },
}))
vi.mock('@/composables/useToast', () => ({ toast }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => sessionsStore }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => chatStore }))

import {
  activeDeepLink,
  disposeDeepLinkListener,
  initDeepLinkListener,
  settleDeepLink,
} from '../deeplink'

type Listener = (request: unknown) => void
let listener: Listener = () => {}

function card(kind: 'ask' | 'plugin', requestId: string) {
  return {
    requestId,
    card: kind === 'ask'
      ? { kind: 'ask', text: 'hello' }
      : { kind: 'plugin', text: 'hi', params: {}, pluginId: 'p', action: 'a', pluginName: 'P', actionTitle: 'A' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.onDeepLinkRequest.mockImplementation((callback: Listener) => {
    listener = callback
    return () => {}
  })
  platform.deepLinkReady.mockResolvedValue({ success: true })
  platform.respondDeepLink.mockResolvedValue({ success: true, dispatched: false })
  sessionsStore.createSession.mockResolvedValue({ id: 'session-1' })
  sessionsStore.updateSessionAgent.mockResolvedValue({ success: true })
  chatStore.sendMessage.mockResolvedValue(undefined)
  initDeepLinkListener()
})

afterEach(() => {
  disposeDeepLinkListener()
})

describe('H4 renderer — 队列', () => {
  it('tells the main process it can draw cards — that is the cold-start release', () => {
    expect(platform.deepLinkReady).toHaveBeenCalled()
  })

  it('queues instead of overwriting — a second link must not swallow the first', async () => {
    listener(card('ask', 'r1'))
    listener(card('ask', 'r2'))
    expect(activeDeepLink.value?.requestId).toBe('r1')

    await settleDeepLink(false)
    // 第一张答完,第二张顶上来。覆盖会让第一条无声消失,而它已经被点过一次了。
    expect(activeDeepLink.value?.requestId).toBe('r2')

    await settleDeepLink(false)
    expect(activeDeepLink.value).toBeNull()
  })

  it('ignores a malformed request payload', () => {
    listener({ requestId: '', card: null })
    expect(activeDeepLink.value).toBeNull()
  })
})

describe('H4 renderer — 取消', () => {
  it('reports the cancel and starts nothing', async () => {
    listener(card('ask', 'r1'))
    await settleDeepLink(false)

    expect(platform.respondDeepLink).toHaveBeenCalledWith({ requestId: 'r1', approved: false })
    expect(sessionsStore.createSession).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })
})

describe('H4 renderer — ask 落地', () => {
  it('creates a session, binds the agent, and sends it as a plain user message', async () => {
    platform.respondDeepLink.mockResolvedValue({
      success: true,
      dispatched: true,
      ask: { text: 'summarise this', agentId: 'writer' },
    })
    listener(card('ask', 'r1'))

    await settleDeepLink(true)

    expect(sessionsStore.createSession).toHaveBeenCalledWith('summarise this')
    expect(sessionsStore.updateSessionAgent).toHaveBeenCalledWith('session-1', 'writer')
    // 三步全是既有函数,深链的 text 在这里之后就是一条普通用户消息。
    expect(chatStore.sendMessage).toHaveBeenCalledWith(
      'session-1', 'summarise this', undefined, { source: 'deeplink' },
    )
  })

  it('skips the agent step when the link named none', async () => {
    platform.respondDeepLink.mockResolvedValue({
      success: true, dispatched: true, ask: { text: 'hi' },
    })
    listener(card('ask', 'r1'))
    await settleDeepLink(true)

    expect(sessionsStore.updateSessionAgent).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).toHaveBeenCalled()
  })

  it('says so when the session could not be created — never silently drops the text', async () => {
    sessionsStore.createSession.mockResolvedValue(undefined)
    platform.respondDeepLink.mockResolvedValue({
      success: true, dispatched: true, ask: { text: 'hi' },
    })
    listener(card('ask', 'r1'))
    await settleDeepLink(true)

    expect(toast.error).toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })
})

describe('H4 renderer — 插件动作落地', () => {
  it('relays the handler notice and starts no session', async () => {
    platform.respondDeepLink.mockResolvedValue({
      success: true, dispatched: true, notice: 'Translated',
    })
    listener(card('plugin', 'r1'))
    await settleDeepLink(true)

    expect(toast.info).toHaveBeenCalledWith('Translated')
    expect(sessionsStore.createSession).not.toHaveBeenCalled()
  })

  it('surfaces a failure instead of pretending it worked', async () => {
    platform.respondDeepLink.mockResolvedValue({ success: false, error: 'boom' })
    listener(card('plugin', 'r1'))
    await settleDeepLink(true)

    expect(toast.error).toHaveBeenCalledWith('boom')
  })
})
