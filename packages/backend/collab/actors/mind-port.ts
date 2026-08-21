/**
 * MindPort —— 「替这个 agent 想一轮」这件事的端口(docs/design/collab-actor-v3.md §1.2)。
 *
 * AgentActor 只关心三件事:什么时候该想、想的时候手上有哪些材料、想完之后它说了
 * 什么。**怎么想**(合成 drive 进执行会话、等终端事件、收割 say)是引擎那一侧的
 * 机械动作,隔在这个端口后面。
 *
 * 这道缝不是洁癖,它买到两样东西:
 *
 *  1. **测试里没有模型**。心智循环的性质(一脑串行、游标不倒退、保密不变量)靠
 *     剧本化的假端口就能钉死,一次网络调用都不用发。真调模型的测试只会变成
 *     「今天这个模型想说什么」的快照。
 *  2. **D6 的接线是换一个实现,不是改循环**。生产适配器(`engine-mind-port.ts`)
 *     本期只写不接 —— v2 的调度链仍然是生产,这里一行都没动它。
 *
 * ## says 为什么是自己的类型,不是 `ChatMessage`
 *
 * 端口的返回值是**这一轮的结论**,不是转录的一段。用 `ChatMessage` 的话,假端口
 * 要为一次「说了句话」编出十几个与结论无关的字段(id/timestamp/role/provider/…),
 * 而每加一个字段都在诱使调用方去读它 —— 那正是端口存在要挡住的耦合。生产适配器
 * 负责把 `ChatMessage` 收敛成这三格。
 */
import type { FloorLease } from '@onething/core/actors'
import type { CollabMentionLike } from '@onething/runtime/collab'

/**
 * 一轮的结局。前四个与引擎的终端事件一一对应;`skipped` 是端口自己的判断
 * ——「这一轮压根没跑」(会话建不出来、引擎没绑),它与 `error` 必须分得开:
 * 前者重试有意义,后者重试多半是再炸一次。
 */
export type CollabMindTurnOutcome = 'complete' | 'error' | 'aborted' | 'timeout' | 'skipped'

/** 这一轮它在房间里说的一句话。 */
export interface CollabMindSay {
  content: string
  mentions?: CollabMentionLike[]
  /** 已经落库的话带上它的 id(生产适配器给);剧本化的假端口不给。 */
  messageId?: string
  at?: number
}

/**
 * 回合的宿主消息 —— 思考文本 + 工具调用那一条,落在**执行会话**里。
 *
 * 只留两格:有没有、有多长。「跑了但一句没说」与「压根没跑」是两件不同的事,
 * 而「写了三百字却一个 say 都没有」(写而未发)是第三件 —— 三者的判据全在这
 * 两格上,再多的字段这一层用不到。
 */
export interface CollabMindTurnMessage {
  id?: string
  /** 正文长度。写而未发的度量读它(§ v2 的 `COLLAB_UNSENT_PROSE_MIN`)。 */
  proseChars: number
  at?: number
}

export interface CollabMindTurnRequest {
  agentId: string
  /** 这一轮在答哪间房。 */
  roomSessionId: string
  /** 经历流 —— 蓝图修正:就是既有的 `agent-exec-<agentId>-<roomId>` 会话。 */
  execSessionId: string
  /** 手里那张牌。端口不验票(那是房间的事),但把它带进日志与排障。 */
  lease: FloorLease
  /** 这一轮的 drive 正文(房间内容 + 折叠信封 + 笔记,已组装好)。 */
  driveContent: string
}

export interface CollabMindTurnResult {
  outcome: CollabMindTurnOutcome
  says: CollabMindSay[]
  turnMessage?: CollabMindTurnMessage
}

export interface CollabMindSteerRequest {
  agentId: string
  roomSessionId: string
  execSessionId: string
  /** 已经裹好信封的正文(与房间投影同源,见 v2 `steer.ts` 的三处收窄)。 */
  body: string
}

export interface CollabMindPort {
  readonly name: string
  /** 跑一轮对话性回合。**同一时刻全局至多一路** —— 这条由 AgentActor 保证。 */
  runConversationalTurn(request: CollabMindTurnRequest): Promise<CollabMindTurnResult>
  /**
   * 把一条中途到达的同房消息并进正在跑的这一轮(v2 steer 机制保留,但注入目标
   * 唯一 —— 不再广播复制)。
   *
   * 返回 `false` = 没并进去(引擎没这扇门、或这一轮已经跑到最后一步读不到了)。
   * 调用方据此退回举手评估:让这条消息走完整的激活决策,总好过让它凭空消失。
   */
  steer?(request: CollabMindSteerRequest): Promise<boolean>
}

/* ── 测试用的假端口 ──────────────────────────────────────────────────────── */

/** 剧本里的一轮:这位同事在这间房被点到时说什么。 */
export interface CollabScriptedTurn {
  agentId: string
  roomId: string
  /** 说的话,按序。空数组 = 沉默(v3 的沉默就是不调任何工具)。 */
  says: string[]
  outcome?: CollabMindTurnOutcome
  /** 宿主消息的正文长度(写而未发的用例造它)。 */
  proseChars?: number
}

/** 假端口记下的一次调用 —— 保密不变量的测试读 `driveContent`。 */
export interface CollabScriptedCall {
  agentId: string
  roomSessionId: string
  execSessionId: string
  leaseId: string
  driveContent: string
  /** 进入这次调用时,已经在跑的回合数。一脑串行的测试断言它恒为 0。 */
  concurrentOnEntry: number
}

export interface CollabScriptedMindPort extends CollabMindPort {
  readonly calls: CollabScriptedCall[]
  readonly steers: CollabMindSteerRequest[]
  /** 这一刻有几路对话性回合在飞。串行性的测试盯着它的峰值。 */
  readonly peakConcurrency: number
  /** 让下一次 `runConversationalTurn` 挂起,直到 `release()` 被调用。 */
  hold(): void
  release(): void
  /** steer 的返回值。默认 true(并进去了)。 */
  setSteerAccepts(next: boolean): void
}

/**
 * 剧本化的假端口:收到 floor-granted 就按剧本说话。
 *
 * 与 `createCollabRoomAccountMemoryStore` 同一个身份 —— 它住在生产目录里而不是
 * `__tests__/` 下,因为**双 actor 金重放**要用它,而金重放是交付物不是测试脚手架。
 */
export function createCollabScriptedMindPort(
  script: readonly CollabScriptedTurn[] = [],
): CollabScriptedMindPort {
  const queue = new Map<string, CollabScriptedTurn[]>()
  for (const turn of script) {
    const key = `${turn.agentId}@${turn.roomId}`
    const list = queue.get(key) ?? []
    list.push(turn)
    queue.set(key, list)
  }

  const calls: CollabScriptedCall[] = []
  const steers: CollabMindSteerRequest[] = []
  let inFlight = 0
  let peak = 0
  let gate: Promise<void> | null = null
  let open: (() => void) | null = null
  let steerAccepts = true

  const port: CollabScriptedMindPort = {
    name: 'scripted',
    calls,
    steers,
    get peakConcurrency() {
      return peak
    },
    hold(): void {
      if (gate) return
      gate = new Promise<void>(resolve => {
        open = resolve
      })
    },
    release(): void {
      open?.()
      gate = null
      open = null
    },
    setSteerAccepts(next: boolean): void {
      steerAccepts = next
    },
    async runConversationalTurn(request: CollabMindTurnRequest): Promise<CollabMindTurnResult> {
      calls.push({
        agentId: request.agentId,
        roomSessionId: request.roomSessionId,
        execSessionId: request.execSessionId,
        leaseId: request.lease.leaseId,
        driveContent: request.driveContent,
        concurrentOnEntry: inFlight,
      })
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        if (gate) await gate
        const key = `${request.agentId}@${request.roomSessionId}`
        const turn = queue.get(key)?.shift()
        return {
          outcome: turn?.outcome ?? 'complete',
          says: (turn?.says ?? []).map(content => ({ content })),
          ...(turn?.proseChars === undefined
            ? {}
            : { turnMessage: { proseChars: turn.proseChars } }),
        }
      } finally {
        inFlight -= 1
      }
    },
    async steer(request: CollabMindSteerRequest): Promise<boolean> {
      steers.push(request)
      return Promise.resolve(steerAccepts)
    },
  }
  return port
}
