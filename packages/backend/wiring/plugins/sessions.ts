/**
 * N1 的**装配层实现**:跨会话投递(信使)与会话感知快照。
 *
 * 协议在 core(`@onething/core/plugins` 的 sessions.ts):枚举、常量、结果形状、
 * 三态矩阵的纯函数。这里放的是那些**只有产品层知道**的事实:谁在生成、正在跑
 * 哪个工具、有没有挂着审批卡、上下文占了多少、最后一条消息说了什么,
 * 以及"起一轮"到底要往总线上发什么。
 *
 * ## 三条纪律
 *
 *  1. **零新统计**。快照的每一格都从现成内存态现算(引擎的 activeStreams、
 *     core Permission 的 pending 表、会话存储、模型注册表的窗口),不落盘、
 *     不开第二本账 —— 两本账迟早会漂,而漂的那一刻插件读到的是一个说谎的状态。
 *  2. **不加载全量历史**。lastMessage 走 `getSessionMessagesPage({anchor:'tail',
 *     limit:1})`;list() 走 `getSessionsList()`(元数据索引),一条消息都不读。
 *  3. **循环闸是这一期的主角**。它是第一个"插件可自发耗 token"的口:没有闸,
 *     两个会话互相回话就是一个不收敛的账单。
 *
 * ## 循环闸怎么记账(诚实说明它的近似)
 *
 * 链长(hop)要回答的是"这次投递是第几手转发"。理想口径是"发起这次调用的那个
 * 回合是第几跳",但 `api.sendMessage(sessionId, …)` **不携带调用方所在的会话**
 * ——插件可以在事件 handler、定时任务、工具执行里任何地方调它。
 *
 * 让插件自己传 `fromSessionId` 是不行的:传一个假的(或干脆不传)就能把跳数
 * 永远压在 0,闸自己把自己关掉了。所以这里取**保守上界**:
 *
 *     hop = 1 + max(此刻仍在飞的、由插件投递引发的回合的 hop)
 *
 * 它不可被插件规避(不需要调用方配合),代价是**并发时会偏保守** —— 另一条无关
 * 的插件链正在跑时,这一次投递会被算高一跳。在上限 8 之下这是可接受的误差,
 * 而反过来(可被规避的精确值)是不可接受的。
 */
import type { MessageOrigin } from '@shared/ipc.js'
import { Permission } from '@onething/core/permission'
import {
  PLUGIN_TRIGGER_MAX_HOP,
  PLUGIN_TRIGGER_RATE_LIMIT,
  PLUGIN_TRIGGER_RATE_WINDOW_MS,
  pluginPeekPreview,
  resolvePluginDelivery,
  type PluginMessageDelivery,
  type PluginSendMessageOptions,
  type PluginSendMessageResult,
  type PluginSessionPeek,
  type PluginSessionPeekLite,
  type PluginSessionState,
} from '@onething/core/plugins'

import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import type { EventBus } from '../../events/event-bus.js'
import type { StreamEngine } from '../engine/stream-engine-bound.js'
import { isCollabCoordinatorDrivenSession } from '../collab/ingress.js'
import { pluginMessageSource } from '@onething/runtime/engine/message-sources'
import * as modelRegistry from '../providers/model-registry.js'

import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('plugins.sessions')


/* ── 循环闸:跳数账 ───────────────────────────────────────────────────────── */

interface TriggerLedgerEntry {
  hop: number
  at: number
}

/**
 * 由插件投递引发的、**可能还在飞**的回合。
 *
 * 何时算"还在飞":目标会话此刻有活跃流 —— 或者投递刚发生不久(引擎起流是异步的,
 * 命令发出去到 activeStreams 里出现之间有一个窗口;没有这段宽限期,连打两次
 * 就都算 hop 1)。宽限期一过且没起流(投递被拒 / 会话没动),条目自然作废。
 */
const GRACE_MS = 30_000

const triggerLedger = new Map<string, TriggerLedgerEntry>()

/** 每 (pluginId, sessionId) 对的投递时刻环。 */
const rateWindows = new Map<string, number[]>()

/** 测试与进程收摊用:两本内存账清零。 */
export function resetPluginSessionLedgers(): void {
  triggerLedger.clear()
  rateWindows.clear()
}

function ledgerIsLive(sessionId: string, entry: TriggerLedgerEntry, engine: StreamEngine, now: number): boolean {
  if (now - entry.at < GRACE_MS) return true
  return engine.getActiveSessionIds().includes(sessionId)
}

/** 保守上界:此刻还在飞的插件链里最深的那一跳。没有就是 0。 */
function ambientHop(engine: StreamEngine, now: number): number {
  let max = 0
  for (const [sessionId, entry] of [...triggerLedger]) {
    if (!ledgerIsLive(sessionId, entry, engine, now)) {
      triggerLedger.delete(sessionId)
      continue
    }
    if (entry.hop > max) max = entry.hop
  }
  return max
}

function recordTrigger(sessionId: string, hop: number, now: number): void {
  const existing = triggerLedger.get(sessionId)
  // 同一会话上更深的一跳覆盖更浅的:链只会变长,不会变短。
  if (existing && existing.hop > hop) {
    triggerLedger.set(sessionId, { hop: existing.hop, at: now })
    return
  }
  triggerLedger.set(sessionId, { hop, at: now })
}

function rateLimited(pluginId: string, sessionId: string, now: number): boolean {
  const key = `${pluginId}::${sessionId}`
  const window = (rateWindows.get(key) ?? []).filter(at => now - at < PLUGIN_TRIGGER_RATE_WINDOW_MS)
  if (window.length >= PLUGIN_TRIGGER_RATE_LIMIT) {
    rateWindows.set(key, window)
    return true
  }
  window.push(now)
  rateWindows.set(key, window)
  return false
}

/* ── 投递 ─────────────────────────────────────────────────────────────────── */

export interface PluginSessionHostDeps {
  eventBus: EventBus
  streamEngine: StreamEngine
  now?(): number
}

function sessionIsBusy(engine: StreamEngine, sessionId: string): boolean {
  return engine.getActiveSessionIds().includes(sessionId)
}

/**
 * 注入消息的身份戳。
 *
 * `source` 是 `plugin:<id>` —— 那是 `isSystemInternalSource` 的判据,它让这条
 * 消息**绕过渠道路由**(插件推送背后没有渠道身份,路由会把它改派到一个匿名身份
 * 会话去)。`origin.plugin` 是给读得懂结构的消费方:渲染归因与链长账。
 *
 * `channel` 刻意**不设** —— 它决定权限提示的目标通道(引擎按 `cmd.channel ||
 * 'ipc'` 记),给一个花名会让桌面 UI 上弹出的审批卡永远点不动。
 */
function pluginOrigin(pluginId: string, hop: number, now: number): MessageOrigin {
  return {
    transport: 'api',
    source: pluginMessageSource(pluginId),
    receivedAt: now,
    plugin: { id: pluginId, hop },
  }
}

/**
 * 一次**系统内部投递**的请求(插件信使 N1 与后台派工回投共用)。
 *
 * 抽出这一层的理由不是省行数,是**闸只能有一本账**:链长与频率两道门存在的
 * 理由是「宿主自己能驱动自己」,而派工回投与插件投递是同一类事 —— 两条链会互相
 * 触发(一个插件叫醒的会话可以派工,派工回来又可以再触发插件)。让它们各记各的
 * 账,合起来的那条链就没有人管了。所以账本、宽限期、三态矩阵、身份戳的写法全部
 * 在这一个函数里,调用方只提供**自己是谁**(rate 账户名)与**怎么盖戳**。
 */
export interface InternalDeliveryRequest {
  /**
   * 频率闸的账户名:插件是 `pluginId`,派工是 `task:<taskSessionId>`。
   * 也是日志前缀 —— 被闸挡住时要看得出是谁被挡的。
   */
  actorKey: string
  sessionId: string
  content: string
  options: PluginSendMessageOptions
  /** 身份戳工厂:拿到这次投递记的跳数,回一份 origin。 */
  origin(hop: number, now: number): MessageOrigin
}

export async function deliverInternalMessage(
  deps: PluginSessionHostDeps,
  request: InternalDeliveryRequest,
  deliveryContext?: { executionContext?: unknown },
): Promise<PluginSendMessageResult> {
  const { actorKey, sessionId, content, options } = request
  const now = deps.now?.() ?? Date.now()
  const engine = deps.streamEngine

  if (!store.getSessionDetails(sessionId)) {
    return { ok: false, reason: 'unknown-session', detail: sessionId }
  }

  const busy = sessionIsBusy(engine, sessionId)
  const delivery = resolvePluginDelivery(options, busy)

  // 协作房 / agent 执行会话由协调者独占驱动:内部来源的命令在引擎里会被当场
  // 拒绝(而那是一次调用方观察不到的静默失败)。在这里就说清楚。
  if (isCollabCoordinatorDrivenSession(sessionId)) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'collab room / agent sessions are driven by the coordinator; they do not accept internal deliveries',
    }
  }

  const hop = ambientHop(engine, now) + 1
  if (hop > PLUGIN_TRIGGER_MAX_HOP) {
    log.warn('sendMessage refused: hop limit exceeded', {
      actorKey,
      sessionId,
      hop,
      limit: PLUGIN_TRIGGER_MAX_HOP,
    })
    return {
      ok: false,
      reason: 'hop-limit',
      hop,
      targetWasBusy: busy,
      detail: `chain length ${hop} > ${PLUGIN_TRIGGER_MAX_HOP}`,
    }
  }
  if (rateLimited(actorKey, sessionId, now)) {
    log.warn('sendMessage refused: rate limited', {
      actorKey,
      sessionId,
      limit: PLUGIN_TRIGGER_RATE_LIMIT,
      windowMs: PLUGIN_TRIGGER_RATE_WINDOW_MS,
    })
    return {
      ok: false,
      reason: 'rate-limited',
      hop,
      targetWasBusy: busy,
      detail: `${PLUGIN_TRIGGER_RATE_LIMIT} per ${PLUGIN_TRIGGER_RATE_WINDOW_MS}ms per (sender, session)`,
    }
  }

  const origin = request.origin(hop, now)
  const source = origin.source

  switch (delivery) {
    case 'triggered':
      // 起一轮 = **既有的** command:send-message 路径(与调度器、语音、网关同一条),
      // 不另造入口。channel 不设 → 引擎按 'ipc' 记,桌面 UI 答得了权限卡。
      await deps.eventBus.emit(sessionId, {
        type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
        content,
        source,
        origin,
      } as Parameters<EventBus['emit']>[1], deliveryContext)
      break
    case 'followed-up':
      engine.followUpMessage(sessionId, content, source, origin)
      break
    case 'steered':
    case 'posted':
      // 同一条既有机制,两种诚实的说法:steering 队列会**立刻持久化并显示**
      // 这条消息,在飞的回合会把它插进去,空闲会话则留给下一轮。
      // 'steered' = 我们本想起轮但目标在忙;'posted' = 本来就不打算起轮。
      engine.steerMessage(sessionId, content, source, origin)
      break
  }

  // 只有**会引发/汇入一个回合**的投递才进链长账:起轮那一格,以及投进一个正在
  // 生成的会话(steer/followUp 会被在飞的那一轮吃掉)。纯 posted 到空闲会话不
  // 记账 —— 它不产生回合,给它记一跳会让"往同一个会话贴十条备忘"把闸撑爆,
  // 而那条链根本不存在。
  if (delivery === 'triggered' || busy) recordTrigger(sessionId, hop, now)
  return { ok: true, delivered: delivery, targetWasBusy: busy, hop }
}

export async function pluginSendMessage(
  deps: PluginSessionHostDeps,
  pluginId: string,
  sessionId: string,
  content: string,
  options: PluginSendMessageOptions,
): Promise<PluginSendMessageResult> {
  return deliverInternalMessage(deps, {
    actorKey: pluginId,
    sessionId,
    content,
    options,
    origin: (hop, now) => pluginOrigin(pluginId, hop, now),
  })
}

/**
 * N2 的 `handled.reply` 投递口 —— **复用 `posted` 那一格**(同一条 steering
 * 机制:立刻持久化并显示,空闲会话不因此起轮),同一个身份戳。
 *
 * 与 `pluginSendMessage` 的两处**刻意不同**,理由都是"这不是插件自发的投递":
 *
 *  1. **不过链长闸 / 频率闸**。闸存在的理由是插件能自己驱动自己(两个会话互相
 *     回话是一个不收敛的循环)。这里的每一条回应都由**用户刚按下的那次回车**
 *     一比一地引出:用户不发,它一条也不发,天然收敛。给它套上 10 条/分钟的
 *     窗口,唯一的效果是用户连算十一次算术之后宏"莫名其妙不答了"。
 *  2. **hop 记 0**。N1 的口径里"第一次由插件发起的投递是 1";0 如实表示
 *     "这不是插件发起的链,是对用户输入的即答"。
 */
/**
 * 这条投递用得上的引擎能力**只有一个动作**:把文本作为追话交给会话。
 *
 * 收窄到这一个动作(P3'e-A2b)而不是整个 `StreamEngine`,是因为调用点在
 * **引擎内部** —— 让引擎为了回调自己而先把自己整只递进来,是一个会诱人再多用
 * 一格的循环引用;写成动作端口之后,`stream-engine-bound.ts` 那边的惰性引用
 * 收在一个箭头函数里,`if (!engine) return` 的空档判断也随之消失。
 */
export interface PluginInterceptSteerPort {
  steer(sessionId: string, content: string, source: string, origin: MessageOrigin): void
}

export function pluginPostInterceptReply(
  /**
   * 刻意只要 `steer`,不要整个 `PluginSessionHostDeps`。
   *
   * 这条投递不碰事件总线,而调用点在**引擎内部** —— 在那里现取
   * `getEventBus()` 只为把它塞进一个用不上的字段,而它在总线未初始化的宿主上
   * 会抛;那一抛发生在 core 的 try 之外,后果是整条发送 reject。
   * 依赖收窄成实际用到的那一个动作,这个失败模式在类型上就不存在了。
   */
  deps: PluginInterceptSteerPort & Pick<PluginSessionHostDeps, 'now'>,
  pluginId: string,
  sessionId: string,
  content: string,
): void {
  const text = String(content ?? '').trim()
  if (!text) return
  const now = deps.now?.() ?? Date.now()
  const origin = pluginOrigin(pluginId, 0, now)
  deps.steer(sessionId, text, origin.source, origin)
}

/* ── 感知快照 ─────────────────────────────────────────────────────────────── */

/**
 * 状态判定的**优先序**(协议层写死语义,这里是实现):
 *
 *   `awaiting-permission` > `tool-running` > `generating` > `idle`
 *
 * 权限排最前是因为它答的是"这轮还会不会自己往前走":挂着一张没人点的审批卡时,
 * 会话在技术上仍有活跃流(而且很可能同时有一个 executing 的工具),但它一步也
 * 不会动。信使插件据此决定"现在插话还是等等" —— 把它说成 generating 就是说谎。
 *
 * pending 不区分 actionable / queued:排队中的那张卡同样意味着这轮被人卡住了。
 */
function peekState(
  engine: StreamEngine,
  sessionId: string,
): { state: PluginSessionState; currentTool?: string } {
  if (Permission.getPendingPrompts(sessionId).length > 0) {
    return { state: 'awaiting-permission' }
  }
  if (!sessionIsBusy(engine, sessionId)) return { state: 'idle' }
  const running = runningToolName(sessionId)
  return running ? { state: 'tool-running', currentTool: running } : { state: 'generating' }
}

/**
 * 正在跑的工具名 —— 读**最后一条 assistant 消息**的 toolCalls(现成内存态)。
 *
 * 从尾部往前扫一小段而不是整条历史:执行中的工具只可能挂在本轮的那条消息上。
 */
function runningToolName(sessionId: string): string | undefined {
  const message = sessionReads.lastMessageOfRole(sessionId, 'assistant')
  if (!message) return undefined
  return message.toolCalls?.find(call => call.status === 'executing')?.toolName
}

/**
 * 上下文占用 —— 口径与输入框的 ctx 仪表逐字相同:
 * `contextSize ?? lastInputTokens` ÷ 该会话上次用的模型的上下文窗口。
 * 解析不出窗口就**不给这个键**(0 是一个会被当真的数)。
 */
async function contextPercentOf(sessionId: string): Promise<number | undefined> {
  const details = store.getSessionDetails(sessionId)
  if (!details?.lastModel) return undefined
  const usage = store.getSessionTokenUsage(sessionId)
  const tokens = usage?.contextSize || usage?.lastInputTokens || 0
  if (tokens <= 0) return undefined
  try {
    const window = await modelRegistry.getModelContextLength(details.lastModel, details.lastProvider)
    if (!window || window <= 0) return undefined
    return Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  } catch {
    return undefined
  }
}

function lastMessageOf(sessionId: string): PluginSessionPeek['lastMessage'] {
  // JSONL 尾读一条 —— 不加载全量历史(这是快照,不是转录)。
  const page = sessionReads.pageMessages({ sessionId, anchor: 'tail', limit: 1 })
  const message = page?.messages?.[page.messages.length - 1]
  if (!message) return undefined
  return {
    role: String(message.role ?? 'unknown'),
    preview: pluginPeekPreview(typeof message.content === 'string' ? message.content : ''),
    at: Number(message.timestamp ?? 0),
  }
}

export async function pluginPeekSession(
  deps: PluginSessionHostDeps,
  sessionId: string,
): Promise<PluginSessionPeek | null> {
  const details = store.getSessionDetails(sessionId)
  if (!details) return null
  const { state, currentTool } = peekState(deps.streamEngine, sessionId)
  const contextPercent = await contextPercentOf(sessionId)
  const lastMessage = lastMessageOf(sessionId)
  return {
    sessionId,
    title: details.name || null,
    state,
    ...(currentTool ? { currentTool } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(contextPercent === undefined ? {} : { contextPercent }),
    updatedAt: Number(details.updatedAt ?? 0),
  }
}

/**
 * 全会话 peek-lite:**纯元数据**,无 lastMessage、无 contextPercent。
 *
 * 两者都要按会话再读一次(尾页 / 模型窗口),N 个会话就是 N 次 —— 列表是拿来
 * "找到那个会话"的,找到之后再 peek 一次拿细节。按 updatedAt 降序。
 */
export async function pluginListSessions(
  deps: PluginSessionHostDeps,
): Promise<PluginSessionPeekLite[]> {
  const metas = store.getSessionsList() ?? []
  return [...metas]
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    .map((meta) => {
      const { state, currentTool } = peekState(deps.streamEngine, meta.id)
      return {
        sessionId: meta.id,
        title: meta.name || null,
        state,
        ...(currentTool ? { currentTool } : {}),
        updatedAt: Number(meta.updatedAt ?? 0),
      }
    })
}

/** 装配用:把三个动词打包成 api-builder 的 host 片段。 */
export function createPluginSessionHostPorts(deps: PluginSessionHostDeps): {
  sendMessage(
    pluginId: string,
    sessionId: string,
    content: string,
    options: PluginSendMessageOptions,
  ): Promise<PluginSendMessageResult>
  peekSession(pluginId: string, sessionId: string): Promise<PluginSessionPeek | null>
  listSessions(pluginId: string): Promise<PluginSessionPeekLite[]>
} {
  return {
    sendMessage: (pluginId, sessionId, content, options) =>
      pluginSendMessage(deps, pluginId, sessionId, content, options),
    peekSession: (_pluginId, sessionId) => pluginPeekSession(deps, sessionId),
    listSessions: () => pluginListSessions(deps),
  }
}

export type { PluginMessageDelivery }
