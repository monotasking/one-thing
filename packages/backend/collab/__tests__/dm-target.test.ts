/**
 * `dm` 的 `to` 指的是谁(docs/design/agent-dm-user.md §3.1)。
 *
 * 三件事:用户可达(**即使没配资料**)、同事解析一字未改、重名时双双拒绝。
 * 最后一条是这个模块存在的理由 —— 用户句柄撞上某个 agent 时两个答案都成立,
 * 而 dm 发错人不可撤销,所以宁可拒绝也不猜。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
}))

vi.mock('../../store.js', () => ({
  getSettings: () => mocks.settings,
}))

const { resolveDmTarget } = await import('../dm-target.js')

const AGENTS = [
  { id: 'agent-3f9c1e2a0000', name: '小李' },
  { id: 'agent-77aa11bb0000', name: '阿明' },
]

beforeEach(() => {
  mocks.settings = { general: {} }
})

describe('用户目标', () => {
  it('两个常量词在空资料下也可达', () => {
    expect(resolveDmTarget('用户', AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
    expect(resolveDmTarget('user', AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
    expect(resolveDmTarget('USER', AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
  })

  it('配了资料后:名字 / 句柄 / #句柄 / 名字#句柄 四种写法都认', () => {
    mocks.settings = { general: { userProfile: { name: '一天', handle: 'yitian' } } }
    for (const written of ['一天', 'yitian', '#yitian', '一天#yitian', '@一天#yitian']) {
      expect(resolveDmTarget(written, AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
    }
  })

  it('以句柄为准:名字写的是旧的,句柄对上就算数', () => {
    mocks.settings = { general: { userProfile: { name: '一天', handle: 'yitian' } } }
    expect(resolveDmTarget('用户#yitian', AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
  })

  it('空 to 说清怎么写', () => {
    const result = resolveDmTarget('  ', AGENTS)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('用户')
  })
})

describe('同事目标(既有语义一字未改)', () => {
  it('裸名字唯一命中', () => {
    expect(resolveDmTarget('小李', AGENTS)).toEqual({
      ok: true,
      target: { kind: 'agent', agentId: 'agent-3f9c1e2a0000' },
    })
  })

  it('名字#句柄', () => {
    expect(resolveDmTarget('小李#3f9c1e2a', AGENTS)).toEqual({
      ok: true,
      target: { kind: 'agent', agentId: 'agent-3f9c1e2a0000' },
    })
  })

  it('查无此人的拒绝话术原样透传', () => {
    const result = resolveDmTarget('小王', AGENTS)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('花名册里没有「小王」这个人')
  })
})

describe('与同事重名:拒绝并列候选,绝不 default 冒充', () => {
  it('用户名字撞上某位同事的名字', () => {
    mocks.settings = { general: { userProfile: { name: '小李', handle: 'yitian' } } }
    const result = resolveDmTarget('小李', AGENTS)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('既是用户本人')
    expect(result.ok === false && result.error).toContain('小李#3f9c1e2a')
  })

  it('用户句柄撞上某位同事的句柄', () => {
    mocks.settings = { general: { userProfile: { name: '一天', handle: '3f9c1e2a' } } }
    const result = resolveDmTarget('3f9c1e2a', AGENTS)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('既是用户本人')
  })

  it('冲突时精确写法仍然通:`用户` 一定是人', () => {
    mocks.settings = { general: { userProfile: { name: '小李', handle: 'yitian' } } }
    expect(resolveDmTarget('用户', AGENTS)).toEqual({ ok: true, target: { kind: 'user' } })
  })
})
