/**
 * 越层清零 C2(2026-10-04):执行器表并进 agent-loop 之后,压缩门与鉴权豁免要问的两条事实
 * **不再依赖谁先加载了 agent 的执行器注册表**。
 *
 * 从前 `acp: external / theirs` 这一行只在 `agent/executor/agent-executor-registry.ts` 被加载时
 * 才由一句加载期副作用抄进 agent-loop 的登记表;没加载它的进程里问 `isCoreExternalAgentProvider('acp')`
 * 得 false。这只测试刻意只引 agent-loop 自己的文件,钉住「表就在这里」。
 */
import { describe, expect, it } from 'vitest'
import {
  coreProviderOwnsItsContextWindow,
  findAgentExecutorDescriptor,
  getCoreProviderExecution,
  isCoreExternalAgentProvider,
  isExternalAgentExecutorId,
  registerCoreProviderExecution,
} from '../agent-loop-external-agent-providers.js'

describe('执行器表住在 agent-loop(越层清零 C2)', () => {
  it('不加载 agent 也认得 acp 是外部执行体、上下文归它自己管', () => {
    expect(isCoreExternalAgentProvider('acp')).toBe(true)
    expect(coreProviderOwnsItsContextWindow('acp')).toBe(true)
    expect(isExternalAgentExecutorId('acp')).toBe(true)
    expect(findAgentExecutorDescriptor('acp')?.capabilities.persona).toBe('prepend')
  })

  it('本地与未登记的 provider 照旧是本地引擎 + 我们管上下文', () => {
    expect(getCoreProviderExecution('local')).toEqual({ kind: 'local', contextWindow: 'ours' })
    expect(getCoreProviderExecution('deepseek')).toEqual({ kind: 'local', contextWindow: 'ours' })
    expect(isExternalAgentExecutorId('deepseek')).toBe(false)
  })

  it('登记行优先于内置行,但不改执行器描述(鉴权豁免问的是描述)', () => {
    const providerId = '__test-c2-executor__'
    registerCoreProviderExecution(providerId, { kind: 'external', contextWindow: 'theirs' })
    expect(isCoreExternalAgentProvider(providerId)).toBe(true)
    expect(findAgentExecutorDescriptor(providerId)).toBeUndefined()
    expect(isExternalAgentExecutorId(providerId)).toBe(false)
    registerCoreProviderExecution(providerId, { kind: 'local', contextWindow: 'ours' })
    expect(isCoreExternalAgentProvider(providerId)).toBe(false)
  })
})
