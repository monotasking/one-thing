import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CollabAgentActivitySnapshot,
  CollabBoard,
  CollabBoardAction,
  CollabBoardActResponse,
  CollabCoordinatorState,
  CollabRoomRevokeLeaseResult,
  CollabTask,
  CollabTaskStopResponse,
  PermissionInfo,
} from '@shared/ipc.js'
import { platformApi } from '@/platform'
import { collabApi } from '@/platform/collab-client'
// 静态引没有环:chat 对 sessions 的依赖是**动态** import,所以静态图上
// sessions → collabBoard → chat 是一条直线。
import { useChatStore } from './chat'
import { invalidateCollabTagCards } from '@/composables/collabInlineTags'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.collab-board')

/**
 * Room board mirrors (docs/design/multi-agent-collab.md P1): hydrate via
 * `collabApi.boardGet`, then follow 'collab:board-changed' session events —
 * the main-process store broadcasts a full (small) snapshot per change.
 */
/** A 'typing: true' with no matching false is forgotten after this long. The
 *  coordinator's false can go missing (crash, restart, dropped event) and a
 *  room stuck at "正在输入" forever is worse than one that forgets — so the
 *  SNAPSHOT carries the timestamp and its typing list expires on read
 *  (架构收敛 C4 §1:兜底挂在快照上,不再是每个 true 自带一个死线)。 */
const TYPING_TTL_MS = 60_000
/**
 * 一份多久没动过的 agent 活动快照就不再算数(D8 观测体系 §4.6)。
 *
 * 与 typing 那把兜底同一条纪律(挂在快照的 `at` 上、在**读**的时候判,安静的房间
 * 一个定时器都不跑),但阈值刻意大一个量级:typing 明灭在秒级,而一个人「在这间房
 * 里想」合法地能想十分钟(工具链路长)。取十分钟是在两种错法里选代价小的那一种 ——
 * 短了,一个真在跑的长回合会被画成空闲(比不显示更糟:它撒谎);长了,一帧丢掉的
 * 「它停下来了」多顶一会儿。窗口重载有冷启动 GET 兜底,所以后一种错法自愈得掉。
 */
const AGENT_ACTIVITY_TTL_MS = 600_000
/**
 * A permission event is a hint that the session's ask set MOVED, not a delta to
 * apply — several can land in one tick (a settle immediately followed by the
 * next queued prompt's request), and re-asking once for the settled truth is
 * both cheaper and more correct than trying to replay the sequence.
 */
const PENDING_RECONCILE_DEBOUNCE_MS = 200

export const useCollabBoardStore = defineStore('collabBoard', () => {
  const boards = ref<Record<string, CollabBoard>>({})
  /**
   * 待审批权限的**唯一** renderer 账本(架构收敛 C4 §5)。
   *
   * sessionId → `getPendingPermissions` 反查回来的那一份**全量** prompt 列表。
   * 此前这件事有三个消费者、两种存储模型:这里按 ±1 攒的徽标计数、ipc-hub 按
   * `permission:request/queued/settled` 事件增删的 chat store 卡片状态、
   * MessageList 切会话时自己直查再自己投影的一份。三处各写各的,谁后到谁说了算,
   * 而审批是安全面 —— "屏幕上有没有这张卡"不允许有第二个答案。
   *
   * 存全量而不是计数,是因为只有全量能同时喂两个消费者:徽标要的是长度,卡片
   * 要的是 prompt 对象本身(callId / promptState / targetChannel)。存计数就等于
   * 逼着卡片那一侧另开一本 —— 那正是收敛前的样子。
   */
  const pendingPrompts = ref<Record<string, PermissionInfo[]>>({})
  /** Sessions with a permission ask outstanding (worker waiting on approval).
   *  由账本派生的读数,不是第二份存储。 */
  const pendingAsks = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    for (const [sessionId, prompts] of Object.entries(pendingPrompts.value)) {
      counts[sessionId] = prompts.length
    }
    return counts
  })
  /**
   * 协调器运行时状态(docs/design/collab-coordinator-inspector.md):
   * roomSessionId → 最近一次快照。
   *
   * 挂在这个 store 而不是新开一个:它与看板走的是**同一条**会话事件通道,而
   * `ensureSubscribed` 是那条通道唯一的订阅处 —— 为一个分支再开一个 store,
   * 就有了两处订阅、两份生命周期,以及迟早对不上的两个"是否已订阅"标志。
   *
   * **「agent 现在在干嘛」的唯一账本**(架构收敛 C4 §1)。此前这件事有四个口径:
   * `collab:turn-active` 事件攒的一本(停止按钮读它,而且**没有冷启动补水** ——
   * 窗口中途重载,按钮的账直接丢)、协调器快照一本(设置面板读它)、
   * `collab:typing` 事件 + 60s TTL 一本(打字行读它)、看板 doing 卡现算一本。
   * 四本各自漂移,真机上已经出过「常驻条 10–40s 显示空闲」的回归。
   *
   * 现在 speaking / typing 都是快照的字段,两个消费点读同一份派生;
   * `collab:turn-active` 与 `collab:typing` 仍然在线上(向后兼容),但渲染层
   * **不再拿它们记账** —— 后端在同一处触发点上推快照,那才是真值。
   */
  const coordinators = ref<Record<string, CollabCoordinatorState>>({})
  /**
   * 「这个人现在在干嘛」的**唯一**账本(D8 观测体系 §3.1/§4.6):
   * agentId → 最近一次活动快照。
   *
   * 与协调器那本是**两本互不派生的账**,而不是一本拆两半:大脑在哪间房想、信箱
   * 积压多少、手上几张工作卡,全都是**跨房**的事实,任何一份房间快照里都没有它们
   * 的位置。硬要从 N 份房间快照里拼一个人的状态,拼出来的是 N 份各自过期的碎片。
   *
   * 与协调器那本同一条纪律,一条不少:
   *  - 全量小快照 + `seq` 去序(广播与冷启动 GET 会赛跑,到达顺序什么都证明不了);
   *  - 冷启动 GET **每人一次**补水,之后跟着广播走;
   *  - 陈旧兜底挂在快照的 `at` 上,读的时候判。
   *
   * 这本账落地之后,「谁在忙」的最后一个野口径(看板 doing 卡现算)也收进来了 ——
   * C4 那四个口径至此只剩这两本快照。看板仍然回答「TA 在做**哪张卡**」(那是看板的
   * 问题),但「TA 此刻忙不忙」只由这本账说了算。
   */
  const agents = ref<Record<string, CollabAgentActivitySnapshot>>({})
  const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 已经补过水的房(冷启动 GET 每间房一次就够,之后跟着广播走)。 */
  const hydratedCoordinators = new Set<string>()
  /** 已经补过水的人(同上,每人一次)。 */
  const hydratedAgents = new Set<string>()
  let subscribed = false

  /**
   * 每问一次 +1。迟到的答案按号丢弃 —— 与看板 / 协调器快照的 `seq` 去序同一条
   * 纪律,只是这里的号由**发问方**自己发。
   *
   * 反查有一个已知时序坑:settle 事件先到、反查后到,而那次反查是在 settle
   * 之前发出的,答案里还带着刚被批掉的 ask。照单全收 = 把一张用户已经按过的
   * 审批卡重新贴回屏幕,这在审批面上是最不能接受的一种漂移。core 是**先摘牌再
   * 广播**(`removePending` 在 `emitSettled` 之前),所以只要保证"最后一次发问
   * 的答案说了算",这扇窗就关上了。
   */
  const reconcileGenerations = new Map<string, number>()

  function nextReconcileGeneration(sessionId: string): number {
    const next = (reconcileGenerations.get(sessionId) ?? 0) + 1
    reconcileGenerations.set(sessionId, next)
    return next
  }

  /**
   * Ask the main process what this session is actually waiting on (P1-3).
   *
   * The badge used to be kept by ±1 event accounting, which cannot be right
   * even in principle: core emits `permission:request` for the HEAD of a
   * session's prompt queue only, while every prompt — queued followers
   * included — emits `permission:settled`, so the ledger drifted negative and a
   * `Math.max(0, …)` clamp hid it. Worse, nothing rebuilt it on reload: a
   * window reopened over a worker waiting for approval showed no badge at all.
   *
   * `getPendingPermissions` is the source of truth core already exposes
   * (promptState and all), so the ledger is derived rather than accumulated.
   * Queued prompts count too — a session sitting behind its own queue is still
   * a session waiting on the user, which is exactly what the badge claims.
   *
   * 反查回来的那一份同时喂两个消费者:徽标读长度,卡片读 `applyPendingPermissionSnapshot`
   * 投影出来的 toolCall 标志位(架构收敛 C4 §5)。
   */
  async function reconcilePending(sessionId: string): Promise<void> {
    const generation = nextReconcileGeneration(sessionId)
    try {
      const response = await platformApi.getPendingPermissions(sessionId)
      // 更新的一问已经在路上(或已经答完),这份答案不再是真相。
      if (reconcileGenerations.get(sessionId) !== generation) return
      const prompts = response?.success && response.pending ? response.pending : []
      pendingPrompts.value = { ...pendingPrompts.value, [sessionId]: prompts }
      useChatStore().applyPendingPermissionSnapshot(sessionId, prompts)
    } catch (error) {
      // Keep the last known ledger: a failed read is not evidence of an empty
      // queue, and dropping the badge would tell the user the opposite.
      log.error('pending asks reconcile failed', { sessionId }, error)
    }
  }

  function scheduleReconcile(sessionId: string): void {
    const existing = reconcileTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    // 事件一到就把号往前推:在飞的那次反查是在这条事件之前发出的,它的答案
    // 已经过期,不该再落到屏幕上。
    nextReconcileGeneration(sessionId)
    reconcileTimers.set(sessionId, setTimeout(() => {
      reconcileTimers.delete(sessionId)
      void reconcilePending(sessionId)
    }, PENDING_RECONCILE_DEBOUNCE_MS))
  }

  /**
   * 权限事件的**唯一**落点(架构收敛 C4 §5)。
   *
   * 事件在这里只有两个身份:
   *  1. 「这个会话的欠账动了,去重新问一次」—— 三种事件一视同仁,合并成一次反查;
   *  2. settle 额外**转达一个只有事件里才有的事实**:decision。账本答得出"还欠
   *     不欠",答不出"刚才那次是批还是拒",而 allowed 要把 pending 推成
   *     executing。这不是记账,是转达 —— 账本本身仍然只从反查来。
   *
   * 两个水龙头都往这里灌(ipc-hub 的全局分发、以及本 store 自己的会话事件订阅):
   * 反查按 sessionId 合并,收尾函数对已经收干净的卡是空操作,所以重复触发是安全的。
   */
  function notePermissionEvent(
    sessionId: string,
    event: {
      type: string
      requestId?: string
      toolCallIds?: string[]
      decision?: 'allowed' | 'rejected'
    },
  ): void {
    if (event.type === SESSION_EVENT_TYPES.PERMISSION_SETTLED && event.toolCallIds?.length) {
      useChatStore().handlePermissionSettled({
        sessionId,
        requestId: event.requestId ?? '',
        toolCallIds: event.toolCallIds,
        decision: event.decision ?? 'rejected',
      })
    }
    scheduleReconcile(sessionId)
  }

  /**
   * 一个会话被搬上屏幕时的补水(架构收敛 C4 §5)。
   *
   * 从前这是 MessageList 里的一段直查加一段手写投影:组件自己认识 prompt 的形状,
   * 自己决定 queued 该走哪个 handler。补水与事件因此走两条不同的路,而"切回一个
   * 正在等审批的会话"是唯一能把两条路的分歧照出来的场景。现在组件只说"这个会话
   * 上屏了",形状与投影规则一概不知道。
   */
  async function ensurePendingForSession(sessionId: string | undefined | null): Promise<void> {
    if (!sessionId) return
    await reconcilePending(sessionId)
  }

  /** 这个会话此刻还欠哪些审批 —— 卡片与徽标之外,别处要用也读这一格。 */
  function pendingPromptsFor(sessionId: string | undefined | null): PermissionInfo[] {
    return (sessionId && pendingPrompts.value[sessionId]) || []
  }

  /**
   * 采纳一份协调器快照 —— **唯一**的写入口(广播、冷启动 GET 都走它)。
   *
   * 与看板的 `applySnapshot` 同一条去序规则(P2-18):比屏幕上更旧的快照丢掉。
   * 两条路会赛跑,而到达顺序什么都证明不了 —— 一次在广播之前发出的 GET 完全
   * 可能在广播之后才回来,把停止按钮按回到上一帧。`seq` 由主进程每广播一次 +1,
   * 所以"更旧"是事实而不是猜测;缺这个字段的旧数据读作 0(0 < 0 为假,照收)。
   *
   * 这条规则同时替掉了老的「关窗只认关它的那个人」:迟到的一条 idle 不再需要
   * 带着 agentId 来自证身份,它带的是号,号小就不算数。
   */
  function applyCoordinatorSnapshot(sessionId: string, state: CollabCoordinatorState): void {
    const current = coordinators.value[sessionId]
    if (current && (state.seq ?? 0) < (current.seq ?? 0)) return
    coordinators.value = { ...coordinators.value, [sessionId]: state }
  }

  /**
   * 冷启动补水:这间房的快照拉一次(每间房一次,之后跟着广播走)。
   *
   * 停止按钮此前的病根就在这里 —— 它读的是事件账,而 `load()` 只重建看板与
   * 待审批数,于是「窗口在一轮发言中途重载」= 按钮的账凭空消失,而下一条事件
   * 要等这一轮结束才来。
   */
  function ensureCoordinator(roomSessionId: string | undefined | null): void {
    if (!roomSessionId || hydratedCoordinators.has(roomSessionId)) return
    hydratedCoordinators.add(roomSessionId)
    void loadCoordinator(roomSessionId)
  }

  /**
   * 采纳一份 agent 活动快照 —— **唯一**的写入口(广播、冷启动 GET 都走它)。
   *
   * 与协调器快照逐字同一条去序规则:比屏幕上更旧的丢掉。号由主进程每广播一次 +1,
   * GET 带的是"上一次广播的号"(它是读,不发号),所以一发比它新的广播总能顶掉
   * 一条迟到的 GET 回包。
   */
  function applyAgentActivitySnapshot(activity: CollabAgentActivitySnapshot): void {
    const agentId = activity?.agentId
    if (!agentId) return
    const current = agents.value[agentId]
    if (current && (activity.seq ?? 0) < (current.seq ?? 0)) return
    agents.value = { ...agents.value, [agentId]: activity }
  }

  /**
   * 冷启动补水:这几位同事的活动快照各拉一次(每人一次,之后跟着广播走)。
   *
   * 不带 `agentIds` = 此刻开着心智循环的全部(总览页要的就是这一档)。带上则**逐个
   * 都有回答** —— 一位没在跑循环的同事回一份空闲快照而不是被悄悄跳过,否则界面上
   * 「读不到」与「空闲」是两个样子,冷启动会闪一下空白。
   *
   * 与 `ensureCoordinator` 同款:去重表在**发问之前**置位,一个人只问一次。
   */
  function ensureAgentActivity(agentIds?: readonly string[]): void {
    if (!agentIds) {
      void loadAgentActivity()
      return
    }
    const wanted = agentIds.filter(agentId => agentId && !hydratedAgents.has(agentId))
    if (wanted.length === 0) return
    for (const agentId of wanted) hydratedAgents.add(agentId)
    void loadAgentActivity(wanted)
  }

  async function loadAgentActivity(agentIds?: readonly string[]): Promise<void> {
    try {
      ensureSubscribed()
      // 数组在过线前重建成裸字符串:Vue 的响应式代理过不了 structured clone
      // (W7 血教训)。从前这一手在 preload 桥上也做过一遍,桥没了之后只剩这里。
      const response = await collabApi.agentActivityGet(
        agentIds ? { agentIds: agentIds.map(id => String(id)) } : {},
      )
      if (!response?.success || !response.activities) return
      for (const activity of response.activities) {
        hydratedAgents.add(activity.agentId)
        applyAgentActivitySnapshot(activity)
      }
    } catch (error) {
      log.error('agent activity load failed', {}, error)
    }
  }

  /**
   * 这位同事此刻的样子。陈旧的一份读作**没有**(见 `AGENT_ACTIVITY_TTL_MS`)。
   *
   * 「拿不到」与「空闲」在界面上刻意是同一个样子:四态徽标的第四态就是"不画",
   * 而一个人本来就该是空闲居多 —— 为"还没补上水"单开一个加载态,只会让安静的
   * 房间在每次开面时闪一下。
   */
  function agentActivityFor(
    agentId: string | undefined | null,
  ): CollabAgentActivitySnapshot | null {
    if (!agentId) return null
    const snapshot = agents.value[agentId]
    if (!snapshot) return null
    if (Date.now() - (snapshot.at ?? 0) > AGENT_ACTIVITY_TTL_MS) return null
    return snapshot
  }

  /** 这个房间此刻有没有可以停的一轮 —— 停止按钮与「在忙」读的同一格。 */
  function isRoomTurnActive(sessionId: string | undefined | null): boolean {
    if (!sessionId) return false
    return (coordinators.value[sessionId]?.speaking?.length ?? 0) > 0
  }

  function ensureSubscribed(): void {
    if (subscribed) return
    // 宿主没有这条通道(单测的裸 platformApi、还没接上的 web 端)时什么都不做,
    // 而且**不置位** —— 装不上就该在下次还能再试一次。
    if (typeof platformApi.onSessionEvent !== 'function') return
    subscribed = true
    platformApi.onSessionEvent(envelope => {
      const event = envelope.event as
        | {
          type?: string
          board?: CollabBoard
          state?: CollabCoordinatorState
          activity?: CollabAgentActivitySnapshot
          requestId?: string
          toolCallIds?: string[]
          decision?: 'allowed' | 'rejected'
        }
        | undefined
      if (!event?.type) return
      if (event.type === SESSION_EVENT_TYPES.COLLAB_BOARD_CHANGED && event.board) {
        applySnapshot(envelope.sessionId, event.board)
      } else if (event.type === SESSION_EVENT_TYPES.COLLAB_AGENT_CHANGED && event.activity) {
        // 信封挂在房上,账按 `activity.agentId` 归 —— 同一个人的快照会从 TA 此刻
        // 牵涉到的每一间房各来一份(后端刻意的扇出),`seq` 去序把重复的收干净。
        hydratedAgents.add(event.activity.agentId)
        applyAgentActivitySnapshot(event.activity)
      } else if (event.type === SESSION_EVENT_TYPES.COLLAB_COORDINATOR_CHANGED && event.state) {
        // 「谁在说 / 谁在打字」全在这一份里(C4 §1)。`collab:typing` 与
        // `collab:turn-active` 照旧在线上,但这里**刻意不接**:后端在同一处触发
        // 点上推快照,再接一遍就是第二本账,而两本账迟早对不上 —— 那正是这次
        // 收敛要拆掉的东西。
        applyCoordinatorSnapshot(envelope.sessionId, event.state)
      } else if (
        event.type === SESSION_EVENT_TYPES.PERMISSION_REQUEST
        || event.type === SESSION_EVENT_TYPES.PERMISSION_QUEUED
        || event.type === SESSION_EVENT_TYPES.PERMISSION_SETTLED
      ) {
        // The event says "something moved here"; the ledger comes from the ask.
        notePermissionEvent(envelope.sessionId, event as Parameters<typeof notePermissionEvent>[1])
      }
    })
  }

  async function load(roomSessionId: string): Promise<void> {
    ensureSubscribed()
    // 看板补水的同时把协调器那一份也补上(C4 §1):停止按钮、打字行与「在忙」
    // 读的都是它,而它们分布在几个不打开看板的界面上。
    ensureCoordinator(roomSessionId)
    try {
      const response = await collabApi.boardGet({ roomSessionId })
      if (response.success && response.board) {
        applySnapshot(roomSessionId, response.board)
        // Cold start: nothing replayed the permission events this window missed,
        // so the badges are rebuilt from the live queues of the sessions that
        // can actually be waiting on one — the workers currently executing.
        await hydratePendingAsks(response.board)
      }
    } catch (error) {
      log.error('collab board load failed', {}, error)
    }
  }

  async function hydratePendingAsks(board: CollabBoard): Promise<void> {
    const sessionIds = board.tasks
      .filter(task => task.status === 'doing')
      .map(task => task.workSessionIds[task.workSessionIds.length - 1])
      .filter((sessionId): sessionId is string => Boolean(sessionId))
    await Promise.all([...new Set(sessionIds)].map(sessionId => reconcilePending(sessionId)))
  }

  function boardFor(roomSessionId: string): CollabBoard | undefined {
    return boards.value[roomSessionId]
  }

  /**
   * Adopt a snapshot — from the 30ms-coalesced broadcast, from a write's reply
   * (W16: no coalescing wait, so a card the user just moved repaints at once),
   * or from the initial fetch. REPLACE semantics, with one ordering rule
   * (P2-18): a snapshot older than the one on screen is dropped.
   *
   * Three producers race over two paths, and the panel used to keep whichever
   * landed last — a GET issued before an act could answer after it and put the
   * card back where it was. `seq` is stamped by the main-process board store on
   * every commit, so "older" is a fact and not a guess. Boards written before
   * this field read as 0 and stay accepted (0 < 0 is false) rather than frozen.
   */
  function applySnapshot(roomSessionId: string, board: CollabBoard): void {
    const current = boards.value[roomSessionId]
    if (current && (board.seq ?? 0) < (current.seq ?? 0)) return
    boards.value = { ...boards.value, [roomSessionId]: board }
    // 行内 <card> 的验真结果是按 id 记住的,新快照可能刚建了(或删了)那张卡。
    invalidateCollabTagCards()
  }

  /**
   * 看板写入(架构收敛 C4 §4)。
   *
   * **回填约定就在这里**:回复带着看板就当场 `applySnapshot` 落账。回复在成功与
   * 失败**两条路上都带板**,所以一次被拒的写也照样从真值重画 —— 这正是冲突提示
   * 说得出"已刷新"的底气。30ms 合并广播随后还会再来一份,`seq` 去序保证它不会
   * 把刚落的这一帧按回去。
   *
   * 从前这段约定写在 CollabBoardPanel 里:组件调完 platformApi 自己记得回填。
   * 新开一个写入点忘了回填的症状是"点了没反应",而没有任何东西会报错。
   *
   * 不吞错:桥抛错就抛给调用方,提示语归 UI —— store 不替谁决定怎么说话。
   */
  async function actBoard(
    roomSessionId: string,
    action: CollabBoardAction,
  ): Promise<CollabBoardActResponse> {
    // 动作在过线前快照一次:Vue 的响应式代理过不了 structured clone,而且会把
    // 整棵组件树带下去(W7 血教训)。这一手从前在 preload 桥上,桥没了就落在这里。
    const response = await collabApi.boardAct({
      roomSessionId,
      action: JSON.parse(JSON.stringify(action)) as CollabBoardAction,
    })
    if (response?.board) applySnapshot(roomSessionId, response.board)
    return response
  }

  /**
   * 停一张卡正在跑的执行(collab-team-v2 §5.1 入口②)。
   *
   * 停止不是一次看板写入:它停的是运行时的一条流,卡的收敛与群里的说明都由主
   * 进程那一侧一起办掉,看板的新样子跟着 `collab:board-changed` 广播回来。回复
   * 万一带了板也照收(与 `actBoard` 同一条回填约定),不带就等广播。
   */
  async function stopTask(
    roomSessionId: string,
    taskId: string,
  ): Promise<CollabTaskStopResponse> {
    const response = await collabApi.taskStop({ roomSessionId, taskId })
    const board = (response as { board?: CollabBoard })?.board
    if (board) applySnapshot(roomSessionId, board)
    return response
  }

  /**
   * 按 id 找一张卡 —— 行内 `<card>` 标签验真的后端(collab-team-v2 §6.1)。
   *
   * 接受任意唯一前缀,因为模型照抄的是看板摘要里的 8 位短 id;前缀撞车时返回
   * undefined 而不是"随便挑一张":指不准就等于指不出,这正是验真要的语义。
   */
  function findTask(taskId: string): { roomSessionId: string; task: CollabTask } | undefined {
    const query = (taskId ?? '').trim().replace(/^#/, '')
    if (!query) return undefined
    const matches: { roomSessionId: string; task: CollabTask }[] = []
    for (const [roomSessionId, board] of Object.entries(boards.value)) {
      for (const task of board.tasks) {
        if (task.id === query) return { roomSessionId, task }
        if (task.id.startsWith(query)) matches.push({ roomSessionId, task })
      }
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  /**
   * 看板要滚到并高亮的那张卡。CollabBoardPanel 是被裸实例化的(无 props、无
   * defineExpose),所以"定位到某张卡"这条命令只能经由 store 传达。
   *
   * 带 `at` 时间戳:连点同一张卡时 id 没变,但高亮动画应该重放一次。
   */
  const focusedTask = ref<{ roomSessionId: string; taskId: string; at: number } | null>(null)

  function focusTask(taskId: string): boolean {
    const found = findTask(taskId)
    if (!found) return false
    focusedTask.value = { roomSessionId: found.roomSessionId, taskId: found.task.id, at: Date.now() }
    return true
  }

  function hasPendingAsk(sessionId: string | undefined): boolean {
    return Boolean(sessionId && (pendingAsks.value[sessionId] ?? 0) > 0)
  }

  /**
   * 协调器状态的冷启动:面板打开时补一次,之后跟着会话事件走。
   *
   * 与 `load` 同一形态(先 `ensureSubscribed` 再取快照)—— 反过来的话,取到快照
   * 与装上订阅之间的那几毫秒里发生的调度就永远丢了。
   */
  async function loadCoordinator(roomSessionId: string): Promise<void> {
    if (!roomSessionId) return
    hydratedCoordinators.add(roomSessionId)
    try {
      ensureSubscribed()
      const response = await collabApi.coordinatorGet({ roomSessionId })
      if (response?.success && response.state) {
        applyCoordinatorSnapshot(roomSessionId, response.state)
      }
    } catch (error) {
      log.error('coordinator state load failed', { roomSessionId }, error)
    }
  }

  function coordinatorFor(roomSessionId: string | undefined | null): CollabCoordinatorState | null {
    return (roomSessionId && coordinators.value[roomSessionId]) || null
  }

  /**
   * 人级停止(E5):点名收回某一张在外的牌。
   *
   * `expectedEpoch` **由 store 现取**而不是让调用方传:代数是屏幕上这份快照的
   * 属性,不是按钮的参数 —— 让每个入口自己去翻快照,就是给它们各自翻错的机会
   * (而翻错的后果是撤到上一轮那位无辜的人)。
   *
   * 撤成之后**不本地改快照**:牌撤掉之后房间会立刻补发下一张,那份新账只有运行
   * 时算得出,`collab:coordinator-changed` 会把它播回来。这里抢先删一行的话,补
   * 发出去的那张牌会在界面上凭空少半秒。
   *
   * `epoch-stale` 时**顺手重取一次快照**:那正是"你这一屏过时了"的定义,而让用户
   * 对着一颗永远失败的按钮再点一次不是答案。不吞错:提示语归 UI。
   */
  async function revokeLease(
    roomSessionId: string,
    leaseId: string,
  ): Promise<CollabRoomRevokeLeaseResult> {
    const epoch = coordinatorFor(roomSessionId)?.floorEpoch
    if (epoch === undefined) return { ok: false, reason: 'not-a-room' }
    const response = await collabApi.roomRevokeLease({
      roomSessionId,
      leaseId,
      expectedEpoch: epoch,
    })
    if (!response?.success || !response.result) {
      return { ok: false, reason: 'not-a-room' }
    }
    if (response.result.reason === 'epoch-stale') void loadCoordinator(roomSessionId)
    return response.result
  }

  /**
   * Members currently typing in a room, oldest first(名单顺序由后端的 Set
   * 插入序给出:先开口的在前)。
   *
   * 陈旧兜底挂在**快照时间戳**上而不是每个 true 自己的死线:名单是整份替换的,
   * 所以"这份名单是什么时候的"才是那个唯一有意义的问题。协调器进程崩了、事件
   * 掉了,一间房最多顶着一分钟的旧名单,而不是永远停在「正在输入」。
   * 过期在**读**的时候判,所以安静的房间一个定时器都不跑
   * (CollabTypingLine 的 1s 脉搏只在显示期间存在)。
   */
  function typingAgents(sessionId: string | undefined | null): string[] {
    if (!sessionId) return []
    const snapshot = coordinators.value[sessionId]
    if (!snapshot?.typing?.length) return []
    if (Date.now() - (snapshot.at ?? 0) > TYPING_TTL_MS) return []
    return [...snapshot.typing]
  }

  return {
    boards,
    pendingAsks,
    pendingPrompts,
    pendingPromptsFor,
    load,
    boardFor,
    applySnapshot,
    actBoard,
    stopTask,
    hasPendingAsk,
    reconcilePending,
    notePermissionEvent,
    ensurePendingForSession,
    typingAgents,
    ensureSubscribed,
    findTask,
    focusedTask,
    focusTask,
    isRoomTurnActive,
    coordinators,
    applyCoordinatorSnapshot,
    ensureCoordinator,
    loadCoordinator,
    coordinatorFor,
    revokeLease,
    agents,
    applyAgentActivitySnapshot,
    ensureAgentActivity,
    loadAgentActivity,
    agentActivityFor,
  }
})
