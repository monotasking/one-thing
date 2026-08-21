/**
 * H4 确认门 —— **无确认不投递**。
 *
 * 这一套是整个 H4 的安全底座。它验的不是"确认卡长得对",而是四件更硬的事:
 *
 *  1. 形状非法的深链**一张卡都不弹**(否则任何网页都能骚扰用户);
 *  2. 合法的深链在用户按钮之前**什么也不发生**;
 *  3. 取消 = 什么也不发生,而且那个 requestId 之后再也答不了;
 *  4. 确认之后才走各自的路 —— ask 交回渲染层,插件动作交给注册表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

// hoisted:vi.mock 的工厂被提到文件顶部,普通 const 在它求值时还没初始化。
const { invokePluginDeepLinkAction, describePluginDeepLinkAction } = vi.hoisted(() => ({
  invokePluginDeepLinkAction: vi.fn(),
  describePluginDeepLinkAction: vi.fn(),
}))

vi.mock('@onething/backend/wiring/deeplink/index.js', () => {
  // buildDeepLinkCard 的真实实现要查 agent 库与插件清单(装配层),那些在这个
  // 测试里没有意义 —— 但**卡的判定逻辑本身**是真的:它决定了哪些链接会弹窗。
  // 所以这里保留真解析 + 真"该不该弹"的形状,只把两处产品查询换成桩。
  type Parsed = ReturnType<typeof import('@onething/core/plugins/deep-link').parseDeepLink>
  return {
    invokePluginDeepLinkAction,
    buildDeepLinkCard: (parsed: Parsed) => {
      if (!parsed.ok) {
        return parsed.reason === 'text-too-long'
          ? { kind: 'rejected', reason: parsed.reason, message: 'too long' }
          : null
      }
      if (parsed.intent.kind === 'ask') {
        return { kind: 'ask', text: parsed.intent.text, agentId: parsed.intent.agentId }
      }
      const info = describePluginDeepLinkAction(parsed.intent.pluginId, parsed.intent.action)
      if (!info) return { kind: 'rejected', reason: 'action-unavailable', message: 'gone' }
      return {
        kind: 'plugin',
        text: parsed.intent.text,
        params: parsed.intent.params,
        pluginId: parsed.intent.pluginId,
        action: parsed.intent.action,
        pluginName: 'Translator',
        actionTitle: info.title,
      }
    },
  }
})

import { IPC_CHANNELS } from '@shared/ipc.js'
import type { DeepLinkConfirmRequest } from '@shared/ipc/deeplink.js'
import {
  configureDeepLinkService,
  handleIncomingDeepLink,
  pendingDeepLinkRequestCount,
  resetDeepLinkServiceForTests,
  respondToDeepLink,
} from '../service.js'

const sent: Array<{ channel: string; payload: DeepLinkConfirmRequest }> = []
let activated = 0

function installWindow(): void {
  activated = 0
  configureDeepLinkService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload: payload as DeepLinkConfirmRequest })
        },
      },
    }),
    activateMainWindow: () => { activated += 1; return true },
    logger: { log: vi.fn(), warn: vi.fn() },
  })
}

function lastRequest(): DeepLinkConfirmRequest {
  return sent.at(-1)!.payload
}

beforeEach(() => {
  resetDeepLinkServiceForTests()
  sent.length = 0
  invokePluginDeepLinkAction.mockReset()
  describePluginDeepLinkAction.mockReset()
  describePluginDeepLinkAction.mockReturnValue({ title: 'Translate the selection' })
  installWindow()
})

describe('H4 confirmation gate — 静默丢弃 vs 看得见的拒绝', () => {
  it('drops a malformed link without ever showing a card', () => {
    for (const url of [
      'https://evil.example/ask?text=hi',
      'onething://run?text=rm',
      'onething://ask',
      'garbage',
    ]) {
      expect(handleIncomingDeepLink(url), url).toBe('dropped')
    }
    // **零弹窗**。这一行就是"外部世界拿不到弹窗权"这条拍板的执行点。
    expect(sent).toEqual([])
    expect(pendingDeepLinkRequestCount()).toBe(0)
  })

  it('shows a card for the one rejection the user must hear about', () => {
    const big = 'a'.repeat(64 * 1024)
    expect(handleIncomingDeepLink(`onething://ask?text=${encodeURIComponent(big)}`)).toBe('delivered')
    expect(lastRequest().card.kind).toBe('rejected')
    // 拒绝卡不进 pending —— 它没有"确认"可按,留着只是给自己攒一份可被误答的状态。
    expect(pendingDeepLinkRequestCount()).toBe(0)
  })

  it('drops everything when there is no window to show the card on', () => {
    configureDeepLinkService({
      getMainWindow: () => null,
      activateMainWindow: () => false,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    expect(handleIncomingDeepLink('onething://ask?text=hi')).toBe('no-window')
    expect(sent).toEqual([])
  })
})

describe('H4 confirmation gate — 无确认不投递', () => {
  it('focuses the window and asks, but dispatches nothing on its own', () => {
    expect(handleIncomingDeepLink('onething://x/translator/translate?text=hi')).toBe('delivered')

    expect(activated).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(IPC_CHANNELS.DEEPLINK_REQUEST)
    expect(lastRequest().card).toMatchObject({
      kind: 'plugin',
      pluginName: 'Translator',
      actionTitle: 'Translate the selection',
      text: 'hi',
    })
    // 这是重点:卡推出去了,**handler 一次都没被调用**。
    expect(invokePluginDeepLinkAction).not.toHaveBeenCalled()
  })

  it('cancel means nothing happens — and the id is spent', async () => {
    handleIncomingDeepLink('onething://x/translator/translate?text=hi')
    const { requestId } = lastRequest()

    await expect(respondToDeepLink({ requestId, approved: false }))
      .resolves.toEqual({ success: true, dispatched: false })
    expect(invokePluginDeepLinkAction).not.toHaveBeenCalled()

    // 答过的 id 不能再答:否则"取消"之后还留着一条可被重放的授权。
    await expect(respondToDeepLink({ requestId, approved: true }))
      .resolves.toMatchObject({ success: false })
    expect(invokePluginDeepLinkAction).not.toHaveBeenCalled()
  })

  it('refuses an unknown or forged requestId', async () => {
    await expect(respondToDeepLink({ requestId: 'made-up', approved: true }))
      .resolves.toMatchObject({ success: false })
    expect(invokePluginDeepLinkAction).not.toHaveBeenCalled()
  })
})

describe('H4 confirmation gate — 确认之后', () => {
  it('hands ask back to the renderer as data, agent and all', async () => {
    handleIncomingDeepLink('onething://ask?text=summarise%20this&agent=writer')
    const { requestId } = lastRequest()

    const response = await respondToDeepLink({ requestId, approved: true })
    expect(response).toEqual({
      success: true,
      dispatched: true,
      ask: { text: 'summarise this', agentId: 'writer' },
    })
    // ask 不在主进程跑 —— 它要既建会话又打开它,而那只有渲染层知道怎么做。
    expect(invokePluginDeepLinkAction).not.toHaveBeenCalled()
  })

  it('passes { text, params } to the plugin action and relays its notice', async () => {
    invokePluginDeepLinkAction.mockResolvedValue({ ok: true, notice: 'Translated' })
    handleIncomingDeepLink('onething://x/translator/translate?text=bonjour&to=zh')
    const { requestId } = lastRequest()

    const response = await respondToDeepLink({ requestId, approved: true })

    expect(invokePluginDeepLinkAction).toHaveBeenCalledWith('translator', 'translate', {
      text: 'bonjour',
      params: { to: 'zh' },
    })
    expect(response).toEqual({ success: true, dispatched: true, notice: 'Translated' })
  })

  it('reports a failing plugin action instead of pretending it worked', async () => {
    invokePluginDeepLinkAction.mockResolvedValue({ ok: false, reason: 'failed', detail: 'boom' })
    handleIncomingDeepLink('onething://x/translator/translate?text=hi')
    const { requestId } = lastRequest()

    await expect(respondToDeepLink({ requestId, approved: true }))
      .resolves.toEqual({ success: false, dispatched: true, error: 'boom' })
  })

  it('shows a refusal instead of a confirm when the action is gone', () => {
    describePluginDeepLinkAction.mockReturnValue(null)
    handleIncomingDeepLink('onething://x/translator/translate?text=hi')
    // 让用户确认一个不会发生的动作,比直接说"它不在了"更坏。
    expect(lastRequest().card.kind).toBe('rejected')
    expect(pendingDeepLinkRequestCount()).toBe(0)
  })
})
