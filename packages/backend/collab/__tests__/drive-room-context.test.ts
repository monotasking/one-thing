/**
 * drive 携带的房间内容（collab-agent-view-v3.md §2，V1）。
 *
 * v3 之前房间内容每回合**重新投影**成一块临时快照，执行会话自己的历史整份丢弃；
 * v3 之后它**跟着 drive 写进执行会话一次**。这个文件守的就是"写进去的是什么"：
 *
 *  - 首轮铺底带整段可见历史（含折叠行与摘要）；
 *  - 之后**只带未读** —— 更早的消息在更早的 drive 里已经进历史了，再带一遍
 *    就是把刚删掉的那种重复投影换个地方长回来；
 *  - 没有新东西就返回空串，让 drive 保持只有一行。
 */
import { describe, expect, it } from 'vitest'
import { buildCollabDriveRoomContext } from '../projection.js'
import { planCollabHistoryWindow } from '../history-window.js'
import type { CollabAgentLike, CollabMessageLike } from '../types.js'

const AT = new Date(2026, 7, 2, 12, 0, 0).getTime()
const DAY = 86_400_000

const AGENTS: CollabAgentLike[] = [
  { id: 'iris', name: 'Iris' },
  { id: 'bram', name: 'Bram' },
]

function say(id: string, agentId: string | undefined, content: string, at: number): CollabMessageLike {
  return {
    id,
    role: agentId ? 'assistant' : 'user',
    ...(agentId ? { agentId } : {}),
    content,
    timestamp: at,
    source: agentId ? 'collab-say' : 'text',
  } as CollabMessageLike
}

const MESSAGES: CollabMessageLike[] = [
  say('m1', undefined, '用户：开局', AT - 2 * DAY),
  say('m2', 'iris', 'Iris：我来当上帝', AT - 2 * DAY + 1),
  say('m3', 'bram', 'Bram：收到', AT - 1000),
  say('m4', undefined, '用户：继续，喊天黑', AT - 500),
]

function build(
  seenMessageId: string | undefined,
  opts: { historyTailCount?: number; scheduled?: string } = {},
) {
  const { scheduled, ...windowOpts } = opts
  const window = planCollabHistoryWindow({
    messages: MESSAGES,
    ...(seenMessageId ? { seenMessageId } : {}),
    selfAgentId: 'iris',
    now: AT,
    ...windowOpts,
  })
  return buildCollabDriveRoomContext({
    messages: MESSAGES,
    selfAgentId: 'iris',
    agents: AGENTS,
    userLabel: 'songyitian',
    userHandle: '666666',
    window,
    bootstrap: !seenMessageId,
    ...(scheduled ? { scheduled } : {}),
  })
}

describe('drive 携带的房间内容', () => {
  it('首轮铺底：整段可见历史都在，署名带句柄', () => {
    const block = build(undefined)
    expect(block).toContain('开局')
    expect(block).toContain('我来当上帝')
    expect(block).toContain('继续，喊天黑')
    // 署名是 `名字#句柄` —— agent 要从这里抄出 `dm to:` 用得上的 token
    expect(block).toContain('from="songyitian#666666"')
    expect(block).toContain('from="Iris#')
  })

  it('增量：只带未读，更早的一条都不重复', () => {
    // 读到 m2 为止 → m3/m4 是未读
    const block = build('m2')
    expect(block).toContain('收到')
    expect(block).toContain('继续，喊天黑')
    // 已经在更早的 drive 里进过历史的，绝不再带一遍
    expect(block).not.toContain('开局')
    expect(block).not.toContain('我来当上帝')
  })

  it('增量 · 没有未读 → 空串，drive 只剩那一行', () => {
    expect(build('m4')).toBe('')
  })

  /**
   * 编排点将的回合:激活理由是 `<Notification>` 上的一个**属性**,而不是一句对
   * 模型说的话(`<turn>` 指令块已整块删除)。零未读时它还负责让 drive 非空 ——
   * "被点到了但没有新消息"同样是数据,而一条空 drive 什么都不是。
   */
  it('点将 · 零未读 → 自闭合的 count="0" 块,而不是空串', () => {
    const block = build('m4', { scheduled: 'coordinator' })
    // C2-1:块上不再有 desc 说明属性(常量早已清空,渲染却还在写 ` desc=""`)。
    expect(block.startsWith('<Notification count=')).toBe(true)
    expect(block).toContain('count="0"')
    expect(block.endsWith('/>')).toBe(true)
    expect(block).toContain('seen_until=')
    expect(block).toContain('scheduled="coordinator"')
    // 不带 scheduled 的同一批入参仍然是空串(增量的老行为一个字没变)。
    expect(build('m4')).toBe('')
  })

  it('点将 · 有未读 → 属性挂在正常的未读块上', () => {
    const block = build('m2', { scheduled: 'coordinator' })
    expect(block).toContain('scheduled="coordinator"')
    expect(block).toContain('收到')
    expect(block).not.toContain('/>')
  })

  it('未读裹在 <Notification> 里，带 seen_until 锚点', () => {
    const block = build('m2')
    expect(block).toContain('<Notification')
    expect(block).toContain('seen_until=')
  })

  it('首轮铺底 · 折叠段存在时，折叠行必须在 —— 静默截断是最脏的失败形态', () => {
    const block = build(undefined, { historyTailCount: 0 })
    expect(block).toContain('<Folded count=')
    // 折叠掉的正文不在，但"这里少了东西"这个事实在
    expect(block).not.toContain('我来当上帝')
    expect(block).toContain('收到')
  })

  it('不套 <ChatRoom> 壳 —— 房名与花名册归 system prompt（v3 §6 决定 2）', () => {
    const block = build(undefined)
    expect(block).not.toContain('<ChatRoom')
    expect(block).not.toContain('<Members>')
  })

  it('自己说过的话也在里面 —— 它是历史的一部分，不是"我错过的"', () => {
    const block = build(undefined)
    expect(block).toContain('我来当上帝')
    // 但不该被标成未读（自己写的不算错过）
    const unreadPart = block.slice(block.indexOf('<Notification'))
    expect(unreadPart).not.toContain('我来当上帝')
  })
})
