import { create } from 'zustand'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionLifecycleEvent } from '@renderer/platform/session-lifecycle'
import {
  buildGroups,
  buildProjects,
  toPreviewMessage,
  toSessionChapter,
  toSessionMarker,
  toSessionSummary,
  isListedSession,
  sessionBelongsToSpace,
} from '../expose/projection'
import { currentSpaceId, subscribeCurrentSpace } from '../workspace/current'
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
 * 重拉一律经 `scheduleRefresh()` 合并:**≤1 次 / 秒**。一次流里几十条事件不该
 * 变成几十次 listMeta。
 *
 * ── 删除:第二条订阅(H 批,那个缺口补上了) ─────────────────────────────
 * 共享层读侧补齐 E 批给出了 `platform/session-lifecycle` 的 `onSessionLifecycle`
 * —— 同一条 `session:event` 推送面上的一层折叠,把「建 / 删」从流里认出来。
 * 于是删除不再等下一次整表重拉:收到 `deleted` 就**当场**把那批 id
 * (自己 + 级联删掉的子会话,事件自带完整名单)从列表里摘掉,并作废它们的
 * 章节 / 消息 / 锚点三份缓存。
 *
 * 两件事划清:
 *  - `created` 这一半**本批不接**,新建仍走判据 a —— 那条路已经在工作,
 *    再加一条会有两个产地说同一件事。
 *  - 删除事件本身在 `onEvent` 里被**提前挡掉**:它在删除**之前**发射,级联删掉的
 *    子会话又常常不在列表里,落到判据 a 就成了「不认识 = 有人新建了」,
 *    一次删除换来一次毫无意义的整表重拉。
 *
 * 形态机那一侧(Quick Look 正开着被删的那条 / 当前会话被删)不在这里判:
 * 数据源只管数据,摘完之后经 `onSessionsRemoved` 把 id 交出去,
 * expose/store.ts 那层壳再调纯函数 `sessionsRemoved` 夹持形态。
 *
 * ── 工作区:一本全库账,一份屏幕投影(09-01「真切换」批)───────────────────
 * `listMeta` **不带空间参数**(契约上没有这一格),它交下来的是这台机器上的
 * 全部会话。所以这里存两样东西,分工严格:
 *
 *  - **全库账**(模块级 `ledger`):listMeta 那一份的原样,未经任何投影过滤。
 *    SSE 的增量(改名 / 抬时间 / 摘除)全都打在它身上。
 *  - **屏幕那一份**(store 里的 `sessions` / `projects` / `groups`):
 *    全库账 ∩ 可陈列的形态 ∩ **当前工作区**(`visibleOf`)。
 *
 * 分这两层是为了让**切换工作区不发一次请求**:换世界只是拿同一本账重投影一次,
 * 同步完成 —— 于是没有「清空 → 骨架 → 重灌」的那一档,四律第 2 条(重拉期间旧
 * 内容留在屏上)在这里被满足得更彻底:根本没有重拉。账本本身由 SSE 保持新鲜,
 * 别的空间的会话在账上照样跟着动,切回去时次序就是对的。
 *
 * 08-31 那张 `hiddenIds` 名单随之退役:它当初存在是因为「被滤掉的会话不在
 * `state.sessions` 里,于是它们的事件会被判据 a 当成新建」。全库账里什么都有,
 * 「认不认识」直接问账本即可 —— 一个名单少一个会跟真相走散的副本。
 */

/** 重拉的最小间隔。一次流里事件密集,合并窗口就是「最多一秒一次」。 */
export const REFRESH_THROTTLE_MS = 1000

/** QuickLook 首页取多少条。够看清「最近在聊什么」,又不至于把一整条会话拖下来。 */
export const PREVIEW_PAGE_SIZE = 20

export type SessionsSourceStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 建会话的结果。**成败是两种形状**而不是一个可空 id:失败时那句人话必须有地方
 * 放,让调用方原样说给用户听(后端说的错不许被换成一句「操作失败」)。
 */
export type CreateSessionOutcome =
  | {
      ok: true
      sessionId: string
      /**
       * 第二步(落目录)失败时后端的原话。会话本身建成了(ok 仍是 true),
       * 但它没有归进那个项目 —— 调用方要把这句说给用户听,不许无声。
       * 08-31 真机账单:壳走 http 面,沙箱夹持把落目录逐次拒掉,而这里以前
       * 只 catch 异常、不看 `success:false`,错误无声蒸发,会话落成空目录,
       * claude-code-agent 因「未绑定工作目录」拒启。
       */
      workdirError?: string
    }
  | { ok: false; error: string }

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
  /**
   * 建一条会话,落在 `projectId` 这个项目下(null = 不属于任何项目)。
   *
   * 三件事,次序即语义:
   *  1. `sessions.create` —— 名字不给,后端落它自己的默认名(见 sessions-port);
   *  2. `sessions.updateWorkingDirectory` —— 只在 projectId 非空时打这一发。
   *     它**失败不回滚**:会话已经真的建出来了,把它删掉换来的是「我按了新建,
   *     什么都没有发生」;落错组比凭空消失轻,所以这一步只把错说出去
   *     (返回成功 + 让列表重拉),分组按后端的事实走;
   *  3. `loadList()` —— **同步等它**,不走节流。调用方紧接着就要 `enterSession`,
   *     而那条路要拿新会话去夹持焦点序列;列表还没有它的话,焦点会退到别处。
   *
   * 这一层不认识形态机,也不弹通知 —— 它只把结果交出去(与 `onSessionsRemoved`
   * 同一条接缝纪律)。
   */
  create: (projectId: string | null) => Promise<CreateSessionOutcome>
  /**
   * 给一条**已经存在**的会话换工作目录(文件面「绑定…」那一条走它)。
   *
   * 与 `create` 里那一步是同一发 RPC,但语义不同,所以是两口:那一步是
   * 「新建的这条落在哪个项目下」(失败不回滚,因为会话已经建出来了),
   * 这一口是「把这条会话挪到这个目录」—— 失败就是失败,原话交给调用方去说。
   *
   * 成功后**同步重拉列表**:工作目录是分组的判据(`expose/projection.ts`),
   * 不重拉的话左栏还挂在老项目下,而文件树的根已经换了 —— 两处说两句话。
   */
  setWorkingDirectory: (
    sessionId: string,
    workingDirectory: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
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

/**
 * **全库账** —— `listMeta` 交下来那一份的原样(未经形态过滤、未经空间过滤)。
 * 见文件头「一本全库账,一份屏幕投影」。它是这一个进程的事实,不是可渲染状态,
 * 所以住在模块级而不是 store 里:进 store 就会有第二份可被订阅的会话表,
 * 而「屏幕上那一份是哪一份」立刻就有两个答案。
 */
let ledger: SessionSummary[] = []

/**
 * 屏幕上那一份的**唯一**判据:可陈列的形态 ∩ 当前工作区。
 * 两条过滤都是投影,数据本体一条不动 —— 检索、账本、引擎一概不受影响。
 */
function visibleOf(all: readonly SessionSummary[]): SessionSummary[] {
  const spaceId = currentSpaceId()
  return all.filter((s) => isListedSession(s) && sessionBelongsToSpace(s, spaceId))
}

/** 换一本全库账,顺手算出屏幕那一份。**换账只经这一口**。 */
function publish(all: SessionSummary[]): Pick<SessionsSourceState, 'sessions' | 'projects' | 'groups'> {
  ledger = all
  return project(visibleOf(all))
}

/** 模块级的订阅句柄与节流闸 —— 它们是「这一个进程的事实」,不是可渲染状态。 */
let unsubscribe: (() => void) | undefined
let unsubscribeLifecycle: (() => void) | undefined
let unsubscribeSpace: (() => void) | undefined
let started = false
let lastRefreshAt = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 「有会话被摘掉了」的通知面。
 *
 * 数据源不认识形态机(反向依赖:expose/store.ts 已经在 import 这个文件),所以
 * 这里只把摘掉的 id 交出去,由那层壳自己决定形态怎么夹持 —— 与 `currentGroups()`
 * 是同一条接缝的两个方向。
 */
export type SessionsRemovedListener = (removedIds: readonly string[]) => void

const removedListeners = new Set<SessionsRemovedListener>()

/** 订阅「有会话被摘掉了」。返回退订函数。 */
export function onSessionsRemoved(listener: SessionsRemovedListener): () => void {
  removedListeners.add(listener)
  return () => removedListeners.delete(listener)
}

/** 从一张按会话缓存里摘掉一批键;一个都没命中就**原样返回**(不制造新对象)。 */
function dropKeys<T>(table: Record<string, T>, gone: Set<string>): Record<string, T> {
  const hit = Object.keys(table).filter((id) => gone.has(id))
  if (hit.length === 0) return table
  const next = { ...table }
  for (const id of hit) delete next[id]
  return next
}

export const useSessionsSource = create<SessionsSourceState>()((set, get) => {
  async function loadList(): Promise<void> {
    const port = await sessionsPort()
    try {
      const response = await port.listMeta()
      if (!response.success) {
        set({ status: 'error', error: response.error || 'sessions.listMeta 未成功' })
        return
      }
      // 全库账原样收下;两道投影过滤(形态 08-31 / 工作区 09-01)在 publish 里。
      set({ status: 'ready', error: undefined, ...publish((response.sessions ?? []).map(toSessionSummary)) })
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

    // 删除走另一条订阅(onLifecycle,它还带着级联名单)。这里必须**先挡**:
    // 事件在删除之前发射、级联子会话又常常不在列表里,落到判据 a 就成了
    // 「不认识 = 有人新建了」,一次删除换来一次毫无意义的整表重拉。
    if (type === SESSION_EVENT_TYPES.SESSION_REMOVED) return

    const state = get()
    // 判据 a:**全库账**里没有这条 = 有人新建了一条,只能整表重拉。
    // 问账本而不是问屏幕那一份:被形态过滤掉的执行会话、以及别的工作区里的会话
    // 都在账上,它们的事件不该被当成新建(08-31 那张 hiddenIds 名单就是干这个的,
    // 全库账上线之后它没有存在的理由了)。
    const known = ledger.some((s) => s.id === sessionId)
    if (!known) {
      scheduleRefresh()
      return
    }
    // 增量照旧打在账上;**屏幕看不见的那条不重投影** —— 别的工作区里跑着的流
    // 每来一条 delta 都重排一次当前工作区的列表,是白烧一次 CPU。
    // 账上那一格照样更新:切回去时次序就是对的。
    const onScreen = state.sessions.some((s) => s.id === sessionId)

    // 判据 b:改名自带新名字,一格增量就够。
    if (type === SESSION_EVENT_TYPES.SESSION_RENAMED) {
      const name = (envelope.event as { name?: string }).name
      if (typeof name !== 'string') return
      const next = ledger.map((s) => (s.id === sessionId ? { ...s, title: name } : s))
      if (!onScreen) {
        ledger = next
        return
      }
      set(publish(next))
      return
    }

    // 判据 c / d:消息动了 → 抬时间 + 作废这条会话的按需缓存。
    if (MESSAGE_EVENTS.includes(type)) {
      const next = ledger.map((s) =>
        s.id === sessionId ? { ...s, updatedAt: Math.max(s.updatedAt, envelope.timestamp) } : s,
      )
      // 缓存作废**无条件**:三份按会话缓存与「这条会话此刻在不在屏上」无关,
      // 少作废一次就会在切回那个工作区时拿一份陈的正文出来画。
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
      // 重投影只给屏上那批 —— 别的工作区里的流不该每条 delta 重排一次本区列表。
      if (!onScreen) {
        ledger = next
        set(patch)
        return
      }
      set({ ...patch, ...publish(next) })
    }
    // 判据 e:其余一律忽略。
  }

  /**
   * 会话被删:当场摘除 + 作废三份缓存 + 通知形态机。
   *
   * 摘的是**事件自带的整份级联名单**而不只是信封上那一条:删一间房会连着删掉
   * 它的子会话,每条各来一次事件,但每一条都带着完整名单 —— 按名单摘是幂等的,
   * 所以级联的第二、三条事件到达时是恒等变换,不会各摘一次各重投影一次。
   *
   * 缓存**无条件**作废:一条会话可以不在列表里(级联子会话)却在缓存里躺着。
   * 正在飞的那两个按需请求不管 —— 它们落地时写进的是一条没人再问的键,
   * 而半路抽掉 loading 闸只会换来一次重复请求。
   */
  function onLifecycle(event: SessionLifecycleEvent): void {
    // `created` 不接:新建仍由判据 a 认出,两个产地说同一件事就会打架(见文件头)。
    if (event.type !== 'deleted') return
    const gone = new Set(event.cascadedSessionIds.filter((id) => typeof id === 'string' && id))
    if (gone.size === 0) return

    const state = get()
    // 摘的是**全库账**:级联子会话常常既不在屏上、也不在当前工作区里,
    // 只摘屏幕那一份会让它们留在账上,下一条事件又把判据 a 骗成「有人新建」。
    const nextLedger = ledger.filter((s) => !gone.has(s.id))
    const chapters = dropKeys(state.chapters, gone)
    const messages = dropKeys(state.messages, gone)
    const markers = dropKeys(state.markers, gone)
    const untouched =
      nextLedger.length === ledger.length &&
      chapters === state.chapters &&
      messages === state.messages &&
      markers === state.markers
    if (!untouched) set({ chapters, messages, markers, ...publish(nextLedger) })

    // 通知在 set 之后:形态机拿到的那份分组事实必须是**摘除之后**的,
    // 否则「焦点退到新序列首」会退到一张马上就要消失的卡上。
    // 哪怕这一条对我们是恒等变换也照发 —— 屏幕上可能正开着它的 Quick Look。
    for (const listener of removedListeners) listener([...gone])
  }

  /**
   * 换了工作区 —— **同一本账重投影一次,一发请求都不打**。
   *
   * 三件事,次序即语义:
   *  1. 先记下换之前屏上有哪些 id(离场名单要拿它算);
   *  2. `publish(ledger)` 用新的当前工作区重算屏幕那一份 —— 同步完成,
   *     所以从旧世界到新世界首屏之间**没有一帧空屏**,骨架一次都不画
   *     (四律第 2 条在这里是「根本没有重拉」而不是「重拉期间留旧的」);
   *  3. 把离场的 id 交给 `onSessionsRemoved` 那条既有接缝 —— 形态机据此夹持焦点、
   *     关掉正开着的 Quick Look、清掉 `currentSessionId`。「离场」与「被删」对
   *     形态机是同一件事(那张卡不在序列里了),所以复用那一条而不是新开一条:
   *     多一条通知面就多一个会跟它走散的焦点夹持规则。
   *
   * **账本一个字不动**:别的工作区的会话仍然在账上、仍然收 SSE 增量。切回去时
   * 次序是对的,而且照样不必重拉。
   */
  function onSpaceChanged(): void {
    const before = new Set(get().sessions.map((s) => s.id))
    set(publish(ledger))
    const left = [...before].filter((id) => !get().sessions.some((s) => s.id === id))
    if (left.length === 0) return
    for (const listener of removedListeners) listener(left)
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
      unsubscribeLifecycle = port.onSessionLifecycle(onLifecycle)
      // 换工作区也一样先订上:工作区列表是异步读的,首次读到时 currentSpaceId()
      // 可能从「persist 槽里那个」解析成别的(那个空间被删了),这一下也要重投影。
      unsubscribeSpace = subscribeCurrentSpace(onSpaceChanged)
      lastRefreshAt = Date.now()
      await loadList()
    },

    refresh: async () => {
      lastRefreshAt = Date.now()
      await loadList()
    },

    create: async (projectId) => {
      const port = await sessionsPort()
      let created
      try {
        // **归属当场落定**:后端不认识「当前空间」(那是 window 级状态),
        // 所以每次建都得显式带上 —— 漏了这一格,新会话会静默落进 default,
        // 而用户明明站在别的工作区里(Vue 壳 `stores/sessions.ts:699` 同一手)。
        created = await port.create({ workspaceId: currentSpaceId() })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!created?.success || !created.session?.id) {
        return { ok: false, error: created?.error || 'sessions.create 未成功' }
      }
      const sessionId = created.session.id

      let workdirError: string | undefined
      if (projectId) {
        // 落目录失败不回滚(理由见接口上的注释):会话已经在了,只是没归到那个项目。
        // 但失败**必须说出去**:从前这里吞异常、也不看应答的 `success:false`,
        // 沙箱拒绝(http 面)就这样无声蒸发过一回(见 CreateSessionOutcome 注)。
        try {
          const updated = await port.updateWorkingDirectory(sessionId, projectId)
          if (!updated?.success) workdirError = updated?.error || 'sessions.updateWorkingDirectory 未成功'
        } catch (error) {
          workdirError = error instanceof Error ? error.message : String(error)
        }
      }

      lastRefreshAt = Date.now()
      await loadList()
      return workdirError ? { ok: true, sessionId, workdirError } : { ok: true, sessionId }
    },

    setWorkingDirectory: async (sessionId, workingDirectory) => {
      if (!sessionId) return { ok: false, error: 'sessionId 为空' }
      const port = await sessionsPort()
      try {
        const updated = await port.updateWorkingDirectory(sessionId, workingDirectory)
        if (!updated?.success) {
          return { ok: false, error: updated?.error || 'sessions.updateWorkingDirectory 未成功' }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      lastRefreshAt = Date.now()
      await loadList()
      return { ok: true }
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
      ledger = []
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeLifecycle?.()
      unsubscribeLifecycle = undefined
      unsubscribeSpace?.()
      unsubscribeSpace = undefined
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
