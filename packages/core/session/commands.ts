/**
 * 会话消息的**形状词汇** + 冷加载修复的两个具名入口。
 *
 * ## 老 reducer 已经退役(§17.7.1 批 3,2026-08-28)
 *
 * 这个文件从 P0 起是**会话消息命令面的纯函数层**:`applySessionCommand` 与它的
 * 7 条分支、`SessionCommand` 联合、写计划、lazy 档、`adoptSessionCommandResult`。
 * c4-d(§16.27)先把"消息数组的维护者"这一身份交给了折叠产物;#8a 削掉 5 条
 * 端口专用分支;批 2(§17.7.1)让**会话账**也成为折叠产物并影子对拍 682 次 0 失配。
 * 到批 3,它最后那个身份("会话级派生的算法")也没有了消费者 —— 整段归约器
 * 连同 `SessionCommand` 词汇一起删除。
 *
 * 今天的写路是一条直线,住在 `backend/session/commands.ts`:
 *
 *   判据(问投影)→ 事件 append(F1 同步可见)→ 会话账落格(折叠产物)
 *   → 落盘调度(写门自算的 lazy 档)→ 索引元数据
 *
 * 留在这里的只有两样,而且都不是归约器:
 *
 * 1. **形状词汇** —— `CoreSessionCommandMessage` / `CoreSessionCommandStep` /
 *    `CoreSessionCommandSession`。它们是"一条会话 / 一条消息 / 一个 step 至少
 *    长什么样"的结构约束,`store-helpers` 与 S0 合同测试按它们说话。
 * 2. **冷加载修复的两个具名入口** —— `sanitizeLoadedSession` /
 *    `sanitizeSessionOnStartup`。它们从前借道 `applySessionCommand` 的
 *    `repairOnLoad` 分支;批 3 起直调纯算法 `computeSessionRepairOnLoad`,
 *    语义一字未改(**COW**:变了返回新会话对象,没变返回 `undefined`)。
 *    修复本身是**可再生的派生**(同一份消息折两次得同一个结果),它的位置在
 *    **读路**(`session-repository.repairOnFirstTouch`),不是写路。
 */

import type { CoreSessionTokenUsage } from './store-helpers.js'
import type {
  CoreTimelineMessage,
  CoreTimelineStep,
} from './timeline.js'
import { computeSessionRepairOnLoad } from './timeline.js'

// ============ 形状 ============

export interface CoreSessionCommandStep extends CoreTimelineStep {
  id: string
  toolCallId?: string
  childSteps?: CoreSessionCommandStep[]
}

export interface CoreSessionCommandMessage extends CoreTimelineMessage {
  contentParts?: unknown[]
  provider?: string
  model?: string
  usage?: CoreSessionTokenUsage
  steps?: CoreSessionCommandStep[]
}

export interface CoreSessionCommandSession<
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
> {
  id?: string
  messages: TMessage[]
  updatedAt: number
  lastProvider?: string
  lastModel?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

// ============ 冷加载 / 启动期修复(COW 入口) ============

/**
 * 旧的就地版 `sanitizeLoadedSession` / `sanitizeSessionOnStartup` 的替身
 * (P0.2 area ①)。
 *
 * 语义一字不改(`'loaded'` = 只清 isStreaming + 元数据;`'startup'` = 再加中断的
 * step / toolCall / 卡死的 compact 消息),**而且不改入参**:变了就返回一个新的
 * 会话对象(消息数组与被改的那几条消息都是新的),没变返回 `undefined`。
 *
 * §17.7.1 批 3:从前它借道 `applySessionCommand({type:'repairOnLoad'})` —— 归约器
 * 退役之后直调纯算法,中间那一层没有了。产出与从前逐字相同:消息数组来自
 * `repair.messages`,会话级那几格来自 `repair.sessionPatch` / `sessionDeletes`
 * (`computeSessionTimelineMetadataRepair` 的同一份判定)。
 */
function runRepairOnLoad<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(session: TSession, policy: 'startup' | 'loaded'): TSession | undefined {
  const repair = computeSessionRepairOnLoad<TMessage>(session, session.messages, policy)
  if (!repair.changed) return undefined

  const next = { ...(session as unknown as Record<string, unknown>), ...repair.sessionPatch }
  if (repair.messagesChanged) next.messages = repair.messages
  for (const key of repair.sessionDeletes) delete next[key]
  return next as unknown as TSession
}

export function sanitizeLoadedSession<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
>(session: TSession): TSession | undefined {
  return runRepairOnLoad<TSession, TMessage>(session, 'loaded')
}

export function sanitizeSessionOnStartup<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
>(session: TSession): TSession | undefined {
  return runRepairOnLoad<TSession, TMessage>(session, 'startup')
}
