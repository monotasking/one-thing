/**
 * 派工(Task)的**产品层口径** —— 自举差距审计 P0-3 / P0-5
 * (`docs/audit/self-hosting-gap-audit-2026-08-11.md`)。
 *
 * 审计的一句话判词是「卡死在第三步 —— 派工」:唯一的派工路径 `board start` 只能
 * 给自己开工,worker 的 cwd 被无条件切到群目录,跑完父会话不被唤醒,拿回的是一条
 * 200 字符状态行。那四条语义单看都是对的**群聊看板**决策,合起来正好把「派一个
 * 后台会话去干活、干完叫醒我、把话说完」这件事堵死。
 *
 * 这个模块只放**纯口径**:名字、闸的阈值、拒绝的形状、回投正文的排版。
 * 装配(建会话、驱动、等终端事件、回投)在 `app/tasks/dispatch.ts`,
 * 因为「谁在生成」「引擎绑没绑」这些事实只有装配层知道。
 *
 * ## 为什么闸写在这里而不是就地写死
 *
 * 并发上限与「不许套娃」是两条会被两处读到的规则:工具执行时要判,
 * 回合的工具面要判(套娃那一条决定了工作会话看不看得见 `task`)。
 * 写成两份的下场在这个仓库里有前科(C2「工具面单点」),所以只有一份。
 */

/** 工具 id / 名字。注册在桌面全量档;headless 与 readonly 都不进。 */
export const TASK_TOOL_ID = 'task'

/**
 * 同一条调用方会话上,同时在跑的工作会话上限(v1 保守值)。
 *
 * 4 的理由:一个人一次能追踪的后台活儿差不多就是这个数,而每一条都在真花 token。
 * 超限**不是排队**,是当场结构化拒绝 —— 悄悄排队会让模型以为活已经派出去了。
 */
export const TASK_MAX_CONCURRENT_PER_SESSION = 4

/**
 * 起流超时:命令发出去这么久还没有 `stream:start`,就当它没起来。
 *
 * 唯一的成因是命令被引擎丢掉(宿主没有投递面)。给它一个超时而不是让它挂着,
 * 是为了让调用方**一定**收得到一句话 —— 派工最坏的失败模式是「石沉大海」。
 */
export const TASK_START_TIMEOUT_MS = 60_000

/**
 * 墙钟:collab worker 的同款 30 分钟。
 *
 * 超时不杀会话 —— 报一句「超时结束,会话仍在」,人点得进去接管。
 * 停在一张没人答的审批卡上的任务,最终会走到这一条。
 */
export const TASK_WALL_CLOCK_MS = 30 * 60_000

/* ── 会话标记 ─────────────────────────────────────────────────────────────── */

/**
 * 一条工作会话在自己的元数据上带的那枚戳。
 *
 * 结构类型而不是 IPC 契约包里那份 `TaskSessionRef`:产品层禁止 import 那个包
 * (boundary checker 强制)。两者字段同名同义,装配层传下来的就是那一份。
 */
export interface TaskSessionMarkLike {
  /** 派工的那条会话 —— 完成回流投回它。 */
  parentSessionId?: string
}

export interface TaskSessionLike {
  task?: TaskSessionMarkLike | null
}

/** 这条会话是被派出去的工作会话吗(判据 = 会话元数据上的 task 戳)。 */
export function isTaskSession(session: TaskSessionLike | null | undefined): boolean {
  return Boolean(session?.task && typeof session.task === 'object')
}

/**
 * 这条会话的回合**看不见**哪些工具。
 *
 * 目前只有一条规则:工作会话看不见 `task`,即禁止嵌套派工。
 *
 * 为什么要在工具面上真的摘掉,而不是只在执行时拒绝:一个摆在工具表里的工具,
 * 模型会去调它,调了被拒是一次纯浪费的往返,而且拒绝理由要靠模型读懂。摘掉
 * 之后这条路在提示词里根本不存在。执行时的拒绝仍然保留(见 dispatch),那是
 * 兜底 —— 工具面是给模型看的,闸是不能被绕过的。
 *
 * 闸只有一跳深:工作会话不能再派工,所以派工树最深两层(调用方 → 工作会话)。
 * 这是 v1 刻意的保守 —— 失控的派工树比派不出去贵得多。
 */
export function sessionHiddenToolIds(
  session: TaskSessionLike | null | undefined,
): readonly string[] {
  return isTaskSession(session) ? [TASK_TOOL_ID] : []
}

/* ── 拒绝 ─────────────────────────────────────────────────────────────────── */

export type TaskRejectionReason =
  /** 任务书是空的。 */
  | 'empty-prompt'
  /** 调用方自己就是一条工作会话(禁止套娃)。 */
  | 'nested'
  /** 这条会话上同时在跑的工作会话已满。 */
  | 'concurrency'
  /** 引擎没绑投递面(命令会被静默丢掉),或调用方会话不存在。 */
  | 'unsupported'
  | 'error'

/**
 * 拒绝的**人话**。模型读到的就是这一句,所以每一条都要说清楚
 * 「为什么」以及「现在该怎么办」—— 只说 reason 枚举名等于什么都没说。
 */
export function describeTaskRejection(
  reason: TaskRejectionReason,
  detail?: string,
): string {
  const base = (() => {
    switch (reason) {
      case 'empty-prompt':
        return 'Rejected: prompt is empty. A task session starts with nothing but this prompt — write the whole brief.'
      case 'nested':
        return 'Rejected: nested dispatch. This session IS a background task session, and a task session may not dispatch further tasks. Do the work here, or report back and let the session that dispatched you decide.'
      case 'concurrency':
        return `Rejected: too many background tasks already running for this session (limit ${TASK_MAX_CONCURRENT_PER_SESSION}). Wait for one to report back before dispatching another.`
      case 'unsupported':
        return 'Rejected: this host cannot run background task sessions right now.'
      case 'error':
        return 'Rejected: the task could not be started.'
    }
  })()
  return detail ? `${base}\n${detail}` : base
}

/* ── 回投正文 ─────────────────────────────────────────────────────────────── */

export type TaskOutcome = 'complete' | 'error' | 'aborted' | 'timeout'

export interface TaskReportInput {
  taskSessionId: string
  /** 建卡时给的短标签;没有就用任务书首行。 */
  description?: string
  outcome: TaskOutcome
  /** 工作会话最后一条助手正文 —— **整条**,不截断。 */
  body?: string
}

const OUTCOME_NOTE: Record<TaskOutcome, string> = {
  complete: '已完成',
  error: '出错结束',
  aborted: '被中止',
  timeout: '超时结束(工作会话仍在,可进去接管)',
}

/**
 * 回投给调用方的那条消息。
 *
 * **正文不截断**,这是本期的主诉之一(审计 P0-5:collab 的回报硬截 200 字符)。
 * 那条截断在 collab 的回报链上,这里一个字都没动它 —— 走的是插件 sendMessage 的
 * 投递路径,天然不经过它。派工回来的东西是**工作成果**,截成一行等于白干。
 */
export function renderTaskReport(input: TaskReportInput): string {
  const label = input.description?.trim()
  const head = `[任务${OUTCOME_NOTE[input.outcome]}]${label ? ` ${label}` : ''}`
  const body = input.body?.trim()
  return [
    `${head}(会话 ${input.taskSessionId})`,
    body || '(工作会话没有留下正文。可以打开这条会话看它到底做了什么。)',
  ].join('\n\n')
}

/** 会话列表里那条工作会话叫什么。 */
export function taskSessionName(description: string | undefined, prompt: string): string {
  const label = (description?.trim() || prompt.trim().split('\n')[0] || '').slice(0, 40)
  return label ? `[派工] ${label}` : '[派工]'
}
