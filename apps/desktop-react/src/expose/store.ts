import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  currentGroups,
  currentSessions,
  onSessionsRemoved,
  useSessionsSource,
} from '../data/sessions-source'
import { useAgentsSource } from '../data/agents-source'
import { useModelsSource } from '../data/models-source'
import { useChatSource } from '../data/chat-source'
import { focusComposer } from '../composer/focus'
import { findSession } from './projection'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { useStageStore } from '../stage/store'
import {
  foldFlatIntoDefaultSpace,
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import { formOf } from '../stage/transitions'
import * as T from './transitions'
import type { ExposeState, FocusDir } from './types'

/** 跟着工作区走的那一格:组 id 就是这个空间的项目目录(T-W1)。 */
interface ExposeFurniture {
  collapsedGroups: string[]
}

export const EXPOSE_PER_SPACE: PerSpaceSpec<ExposeStore, ExposeFurniture> = {
  pick: (s) => ({ collapsedGroups: s.collapsedGroups }),
  factory: () => ({ collapsedGroups: [] }),
}

interface ExposeStore extends ExposeState, PerSpaceState<ExposeFurniture> {
  /** 开场归位。这块面一挂载就叫一次 —— 「在场即开场」只有挂载这一个时刻。 */
  open: () => void
  escape: () => void
  enterList: (groupId: string) => void
  backToOverview: () => void
  openQuickLook: (sessionId: string) => void
  closeQuickLook: () => void
  moveFocus: (dir: FocusDir) => void
  /** 搜索框把键盘交给网格(只点亮锚点,不移动)。 */
  focusGrid: () => void
  /** 渲染层量到「一行几张」之后报进来 —— 唯一产地是 CSS 的计算值。 */
  setColumns: (columns: number) => void
  quickLookPrev: () => void
  quickLookNext: () => void
  toggleGroupCollapsed: (groupId: string) => void
  setQuery: (query: string) => void
  enterSession: (sessionId: string) => void
  /**
   * 建一条会话并进去。`projectId` = 落在哪个项目下(null = 不属于任何项目)。
   *
   * 这是**唯一**的建会话入口:组头的 `+`、⌘N、首开草稿态发送都走它,
   * 不许谁再开第二条路。
   *
   * 返回新会话 id;`undefined` = 没建成(后端拒了)**或**这一下被单飞闸挡住了。
   * 「没建成」与「当没按」在调用方那里是同一件事:接下来什么都别做。
   * 从前它返回 void,现在多这一格是因为惰性建会话那条路要拿着这个 id
   * 接着把那句话发出去 —— 让调用方回头去 store 里捞「当前会话」是在猜。
   */
  newSession: (projectId: string | null) => Promise<string | undefined>
  /** ⌘N 那一条:落在**当前会话所属的项目**下;没有当前会话就不属于任何项目。 */
  newSessionInCurrentProject: () => Promise<string | undefined>
}

/**
 * 和 stage/store.ts 一样:store 只是 transitions 的一层壳,
 * 每个 action 都是 set(transitions.f)。逻辑写在这里就测不到了。
 *
 * D1 之后它多了一份职责,而且只有这一份:**把「此刻有哪些组」交给纯函数**。
 * 纯函数不认识数据源(不然它就不纯了),组件也不该为了按一下方向键去取一次数据 ——
 * 所以这层壳是那个唯一的接缝,`currentGroups()` 只在这里出现。
 *
 * 另外两处「组合」同样只能落在壳里:
 *  - enterSession:换会话之后顺手把这块面收回 Dock(纯函数不认识 Placement);
 *  - openQuickLook / enterSession:顺手让数据源去拉那条会话的首页消息与章节
 *    (「按需」的需求正是在这两个动作发生的)。
 */
/**
 * 「此刻有一次新建正在飞」。模块级而不是 store 字段:它不是可渲染状态,
 * 而且**没有任何一处画它** —— 建会话是一次往返,不该为它长出一个转圈的按钮。
 *
 * 它挡的是按住 ⌘N 不放:键盘自动重复一秒能发十几次,那会真的建出十几条会话。
 * 一次一条,飞着的时候后来的那几下当没按 —— 而不是排队(排队等于延迟发作)。
 */
let creating = false

export const useExposeStore = create<ExposeStore>()(
  persist(
    (set, get) => ({
      ...T.initialExposeState,
      byWorkspace: {},

      open: () => set((s) => T.open(s, currentGroups())),
      escape: () => set(T.escape),
      enterList: (groupId) => set((s) => T.enterList(s, groupId)),
      backToOverview: () => set(T.backToOverview),
      openQuickLook: (sessionId) => {
        set((s) => T.openQuickLook(s, sessionId))
        void useSessionsSource.getState().ensureMessages(sessionId)
      },
      closeQuickLook: () => set(T.closeQuickLook),
      moveFocus: (dir) => set((s) => T.moveFocus(s, dir, currentGroups())),
      focusGrid: () => set((s) => T.focusGrid(s, currentGroups())),
      setColumns: (columns) => set((s) => T.setColumns(s, columns)),
      quickLookPrev: () => {
        set((s) => T.quickLookPrev(s, currentGroups()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      quickLookNext: () => {
        set((s) => T.quickLookNext(s, currentGroups()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      toggleGroupCollapsed: (groupId) =>
        set((s) => T.toggleGroupCollapsed(s, groupId, currentGroups())),
      // 搜索词一变,焦点可能落到一张被过滤掉的卡上 —— 纯函数要那份分组事实才夹得住。
      setQuery: (query) => set((s) => T.setQuery(s, query, currentGroups())),
      enterSession: (sessionId) => {
        set((s) => T.enterSession(s, sessionId))
        // 进了会话,目录(钢琴键)与首页消息就都成了「此刻要看的东西」。
        void useSessionsSource.getState().ensureChapters(sessionId)
        void useSessionsSource.getState().ensureMessages(sessionId)
        /*
         * 「进入」之后这块面收不收,看它的**形态**(08-30 用户拍板):
         *  - 舞台 / 浮窗是**瞬态形**——点开、选完、即走,「进入」的语义就是活干完了,
         *    收回 Dock(已在 Dock 时是恒等变换,不必先判)。
         *  - 钉在边上(edge)是**常驻形**——用户把它固定成了工作面,选一条会话是
         *    这块面的日常动作,不是谢幕;收掉它等于把用户刚安置好的家具搬走。
         * 同一个动作按落点分岔,分岔判据只有这一处 —— 纯函数(transitions.enterSession)
         * 仍然不认识 Placement,这层壳才是那个唯一的接缝。
         */
        const stage = useStageStore.getState()
        if (formOf(stage, SESSIONS_ITEM_ID) !== 'edge') {
          stage.closeToDock(SESSIONS_ITEM_ID)
        }
      },

      /**
       * 建会话的**唯一**编排点。它落在这层壳里的理由与 enterSession 逐字相同:
       * 这件事要同时碰数据源(建 + 重拉)、agent 名册(兑现 pendingAgentId)、
       * 形态机(进会话)和输入框(交出键盘)—— 四个谁也不该认识谁,
       * 而这层壳本来就是那个唯一的接缝。
       *
       * 次序不是随手排的:
       *  1. 建 + 重拉(数据源里等完)—— 列表里有了它,后面两步才有事实可依;
       *  2. 兑现 pendingAgentId —— **不 await**:它是「顺手落一笔」,
       *     没道理让用户多等一次往返才看见新会话;写失败它自己 notify(warn),
       *     那时会话已经在屏幕上了,一句提示比一次卡顿诚实;
       *  3. 进会话 + 把光标交给输入框 —— 新建的下一秒就是打字;
       *  4. **等聊天面真的开在这条会话上**(见下方那段理由),再把 id 交出去。
       *
       * 失败:notify(error)(error 档**不自动消失**,人回头还能看见),
       * 形态一格不动 —— 尤其**不碰输入框**:那句还没发出去的话还在人手里。
       */
      newSession: async (projectId) => {
        if (creating) return undefined
        creating = true
        let outcome
        try {
          outcome = await useSessionsSource.getState().create(projectId)
        } finally {
          creating = false
        }
        if (!outcome.ok) {
          notify({
            level: 'error',
            source: 'session.create',
            title: t('notify.createSessionFailed'),
            body: outcome.error,
            detail: outcome.error,
          })
          return undefined
        }
        if (outcome.workdirError) {
          // 会话建成但没归进项目(第二步落目录被后端拒了)。warn 不拦路:
          // 人还能聊,只是外部 agent 这类要目录的活会拒启 —— 后端原话给全。
          notify({
            level: 'warn',
            source: 'session.create',
            title: t('notify.bindWorkdirFailed'),
            body: outcome.workdirError,
            detail: outcome.workdirError,
          })
        }
        void useAgentsSource.getState().applyPendingAgent(outcome.sessionId)
        /*
         * 同一步的第二笔:草稿态选过的模型也在这里兑现(D2 波一)。
         *
         * 接缝选在这里而不是 `composer/sink.startSession` 的返回处,理由是这个
         * 函数头上那句话:**建会话的唯一编排点**。「新会话要带上哪些预选」是
         * 建会话这件事的一部分,agent 与模型是同一类账;摊到 sink 里就成了
         * 两处各兑现一格,而 ⌘N 那条路(不经过 composer)会漏掉模型那一格。
         * 同样**不 await**:顺手落一笔,失败自己 notify(warn)。
         */
        void useModelsSource.getState().applyPendingModel(outcome.sessionId)
        get().enterSession(outcome.sessionId)
        focusComposer()
        /*
         * 平时没人在这里显式开聊天面 —— ChatStream 有个 effect 盯着「当前会话」,
         * 换一条它就 open 一次。但 effect 要等 React 提交完那一帧才跑,而
         * **紧接着就要发第一句话**的那条路(首开草稿态)等不了:发送读的是
         * chat-source 里的当前会话,那一格正是 open 设的。
         *
         * 所以这层壳自己开一次。两条理由让它是 await 而不是 void:
         *  - open 先订阅再起底,等它回来才保证这一轮的事件一条不漏;
         *  - open 对同一条会话是**幂等**的(已经开着就当场返回),
         *    所以后来那次 effect 里的 open 是恒等变换,不是第二次起底。
         */
        await useChatSource.getState().open(outcome.sessionId)
        return outcome.sessionId
      },

      newSessionInCurrentProject: async () => {
        // 「当前项目」= 当前会话的那个。没有当前会话(刚启动 / 上一条被删)就是
        // null —— 不去猜一个「最近用过的项目」,那是编。
        const current = findSession(currentSessions(), get().currentSessionId)
        return get().newSession(current?.projectId ?? null)
      },
    }),
    {
      name: 'onething.expose',
      /*
       * v1 = 折叠态按工作区各持一份(T-W1)。**从前这张表没有版本号**,
       * zustand 把「没有版本」读作 0,所以这一段照常跑得到存量档案。
       *
       * 它为什么算家具:组 id 就是**项目目录**,而项目是从这个空间的会话推出来的
       * (`expose/projection.buildProjects`)。别的空间的组 id 在这里连出现的机会
       * 都没有 —— 一张跨空间共享的折叠表,存的是一半永远用不上的键。
       */
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (version >= 1 || !persisted || typeof persisted !== 'object') return persisted
        return foldFlatIntoDefaultSpace<ExposeFurniture>(
          persisted as Record<string, unknown>,
          ['collapsedGroups'],
          DEFAULT_SPACE_ID,
        )
      },
      // 同步摊开当前空间那一格 —— 第一帧就是对的(理由同 stage 的 merge)。
      merge: (persisted, current) => {
        const byWorkspace = ((persisted as Partial<ExposeStore> | undefined)?.byWorkspace
          ?? {}) as Record<string, ExposeFurniture>
        return { ...current, byWorkspace, ...spreadSpace(byWorkspace, EXPOSE_PER_SPACE) }
      },
      // 只持久化折叠状态:视图层每次开场都归位,不该被上次的停留点污染。
      // 当前会话也不持久化 —— 它现在是**真会话 id**,把一个可能已被删掉的 id
      // 记到下次启动,换来的是一个指向空气的标题。
      partialize: (s) => ({ byWorkspace: stashSpace(s, s.byWorkspace, EXPOSE_PER_SPACE) }),
    },
  ),
)

/**
 * 「有会话被删掉了」→ 形态夹持(H 批)。
 *
 * 这是同一条接缝的第二个方向:`currentGroups()` 是壳**问**数据源要事实,
 * 这一条是数据源**告诉**壳事实没了。判据仍然全在纯函数
 * (`T.sessionsRemoved`:Quick Look 退层 / 空掉的组退层 / 当前会话回空态 /
 * 焦点退到序列首),壳只负责把那份**摘除之后**的分组事实递进去。
 *
 * 订阅在模块求值时装一次,不退订 —— 它和 store 本身同寿命,而 store 是单例。
 */
onSessionsRemoved((removedIds) => {
  useExposeStore.setState((s) => T.sessionsRemoved(s, removedIds, currentGroups()))
})
