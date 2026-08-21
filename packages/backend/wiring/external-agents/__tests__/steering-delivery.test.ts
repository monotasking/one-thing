/**
 * **中途追话的接线验收(装配层)**,2026-08-12。
 *
 * 连接器那一侧的机械由 `external-agents/__tests__/claude-code-steering.test.ts` 管;
 * 这里管的是**接线**,而接线上只有一个真正会出人命的问题:
 *
 *   一条追话到底进了几条路?
 *
 * 进两条 = 模型把同一句话听两遍(连接器一遍、宿主队列在回合收尾后再一遍);
 * 进零条 = 用户插的话没了。所以三条用例全是围绕这个:
 *
 *  1. 连接器**接走了**(steered / queued 都算)→ 返回 true,引擎因此不入队;
 *  2. 连接器说 **unavailable** → 返回 false,退回宿主队列(= 改动前的行为);
 *  3. **能力位说了算** —— E0 表或连接器任一处翻成 false,就真的不再交给它。
 *     翻一行会改变行为,能力表因此不是一份没人读的文档(原则 5)。
 *
 * 外加一条纪律:投递抛异常时**降级成没接走**,不是让用户的一次插话炸掉整条
 * steering 通路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAgentSteerOutcome } from '@onething/runtime/external-agents'

const mocks = vi.hoisted(() => ({
  /** E0 能力表里 claude-code 的 `steer`。 */
  descriptorSteer: true,
  /** 连接器自己声明的 `capabilities.steer`。 */
  connectorSteer: true,
  /** 下一次 `connector.steer` 的答复;字符串直接返回,Error 则抛。 */
  outcome: 'steered' as ExternalAgentSteerOutcome | Error,
  calls: [] as { sessionId: string; text: string }[],
}))

vi.mock('@onething/runtime/external-agents', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createClaudeCodeConnector: () => ({
      id: 'claude-code-agent',
      get capabilities() {
        return { steer: mocks.connectorSteer, interrupt: true }
      },
      steer(sessionId: string, text: string) {
        mocks.calls.push({ sessionId, text })
        if (mocks.outcome instanceof Error) throw mocks.outcome
        return mocks.outcome
      },
      async *streamTurn() { /* 本文件不跑回合 */ },
      async interrupt() {},
      async dispose() {},
    }),
  }
})

vi.mock('@onething/runtime/agents', () => ({
  findAgentExecutorDescriptor: (id: string) =>
    id === 'claude-code-agent'
      ? { id, kind: 'external', capabilities: { steer: mocks.descriptorSteer } }
      : undefined,
}))

vi.mock('../../../store.js', () => ({
  getSession: () => undefined,
  getSettings: () => ({ network: {} }),
}))
vi.mock('@onething/runtime/storage', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getOnethingStorePath: () => '/tmp/onething-steer-test',
}))
const noopLogger = () => {
  const logger: Record<string, unknown> = {
    ns: 'test',
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
    isLevelEnabled: () => false,
  }
  logger.child = () => logger
  return logger
}
vi.mock('../../../logging/index.js', () => ({
  writeAppLog: vi.fn(),
  getLogger: () => noopLogger(),
  consolePort: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}))
vi.mock('../host-tools.js', () => ({ resolveClaudeCodeHostToolSurface: vi.fn() }))

const { getExternalAgentConnectors, takeExternalAgentSteering } = await import('../index.js')

describe('takeExternalAgentSteering', () => {
  beforeEach(() => {
    mocks.descriptorSteer = true
    mocks.connectorSteer = true
    mocks.outcome = 'steered'
    mocks.calls.length = 0
    // 建表(生产里由第一次外部回合建);不建表就没有连接器可问。
    getExternalAgentConnectors()
  })

  it.each<ExternalAgentSteerOutcome>(['steered', 'queued'])(
    '连接器报 %s = 接走了 → true,引擎不再入队',
    outcome => {
      mocks.outcome = outcome
      expect(takeExternalAgentSteering('exec-1', '插一句')).toBe(true)
      expect(mocks.calls).toEqual([{ sessionId: 'exec-1', text: '插一句' }])
    },
  )

  it('连接器报 unavailable → false,追话退回宿主队列', () => {
    mocks.outcome = 'unavailable'
    expect(takeExternalAgentSteering('exec-1', '插一句')).toBe(false)
    expect(mocks.calls).toHaveLength(1)
  })

  it('E0 能力表把 steer 翻成 false:连一次都不问', () => {
    mocks.descriptorSteer = false
    expect(takeExternalAgentSteering('exec-1', '插一句')).toBe(false)
    expect(mocks.calls).toHaveLength(0)
  })

  it('连接器自己声明接不住:连一次都不问', () => {
    mocks.connectorSteer = false
    expect(takeExternalAgentSteering('exec-1', '插一句')).toBe(false)
    expect(mocks.calls).toHaveLength(0)
  })

  it('投递抛异常 → 降级成没接走,不炸掉 steering 通路', () => {
    mocks.outcome = new Error('boom')
    expect(() => takeExternalAgentSteering('exec-1', '插一句')).not.toThrow()
    expect(takeExternalAgentSteering('exec-1', '插一句')).toBe(false)
  })
})
