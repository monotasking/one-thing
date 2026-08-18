/**
 * R1 软隔离验收之二:一个挂起的 promptContextProvider 不阻塞消息发送路径。
 *
 * 这条测试住在产品层(而不是装配层的 app/plugins/__tests__)—— collectPluginPromptContext
 * 是 prompts 的注册表,守卫 "plugin logic stays out of the host assembly tree"
 * 要求装配层的测试不伸手进产品层。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAllPromptContextProviders,
  collectPluginPromptContext,
  registerPromptContextProvider,
} from '../index.js'

afterEach(() => {
  clearAllPromptContextProviders()
})

describe('collectPluginPromptContext timeout budget', () => {
  it('drops a hanging provider and still returns the other fragments', async () => {
    registerPromptContextProvider('hanging-plugin', 'stuck', () => new Promise(() => {}))
    registerPromptContextProvider('good-plugin', 'fast', () => 'fast fragment')

    const failures: Array<{ pluginId: string; timedOut: boolean }> = []
    const started = Date.now()
    const fragments = await collectPluginPromptContext({ hasTools: true, skills: [] }, {
      timeoutMs: 25,
      onProviderFailure: failure => failures.push({ pluginId: failure.pluginId, timedOut: failure.timedOut }),
    })

    // pluginId/providerId are stamped by the collector — they are the turn
    // block's dedupe identity, so they must be present and not plugin-supplied.
    expect(fragments).toEqual([{
      pluginId: 'good-plugin',
      providerId: 'fast',
      role: 'developer',
      source: 'plugins/good-plugin/fast',
      content: 'fast fragment',
    }])
    expect(failures).toEqual([{ pluginId: 'hanging-plugin', timedOut: true }])
    // 提示词装配确实返回了 —— 这才是"发消息不被插件钉死"的字面意思。
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  /**
   * 成功也要上报,否则 promptContext 这条车道的连败计数只增不减:
   * 一个偶发超时会跨天累加成误禁。
   */
  it('reports a success for every provider that returns', async () => {
    const successes: string[] = []
    registerPromptContextProvider('good-plugin', 'fast', () => 'fragment')
    registerPromptContextProvider('quiet-plugin', 'empty', () => null)

    await collectPluginPromptContext({ hasTools: true, skills: [] }, {
      onProviderSuccess: success => successes.push(`${success.pluginId}/${success.providerId}`),
    })

    expect(successes).toEqual(['good-plugin/fast', 'quiet-plugin/empty'])
  })
})
