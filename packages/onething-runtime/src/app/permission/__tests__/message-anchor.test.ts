/**
 * 审批卡的消息锚:**永远给一条渲染侧真的拿得到的消息**。
 *
 * 病理(2026-08-11,SDK 线冻结前收口):渲染侧落卡要过两道闸 —— 先按 messageId 找
 * 消息,再按 callId 找 toolCall。第 2 道闸有领养兜底(嵌套 `parent_tool_use_id` 的
 * 后台子代理调用压根没有工具卡,靠它接住);第 1 道闸**没有兜底也不自愈** ——
 * 缓存只在"那条消息被创建"时唤醒,一个永不被创建的 messageId(`?? ''`)就是永久静默:
 * 后端挂着等审批,前端一张卡都不出。
 *
 * 两条外部通路从前各写一份逐字相同、且各自以 `?? ''` 收尾的解析器。这里钉的是合成后的
 * 单一所有者:除非会话真的一条消息都没有,否则它交出的锚必须在会话里找得到。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../session/testing/facade-mock.js'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { messages: { id: string; role: string }[] }>(),
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', () => import('../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
}))

const { resolvePermissionMessageAnchor } = await import('../message-anchor.js')

function seed(sessionId: string, messages: { id: string; role: string }[]): void {
  mocks.sessions.set(sessionId, { messages })
}

/** 「锚可解析」= 渲染侧按它 `messages.find(m => m.id === anchor)` 找得到。 */
function resolvableIn(sessionId: string, anchor: string): boolean {
  const messages = mocks.sessions.get(sessionId)?.messages ?? []
  return messages.some(message => message.id === anchor)
}

describe('resolvePermissionMessageAnchor', () => {
  beforeEach(() => {
    mocks.sessions.clear()
  })

  it('调用方给的锚存在 —— 原样采用', () => {
    seed('s1', [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant' },
    ])
    expect(resolvePermissionMessageAnchor('s1', 'a1')).toBe('a1')
  })

  it('调用方给的锚在会话里不存在(旧轮 / 执行会话 / 陈旧号)—— 换成拿得到的那条', () => {
    seed('s1', [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
    ])
    const anchor = resolvePermissionMessageAnchor('s1', 'm-from-another-turn')
    expect(anchor).toBe('a1')
    expect(resolvableIn('s1', anchor)).toBe(true)
  })

  it('没给锚 —— 取最新的 assistant 消息(卡本来就该长在那里)', () => {
    seed('s1', [
      { id: 'a1', role: 'assistant' },
      { id: 'u1', role: 'user' },
      { id: 'a2', role: 'assistant' },
      { id: 'u2', role: 'user' },
    ])
    expect(resolvePermissionMessageAnchor('s1')).toBe('a2')
  })

  it('一条 assistant 消息都还没有 —— 退到最后一条消息,而不是空串', () => {
    // 首轮:工具审批可以早于 assistant 消息落库。从前这里给出 `''`,
    // 卡就此永久静默 —— 这一条正是那个洞。
    seed('s1', [{ id: 'u1', role: 'user' }])
    const anchor = resolvePermissionMessageAnchor('s1')
    expect(anchor).toBe('u1')
    expect(anchor).not.toBe('')
    expect(resolvableIn('s1', anchor)).toBe(true)
  })

  it('会话一条消息都没有 —— 真空,原样退回(渲染侧此刻也没有可投影的载体)', () => {
    seed('s1', [])
    expect(resolvePermissionMessageAnchor('s1')).toBe('')
    expect(resolvePermissionMessageAnchor('s1', 'given')).toBe('given')
  })

  it('会话不存在 —— 不编造', () => {
    expect(resolvePermissionMessageAnchor('missing')).toBe('')
    expect(resolvePermissionMessageAnchor('missing', 'given')).toBe('given')
  })

  it('回归闸:只要会话有消息,交出的锚就必须在会话里找得到', () => {
    const shapes: { id: string; role: string }[][] = [
      [{ id: 'u1', role: 'user' }],
      [{ id: 'a1', role: 'assistant' }],
      [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }],
      [{ id: 'a1', role: 'assistant' }, { id: 'u1', role: 'user' }],
      [{ id: 's1', role: 'system' }, { id: 'u1', role: 'user' }],
    ]
    const preferreds = [undefined, '', 'nope', 'a1', 'u1']

    for (const messages of shapes) {
      for (const preferred of preferreds) {
        seed('s1', messages)
        const anchor = resolvePermissionMessageAnchor('s1', preferred)
        expect(resolvableIn('s1', anchor)).toBe(true)
      }
    }
  })
})
