/**
 * **中途追话的接线验收(装配层)**,2026-08-12。
 *
 * 连接器那一侧的机械归连接器自己的测试(ACP:`acp/__tests__/`);
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
import type { ExternalAgentSteerOutcome } from '@onething/backend/external-agent'

const mocks = vi.hoisted(() => ({
  /** E0 能力表里 acp 的 `steer`。 */
  descriptorSteer: true,
  /** 连接器自己声明的 `capabilities.steer`。 */
  connectorSteer: true,
  /** 下一次 `connector.steer` 的答复;字符串直接返回,Error 则抛。 */
  outcome: 'steered' as ExternalAgentSteerOutcome | Error,
  calls: [] as { sessionId: string; text: string }[],
}))

// 深层引用收口第四批(2026-10-04):连接器登记表改引兄弟文件(D126),不再经入口拿 `createAcpConnector`,
// 所以桩打在声明它的 `external-agent-acp-connector.ts` 上。
vi.mock('../external-agent-acp-connector.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createAcpConnector: () => ({
      id: 'acp',
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

vi.mock('@onething/backend/agent', () => ({
  findAgentExecutorDescriptor: (id: string) =>
    id === 'acp'
      ? { id, kind: 'external', capabilities: { steer: mocks.descriptorSteer } }
      : undefined,
}))

vi.mock('@onething/backend/session', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/session')>(),
  getSession: () => undefined,
}))
vi.mock('@onething/backend/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/settings')>(),
  getSettings: () => ({ network: {} }),
}))
vi.mock('@onething/backend/storage', async importOriginal => ({
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
// D191:读者改从 logging 入口拿 `writeAppLog`,替身随之打在入口上(从前打在 `logging-configure`)。
vi.mock('@onething/backend/logging', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/logging')>(),
  writeAppLog: vi.fn(),
  getLogger: () => noopLogger(),
  consolePort: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}))
vi.mock('../external-agent-host-tools.js', () => ({ resolveHostToolSurface: vi.fn() }))
vi.mock('@onething/backend/acp/acp-host-mcp-port', () => ({ createAcpHostMcpPort: () => ({}) }))

const { getExternalAgentConnectors, takeExternalAgentSteering } = await import('../external-agent-connector-registry.js')

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
