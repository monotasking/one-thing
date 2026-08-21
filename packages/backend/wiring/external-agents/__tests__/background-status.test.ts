/**
 * **电平 → 状态格子**的验收(装配层翻译),2026-08-11。
 *
 * 连接器只报电平,文案与三态的判据全在这里,所以这一层的断言就是"用户在气泡里
 * 会看到哪一行字、界面据什么决定走秒还是定格"。
 */
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_AGENT_BACKGROUND_STATUS_ID,
  buildExternalAgentBackgroundStatusPart,
} from '../background-status.js'

const base = {
  connectorId: 'claude-code-agent',
  localSessionId: 'exec-1',
  startedAt: 1_700_000_000_000,
}

describe('后台电平翻译成流内状态格子', () => {
  it('running:说人话、带起始墙钟、不带 durationMs', () => {
    const part = buildExternalAgentBackgroundStatusPart({ ...base, phase: 'running', count: 1 })

    expect(part).toEqual({
      type: 'plugin-status',
      pluginId: 'claude-code-agent',
      id: EXTERNAL_AGENT_BACKGROUND_STATUS_ID,
      label: '后台子代理运行中',
      startedAt: base.startedAt,
    })
    // durationMs 缺席 = 还在跑。它一出现就意味着定格,所以这里**必须**是缺席
    // 而不是 undefined:后者会让 `'durationMs' in part` 为真。
    expect('durationMs' in part).toBe(false)
  })

  it('running 多个任务:数目进文案', () => {
    const part = buildExternalAgentBackgroundStatusPart({ ...base, phase: 'running', count: 3 })
    expect(part.label).toBe('后台子代理运行中 · 3 个任务')
  })

  it('settled 归零:完成态 + 定格总耗时', () => {
    const part = buildExternalAgentBackgroundStatusPart({
      ...base, phase: 'settled', count: 0, elapsedMs: 83_400,
    })
    expect(part.label).toBe('后台子代理已完成')
    expect(part.durationMs).toBe(83_400)
    // 起点仍然带着 —— 渲染侧靠 durationMs 判定格,startedAt 是同一条记录的一部分。
    expect(part.startedAt).toBe(base.startedAt)
  })

  it('settled 但仍有残留:如实说没收尾,不假装完成', () => {
    const part = buildExternalAgentBackgroundStatusPart({
      ...base, phase: 'settled', count: 2, elapsedMs: 1_000,
    })
    expect(part.label).toBe('后台子代理未收尾 · 2 个仍在运行')
    expect(part.durationMs).toBe(1_000)
  })

  it('settled 少了 elapsedMs:定格成 0,而不是变回"在跑"', () => {
    // durationMs 是"已结算"的唯一判据。这里退回 undefined 的话,一条收场事件
    // 会让状态条重新开始走秒 —— 那正是这一期要消灭的坏结局。
    const part = buildExternalAgentBackgroundStatusPart({ ...base, phase: 'settled', count: 0 })
    expect(part.durationMs).toBe(0)
  })

  it('负的 elapsedMs(时钟回拨)被夹到 0', () => {
    const part = buildExternalAgentBackgroundStatusPart({
      ...base, phase: 'settled', count: 0, elapsedMs: -5,
    })
    expect(part.durationMs).toBe(0)
  })

  it('整条会话只占一格:id 恒定,所以重复投递是更新而不是追加', () => {
    const first = buildExternalAgentBackgroundStatusPart({ ...base, phase: 'running', count: 1 })
    const second = buildExternalAgentBackgroundStatusPart({ ...base, phase: 'running', count: 2 })
    expect(first.id).toBe(second.id)
    expect(first.pluginId).toBe(second.pluginId)
  })
})
