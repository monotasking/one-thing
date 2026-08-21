/**
 * 双成员 dm 房的链长闸默认值(docs/design/agent-im-dm.md §3.3,IM P3)。
 *
 * 这个文件从前还盯着两件**接线**的事:一位成员 say 收尾之后对面被免判驱动、
 * 用户插话不免判。两件都随 v2 调度链一起删了(D6-b)—— 它们在 v3 不再是"协调器
 * 把纯规则接到级联上",而是房间发言策略自己的一档
 * (`collab/actors/floor-policy.ts` 的「私聊房免裁决」),而那一档的行为在**纯层**
 * 已经被逐条钉住:
 *
 *  - `collab/__tests__/agent-pair-dm.test.ts` —— 16 条,覆盖免判激活、@ 去重、
 *    用户插话不免判、退休对面、冻结房、群房行为守恒、链长走到上限;
 *  - `collab/actors/__tests__/floor-policy.test.ts` —— 「私聊房免裁决 —— 没有
 *    第二个人要排次序」。
 *
 * 留在这里的是**闸的默认值**:它读 `session.room`,是配置不是调度,住在
 * `room-runtime.ts` 里。纯层测不到它,因为默认值的分叉判据(双成员 + dm)要一份
 * 真的会话形状。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_DEFAULT_MAX_CHAIN,
  COLLAB_DM_PAIR_MAX_CHAIN,
} from '@onething/runtime/collab'
import { maxChainFor } from '../room-runtime.js'

interface RoomShape {
  memberAgentIds: string[]
  dm?: boolean
  budgets?: { maxChain?: number }
}

const chainFor = (room: RoomShape) =>
  maxChainFor({
    id: 'x',
    kind: 'room',
    room,
    messages: [],
  } as unknown as Parameters<typeof maxChainFor>[0])

describe('§3.3 链长闸默认值', () => {
  it('双成员 dm 房没配过 → 6(客套乒乓的机械止损)', () => {
    expect(chainFor({ memberAgentIds: ['fe', 'pm'], dm: true })).toBe(COLLAB_DM_PAIR_MAX_CHAIN)
    expect(COLLAB_DM_PAIR_MAX_CHAIN).toBe(6)
  })

  it('群房与单成员私聊房零变化 → 仍是默认 32', () => {
    expect(chainFor({ memberAgentIds: ['fe', 'pm'] })).toBe(COLLAB_DEFAULT_MAX_CHAIN)
    expect(chainFor({ memberAgentIds: ['fe'], dm: true })).toBe(COLLAB_DEFAULT_MAX_CHAIN)
  })

  it('显式配置压过默认值,0 仍是"不限"', () => {
    expect(chainFor({ memberAgentIds: ['fe', 'pm'], dm: true, budgets: { maxChain: 20 } })).toBe(20)
    expect(chainFor({ memberAgentIds: ['fe', 'pm'], dm: true, budgets: { maxChain: 0 } }))
      .toBe(Number.POSITIVE_INFINITY)
  })
})
