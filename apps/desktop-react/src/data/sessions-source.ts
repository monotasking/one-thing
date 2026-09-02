import { useCallback, useRef, useSyncExternalStore } from 'react'
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
import { createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(09-01 用户令,施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 本批(读路战役 7c)动的是**按会话的三张按需缓存**:章节 / 首页消息 / 用户锚点。
 * 三张都迁进 `createQueryFamily`,键就是 sessionId。列表那一发、全库账、SSE 增量
 * 投影、`create` / `setWorkingDirectory` 一个字不动 —— 那是另一批的射程。
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载   —— import 只建三只**空**族,零往返、零订阅。族里一格都没有,
 *              第一次 `ensureX(id)` 才建出那一格(键面由数据说了算,不是
 *              「有几条会话就先建几格」);
 *  · 首载   —— `ensureChapters/Messages/Markers(id)` = 那一格的 `ensure()`。
 *              「问过一次且不脏就什么都不做」由原语承担 —— 从前那两张
 *              `loadingChapters` / `loadingMessages` 去重表随之退役,
 *              `ensureMarkers` 从来没有的那道去重也顺手补上(勘察偏离 6);
 *  · 换宿主 —— 三张都是**跟着会话走**的东西。换会话 = 换一格键,不是重拉:
 *              上一条的答案原样留在它自己那一格里,切回去时不再问一遍;
 *  · 作废   —— SSE 说这条会话又动了(判据 c / d)→ 那一格 `invalidate()`。
 *              **这是本批列明的规范修正**:从前是把缓存整格删掉(下次 ensure
 *              重拉,屏幕先退回骨架再长回来),现在是标脏 —— 有人正看着就
 *              后台补拉、旧内容留在屏上(律②),没人看着就等下一次 ensure;
 *  · 丢格   —— 会话被删(onLifecycle deleted)→ `drop(id)`。它与作废是两件事:
 *              作废说的是「答案旧了,再问」,丢格说的是「问谁?那条已经不在了」;
 *  · 卸载   —— `reset()`:退订三条订阅 + 三族一起归零。HMR dispose 复用的就是它。
 *
 * ── ② UI 生命状态(三族共用一张,消费者各取所需)─────────────────────────
 *  · empty   —— 拉到手是空表 = 「这条会话真的没有章 / 没有消息 / 没有锚点」。
 *               目录 rail 整个不在场,Quick Look 说「还没有消息」;
 *  · loading —— **只有首载算**:`phase === 'initial' && inflight`。Quick Look 的
 *               骨架读的就是这一句(再经 `SKELETON_DELAY_MS` 防闪);重拉期间
 *               `phase` 停在 ready,骨架一次都不画;
 *  · ready   —— 有过一次答案就永远是它,重拉保旧(律②);
 *  · error   —— 三只 fetcher 都**不抛**:拉不到 = 这条会话此刻没有目录 / 没有正文
 *               可看,不是整个面的错误(逐字保留迁移前的裁定)。所以这三格的
 *               `error` 恒为 undefined,屏幕上没有它的落点;
 *  · 超量    —— 首页消息由 `PREVIEW_PAGE_SIZE` 封顶;章节 / 锚点是一条会话内部的
 *               量级,不设削量(真长到要削的那天削的是钢琴键,不是这里)。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * 这一层不画任何控件,交出去的只有读数:
 *  · 三个 `ensureX` 是**幂等的取数**,不是按钮动作 —— 没有 pending 反馈要长在
 *    哪个控件上(律③在这条线上不适用:用户按不到它);
 *  · 唯一与交互挂钩的是 Quick Look 的骨架与目录 rail 的在场与否,判据见上表。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 重拉的最小间隔。一次流里事件密集,合并窗口就是「最多一秒一次」。 */
export const REFRESH_THROTTLE_MS = 1000

/** QuickLook 首页取多少条。够看清「最近在聊什么」,又不至于把一整条会话拖下来。 */
export const PREVIEW_PAGE_SIZE = 20

/* ── 三张按需缓存 = 三族 query,键 = sessionId ──────────────────────────── */

/**
 * 「拉不到就当作没有」这一条**留在 fetcher 里**,不上交给原语。
 *
 * 它是**这块面的裁定**而不是取数的通性(与 agents-source 那条「失败只重来一次」
 * 同一处判例):一条会话拉不到章节,说的是「它此刻没有目录可看」,不是整个
 * 总览面出了错 —— 从前那三个 `catch { = [] }` 就是这句话,原样搬进来。
 *
 * 所以三格的 `error` 恒为 undefined,而 `data` 恒为一张(可能是空的)表。
 * 哪天要把「后端说不行」与「这条真的没有」分开画,改的是这三个 fetcher 的
 * 一句 `throw`,不是每个消费者各加一条分支。
 */
async function orEmpty<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load()
  } catch {
    return []
  }
}

/** 章节(`sessions.getSegments`)。作废的判据只有 `stream:complete` —— 章是一轮跑完才推导出来的。 */
export const chaptersQuery = createQueryFamily<SessionChapter[]>('sessions.chapters', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getSegments(ctx.key)
    return response.success ? (response.segments ?? []).map(toSessionChapter) : []
  }),
)

/** 首页消息(`sessions.getMessagesPage`)。Quick Look 与「进入会话」都吃这一格。 */
export const messagesQuery = createQueryFamily<SessionPreviewMessage[]>('sessions.messages', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getMessagesPage(ctx.key, PREVIEW_PAGE_SIZE)
    return response.success ? (response.messages ?? []).map(toPreviewMessage) : []
  }),
)

/** 用户消息锚点(`sessions.getUserMarkers`)= 钢琴键的键,也是滚动落点的 id。 */
export const markersQuery = createQueryFamily<SessionMarker[]>('sessions.markers', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getUserMarkers(ctx.key)
    return response.success ? (response.markers ?? []).map(toSessionMarker) : []
  }),
)

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

  /*
   * 按会话的三张缓存**不在这里** —— 它们是 `chaptersQuery` / `messagesQuery` /
   * `markersQuery` 三族(键 = sessionId,见文件头三张表)。留一份转发的壳只会
   * 变成第二份真相(kernel 手册「迁移一个 source 的步骤」第 2 条)。
   * 组件侧的读法是本文件末尾那四只 hook。
   */

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
  /**
   * 三只「确保问过一次」。签名与迁移前逐字相同(调用点一个字不改),内部就是
   * 对应族那一格的 `ensure()` —— 去重、缓存、脏标记全由原语承担。
   */
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

/**
 * 一条会话的三份按需缓存一起丢掉(`drop` 对没建过的键是恒等变换,
 * 所以级联名单里那些从来没人问过的 id 不会在这里各建一格)。
 */
function dropSessionCaches(sessionId: string): void {
  chaptersQuery.drop(sessionId)
  messagesQuery.drop(sessionId)
  markersQuery.drop(sessionId)
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
      /*
       * 作废**无条件**:三份按会话缓存与「这条会话此刻在不在屏上」无关,
       * 少作废一次就会在切回那个工作区时拿一份陈的正文出来画。
       *
       * **本批的规范修正**:从前这里是把那一格整个删掉(`delete messages[id]`),
       * 于是正开着 Quick Look 的人会看见「内容消失 → 骨架 → 重新长出来」。
       * 现在是标脏 —— 有人正订着这一格就后台补拉、旧内容留在屏上(律②),
       * 没人订就只留个脏标记,下一次 `ensureX` 才真去问。
       *
       * `invalidate(key)` 对没建过的键什么都不做,所以「一条从来没人看过的会话
       * 在刷屏」不会在这里凭空建出三格。
       */
      messagesQuery.invalidate(sessionId)
      markersQuery.invalidate(sessionId)
      // 判据 d:章是一轮跑完才推导出来的,所以只有 stream:complete 动它。
      if (type === SESSION_EVENT_TYPES.STREAM_COMPLETE) chaptersQuery.invalidate(sessionId)
      // 重投影只给屏上那批 —— 别的工作区里的流不该每条 delta 重排一次本区列表。
      if (!onScreen) {
        ledger = next
        return
      }
      set(publish(next))
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
   * 缓存**丢格**(不是标脏):一条会话可以不在列表里(级联子会话)却在缓存里
   * 躺着。这里用 `drop` 而不是 `invalidate` —— 「这条会话没了」不是「答案旧了」,
   * 标脏会让还订着它的那一格当场后台补拉一发注定问不着的请求。
   * 正在飞的那两个按需请求不管:它们落地时写进的是一格已经被摘掉的 query,
   * 而半路抽掉在飞的那一发只会换来一次重复请求。
   */
  function onLifecycle(event: SessionLifecycleEvent): void {
    // `created` 不接:新建仍由判据 a 认出,两个产地说同一件事就会打架(见文件头)。
    if (event.type !== 'deleted') return
    const gone = new Set(event.cascadedSessionIds.filter((id) => typeof id === 'string' && id))
    if (gone.size === 0) return

    // 摘的是**全库账**:级联子会话常常既不在屏上、也不在当前工作区里,
    // 只摘屏幕那一份会让它们留在账上,下一条事件又把判据 a 骗成「有人新建」。
    const nextLedger = ledger.filter((s) => !gone.has(s.id))
    for (const id of gone) dropSessionCaches(id)
    // 账上一条都没摘掉 = 屏幕那一份不必重投影(三族有它们自己的订阅面,
    // 丢格时各自喊过人了)。这一句护的是列表的行身份(律④)。
    if (nextLedger.length !== ledger.length) set(publish(nextLedger))

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

    /*
     * 三只 ensure 现在是**薄的**:空 id 挡掉(空串不是一条会话),其余原样交给
     * 那一族的 `ensure()`。三条从前各自手写的东西 —— 「拉过了就别再拉」
     * (`sessionId in table`)、「有一发在飞就别发第二发」(那两张 loading 表)、
     * 「拉不到就缓存成空表」(catch) —— 分别由原语的脏标记、并发折叠与
     * 上面那只 `orEmpty` 接手。`ensureMarkers` 从前**没有**去重表(同帧双发会真的
     * 发两次,勘察偏离 6),现在三条走同一条路,那个偏离自动结掉。
     */
    ensureChapters: async (sessionId) => {
      if (!sessionId) return
      await chaptersQuery.get(sessionId).ensure()
    },

    ensureMessages: async (sessionId) => {
      if (!sessionId) return
      await messagesQuery.get(sessionId).ensure()
    },

    ensureMarkers: async (sessionId) => {
      if (!sessionId) return
      await markersQuery.get(sessionId).ensure()
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
      // 三族一起归零 —— 「回到未启动的干净态」包括那三张按会话缓存,
      // 它们只是搬了家,不是不归这一口管了。
      chaptersQuery.reset()
      messagesQuery.reset()
      markersQuery.reset()
      set({
        status: 'idle',
        error: undefined,
        sessions: [],
        projects: [],
        groups: [],
      })
    },
  }
})

/**
 * **HMR 退役**(09-01 立法,起因是 chat-source 那一案:热更之后旧模块的模块级
 * 副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用:三条订阅句柄(SSE / lifecycle / 工作区)、节流定时器、
 * 启动闸、全库账,以及本批搬进来的三族 query(各自带一张监听表)。不退役的话,
 * 旧模块那条 `onSessionEvent` 订阅还挂在传输面上,两台数据源各投影各的。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useSessionsSource.getState().reset()
  })
}

/** 非组件上下文的读法(store 壳、纯函数的入参)。 */
export function currentGroups(): SessionGroup[] {
  return useSessionsSource.getState().groups
}

export function currentSessions(): SessionSummary[] {
  return useSessionsSource.getState().sessions
}

/* ── 组件侧:三族的读法 ────────────────────────────────────────────────── */

/**
 * 一条会话的章 / 首页消息 / 锚点。交出去的是**整张快照**而不是 `data` ——
 * Quick Look 的骨架要判 `phase === 'initial' && inflight`,只给数据的话它就得
 * 自己再猜一遍「现在是首载还是重拉」,那正是 kernel 存在的理由。
 *
 * 空 `sessionId` 照常建一格(键就是空串)—— 它永远不会被 ensure,所以恒是
 * 出厂快照。不在这里分岔的理由:hook 不能有条件地调。
 */
export function useSessionChapters(sessionId: string): QuerySnapshot<SessionChapter[]> {
  return useQuery(chaptersQuery.get(sessionId))
}

export function useSessionMessages(sessionId: string): QuerySnapshot<SessionPreviewMessage[]> {
  return useQuery(messagesQuery.get(sessionId))
}

export function useSessionMarkers(sessionId: string): QuerySnapshot<SessionMarker[]> {
  return useQuery(markersQuery.get(sessionId))
}

/** 一条都还没拉到时交出去的那一份 —— 恒等引用,免得每次渲染都换一张新空表(律④)。 */
const EMPTY_CHAPTER_RECORD: Readonly<Record<string, SessionChapter[]>> = {}

/**
 * **已经拉到手的全部章节**,摊成检索面板要的那张 `Record<sessionId, 章[]>`。
 *
 * 为什么不照 `useCatalogRecord(ids)` 那一手逐键订:那只 hook 的键面由**屏幕**
 * 给定(设置面要列这几家),而这里的键面由**数据**给定 —— 检索的判据是
 * 「凡是手上有章的会话,章里也搜一遍」,包括用户从没在这块面里点过、章却
 * 因为别处(进入会话 / 目录 rail)已经拉到手的那些。逐键订要先 `get(key)` 建格,
 * 于是「有几条会话就先建几格空格」(500 条会话 = 500 格 + 500 个订阅),
 * 而且真正新落地的那一格反而没人订。
 *
 * 所以订的是**整族**(`chaptersQuery.subscribe`,O(1)),快照按 `keys()` 逐格记
 * `dataRev`:只有哪一格的内容**真的变了**才换引用 —— 在飞 / 落地这种来回不算,
 * 否则每一次后台补拉都会让整块检索结果重算一遍(律④)。
 */
export function useChapterRecord(): Readonly<Record<string, SessionChapter[]>> {
  const cache = useRef<{ revs: string | null; value: Readonly<Record<string, SessionChapter[]>> }>({
    revs: null,
    value: EMPTY_CHAPTER_RECORD,
  })

  const subscribe = useCallback((listener: () => void) => chaptersQuery.subscribe(listener), [])

  const snapshot = useCallback(() => {
    const ids = chaptersQuery.keys()
    const revs = ids.map((id) => `${id}:${chaptersQuery.get(id).get().dataRev}`).join('\n')
    const held = cache.current
    // 「从来没算过」用 `revs: null` 表达:`join` 的结果可以是空串(一格都没有),
    // 所以空串不能当哨兵 —— null 不在 join 的值域里(models-source 同一处判例)。
    if (held.revs === revs) return held.value
    const value: Record<string, SessionChapter[]> = {}
    for (const id of ids) {
      const chapters = chaptersQuery.get(id).get().data
      if (chapters) value[id] = chapters
    }
    cache.current = { revs, value }
    return value
  }, [])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
