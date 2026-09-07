/**
 * 跨房唤醒的兑现器 —— P1 唯一的新机械件
 * (docs/design/collab-send-channel-and-wake.md §3)。
 *
 * 缘起是狼人杀:上帝在私聊里发完身份牌,需要一个**机械保证**让玩家回到群里
 * 露面。措辞嘱咐(「看完请到群里报到」)不构成保证 —— 这是 W22 的结论,也是
 * 这个文件存在的全部理由。
 *
 * 三件事,按顺序:
 *
 *  - **登记**:`sendCollabDm` 送达且带 `wake` 时,记下(私聊房、对方、目标群、
 *    发起人、锚点消息);
 *  - **观察**:对方在那间私聊房里的**回合结束**。信号用的是 `collab:turn-active`
 *    的落边 —— 它就是 turn.ts 里那个回合窗口的 finally,per(房 × 人),已经
 *    存在,不需要为 wake 新造一个 settle 事件;
 *  - **兑现**:以**发起人**的身份,在目标群里发一条固定模板的 @ 消息(poke),
 *    随后显式入队激活对方。
 *
 * 为什么等 settle 而不是 dm 落库就兑现(§3.1 ③):立刻兑现会让群房回合与私聊
 * 回合竞速 —— 状态板还没写,群里那句「收到」就是空心的。120s 超时兜底:宁可
 * 对方还没准备好,也不能让发起方永远等不到那一声。激活在驱动侧被门拦掉(退休、
 * 预算、冻结)同样走超时那条路 —— 那些门都不发 `collab:turn-active`。
 *
 * **进程内存活即可**(§3.2):不做跨重启持久化。wake 是秒级跟手的事,重启丢一
 * 个 pending 的代价是"上帝再 @ 一声",不值得一张持久化表。
 */
import {
  formatCollabAgentHandle,
  formatCollabWakePoke,
} from '@onething/runtime/collab'
import { getEventBus } from '../../events/index.js'
import { findAgent } from '../agents/index.js'
import { speakIntoCollabRoom } from './say-tool.js'
import { noteCollabSchedule } from './inspector.js'
import { sessionAccess } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import type { RuntimeRequestContext } from '@onething/core'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.wake')


/**
 * 等一个回合最多等这么久。与权限降级同一个数字(120s)不是巧合:两处问的是
 * 同一个问题 —— "对面还会不会回应我",而超过两分钟的答案在两处都是"不等了"。
 */
export const COLLAB_WAKE_TIMEOUT_MS = 120_000

interface PendingWake {
  executionContext: Readonly<RuntimeRequestContext>
  dmRoomSessionId: string
  targetAgentId: string
  wakeRoomSessionId: string
  /** poke 以谁的身份说 —— 发起人的那条会话(执行器从它推导发言身份)。 */
  senderSessionId: string
  senderAgentId: string
  /** 私聊里那条消息的 id。只用于日志:回合窗口本身已经把先后关系定死了。 */
  sinceMessageId: string
  detach(): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * key = 私聊房 × 收件人。同一对人在同一间私聊房里连着 wake 两次,兑现的是
 * **一次** —— 第二条私聊到达时对方那一轮还没跑完,而 poke 说的是"我给你发了
 * 消息",一次就够(降噪见 §7 开放问题 2)。
 */
const pending = new Map<string, PendingWake>()

function keyOf(dmRoomSessionId: string, targetAgentId: string): string {
  return `${dmRoomSessionId}:${targetAgentId}`
}

function dispose(key: string): PendingWake | undefined {
  const entry = pending.get(key)
  if (!entry) return undefined
  pending.delete(key)
  clearTimeout(entry.timer)
  entry.detach()
  return entry
}

export function registerCollabWakeFollowup(input: {
  dmRoomSessionId: string
  targetAgentId: string
  wakeRoomSessionId: string
  senderSessionId: string
  senderAgentId: string
  sinceMessageId: string
}, options: { executionContext?: unknown } = {}): void {
  const executionContext = fixedExecutionContext(options.executionContext)
  sessionAccess.resolveAll(executionContext,
    [input.senderSessionId, input.dmRoomSessionId, input.wakeRoomSessionId], 'write')
  const key = keyOf(input.dmRoomSessionId, input.targetAgentId)
  // 已经在等同一个人了:锚点换成新的那条,不叠第二次 poke。
  if (pending.has(key)) return

  const unsubscribe = getEventBus().onAny(
    input.dmRoomSessionId,
    envelope => {
      const event = (envelope as { event?: { type?: string; agentId?: string; active?: boolean } } | undefined)?.event
      if (event?.type !== SESSION_EVENT_TYPES.COLLAB_TURN_ACTIVE) return
      if (event.agentId !== input.targetAgentId) return
      // 落边才是 settle:起边(true)只是说回合开始了。
      if (event.active !== false) return
      void fulfill(key, 'settled').catch(error => log.warn('wake followup failed', {}, error))
    },
    'collab-wake-followup',
  )

  const timer = setTimeout(() => {
    void fulfill(key, 'timeout').catch(error => log.warn('wake followup failed', {}, error))
  }, COLLAB_WAKE_TIMEOUT_MS)
  // 一个还没兑现的 wake 不该拖住进程退出(CLI/守护进程都会等 timer)。
  timer.unref?.()

  pending.set(key, {
    executionContext,
    dmRoomSessionId: input.dmRoomSessionId,
    targetAgentId: input.targetAgentId,
    wakeRoomSessionId: input.wakeRoomSessionId,
    senderSessionId: input.senderSessionId,
    senderAgentId: input.senderAgentId,
    sinceMessageId: input.sinceMessageId,
    detach: unsubscribe,
    timer,
  })
}

/**
 * 兑现一次。**先注销再发**:poke 落群会激活对方在群里的回合,而那条链路上任何
 * 一处回头触发这里,都不该变成第二条 poke。
 */
async function fulfill(key: string, why: 'settled' | 'timeout'): Promise<void> {
  const entry = dispose(key)
  if (!entry) return
  sessionAccess.resolveAll(entry.executionContext,
    [entry.senderSessionId, entry.dmRoomSessionId, entry.wakeRoomSessionId], 'write')

  const target = findAgent(entry.targetAgentId)
  if (!target) return
  const mention = formatCollabAgentHandle(target.id, target.name)

  // poke = 一条普通的 say(§3.1 ①):@ 短路激活、rel 标注、UI 渲染、幂等窗、
  // 冻结/预算门全部免费继承。机械上它等价于"发起人自己回群 @ 了一声"。
  const said = await speakIntoCollabRoom({
    sessionId: entry.senderSessionId,
    content: formatCollabWakePoke(mention),
    room: entry.wakeRoomSessionId,
    // 清零的**可重放**那一半:标记落在这条 poke 上,boot 重算认它作边界。
    chainReset: true,
  }, { executionContext: entry.executionContext })
  if (!said.ok || !said.messageId) {
    // 发起回合早就结束了,没有人可以回执(§3.2 失败面):只留痕。
    log.warn('wake poke not delivered to room', {
      roomSessionId: entry.wakeRoomSessionId,
      targetAgentId: entry.targetAgentId,
      why,
      reason: said.error ?? 'unknown',
    })
    noteCollabSchedule(entry.wakeRoomSessionId, {
      kind: 'blocked',
      agentId: entry.targetAgentId,
      detail: `唤醒未送达:${said.error ?? '未知原因'}`,
    })
    return
  }

  /**
   * 清零与激活都归房间(D6-b)。
   *
   * 这里从前还有两段 v2 的手工版:直接改 `runtime.state.chainCount` 清链闸,
   * 再 `enqueue` 把对方拉起来。两段现在都没有了 —— 上面那条 poke 是一次**普通
   * 的 say**,它带着 `collabChainReset` 落库,而 RoomActor 收到这条 posted 之后
   * 自己就会清链、按 @ 直通授牌(§2「@=直通授牌」)。
   *
   * 当初写"显式入队而不是靠 @ 短路"的理由是"句柄若因改名而失配,唤醒就静默地
   * 没发生"——那条顾虑在 v3 里由 `formatCollabAgentHandle` 现取名字消掉了:
   * poke 的 @ 是**此刻**渲染出来的,与房间解析它时读的是同一份花名册。
   */
}

/** 测试/收摊用:忘掉所有还在等的 wake(定时器与订阅一起拆)。 */
export function clearCollabWakeFollowups(): void {
  for (const key of [...pending.keys()]) dispose(key)
}

/** 还在等的 wake 数量(测试/自检)。 */
export function pendingCollabWakeCount(): number {
  return pending.size
}
