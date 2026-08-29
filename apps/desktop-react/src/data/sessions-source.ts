import { create } from 'zustand'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import {
  buildGroups,
  buildProjects,
  toPreviewMessage,
  toSessionChapter,
  toSessionMarker,
  toSessionSummary,
} from '../expose/projection'
import type {
  ProjectSummary,
  SessionChapter,
  SessionGroup,
  SessionMarker,
  SessionPreviewMessage,
  SessionSummary,
} from '../expose/types'
import { sessionsPort } from './sessions-port'

/**
 * 会话侧的**真数据源**(D1)。全应用一个:总览 / 检索面板会话侧 / QuickLook /
 * 钢琴键目录都从这里取,不许谁再开第二份。
 *
 * 分工与旧 mock 表逐字相同 —— 换的只是「数据从哪来」:
 *  - 形状与分组:expose/projection.ts(纯函数);
 *  - 形态机:expose/transitions.ts(纯函数);
 *  - 取数与订阅:**这里**;
 *  - 画:components/。
 *
 * ── 三层数据,三种时机 ──────────────────────────────────────────────────
 *  1. **列表**(`sessions.listMeta`):连通后拉一次,之后由 SSE 驱动;
 *  2. **章节**(`sessions.getSegments`):按会话**按需**拉(进 QuickLook / 被检索
 *     面板点名),拉过就缓存;
 *  3. **首页消息**(`sessions.getMessagesPage`):同上。
 * 二三两层从不在列表阶段批量拉 —— 一次开面拉 N 条会话的正文,那是把「按需」写成
 * 了「全量」。
 *
 * ── SSE 的判据(增量 vs 重拉) ────────────────────────────────────────────
 * 能到手的只有 `session:event`(按会话的信封)。`session:created` /
 * `session:deleted` 是**全局事件**,而 `@renderer/platform` 没有开全局事件的订阅面
 * —— 所以「新建 / 删除」不能直接听见,只能从别的迹象推:
 *
 *  a. 信封的 sessionId **不在当前列表里** → 出现了我们不认识的会话 → 整表重拉
 *     (`listMeta`)。这是新建会话唯一可靠的迹象。
 *  b. `session:renamed` → **增量**:改那一条的 title(事件自带 name,不必回问)。
 *  c. 任何一条会动消息的事件(message:* / messages:replaced / stream:complete)
 *     → **增量**:把那条会话的 updatedAt 抬到信封时间(列表次序立刻跟上),
 *     并**作废**它那份首页消息与用户锚点缓存(下次要看时重拉)。
 *  d. `stream:complete` 额外作废**章节**缓存 —— 章节是一轮跑完之后才推导出来的。
 *  e. 其余事件(工具 / 权限 / 步骤 / 用量 / 账本…)对列表没有影响,一律忽略。
 *
 * **删除是一个诚实的缺口**:没有任何 per-session 事件说「我没了」,所以一条被
 * 别处删掉的会话会在列表里留到下一次整表重拉。补法是开全局事件订阅面,那要动
 * 共享层,不在本批。
 *
 * 重拉一律经 `scheduleRefresh()` 合并:**≤1 次 / 秒**。一次流里几十条事件不该
 * 变成几十次 listMeta。
 */

/** 重拉的最小间隔。一次流里事件密集,合并窗口就是「最多一秒一次」。 */
export const REFRESH_THROTTLE_MS = 1000

/** QuickLook 首页取多少条。够看清「最近在聊什么」,又不至于把一整条会话拖下来。 */
export const PREVIEW_PAGE_SIZE = 20

export type SessionsSourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SessionsSourceState {
  status: SessionsSourceStatus
  /** 失败时那句人话;成功后清空。 */
  error?: string
  sessions: SessionSummary[]
  projects: ProjectSummary[]
  groups: SessionGroup[]
  /** 按会话缓存的章节。键在表里 = 拉过了(空数组是「真的没有章节」)。 */
  chapters: Record<string, SessionChapter[]>
  /** 按会话缓存的首页消息。 */
  messages: Record<string, SessionPreviewMessage[]>
  /** 按会话缓存的用户消息锚点(钢琴键的键)。 */
  markers: Record<string, SessionMarker[]>
  /** 正在飞的按需请求(章节 / 消息各一份),用来去重并驱动骨架。 */
  loadingChapters: Record<string, true>
  loadingMessages: Record<string, true>

  /** 连通后启动:拉一次列表 + 订上 SSE。幂等。 */
  start: () => Promise<void>
  /** 立刻整表重拉(不经节流)—— 只给「明知列表脏了」的地方用。 */
  refresh: () => Promise<void>
  ensureChapters: (sessionId: string) => Promise<void>
  ensureMessages: (sessionId: string) => Promise<void>
  ensureMarkers: (sessionId: string) => Promise<void>
  /** 测试用:回到未启动的干净态(并退订)。 */
  reset: () => void
}

/** 会动消息的那批事件 —— 判据 c。 */
const MESSAGE_EVENTS: string[] = [
  SESSION_EVENT_TYPES.MESSAGE_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_UPDATED,
  SESSION_EVENT_TYPES.MESSAGE_DELETED,
  SESSION_EVENT_TYPES.MESSAGES_REPLACED,
  SESSION_EVENT_TYPES.STREAM_COMPLETE,
]

function project(sessions: SessionSummary[]): Pick<SessionsSourceState, 'sessions' | 'projects' | 'groups'> {
  const projects = buildProjects(sessions)
  return { sessions, projects, groups: buildGroups(projects, sessions) }
}

/** 模块级的订阅句柄与节流闸 —— 它们是「这一个进程的事实」,不是可渲染状态。 */
let unsubscribe: (() => void) | undefined
let started = false
let lastRefreshAt = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined

export const useSessionsSource = create<SessionsSourceState>()((set, get) => {
  async function loadList(): Promise<void> {
    const port = await sessionsPort()
    try {
      const response = await port.listMeta()
      if (!response.success) {
        set({ status: 'error', error: response.error || 'sessions.listMeta 未成功' })
        return
      }
      set({ status: 'ready', error: undefined, ...project((response.sessions ?? []).map(toSessionSummary)) })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 合并重拉:窗口内的多次请求塌成末尾一次。 */
  function scheduleRefresh(): void {
    if (refreshTimer) return
    const wait = Math.max(0, lastRefreshAt + REFRESH_THROTTLE_MS - Date.now())
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      lastRefreshAt = Date.now()
      void loadList()
    }, wait)
  }

  function onEvent(envelope: SessionEventEnvelope): void {
    const { sessionId } = envelope
    const type = envelope.event?.type
    if (!sessionId || typeof type !== 'string') return

    const state = get()
    const known = state.sessions.some((s) => s.id === sessionId)
    // 判据 a:不认识这条会话 = 有人新建了一条,只能整表重拉。
    if (!known) {
      scheduleRefresh()
      return
    }

    // 判据 b:改名自带新名字,一格增量就够。
    if (type === SESSION_EVENT_TYPES.SESSION_RENAMED) {
      const name = (envelope.event as { name?: string }).name
      if (typeof name !== 'string') return
      set(project(state.sessions.map((s) => (s.id === sessionId ? { ...s, title: name } : s))))
      return
    }

    // 判据 c / d:消息动了 → 抬时间 + 作废这条会话的按需缓存。
    if (MESSAGE_EVENTS.includes(type)) {
      const messages = { ...state.messages }
      delete messages[sessionId]
      const markers = { ...state.markers }
      delete markers[sessionId]
      const patch: Partial<SessionsSourceState> = { messages, markers }
      if (type === SESSION_EVENT_TYPES.STREAM_COMPLETE) {
        const chapters = { ...state.chapters }
        delete chapters[sessionId]
        patch.chapters = chapters
      }
      set({
        ...patch,
        ...project(
          state.sessions.map((s) =>
            s.id === sessionId ? { ...s, updatedAt: Math.max(s.updatedAt, envelope.timestamp) } : s,
          ),
        ),
      })
    }
    // 判据 e:其余一律忽略。
  }

  return {
    status: 'idle',
    sessions: [],
    projects: [],
    groups: [],
    chapters: {},
    messages: {},
    markers: {},
    loadingChapters: {},
    loadingMessages: {},

    start: async () => {
      if (started) return
      started = true
      set({ status: 'loading' })
      const port = await sessionsPort()
      await port.ready()
      // 先订上再拉:拉的那一刻起的事件不能漏(与 D0 连通面同一条理由)。
      unsubscribe = port.onSessionEvent(onEvent)
      lastRefreshAt = Date.now()
      await loadList()
    },

    refresh: async () => {
      lastRefreshAt = Date.now()
      await loadList()
    },

    ensureChapters: async (sessionId) => {
      const state = get()
      if (!sessionId) return
      if (sessionId in state.chapters || state.loadingChapters[sessionId]) return
      set({ loadingChapters: { ...state.loadingChapters, [sessionId]: true } })
      const port = await sessionsPort()
      let chapters: SessionChapter[] = []
      try {
        const response = await port.getSegments(sessionId)
        chapters = response.success ? (response.segments ?? []).map(toSessionChapter) : []
      } catch {
        // 章节拉不到 = 这条会话此刻没有目录可看,不是整个面的错误 ——
        // 所以它不进 status,缓存成空表(空态由渲染层画)。
        chapters = []
      }
      set((prev) => {
        const loading = { ...prev.loadingChapters }
        delete loading[sessionId]
        return { chapters: { ...prev.chapters, [sessionId]: chapters }, loadingChapters: loading }
      })
    },

    ensureMessages: async (sessionId) => {
      const state = get()
      if (!sessionId) return
      if (sessionId in state.messages || state.loadingMessages[sessionId]) return
      set({ loadingMessages: { ...state.loadingMessages, [sessionId]: true } })
      const port = await sessionsPort()
      let messages: SessionPreviewMessage[] = []
      try {
        const response = await port.getMessagesPage(sessionId, PREVIEW_PAGE_SIZE)
        messages = response.success ? (response.messages ?? []).map(toPreviewMessage) : []
      } catch {
        messages = []
      }
      set((prev) => {
        const loading = { ...prev.loadingMessages }
        delete loading[sessionId]
        return { messages: { ...prev.messages, [sessionId]: messages }, loadingMessages: loading }
      })
    },

    ensureMarkers: async (sessionId) => {
      const state = get()
      if (!sessionId) return
      if (sessionId in state.markers) return
      const port = await sessionsPort()
      let markers: SessionMarker[] = []
      try {
        const response = await port.getUserMarkers(sessionId)
        markers = response.success ? (response.markers ?? []).map(toSessionMarker) : []
      } catch {
        markers = []
      }
      set((prev) => ({ markers: { ...prev.markers, [sessionId]: markers } }))
    },

    reset: () => {
      unsubscribe?.()
      unsubscribe = undefined
      started = false
      lastRefreshAt = 0
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = undefined
      set({
        status: 'idle',
        error: undefined,
        sessions: [],
        projects: [],
        groups: [],
        chapters: {},
        messages: {},
        markers: {},
        loadingChapters: {},
        loadingMessages: {},
      })
    },
  }
})

/** 非组件上下文的读法(store 壳、纯函数的入参)。 */
export function currentGroups(): SessionGroup[] {
  return useSessionsSource.getState().groups
}

export function currentSessions(): SessionSummary[] {
  return useSessionsSource.getState().sessions
}
