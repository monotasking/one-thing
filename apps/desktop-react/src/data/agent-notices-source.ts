import { create } from 'zustand'
import { t } from '../i18n'
import { notify } from '../services/notify'
import type { NotifyLevel } from '../services/notify'
import { acpAgentsQuery } from './acp-agents-source'

/**
 * **agent 发给人的提醒**(ACP A4-a 的全局事件 `agent:notification`,壳半边 A2-c)。
 *
 * 外部 agent 经宿主工具面调 `send_notification`,后端按**桥凭据背后那条本地会话**
 * (不是 agent 自己报的)发一帧 `agent:notification { sessionId, agentId, message, title?,
 * level, at }`。它不进账本(不是聊天正文,那是 `send_message` 的事),所以壳这一侧就是
 * 它唯一的家,两个落点:
 *
 *  1. **那条会话里一行系统行**(`ChatStream` 按时间插在消息之间,`AgentNoticeRow`)——
 *     打开会话就看得到「agent 在这里说过一句话」;
 *  2. **会话不在屏上时**再走一次 `notify`(通知中心 + 按级别弹不弹)—— 人不在看那条
 *     会话,那一行系统行就等于没说。在屏上时只落 1:当着人的面再弹一个框是重复。
 *
 * 「在不在屏上」不是这个模块的判断(数据层不认识拼贴树):由启动的人传一只判据进来
 * (`main.tsx` 传的是 `content/session-ref.sessionShownOnScreen`)。
 *
 * ── 寿命 ────────────────────────────────────────────────────────────────
 * 这张表在内存里,**跟壳同寿**:重开壳它就空了。这是一个诚实的限度 —— 通知没有账本,
 * 后端也不回放全局事件(`?after=` 只回放会话事件)。关掉壳之前那几条在通知中心的存档里
 * (那一份落 localStorage),会话里的系统行不在。每条会话最多留 `NOTICE_CAP` 条,
 * 满了丢最老的:一台失控的 agent 刷屏,不该让一条会话无限长。
 *
 * ── 订阅 ────────────────────────────────────────────────────────────────
 * 一条模块级订阅,`startAgentNotices()` 起(幂等),HMR 退役复用 `stopAgentNotices()`。
 */

export interface AgentNotice {
  /** 本机铸的号(推送帧没有 id)。只用来当 React key。 */
  id: string
  sessionId: string
  agentId: string
  message: string
  title?: string
  level: AgentNoticeLevel
  /** epoch ms,发的一方盖。系统行按它插进消息之间。 */
  at: number
}

export type AgentNoticeLevel = 'info' | 'success' | 'warn' | 'error'

const LEVELS: ReadonlySet<string> = new Set<AgentNoticeLevel>(['info', 'success', 'warn', 'error'])

/** 每条会话最多留几条(见文件头「寿命」)。 */
export const NOTICE_CAP = 50

export interface AgentNoticesPort {
  ready(): Promise<unknown>
  /** `agent:notification` 的推送面。返回退订函数。 */
  onNotice(callback: (data: unknown) => void): () => void
}

let port: AgentNoticesPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAgentNoticesPort(next: AgentNoticesPort | undefined): void {
  port = next
}

async function realPort(): Promise<AgentNoticesPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  return {
    ready: () => whenConnected(),
    onNotice: (callback) =>
      client.events.onAny((frame) => {
        if (frame.name === 'agent:notification') callback(frame.data)
      }),
  }
}

/**
 * 一帧载荷认不认。形不对就丢(推送面是不可信输入):会话、agent、正文三格缺一不可,
 * 级别认不出落 `info`(说错颜色比丢掉一条话好),时刻没有就用收到的那一刻。
 */
export function agentNoticeOfFrame(data: unknown, now = Date.now()): Omit<AgentNotice, 'id'> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const { sessionId, agentId, message, title, level, at } = record
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof agentId !== 'string' || !agentId) return null
  if (typeof message !== 'string' || !message) return null
  return {
    sessionId,
    agentId,
    message,
    ...(typeof title === 'string' && title ? { title } : {}),
    level: typeof level === 'string' && LEVELS.has(level) ? (level as AgentNoticeLevel) : 'info',
    at: typeof at === 'number' && Number.isFinite(at) ? at : now,
  }
}

interface AgentNoticesState {
  bySession: Readonly<Record<string, readonly AgentNotice[]>>
}

export const useAgentNotices = create<AgentNoticesState>(() => ({ bySession: {} }))

const EMPTY: readonly AgentNotice[] = []

/** 一条会话此刻的提醒(按 `at` 升序)。没有 = 恒等的空数组,订阅者不会因它重渲。 */
export function useSessionAgentNotices(sessionId: string): readonly AgentNotice[] {
  return useAgentNotices((state) => state.bySession[sessionId] ?? EMPTY)
}

let seq = 0

/** 收下一条。纯写表,不弹、不判屏 —— 那一半在 `receiveAgentNotice`。导出给测试。 */
export function addAgentNotice(notice: Omit<AgentNotice, 'id'>): AgentNotice {
  seq += 1
  const entry: AgentNotice = { ...notice, id: `agent-notice-${seq}` }
  useAgentNotices.setState((state) => {
    const prev = state.bySession[notice.sessionId] ?? EMPTY
    // 按 `at` 插进去而不是追加:两台 agent 的钟与到达序不一定同向,系统行要按时间排。
    const next = [...prev, entry].sort((a, b) => a.at - b.at)
    return { bySession: { ...state.bySession, [notice.sessionId]: next.slice(-NOTICE_CAP) } }
  })
  return entry
}

/** agent 在名册上叫什么。名册没拉过 / 没这一台 → 就用 id(那是事实,编一个名字是猜)。 */
function agentNameOf(agentId: string): string {
  const row = acpAgentsQuery.get().data?.find((state) => state.config.id === agentId)
  return row?.config.name || row?.agentInfo?.name || agentId
}

/** 通知中心那一条的标题:agent 名 + 它自己给的标题(没给就说「发来通知」)。 */
export function agentNoticeTitle(notice: Pick<AgentNotice, 'agentId' | 'title'>, name = agentNameOf(notice.agentId)): string {
  return notice.title
    ? t('chat.agentNotice.title', { agent: name, title: notice.title })
    : t('chat.agentNotice.untitled', { agent: name })
}

const NOTIFY_LEVEL: Record<AgentNoticeLevel, NotifyLevel> = {
  info: 'info',
  success: 'success',
  warn: 'warn',
  error: 'error',
}

export interface AgentNoticesDeps {
  /** 这条会话此刻在不在屏上(在 = 只落系统行,不再弹)。 */
  isSessionOnScreen: (sessionId: string) => boolean
}

/** 一帧进来:认形 → 落表 → 不在屏上就再说一次。导出给测试。 */
export function receiveAgentNotice(data: unknown, deps: AgentNoticesDeps): AgentNotice | null {
  const parsed = agentNoticeOfFrame(data)
  if (!parsed) return null
  const entry = addAgentNotice(parsed)
  if (!deps.isSessionOnScreen(entry.sessionId)) {
    notify({
      level: NOTIFY_LEVEL[entry.level],
      title: agentNoticeTitle(entry),
      body: entry.message,
      // 按 agent 分来源:通知中心里同一台 agent 的几条归在一处,去重窗口也按它。
      source: `agent:${entry.agentId}`,
    })
  }
  return entry
}

let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

/** 起那一条订阅。幂等;连不上就不起(通知本来就是尽力而为,不挡任何事)。 */
export function startAgentNotices(deps: AgentNoticesDeps): Promise<void> {
  if (unsubscribe || starting) return starting ?? Promise.resolve()
  starting = (async () => {
    try {
      const p = port ?? (await realPort())
      await p.ready()
      unsubscribe = p.onNotice((data) => {
        receiveAgentNotice(data, deps)
      })
    } catch {
      // 连不上 = 这一台壳收不到 agent 的提醒;其余一切照旧。下一次 start 再试。
    } finally {
      starting = undefined
    }
  })()
  return starting
}

/** 退订并清表。测试与 HMR 用;幂等。 */
export function stopAgentNotices(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  useAgentNotices.setState({ bySession: {} })
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopAgentNotices)
}
