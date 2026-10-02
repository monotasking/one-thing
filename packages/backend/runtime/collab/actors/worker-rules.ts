/**
 * WorkerChildActor 的**纯规则**(docs/design/collab-actor-v3.md §1.6)——限额、
 * 子清单账、evidence 采集、回投素材、任务书。
 *
 * 与 `mind-rules.ts`/`room-rules.ts` 同一条分工:带 IO 的那一半(派生子 actor、
 * 驱动工作会话、写看板)在隔壁的 `worker-child.ts`(P3'b-B 起同目录;撞后端脊柱的
 * `worker-mind-port` 留在 `@onething/backend/wiring/collab/actors/`),这里只有同步纯
 * 函数。理由也一样 —— 金重放与真机必须走同一行代码,而重放没有磁盘、没有引擎、
 * 没有时钟。
 *
 * ## 「一个大脑」为什么管不到这里
 *
 * §0.1 那条宪法约束的是**对话性**回合:同一时刻全局至多一路 LLM 调用代表这个
 * agent 说话。重活不是说话 —— 它是一双手。一个人一边听会一边写代码不构成
 * 「自相矛盾」,而把工作塞进心智循环的代价是:一张跑三十分钟的卡会让这位同事
 * 在群里三十分钟不吭声。所以子 actor 与心智循环**并行**,这是有意的豁免,不是
 * 疏漏(测试 `worker-child.test.ts` 的第一条钉的就是它)。
 *
 * ## 限额:v2 的 2/房 + 4/全局,在 v3 换成 2/人 + 4/全局
 *
 * 数值一个没动,**归属**换了一次,理由值得写下来:
 *
 *  - v2 的房闸(`MAX_CONCURRENT_WORK_PER_ROOM = 2`)挡的是「一间房把机器占满」。
 *    但 v3 里房间已经不是执行边界了(§0.1:执行归 AgentActor)——同一个人在两间
 *    房各开 2 张卡,v2 的房闸一次都不会响,而它其实已经开了 4 双手。
 *  - 真正稀缺的是两样:**这个人的注意力**(卡多了它自己的产出会互相打架,而且
 *    每一张都在往同一个房间里说话)与**整机并发**(全局 4 = v2 原样)。v3 直接
 *    按这两样计价。
 *  - 房闸没有被「删掉」,是被**换算**掉了:一间房里的两个人各开 2 张卡在 v2 会
 *    被房闸拦住一半,在 v3 不会 —— 那是有意的,那两双手属于两个人的注意力预算。
 *
 * ## 墙钟与 maxTurns:沿用 v2,而且只写一遍
 *
 * 30 分钟总墙钟、30 秒起流上限,与 v2 `worker.ts` 逐字相同;`maxTurns` 走引擎
 * 缺省(100),这一层**不加第二个数** —— v2 也没加,两处各写一个上限的下场是
 * 「卡在第 87 轮停了,而两份文档说的是 100 和 50」。断路器仍然没有(保留决策)。
 *
 * 墙钟由**端口**执行:它是唯一掐得动流的那一方(`abortCollabZombieStream`)。
 * 常量放在这里只是为了让「端口」与「文档」读同一个数字。
 */
import { escapeCollabPromptText } from '../inline-tags.js'
import { buildCollabWorkRules } from '../agent-rules.js'
import type { CollabFoldWorkerEntry } from './envelope-fold.js'
import type { CollabWorkerEvidenceRef, CollabWorkerOutcome } from './protocol.js'

/* ── 限额与上限 ─────────────────────────────────────────────────────────── */

/** 一个 agent 同时在外的手。v2 的「一间房 2 个 worker」在 v3 的等价问法(见文件头)。 */
export const COLLAB_WORKER_MAX_PER_AGENT = 2
/** 整机同时在外的手。与 v2 `MAX_CONCURRENT_WORK_GLOBAL` 同值。 */
export const COLLAB_WORKER_MAX_GLOBAL = 4
/** 起流上限:没见到流起来就是没跑起来(v2 `WORK_START_TIMEOUT_MS`)。 */
export const COLLAB_WORKER_START_TIMEOUT_MS = 30_000
/** 一份工作的总墙钟(v2 `WORK_TOTAL_TIMEOUT_MS`)。 */
export const COLLAB_WORKER_WALL_CLOCK_MS = 30 * 60_000
/** 回投摘要的长度上限。它进的是父的下一条 drive,不是看板 —— 卡上那份仍是 2000。 */
export const COLLAB_WORKER_SUMMARY_MAX_CHARS = 200
/** 一次回投最多带几条 evidence 引用。 */
export const COLLAB_WORKER_EVIDENCE_MAX_REFS = 12
/** 单条引用的长度上限(一条深路径不该把回投撑破)。 */
export const COLLAB_WORKER_EVIDENCE_REF_MAX_CHARS = 120
/** 子清单里留几条**已收尾**的记录(在跑的那些永远留着)。 */
export const COLLAB_WORKER_ROSTER_MAX = 20

/**
 * 不算 evidence 的工具。与 v2 `EVIDENCE_EXCLUDED_TOOLS` 同一条:board 是它
 * **谈论**工作的方式,不是**做**工作的方式 —— 一个只调了 board 的成员把自己的卡
 * 关掉,不该看起来像干过活。
 */
export const COLLAB_WORKER_EVIDENCE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['board'])
/** 写字节的两个工具 = 交付物的唯一来源(v2 `DELIVERABLE_TOOLS`,理由见那里)。 */
export const COLLAB_WORKER_DELIVERABLE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])
/** 路径参数的几种历史叫法(v2 `DELIVERABLE_PATH_KEYS`)。 */
export const COLLAB_WORKER_DELIVERABLE_PATH_KEYS = ['file_path', 'path', 'filePath'] as const

export interface CollabWorkerLimits {
  perAgent?: number
  global?: number
}

export type CollabWorkerAdmissionReason = 'per-agent' | 'global'

export interface CollabWorkerAdmission {
  admitted: boolean
  /** 没进来的话是被哪一道闸挡的(排队说明与排障读它)。 */
  reason?: CollabWorkerAdmissionReason
}

/**
 * 这只手现在能不能派出去。
 *
 * 顺序是先人后机:被自己的注意力预算挡住与被整机挡住,是两件该分得开的事 ——
 * 前者说「你手上活够多了」,后者说「机器满了,换个时间」。
 */
export function admitCollabWorker(input: {
  agentRunning: number
  globalRunning: number
  limits?: CollabWorkerLimits
}): CollabWorkerAdmission {
  const perAgent = normalizeLimit(input.limits?.perAgent, COLLAB_WORKER_MAX_PER_AGENT)
  const global = normalizeLimit(input.limits?.global, COLLAB_WORKER_MAX_GLOBAL)
  if (input.agentRunning >= perAgent) return { admitted: false, reason: 'per-agent' }
  if (input.globalRunning >= global) return { admitted: false, reason: 'global' }
  return { admitted: true }
}

/** 0 / 负数 / 非数 = 退回缺省。「不限」不是这里的取值 —— 不限的并发闸等于没有闸。 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/* ── 子清单(账) ────────────────────────────────────────────────────────── */

/**
 * 一条子任务在父账里的状态。三态,不是四态:
 *
 *  - `running` —— 这双手还在外面。**崩溃对账认的就是它**。
 *  - `done` —— 子 actor 自己收尾了。成败在 `outcome` 里,不在这一格 —— 一份
 *    失败但收过尾的工作与一份跑到一半没了的工作,对父的意义完全不同(前者
 *    不用管了,后者要么重派要么标断)。
 *  - `interrupted` —— 它**没能**自己收尾(进程死了),由重启对账认领。
 */
export type CollabWorkerStatus = 'running' | 'done' | 'interrupted'

/** 父账里的一条子清单记录(§1.6「结果回投父 mailbox」的账那一面)。 */
export interface CollabAgentWorkerRecord {
  workerId: string
  cardId: string
  roomId: string
  /**
   * 这一段跑在哪条工作会话里。
   *
   * 可空:会话由端口建(续做则是原来那条),派生的那一刻还不知道。续做要它 ——
   * 「接着原来的会话往下做」这条 v2 决策(collab-team-v2 §5.3)在 v3 靠它兑现。
   */
  workSessionId?: string
  startedAt: number
  status: CollabWorkerStatus
  /** 终局。`status === 'running'` 时缺席。 */
  outcome?: CollabWorkerOutcome
  settledAt?: number
}

export function createCollabWorkerRecord(input: {
  workerId: string
  cardId: string
  roomId: string
  startedAt: number
  workSessionId?: string
}): CollabAgentWorkerRecord {
  return {
    workerId: input.workerId,
    cardId: input.cardId,
    roomId: input.roomId,
    ...(input.workSessionId ? { workSessionId: input.workSessionId } : {}),
    startedAt: input.startedAt,
    status: 'running',
  }
}

const WORKER_STATUSES: readonly CollabWorkerStatus[] = ['running', 'done', 'interrupted']

/** 从盘上认一份子清单。认不出的条目丢掉 —— 半条记录会在对账时冒充一个孤儿。 */
export function normalizeCollabAgentWorkerRecords(value: unknown): CollabAgentWorkerRecord[] {
  if (!Array.isArray(value)) return []
  const records: CollabAgentWorkerRecord[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.workerId !== 'string' || typeof raw.cardId !== 'string') continue
    const status = WORKER_STATUSES.includes(raw.status as CollabWorkerStatus)
      ? (raw.status as CollabWorkerStatus)
      : 'running'
    records.push({
      workerId: raw.workerId,
      cardId: raw.cardId,
      roomId: typeof raw.roomId === 'string' ? raw.roomId : '',
      ...(typeof raw.workSessionId === 'string' ? { workSessionId: raw.workSessionId } : {}),
      startedAt: typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
      status,
      ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome as CollabWorkerOutcome } : {}),
      ...(typeof raw.settledAt === 'number' ? { settledAt: raw.settledAt } : {}),
    })
  }
  return records
}

export function collabWorkerRunning(
  workers: readonly CollabAgentWorkerRecord[],
): CollabAgentWorkerRecord[] {
  return workers.filter(worker => worker.status === 'running')
}

export function collabWorkerOf(
  workers: readonly CollabAgentWorkerRecord[],
  workerId: string,
): CollabAgentWorkerRecord | undefined {
  return workers.find(worker => worker.workerId === workerId)
}

/** 这张卡此刻有没有手在做。重投的 spawn 与「群里又催了一次」在这一层是同一件事。 */
export function collabWorkerRunningForCard(
  workers: readonly CollabAgentWorkerRecord[],
  cardId: string,
): CollabAgentWorkerRecord | undefined {
  return workers.find(worker => worker.status === 'running' && worker.cardId === cardId)
}

/**
 * 淘汰已收尾的旧记录。
 *
 * **在跑的一条都不动** —— 子清单的第一职责是崩溃对账,而对账认的正是 running。
 * 按容量淘汰只发生在已收尾的那一段(它们的用处只剩排障)。
 */
export function pruneCollabWorkerRecords(
  workers: readonly CollabAgentWorkerRecord[],
  max: number = COLLAB_WORKER_ROSTER_MAX,
): CollabAgentWorkerRecord[] {
  const limit = Math.max(0, Math.floor(max))
  const settled = workers.filter(worker => worker.status !== 'running')
  if (settled.length <= limit) return [...workers]
  const drop = new Set(settled.slice(0, settled.length - limit).map(worker => worker.workerId))
  return workers.filter(worker => !drop.has(worker.workerId))
}

/** 派出去一只手:同 workerId 以新的为准(重投),其余原样。 */
export function upsertCollabWorkerRecord(
  workers: readonly CollabAgentWorkerRecord[],
  record: CollabAgentWorkerRecord,
): CollabAgentWorkerRecord[] {
  const rest = workers.filter(worker => worker.workerId !== record.workerId)
  return pruneCollabWorkerRecords([...rest, record])
}

/** 收尾一只手。认不出的 workerId 原样返回 —— 一封迟到的回投不该凭空造一条记录。 */
export function settleCollabWorkerRecord(
  workers: readonly CollabAgentWorkerRecord[],
  input: {
    workerId: string
    outcome: CollabWorkerOutcome
    at: number
    status?: CollabWorkerStatus
    workSessionId?: string
  },
): CollabAgentWorkerRecord[] {
  let hit = false
  const next = workers.map(worker => {
    if (worker.workerId !== input.workerId) return worker
    hit = true
    return {
      ...worker,
      ...(input.workSessionId ? { workSessionId: input.workSessionId } : {}),
      status: input.status ?? 'done',
      outcome: input.outcome,
      settledAt: input.at,
    }
  })
  return hit ? pruneCollabWorkerRecords(next) : [...workers]
}

export interface CollabWorkerOrphanAdoption {
  workers: CollabAgentWorkerRecord[]
  /** 上一条命里在跑、这条命里没人接的那些。**账已经标成 interrupted**。 */
  orphans: CollabAgentWorkerRecord[]
}

/**
 * 重启对账:把 `running` 的记录认成孤儿。
 *
 * 判据是「进程没了」而不是「超时了」——一条 running 记录能活到下一次进程启动,
 * 只可能是上一条命没来得及给它收尾(§3:流从不恢复,只重驱)。
 *
 * **先标 interrupted 再决定怎么办**:标记是账,重派是动作,次序不能反 —— 反过来
 * 的话一次崩在重派中间的重启会看见两条 running(旧的没标、新的已起),而并发闸
 * 按 running 计数。
 */
export function adoptCollabWorkerOrphans(
  workers: readonly CollabAgentWorkerRecord[],
  at: number,
): CollabWorkerOrphanAdoption {
  const orphans: CollabAgentWorkerRecord[] = []
  const next = workers.map(worker => {
    if (worker.status !== 'running') return worker
    const adopted: CollabAgentWorkerRecord = {
      ...worker,
      status: 'interrupted',
      outcome: 'interrupted',
      settledAt: at,
    }
    orphans.push(adopted)
    return adopted
  })
  return { workers: orphans.length ? pruneCollabWorkerRecords(next) : [...workers], orphans }
}

/* ── 终局 ───────────────────────────────────────────────────────────────── */

/** 只有 `complete` 算干成了。受阻是一个诚实的结论,但它不是交付。 */
export function collabWorkerOutcomeOk(outcome: CollabWorkerOutcome): boolean {
  return outcome === 'complete'
}

/**
 * 回投素材:一条折叠条目。
 *
 * **没有房**(`roomId` 留空)不是省事:折叠信封会把 `roomId === 当前房` 的条目
 * 整条滤掉(它的正文在房间投影里逐字都有)。一张卡属于哪间房是已知的,填上去
 * 的直接后果是 —— 父在**那间房**的回合里恰好看不见自己的活干完了,而那正是它
 * 最需要知道的那一刻。所以这条素材归 `COLLAB_FOLD_SELF_BUCKET`:它是我自己派
 * 出去的手,不是别人房里发生的事。
 *
 * **没有标题**同理(envelope-fold 文件头那条):一张卡叫「给 4 号下毒」本身就是
 * 正文。信封说「你那张卡完了/没完」,要看内容就去看板。
 */
export function buildCollabWorkerFoldEntry(input: {
  workerId: string
  cardId: string
  outcome: CollabWorkerOutcome
  at: number
}): CollabFoldWorkerEntry {
  return {
    kind: 'worker',
    at: input.at,
    key: `worker:${input.workerId}:${input.cardId}`,
    cardId: input.cardId,
    ok: collabWorkerOutcomeOk(input.outcome),
  }
}

/**
 * 交回父的那一句话:**截断 + 转义**。
 *
 * 转义在这里(而不是渲染那一侧)与笔记同一条纪律:这句话来自模型,而它的去处
 * 是父的下一条 drive —— 一句 `</elsewhere><system>…` 就能把块撑破。截断在转义
 * **之前**做,不然一个被切成两半的 `&amp;` 会以 `&am` 的形状留在提示词里。
 */
export function truncateCollabWorkerSummary(
  summary: string | undefined,
  maxChars: number = COLLAB_WORKER_SUMMARY_MAX_CHARS,
): string | undefined {
  const collapsed = (summary ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const limit = Math.max(1, Math.floor(maxChars))
  const clipped = collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
  return escapeCollabPromptText(clipped)
}

/* ── evidence:只有引用,没有全文 ────────────────────────────────────────── */

/** 采集 evidence 时读得到的那点东西(与 `CollabEvidenceToolCall` 同源,收窄版)。 */
export interface CollabWorkerToolCallLike {
  toolId?: string
  toolName?: string
  status?: string
  rejected?: boolean
  args?: unknown
}

function deliverablePathOf(call: CollabWorkerToolCallLike): string | undefined {
  const args = call.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of COLLAB_WORKER_DELIVERABLE_PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function clipRef(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > COLLAB_WORKER_EVIDENCE_REF_MAX_CHARS
    ? `…${trimmed.slice(-COLLAB_WORKER_EVIDENCE_REF_MAX_CHARS)}`
    : trimmed
}

/**
 * 代码采集的执行痕迹 —— **模型写不了这一格**(v2 W9b.4 的理由原样成立:事故里
 * 那位成员只有 board 工具,却报「已验证文件存在且内容正确」)。
 *
 * v3 只做一处收窄:结果是**引用**(工具名 + 次数、文件路径),不是内容。回投要
 * 穿过父的上下文,而一份 diff 贴进 drive 就等于把工作会话的正文搬进了对话流 ——
 * 那是保密纪律与上下文预算同时被破的一刀。要看内容就去那条工作会话。
 *
 * 这里没有 import v2 的 `collectWorkEvidence`:那个函数住在 `worker.ts` 里,而
 * 那个文件是 v2 编排的入口(队列、板事件、房间闸),D6 要整层删掉。同一份走法
 * 在这里是 30 行纯函数,而且第一次变得可以在没有 store 的环境里测。
 */
export function collectCollabWorkerEvidence(
  calls: Iterable<CollabWorkerToolCallLike>,
  options: { maxRefs?: number; relativeTo?: string } = {},
): CollabWorkerEvidenceRef[] {
  const toolCounts = new Map<string, number>()
  const files: string[] = []
  const seenFiles = new Set<string>()

  for (const call of calls) {
    // 只有真的跑过的才算 —— 一次被拒/失败的 write 什么都没写,evidence 不能
    // 在「试过」上通胀。
    if (call.status !== 'completed' || call.rejected) continue
    const name = (call.toolName || call.toolId || '').trim()
    if (!name || COLLAB_WORKER_EVIDENCE_EXCLUDED_TOOLS.has(name)) continue
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    if (!COLLAB_WORKER_DELIVERABLE_TOOLS.has(name)) continue
    const raw = deliverablePathOf(call)
    if (!raw) continue
    const file = relativise(raw, options.relativeTo)
    if (seenFiles.has(file)) continue
    seenFiles.add(file)
    files.push(file)
  }

  const refs: CollabWorkerEvidenceRef[] = [
    // 文件在前:「产出了什么」比「调了几次工具」更接近父想知道的那件事。
    ...files.map(file => ({ kind: 'file' as const, ref: clipRef(file) })),
    ...[...toolCounts].map(([name, count]) => ({ kind: 'tool' as const, ref: clipRef(name), count })),
  ]
  const max = Math.max(0, Math.floor(options.maxRefs ?? COLLAB_WORKER_EVIDENCE_MAX_REFS))
  return refs.slice(0, max)
}

/** 相对化的口径与 v2 `relativiseDeliverable` 一致:基准之外的保持原样。 */
function relativise(filePath: string, relativeTo?: string): string {
  if (!relativeTo) return filePath
  const base = relativeTo.endsWith('/') ? relativeTo : `${relativeTo}/`
  return filePath.startsWith(base) ? filePath.slice(base.length) : filePath
}

/* ── 任务书 ─────────────────────────────────────────────────────────────── */

export interface BuildCollabWorkerBriefingOptions {
  roomName?: string
  cardId: string
  title: string
  description?: string
  /** 看板现状。端口不认识看板 —— 这一块由 board 端口喂进来。 */
  boardDigest?: string
  /** 群聊最近的讨论(IM 式渲染,由宿主取)。 */
  roomTail?: string
  /** 续做:现场就在本会话里(collab-team-v2 §5.3)。 */
  resuming?: boolean
  /** 负责人名字 —— 交付时顺手 @ 谁。 */
  pmName?: string
}

/**
 * 一份工作的任务书。
 *
 * 与 v2 `buildBriefing` 同一条收窄(C3-5):**身份与卡框架已经进了 system prompt**
 * (work 分支从会话 meta 取 roomSessionId/taskId/taskTitle),这里只留会过期的
 * 那一半 —— 这一刻的看板、这一刻的群聊尾巴、这一次的交付协议。
 *
 * 续做那一句刻意不说「被什么中断」:超时、停止、重启在模型这一侧是同一件事 ——
 * 上次没做完。
 */
export function buildCollabWorkerBriefing(options: BuildCollabWorkerBriefingOptions): string {
  const room = options.roomName?.trim() || '群聊'
  return [
    options.resuming
      ? '这个任务此前的执行被中断了,现在继续。你的工作历史就在本会话里——先盘点已经做到哪一步(别重复已完成的写入),再往下做。'
      : `你被指派了群聊「${room}」看板上的任务,请在这个工作会话里完成它。`,
    '',
    `任务 #${options.cardId}`,
    `标题: ${options.title}`,
    options.description ? `详情: ${options.description}` : null,
    options.boardDigest ? `\n看板现状:\n${options.boardDigest}` : null,
    options.roomTail ? `\n群聊最近的讨论:\n${options.roomTail}` : null,
    '',
    // W14b 交付自主化:交付的话由执行者自己说 —— send_message 是它的嘴,
    // board complete 是流转。这条在 v3 一字不改(§8 保留的已拍板决策)。
    `完成后先用 send_message 把关键结论发进群里${options.pmName ? `(顺手 @ 负责人 ${options.pmName})` : ''},`
      + `再调用 board 工具 { action: "complete", taskId: "${options.cardId}", summary: 交付摘要 } 作为你的最后一个动作。`,
    `工作过程中随时可以用 send_message 在群里发一条(有发现、要确认、卡住了);不发也没关系。`
      + `无法继续时用 board { action: "block", taskId: "${options.cardId}", reason: 原因 }。`,
    '',
    buildCollabWorkRules(),
  ].filter(line => line !== null).join('\n')
}
