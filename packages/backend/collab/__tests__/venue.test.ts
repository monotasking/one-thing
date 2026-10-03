/**
 * 场子(venue)判定与一览表(架构收敛 C3-6)。
 *
 * 这是四个工具的门此前各手写一份的那句 if,现在只有这一份实现。测试要钉住的
 * 不是"函数会不会返回",而是**归一化的方向**:认不出的 kind 一律算普通对话。
 * 反过来写(「不是 chat 就放行」)就是 A3 那个洞 —— 网关按远端身份建出来的会话
 * `kind` 为空,那样写等于给陌生人开门。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_TOOL_VENUES,
  COLLAB_WORK_REQUIRED_TOOLS,
  collabVenueLinksRoom,
  isCollabToolAllowedInVenue,
  resolveCollabVenue,
  type CollabVenueTool,
} from '../tool-surface.js'

describe('resolveCollabVenue —— 归一化只有一个方向', () => {
  it('三个协作 kind 原样通过', () => {
    expect(resolveCollabVenue('room')).toBe('room')
    expect(resolveCollabVenue('agent')).toBe('agent')
    expect(resolveCollabVenue('work')).toBe('work')
  })

  it('缺席 / 空串 / 认不出的一律算普通对话', () => {
    // 网关(微信/Telegram)按远端身份建的会话就是第一行这个形状。
    expect(resolveCollabVenue(undefined)).toBe('chat')
    expect(resolveCollabVenue(null)).toBe('chat')
    expect(resolveCollabVenue('')).toBe('chat')
    expect(resolveCollabVenue('chat')).toBe('chat')
    expect(resolveCollabVenue('branch')).toBe('chat')
    expect(resolveCollabVenue('ROOM')).toBe('chat')
  })
})

describe('collabVenueLinksRoom —— 谁的 collab.roomSessionId 作数', () => {
  it('只有 work 与 agent 挂着一间房', () => {
    expect(collabVenueLinksRoom('work')).toBe(true)
    expect(collabVenueLinksRoom('agent')).toBe(true)
    // 房场子的房是它自己(调用点的事实),chat 根本没有房。
    expect(collabVenueLinksRoom('room')).toBe(false)
    expect(collabVenueLinksRoom('chat')).toBe(false)
  })
})

describe('COLLAB_TOOL_VENUES —— 声明式一览', () => {
  const tools = Object.keys(COLLAB_TOOL_VENUES) as CollabVenueTool[]

  it('每个协作工具都在 agent / work 里成立,普通对话里一个都不成立', () => {
    for (const tool of tools) {
      expect(isCollabToolAllowedInVenue(tool, 'agent')).toBe(true)
      expect(isCollabToolAllowedInVenue(tool, 'work')).toBe(true)
      expect(isCollabToolAllowedInVenue(tool, 'chat')).toBe(false)
    }
  })

  /**
   * 发送/看板/历史三件都开着 `room` 那一格,notebook 没有。
   *
   * 一工具一行、而不是一句「协作工具都是这三格」,理由正在这里:W18 之后房回合
   * 跑在执行会话(`agent` 场子)里,`room` 场子的会话不承载回合,所以 Collab v3
   * 的 notebook 从一开始就不需要那一格。合并写法会让这次「单独收紧」无处落笔。
   */
  it('房场子那一格不是所有工具都开:notebook 只在 agent / work', () => {
    for (const tool of ['send_message', 'board', 'history'] as CollabVenueTool[]) {
      expect(isCollabToolAllowedInVenue(tool, 'room')).toBe(true)
    }
    expect(isCollabToolAllowedInVenue('notebook', 'room')).toBe(false)
  })

  /**
   * 这条测试是那张表**不能从工具地板反推**的实证(C3-6 原方案设想过「一处声明
   * 两面消费」)。地板答「这个场子至少发几个工具」,门答「这个工具至多在哪些场子里
   * 成立」—— 不是互逆:工作台地板里没有 `history`,而工作台会话是可以查历史的。
   * 按地板推门会把它静静地关掉。
   */
  it('工作台地板不含 history,而 history 在工作台里是允许的', () => {
    expect(COLLAB_WORK_REQUIRED_TOOLS).not.toContain('history')
    expect(isCollabToolAllowedInVenue('history', 'work')).toBe(true)
  })
})
