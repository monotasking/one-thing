/**
 * A0-3:core 不再内置任何 provider 名字,「acp 的上下文归它自己管」
 * 这条事实只能来自 runtime 执行器注册表的模块加载登记。这里守的是装配入口:只 import
 * `backend.ts`,压缩门就必须已经认得它 —— 否则引擎会去压缩一个它根本管不着的会话。
 */
import { describe, expect, it } from 'vitest'

describe('provider execution facts reach core through the assembly entry', () => {
  it('importing backend.ts registers the external executors before any compaction decision', { timeout: 60_000 }, async () => {
    await import('../backend.js')
    const { coreProviderOwnsItsContextWindow, isCoreExternalAgentProvider } = await import('../agent-loop/agent-loop-external-agent-providers.js')
    expect(coreProviderOwnsItsContextWindow('acp')).toBe(true)
    expect(isCoreExternalAgentProvider('acp')).toBe(true)
    expect(coreProviderOwnsItsContextWindow('deepseek')).toBe(false)
  })
})
