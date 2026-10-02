/**
 * 顺序模式(接力)的全部规则 —— 纯函数(docs/design/collab-speaking-order.md)。
 *
 * 房间有两种响应模式:
 *  - **并行**(缺省,现状):每条真实消息买一轮意愿判定,愿意说的人并行开口;
 *  - **顺序**(接力):**不买判定**,棒子沿一个固定的环依次传,轮到谁谁说。
 *
 * 接力存在的理由是一个验收用例:四人房里说一句「按顺序从 1 数到 10」。判定形态
 * 下这件事的成败取决于连续约 30 次独立 yes/no 全部答对,任何一个 no 都让计数
 * 静默停住;接力把它变成确定性的环。设计文档 §1 有完整推演。
 *
 * 这个文件里没有 I/O、没有模型调用、也不认识 `CollabActivationRecord`(那是装配
 * 层的类型,产品层不能反向依赖)。装配层喂事实进来,拿决定回去。
 */
import type { CollabAgentLike } from './types.js'

/** 判定要读的房间配置字段 —— 最小结构类型,与 `dm.ts` 同一条纪律。 */
export interface CollabRelayRoomLike {
  /**
   * `'auto'`(缺省)= 协调器每轮现场编排(collab-coordinator-plan.md);
   * `'serial'` / `'parallel'` = 用户强制,协调器不得违背。
   */
  responseMode?: 'auto' | 'parallel' | 'serial'
  speakOrder?: readonly string[]
  relayLoops?: number
  dm?: boolean
}

/**
 * 这间房走**编排**吗(collab-coordinator-plan.md)。
 *
 * 两档走:`auto` 问协调器要一份,`serial` 由本地按次序表合成一份 —— 强制顺序
 * 因此不是另一套机制,而是"一份所有 wave 都只有一个人的编排",于是执行器只有
 * 一套。
 *
 * **缺省(未配)走的是并行,不是 auto。** 设计里写的是"auto 作新默认",而这一版
 * 刻意没有跟着翻:机制和默认翻转放进同一个改动,任何一个 bug 都会一次性铺满每
 * 一间既有房间 —— 而编排是一次模型调用换掉 N 次判定,失误面完全不同。先让它可
 * 显式打开、真机跑过,再谈翻默认。
 *
 * 私聊房排除在外:单成员房用户开口即免判激活唯一那位,双成员房 agent 开口即
 * 激活对面 —— 两种形态本来就是"依次",再套一层编排只会多一次模型调用。
 */
export function isCollabPlanRoom(room: CollabRelayRoomLike | null | undefined): boolean {
  if (room?.dm === true) return false
  return room?.responseMode === 'auto' || room?.responseMode === 'serial'
}

/** 用户把模式钉死成顺序了吗 —— 钉死时不问协调器,本地按次序表合成编排。 */
export function isCollabForcedSerialRoom(room: CollabRelayRoomLike | null | undefined): boolean {
  return room?.responseMode === 'serial' && room?.dm !== true
}

/**
 * 强制顺序模式的**本地合成编排**:次序表(或名册序)展开成 N 个单人批,循环。
 *
 * 这是 waves 吃掉「模式」这个概念的地方 —— 用户钉死的"顺序"不再是执行器的另一
 * 条分支,而是一份不问模型就能写出来的编排。`buildCollabRelayRing` 因此不退役:
 * 它从"接力环的构造"变成"这一份编排怎么排"。
 *
 * `cycle: true` 是对的:钉死顺序的房间要的正是"一直轮下去,直到没人接"。
 * 什么时候停仍然由终止条件回答(走满一整轮全静默 / 圈数天花板 / 链闸 / 喊停)。
 */
export function synthesizeCollabSerialPlan(options: {
  speakOrder?: readonly string[]
  members: readonly CollabAgentLike[]
  /** 被 @ 的人排到最前 —— 「点名必须能应」在合成这一路同样成立。 */
  mentionedAgentIds?: readonly string[]
}): { waves: string[][]; cycle: boolean; why: string } {
  const ring = buildCollabRelayRing({
    speakOrder: options.speakOrder,
    members: options.members,
  })
  if (ring.length === 0) return { waves: [], cycle: false, why: '' }
  const starter = pickCollabRelayStarter(ring, options.mentionedAgentIds)
  const offset = starter ? Math.max(0, ring.indexOf(starter)) : 0
  const ordered = [...ring.slice(offset), ...ring.slice(0, offset)]
  return {
    waves: ordered.map(agentId => [agentId]),
    cycle: true,
    why: '按房间设定的次序依次发言',
  }
}

/**
 * 一趟接力最多跑几圈。缺省 **0 = 不限**(与 `maxChain` / `dailyCostUSD` 那族闸
 * 同一套约定),靠"一圈静默"与链长闸收尾。
 *
 * 缺省取不限而不是 1,是因为选顺序模式的动机是"让他们把一件事走完",而不是
 * "每人表个态"——后者并行模式已经覆盖了。负数按没配处理。
 */
export function collabRelayLoopsFor(room: CollabRelayRoomLike | null | undefined): number {
  const configured = room?.relayLoops
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) return 0
  return Math.floor(configured)
}

/**
 * 接力环:`speakOrder` 里还在册的那些(按列表次序),后面接上没列进去的成员
 * (按名册次序)。
 *
 * 三条纪律(设计 §3④):
 *  - 列表定义的是**已列出者的相对次序**,不是准入名单 —— 新拉进房的人不改列表
 *    也能进环,否则每加一个人就要记得回来改一次设置;
 *  - 列表里已退休/已离房的 id **读时忽略,不清理** —— 与 `memberAgentIds` 保留
 *    退休成员同一纪律:数据不动,他被拉回来时次序还在;
 *  - 列表空/未配 → 直接就是名册序,所以顺序模式**开箱可用**,列表是可选精调。
 *
 * `members` 由调用方按在职过滤(`roomMembers`),这里只做次序。
 */
export function buildCollabRelayRing(options: {
  speakOrder?: readonly string[]
  members: readonly CollabAgentLike[]
}): string[] {
  const memberIds = options.members.map(member => member.id)
  const inRoom = new Set(memberIds)
  const listed: string[] = []
  const seen = new Set<string>()
  for (const agentId of options.speakOrder ?? []) {
    if (!inRoom.has(agentId) || seen.has(agentId)) continue
    seen.add(agentId)
    listed.push(agentId)
  }
  return [...listed, ...memberIds.filter(agentId => !seen.has(agentId))]
}

/**
 * 起棒:@ 到的人里**在环上最靠前的那位**,没有 @ 就是环首(设计 §3①)。
 *
 * 取"环上最靠前"而不是"消息里写在最前" —— 一次 @ 三个人时,次序该由房间配置
 * 决定,而不是由用户敲字的顺序决定,后者正是这个列表要消除的东西。
 */
export function pickCollabRelayStarter(
  ring: readonly string[],
  mentionedAgentIds?: readonly string[],
): string | undefined {
  if (ring.length === 0) return undefined
  const mentioned = new Set(mentionedAgentIds ?? [])
  if (mentioned.size > 0) {
    const named = ring.find(agentId => mentioned.has(agentId))
    if (named) return named
  }
  return ring[0]
}

// 传棒/收棒那半套(`pickCollabRelayNext` / `shouldPassCollabRelayBaton` /
// `isCollabRelayRoom`)已随 waves 编排删除:顺序模式的执行走
// `synthesizeCollabSerialPlan` → plan-runner,终止条件由 `advanceCollabPlan`
// (plan.ts)回答 —— 那里的静默收尾/圈数闸语义与被删的这半套一字不差。
