/**
 * 中途来消息怎么办 —— 一张显式路由表(docs/design/qm-collab-learnings.md §1.3 / P1-6)。
 *
 * 用户在一个房间里说话时,房间可能正有人在说。此前这件事的语义散在三处
 * (coordinator 的入队、turn 的回合窗口、引擎的 steering),谁都没有完整写下来,
 * 结果就是「连发两条」落进了最笨的那条路:第二条老老实实排在第一条的全部激活
 * 之后,而用户看到的是房间卡住。
 *
 * 这里把它收敛成一个纯函数。四个出口:
 *
 *   engage  另起一轮 —— 走完整的激活决策(@ 短路 + 意愿判定 + 入队)
 *   steer   并进当前回合 —— 正在说话的那位在下一个工具回合边界读到这条,
 *           两条一起答;**不**为这条消息另买判定
 *   abort   停 —— 中止在跑的回合,并作废还在队里的对话性激活
 *   drop    什么都不做
 *
 * 最重要的一条是默认值:**有人在说话时,默认 steer 而不是 abort**。真实 IM 里
 * 连发两条是最普通的行为(一句问题 + 一句补充),对方是读完两条再回,不是把
 * 第一条的回答撕掉重来。抢占只发生在用户明说「停」的时候。
 *
 * 第二重要的是那条 engage 例外:**新消息点了别人的名** —— 这时候不能 steer,
 * 否则正在说话的那位就替被点名的人把话答了。
 *
 * 这一条是本表相对 QM 的**收窄**,而不是照抄。QM 一个 scope 只有一个身份,所以
 * 它只需要问「在跑的是不是旁听回合」;我们一个房间有 N 位同事,「@ 谁」才是那个
 * 真正的判据 —— @ 的正是正在说话的这位,并进去是对的(它马上就会读到);@ 的是
 * 别人,那就必须另起一轮。
 */
import type { CollabActivationReason } from './activation.js'

export type CollabWakeRoute = 'engage' | 'steer' | 'abort' | 'drop'

/**
 * 「停」的词表 —— 整条消息就是这个词才算数。
 *
 * 刻意只认**裸的**停止词:一条「先停一下,我们改个方向」是有内容的话,它应该
 * 被读进当前回合(steer),而不是把回合杀掉后连内容都没人看。误杀一个正在跑的
 * 回合的代价,比多读一句话大得多。
 *
 * 标点在匹配前剥掉(「停!」「停。」都算),大小写归一(stop/STOP)。
 */
export const COLLAB_STOP_WORDS: readonly string[] = [
  'stop',
  '停',
  '停停',
  '停下',
  '停一下',
  '停止',
  '别说了',
  '打住',
  '住口',
  '闭嘴',
]

/** 匹配前剥掉的收尾标点与空白 —— 「停!」与「停」是同一个意思。 */
const TRIM_PUNCTUATION = /^[\s"'「」『』]+|[\s"'「」『』。.,,!!;;~～、]+$/g

/**
 * 词表匹配前再剥一层**语气/趋向后缀**。
 *
 * 2026-08-01 真机:用户打的是「stop掉。」——剥完标点是 `stop掉`,词表里没有,
 * 于是那次喊停整个失效:回合没中止、`floorEpoch` 没换代,队里 6 条对话性激活
 * 一条没作废,重启后原样复活,群里对着一段用户早就叫停的对话继续喊「天黑请闭眼」。
 *
 * 只剥**后缀**,不碰前缀:剥前缀会把「不要停」变成「停」,而那是相反的意思。
 * 一次剥一个、最多剥到词表命中为止,所以「停下来吧」→「停下来」→「停下」命中,
 * 而「停车场那个方案呢」剥不出任何词表项。
 */
const STOP_SUFFIXES: readonly string[] = ['吧', '啦', '了', '呀', '啊', '掉', '来', '下']

export function isCollabStopMessage(text: string | undefined): boolean {
  if (!text) return false
  let needle = text.replace(TRIM_PUNCTUATION, '').toLowerCase()
  if (!needle) return false
  // 逐个剥后缀,每剥一次都回头看词表。上限就是后缀个数 —— 剥空了自然停。
  for (let step = 0; step <= STOP_SUFFIXES.length; step++) {
    if (COLLAB_STOP_WORDS.includes(needle)) return true
    const suffix = STOP_SUFFIXES.find(candidate => needle.endsWith(candidate))
    if (!suffix || needle.length <= suffix.length) return false
    needle = needle.slice(0, -suffix.length)
  }
  return false
}

/** 房间当前那个回合的样子 —— 路由只需要这两件事。 */
export interface CollabLiveTurnLike {
  /** 正在说话的是谁。@ 的是不是这一位,决定了 steer 还是 engage。 */
  agentId?: string
  /** 这一轮是怎么被叫起来的。目前只用于诊断,规则不看它(见文件头的收窄)。 */
  reason?: CollabActivationReason
}

export interface RouteCollabRoomWakeOptions {
  /** 新到的这条用户消息的正文。 */
  text: string
  /** 这条消息 @ 到的成员 id(ingress 已解析过的 mentions)。 */
  mentionedAgentIds?: readonly string[]
  /**
   * 正文之外还带了东西(附件、图片)。一条只有附件的消息不是空消息 ——
   * 它有内容,只是没有字。
   */
  hasPayload?: boolean
  /**
   * 此刻正在跑的回合,**可以有多个**(房间回合已并行化)。空数组 = 没人在说话。
   */
  liveTurns?: readonly CollabLiveTurnLike[]
}

/**
 * 一条新到的用户消息,对**正在跑的那个回合**意味着什么。
 *
 * 注意这个函数只回答"拿在跑的回合怎么办",不回答"谁该应答这条消息" ——
 * 后者仍然是 `decideCollabActivations` + 意愿判定的活。engage 的含义就是
 * 「照常走那条路」。
 */
export function routeCollabRoomWake(options: RouteCollabRoomWakeOptions): CollabWakeRoute {
  const text = (options.text ?? '').trim()
  const mentioned = options.mentionedAgentIds ?? []
  const liveTurns = options.liveTurns ?? []

  // 空且无附件:没什么可传达的。没人在说话时仍然走 engage —— 空消息该不该激活
  // 是决策那一层的既有行为,这张表不改它。
  if (!text && !options.hasPayload) return liveTurns.length > 0 ? 'drop' : 'engage'

  // 裸「停」:无论有没有人在说话都是同一个意思。没人在说话时它什么也停不了,
  // 但 abort 分支同样会清掉还在队里的对话性激活 —— 那正是喊停期待的。
  if (isCollabStopMessage(text)) return 'abort'

  // 没人在说话 —— 本来就没有"中途"可言。
  if (liveTurns.length === 0) return 'engage'

  // 点到了**任何一个还没在说话的人**:另起一轮,那个人得被拉起来。并行之后这条
  // 判据就是它字面的样子 —— 被 @ 的人只要不在这组正在说话的人里,steer 就送不到
  // 它手上,而"点名必须能应"是不能让步的。
  const speaking = new Set(liveTurns.map(turn => turn.agentId).filter(Boolean))
  if (mentioned.some(agentId => !speaking.has(agentId))) return 'engage'

  // 其余:并进当前正在跑的那些回合。连发两条落在这里。
  return 'steer'
}
