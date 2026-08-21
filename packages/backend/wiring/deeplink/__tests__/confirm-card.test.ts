/**
 * H4 确认卡的内容 —— **卡上不出现裸 id,说不了的事就说不能做**。
 *
 * 这一套盯的是两类谎:一类是让用户以为他点名的那个 agent 在答(而实际回落了
 * 默认),一类是让用户确认一个不会发生的动作(插件已停用 / 动作被熔断)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDeepLink } from '@onething/core/plugins'

const findAgent = vi.hoisted(() => vi.fn())
const defaultAgent = vi.hoisted(() => vi.fn())
const describePluginDeepLinkAction = vi.hoisted(() => vi.fn())
const getPluginManager = vi.hoisted(() => vi.fn())

vi.mock('../../agents/index.js', () => ({ findAgent, defaultAgent }))
vi.mock('../../plugins/manager.js', () => ({ getPluginManager }))
vi.mock('../registry.js', () => ({ describePluginDeepLinkAction }))

import { buildDeepLinkCard } from '../confirm-card.js'

beforeEach(() => {
  vi.clearAllMocks()
  findAgent.mockReturnValue(null)
  defaultAgent.mockReturnValue({ id: 'default', name: 'onething' })
  describePluginDeepLinkAction.mockReturnValue(null)
  getPluginManager.mockReturnValue(null)
})

describe('H4 confirm card — ask', () => {
  it('names the agent it found', () => {
    findAgent.mockReturnValue({ id: 'writer', name: 'Ada' })
    const card = buildDeepLinkCard(parseDeepLink('onething://ask?text=hi&agent=writer'))
    expect(card).toEqual({ kind: 'ask', text: 'hi', agentId: 'writer', agentName: 'Ada' })
  })

  it('says out loud that it fell back — never impersonates the requested agent', () => {
    // findAgent 是严格查找:它不冒充 default(那是 getAgent 的行为)。回落这件事
    // 由我们做,并且**必须写在卡上**,否则用户会以为他点名的那个人在答。
    const card = buildDeepLinkCard(parseDeepLink('onething://ask?text=hi&agent=ghost'))
    expect(card).toMatchObject({
      kind: 'ask',
      agentFallbackFrom: 'ghost',
      defaultAgentName: 'onething',
    })
    expect(card).not.toHaveProperty('agentId')
  })

  it('survives an agent store that is not up yet', () => {
    defaultAgent.mockImplementation(() => { throw new Error('not initialized') })
    const card = buildDeepLinkCard(parseDeepLink('onething://ask?text=hi&agent=ghost'))
    // 名字说不出来就不说,但"回落了"这件事照说。
    expect(card).toMatchObject({ kind: 'ask', agentFallbackFrom: 'ghost' })
    expect(card).not.toHaveProperty('defaultAgentName')
  })

  it('carries the full text — no truncation at the card boundary', () => {
    const long = 'x'.repeat(10_000)
    const card = buildDeepLinkCard(parseDeepLink(`onething://ask?text=${encodeURIComponent(long)}`))
    expect(card?.kind === 'ask' && card.text).toHaveLength(10_000)
  })
})

describe('H4 confirm card — 插件动作', () => {
  it('shows the plugin display name and the action title, never the ids', () => {
    describePluginDeepLinkAction.mockReturnValue({
      pluginId: 'trans', name: 'translate', address: 'plugin:trans:translate',
      title: 'Translate the selection', degraded: false,
    })
    getPluginManager.mockReturnValue({
      getPlugins: () => [{ definition: { id: 'trans', manifest: { name: '划词翻译' } } }],
    })

    const card = buildDeepLinkCard(parseDeepLink('onething://x/trans/translate?text=bonjour&to=zh'))
    expect(card).toMatchObject({
      kind: 'plugin',
      pluginName: '划词翻译',
      actionTitle: 'Translate the selection',
      params: { to: 'zh' },
    })
  })

  it('falls back to the id only when the manifest name is unreachable', () => {
    describePluginDeepLinkAction.mockReturnValue({
      pluginId: 'trans', name: 'translate', address: 'plugin:trans:translate',
      title: 'T', degraded: false,
    })
    const card = buildDeepLinkCard(parseDeepLink('onething://x/trans/translate?text=x'))
    expect(card).toMatchObject({ kind: 'plugin', pluginName: 'trans' })
  })

  it('refuses instead of confirming when nobody registered the action', () => {
    const card = buildDeepLinkCard(parseDeepLink('onething://x/trans/translate?text=x'))
    expect(card).toMatchObject({ kind: 'rejected', reason: 'action-unavailable' })
  })

  it('refuses while the action is degraded — greyed out, said out loud', () => {
    describePluginDeepLinkAction.mockReturnValue({
      pluginId: 'trans', name: 'translate', address: 'plugin:trans:translate',
      title: 'Translate', degraded: true,
    })
    const card = buildDeepLinkCard(parseDeepLink('onething://x/trans/translate?text=x'))
    expect(card).toMatchObject({ kind: 'rejected', reason: 'action-degraded' })
    expect(card?.kind === 'rejected' && card.message).toContain('Translate')
  })
})

describe('H4 confirm card — 弹窗权不外包', () => {
  it('returns null for every rejection except the one the user must hear', () => {
    for (const url of [
      'https://evil.example/ask?text=hi',
      'onething://run?text=x',
      'onething://ask',
      'onething://x/a/b/c?text=x',
      'onething://x/trans/BAD?text=x',
      'nonsense',
    ]) {
      expect(buildDeepLinkCard(parseDeepLink(url)), url).toBeNull()
    }
  })

  it('returns a refusal card for over-long text', () => {
    const big = 'a'.repeat(64 * 1024)
    const card = buildDeepLinkCard(parseDeepLink(`onething://ask?text=${encodeURIComponent(big)}`))
    expect(card).toMatchObject({ kind: 'rejected', reason: 'text-too-long' })
    expect(card?.kind === 'rejected' && card.message).toContain('32KB')
  })
})
