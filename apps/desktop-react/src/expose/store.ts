import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  currentSessions,
  onSessionsRemoved,
  useSessionsSource,
} from '../data/sessions-source'
import { useAgentsSource } from '../data/agents-source'
import { useModelsSource } from '../data/models-source'
import { chatSources } from '../data/chat-source'
import {
  bindNewSessionRef,
  enterSessionInWorkbench,
  openNewSessionPlaceholder,
} from '../content/session-open'
import { sessionRefOf } from '../content/session-ref'
import { activateScopeAfterCommit } from '../focus/after-commit'
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
import { useWorkbenchStore } from '../workbench/store'
import { ALL_SCOPE } from './scopes'
import * as T from './transitions'
import type { ExposeState, FocusDir, ProjectScope } from './types'

/**
 * 跟着工作区走的那两格(T-W1)。
 *
 * 从前是 `collapsedGroups`(折叠了哪些**项目组**);09-04 换成范围与展开的房间,
 * 而它们算家具的理由与那一格逐字相同:两格的键都是**这个空间里的东西**——
 * 范围里带的是项目目录,展开表里是房间会话 id,别的空间的键在这里连出现的机会
 * 都没有。一张跨空间共享的表,存的是一半永远用不上的键。
 */
/**
 * 置顶那一发的回执 —— **交给 UI 去播报**(设计 §3.3)。
 * store 不碰 `announce`:播报是可感知输出,产地该在渲染层那一侧
 * (`components/pin-announce.ts`),store 只如实说「翻成了哪一面、成没成、谁」。
 */
export interface TogglePinOutcome {
  ok: boolean
  isPinned: boolean
  name: string
}

interface ExposeFurniture {
  scope: ProjectScope
  expandedRooms: string[]
  /**
   * 09-04 第三格:收起来的分节。它算家具的理由与另外两格**不同** ——
   * 分节 id 不带任何空间里的东西(`today` / `month:2026-08` 到处一样),
   * 所以它本可以是一张全局表。跟着工作区分格是因为**这块面的记忆是整片的**:
   * 换个空间看见的是另一摞会话,「我在那边把八月收起来了」不该跟过来。
   */
  collapsedSections: string[]
}

export const EXPOSE_PER_SPACE: PerSpaceSpec<ExposeStore, ExposeFurniture> = {
  pick: (s) => ({
    scope: s.scope,
    expandedRooms: s.expandedRooms,
    collapsedSections: s.collapsedSections,
  }),
  factory: () => ({ scope: ALL_SCOPE, expandedRooms: [], collapsedSections: [] }),
}

/**
 * 状态机问屏幕的那两件事。`now` 每次现读 —— 分节是按「此刻」落的桶,
 * 一个记在模块里的时间会让今天的会话在跨过午夜之后仍然待在「今天」那一节。
 */
function facts(): T.ListFacts {
  return { sessions: currentSessions(), now: Date.now() }
}

interface ExposeStore extends ExposeState, PerSpaceState<ExposeFurniture> {
  /** 开场归位。这块面一挂载就叫一次 —— 「在场即开场」只有挂载这一个时刻。 */
  open: () => void
  escape: () => void
  openQuickLook: (sessionId: string) => void
  closeQuickLook: () => void
  /** 活动行上下走(一维;树的 ←→ 走 treeKey)。 */
  moveFocus: (dir: FocusDir) => void
  /** 树语义的 ←→ 与 Home / End(§3.2)。 */
  treeKey: (intent: T.TreeKeyIntent) => void
  /** 搜索框把键盘交给列表(只点亮锚点,不移动)。 */
  focusGrid: () => void
  quickLookPrev: () => void
  quickLookNext: () => void
  /** 换侧栏那一格范围。 */
  setScope: (scope: ProjectScope) => void
  /** 房间展开 / 收起(子行是 work / agent)。 */
  toggleRoom: (sessionId: string) => void
  expandRoom: (sessionId: string) => void
  collapseRoom: (sessionId: string) => void
  /** 分节收 / 展(09-04 用户报「分组没法收」)。 */
  toggleSection: (sectionId: string) => void
  expandSection: (sectionId: string) => void
  collapseSection: (sectionId: string) => void
  /**
   * ↵ 落在活动行上。**两档由行的形态决定**(纯函数 `T.activateRow` 判),
   * 会话那一档还要接着走 `enterSession` 的整套编排 —— 那一半只有壳做得了。
   */
  activateRow: () => void
  /**
   * 置顶 / 取消置顶。**它不是形态机的一格** —— `isPinned` 是账本上的事实
   * (`sessions.updatePin`),所以这一口直接走数据源的写路,列表由对账重拉带回来。
   * 落在这层壳里的理由与 `newSession` 逐字相同:动作的编排点只该有一个。
   */
  togglePin: (sessionId: string) => Promise<TogglePinOutcome | null>
  setQuery: (query: string) => void
  /**
   * 搜索行的两档(09-12 方向 A §3.1)。它们**不碰焦点** —— 「开什么焦点进什么」
   * 由那块面自己在提交之后 `activate()` 一句(见 NavRows),纯函数与 store
   * 都不认识 DOM。
   */
  openSearch: () => void
  closeSearch: () => void
  /**
   * 原地改名的两档(A2)。形与搜索行那两档相同(纯函数翻一格形态),但**焦点
   * 这一半不同**:开搜索行的人是那块面自己(落点由 `restingTarget` 自然答对),
   * 而开改名的人是一张**正在卸载的菜单** —— 它卸载时会做一次结构性归还,把焦点
   * 拽回右键之前那个元素。所以 `startRename` 要**点一次名**
   * (`activateScopeAfterCommit('expose')`),病历整段在 `SessionRename.tsx`
   * 的文件头与下面那句实现上。
   */
  startRename: (sessionId: string) => void
  cancelRename: () => void
  /**
   * 落定一次改名。**屏幕上那只框当场收回**(不等往返),写路走数据源的
   * `rename`(就地更新 + 重拉对账);答案原样交出去,由渲染层决定怎么说
   * (与 `togglePin` 逐字同一条接缝纪律:store 不碰 `announce`)。
   *
   * 空串 / 没变在数据源那一层就是「当没改」(答 `{ ok: true }`),所以这里
   * 不再判一遍 —— 判据只有一个产地。
   */
  commitRename: (
    sessionId: string,
    newName: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * 删一条会话(A2)。**编排点落在这层壳里**,理由与 `newSession` / `enterSession`
   * 逐字相同:这一下要同时碰拼贴台(把开着它的格子摘掉)与数据源(那一发写),
   * 两个谁也不该认识谁。
   *
   * 次序即语义:**先摘格子,再删账本**。反过来的话账本先没了 →
   * `session:removed` 到达 → `sweepRefs` 那条清洗路会把中央区最后一格**原位换成
   * 新播的一格**(种类自述的 `resident.seed`),而那正是「删完之后屏幕上莫名
   * 出现一条新会话」的来路;先摘则那一格是用户点着关的,收场看得懂。
   * 摘不掉(常驻最后一格)也照删 —— 账本的事实与屏幕摆着谁是两件事,
   * 账本没了之后那一格由清洗路换成新播的一格,那是它该有的收场。
   *
   * 确认那一问**不在这里**:它是一次可感知的打断,产地在渲染层(菜单那一行,
   * `ui/Dialog` 的 `useConfirm`)。store 收到的调用就是「已经确认了」。
   */
  deleteSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>
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
  /**
   * **只建,不摆**(K2:⌘T 在一片会话叶上那条路)。
   *
   * 与 `newSessionInCurrentProject` 同一条创建路、同一个项目判据,差的只是
   * **摆放那一半**:那一条在焦点会话叶上原位换会话(⌘N 的语义是「在这一片开
   * 一条新的」),这一条什么都不摆 —— 摆到哪儿由叫它的那片叶说了算(⌘T 的
   * 语义是「紧挨着当前那一格再来一格」)。拆法见下面的 `NewSessionSeat`。
   */
  newSessionDetached: () => Promise<string | undefined>
}

/**
 * 和 stage/store.ts 一样:store 只是 transitions 的一层壳,
 * 每个 action 都是 set(transitions.f)。逻辑写在这里就测不到了。
 *
 * D1 之后它多了一份职责,而且只有这一份:**把「此刻有哪些组」交给纯函数**。
 * 纯函数不认识数据源(不然它就不纯了),组件也不该为了按一下方向键去取一次数据 ——
 * 所以这层壳是那个唯一的接缝,`currentSessions()`(与「此刻」)只在这里出现。
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

/**
 * **「开会话 → 焦点进输入面板」排在召唤那条落焦之后**(§3.5 规则 2;W7-p 裁定 6 的接缝)。
 *
 * ── 为什么不能是一句同步的 `activateScope` ──────────────────────────────
 * 这一下同时有**两条**落焦规则在跑:
 *  · 召唤那条 —— `stage.summonRef` 的第三态「看得见、焦点不在里面 → 送焦点」,
 *    它经 `workbench/focus-into.focusIntoRefAfterCommit` **排在 React 提交之后**
 *    (一拍微任务 + 一帧,判词写在那只文件上);
 *  · 会话那条 —— 就是这一句,§3.5 规则 2。
 * 同步写在这里的话它**先**跑,随后召唤那条后到,把焦点从输入框拽进聊天正文层 ——
 * `gate:focus` 场景 8 当场红(真机读数:焦点落在 `[chat-stream]`,作用域 `chat`)。
 *
 * ── 谁该赢:会话那条 ────────────────────────────────────────────────────
 * 中央区那一形里,「那格内容自己」与「输入面板」本来就是同一台聊天的两半,而
 * §3.5 规则 2 明写落点是输入面板 —— 点一条会话就是要打字。所以这一句用**同一
 * 副排法**(`focus/after-commit.activateScopeAfterCommit`,唯一产地),于是两条
 * 规则落在同一拍的同两个队列里,而这一条排在后面注册 —— 队列是 FIFO,后注册的
 * 后跑,它因此是最后一句话。次序不是巧合:`summonRef` 那一句就写在这一句上面,
 * 读代码的次序就是落焦的次序。
 *
 * **排法本身不在这只文件里**(W7-p 修一轮裁定 5):它从前在这里抄了一份
 * `focus-into.ts` 的微任务 + 帧,而「为什么是这一副队列」的判词只写在那一头 ——
 * 抄的人看不见判词,改的人也就不知道自己在改什么。今天它整件在 `focus/after-commit.ts`。
 *
 * 架子 / 浮窗那两形不走这里(判词在调用点上):那时输入框不是它自己的。
 */
function focusComposerAfterCommit(): void {
  activateScopeAfterCommit('composer', { reason: 'open' })
}

/**
 * **「当前项目」= 环境会话的那个**(W5-b 裁定 3 的第三义)。没有环境会话
 * (刚启动 / 上一条被删)就是 null —— 不去猜一个「最近用过的项目」,那是编。
 *
 * 读 `envSessionId` 而不是 `currentSessionId`:焦点此刻可能停在一片文件叶
 * 上,而「我上一次在哪条会话里干活」才是新建那一下该继承的那个项目 —— 与文件树
 * 的根、检索的 cwd 是同一句话,所以读同一格。
 *
 * K2 把它从 `newSessionInCurrentProject` 里抽出来,因为⌘T 那条路(只建不摆)
 * 要的是**同一个**判据 —— 抄第二遍就是两个产地。
 */
function currentProjectIdOf(envSessionId: string | null): string | null {
  return findSession(currentSessions(), envSessionId)?.projectId ?? null
}

/**
 * **建一条会话时,那一格摆在哪**(K2)。
 *
 * ── 为什么是一格注入的对象,而不是一个 `detached` 布尔 ─────────────────────
 * 摆放这件事在建会话的流程里有**三个落点**(建之前占位、建成那一刻绑真 id、
 * 收尾时成为当前会话并落焦),而且它们之间夹着「兑现预选 agent / 模型」这些
 * 与摆放无关的步骤 —— 一个布尔要在三处各写一次 `if`,那正是「按能力枚举」。
 * 交一格座位进来,创建那一半于是一个 `if` 都没有:`null` = 不摆。
 *
 * 两种实现各在它的调用点上:⌘N 那条是「在焦点会话叶原位换成新的」,
 * ⌘T 那条是 `null`(叶自己摆)。
 */
interface NewSessionSeat {
  /** 建之前先在屏幕上占好位。答一口「建不成就换回去」(没占到位 = null)。 */
  reserve(): (() => void) | null
  /** 建成的那一刻:把占位那一格原位绑成真 id(叶不重挂)。 */
  bind(sessionId: string): void
  /** 收尾:让它成为当前会话、焦点进输入面板。 */
  enter(sessionId: string): void
}

/**
 * **建一条会话:创建那一半**(K2 从 `newSession` 里原样拆出来,次序一个字没动)。
 *
 * 「一次一条」那道飞行闸(`creating`)、失败提示、workdir 警告、兑现预选
 * agent / 模型、以及最后那一次 `chatSources.open` 都在这里 —— 它们是**建一条
 * 会话**这件事的一部分,与它摆在屏幕上的哪一格无关。摆放那一半由 `seat` 说,
 * `null` = 不摆(⌘T:摆到哪儿由叫它的那片叶说了算)。
 */
async function createSession(
  projectId: string | null,
  seat: NewSessionSeat | null,
): Promise<string | undefined> {
  if (creating) return undefined
  creating = true
  /*
   * **先在焦点会话叶原位开一片空会话,再去建**(W5-b 交付 3)。
   * 屏幕当场就是那片空会话,人可以立刻打字;建成之后由 `bindNewSessionRef`
   * 把那一格原位绑成真 id(叶不重挂)。建不成就换回去 —— 判词与那口
   * 「换回去」写在 `openNewSessionPlaceholder` 上。
   *
   * 首开草稿态那条路(焦点叶已经是保留键)整件是恒等变换。
   */
  const undoPlaceholder = seat?.reserve() ?? null
  let outcome
  try {
    outcome = await useSessionsSource.getState().create(projectId)
  } finally {
    creating = false
  }
  if (!outcome.ok) {
    undoPlaceholder?.()
    notify({
      level: 'error',
      source: 'session.create',
      title: t('notify.createSessionFailed'),
      body: outcome.error,
      detail: outcome.error,
    })
    return undefined
  }
  // 那一格保留键当场绑成真 id(原位,叶不重挂)。
  seat?.bind(outcome.sessionId)
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
  // 焦点进输入面板那一句在 `enterSession` 里(下面那一行就走了它)——
  // R2 之前这里还要自己叫一次那口单槽接缝(`composer/focus.ts`,本批退役)。
  seat?.enter(outcome.sessionId)
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
  await chatSources.acquire(outcome.sessionId).open()
  return outcome.sessionId
}

export const useExposeStore = create<ExposeStore>()(
  persist(
    (set, get) => ({
      ...T.initialExposeState,
      byWorkspace: {},

      open: () => set((s) => T.open(s, facts())),
      escape: () => set(T.escape),
      openQuickLook: (sessionId) => {
        set((s) => T.openQuickLook(s, sessionId))
        /*
         * 去拉那条会话的首页消息 —— **前提是这一下真的开出了 Quick Look**。
         * 活动行落在节头上时那口是恒等变换(节头没有正文可预览),这里跟着
         * 什么都不做:判据只有纯函数一处,壳读的是它的**结果**而不是再判一遍。
         */
        const view = get().view
        if (view.mode === 'quicklook' && view.sessionId === sessionId) {
          void useSessionsSource.getState().ensureMessages(sessionId)
        }
      },
      closeQuickLook: () => set(T.closeQuickLook),
      moveFocus: (dir) => set((s) => T.moveFocus(s, dir, facts())),
      treeKey: (intent) => set((s) => T.treeKey(s, intent, facts())),
      focusGrid: () => set((s) => T.focusGrid(s, facts())),
      quickLookPrev: () => {
        set((s) => T.quickLookPrev(s, facts()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      quickLookNext: () => {
        set((s) => T.quickLookNext(s, facts()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      setScope: (scope) => set((s) => T.setScope(s, scope, facts())),
      toggleRoom: (sessionId) => set((s) => T.toggleRoom(s, sessionId, facts())),
      expandRoom: (sessionId) => set((s) => T.expandRoom(s, sessionId)),
      collapseRoom: (sessionId) => set((s) => T.collapseRoom(s, sessionId, facts())),
      toggleSection: (sectionId) => set((s) => T.toggleSection(s, sectionId, facts())),
      expandSection: (sectionId) => set((s) => T.expandSection(s, sectionId)),
      collapseSection: (sectionId) => set((s) => T.collapseSection(s, sectionId, facts())),
      activateRow: () => {
        // 判在纯函数里(有单测),壳只执行它交出来的那两半。
        const { state, enterSessionId } = T.activateRow(get(), facts())
        set(state)
        if (enterSessionId) get().enterSession(enterSessionId)
      },
      /*
       * 置顶走**写路**而不是形态机:屏幕上那一格 `isPinned` 的产地是账本,
       * 乐观地先改一份本地副本等于开第二份真相(而后端 pin 不推事件,只能靠
       * `settle` 里那一发重拉对账 —— 见 sessions-source 的 `pin` 那一口)。
       *
       * 失败**不弹通知**:这一层与 `newSession` 的接缝纪律不同 —— 那一口的失败
       * 会让用户「按了新建什么都没发生」,而这一口失败时图钉原样翻了回去,屏幕自己
       * 就说明白了。原话进不了任何地方是留账(见交卷报),不是静默吞:
       * 数据源那一层已经把它记进了 mutation 的错误格。
       *
       * P1 补两样:①数据源那一口先打**乐观补丁**(行当场搬家,律①),
       * ②这里把回执交出去,由渲染层 `announce` 播报一句(设计 §3.3)——
       * 播报**零 Toast**,与「复制类反馈就地」同一条纪律。
       */
      togglePin: async (sessionId) => {
        const session = findSession(currentSessions(), sessionId)
        if (!session) return null
        const isPinned = !session.isPinned
        const outcome = await useSessionsSource.getState().setPinned(sessionId, isPinned)
        return { ok: outcome.ok, isPinned, name: session.title }
      },
      // 搜索词一变,焦点可能落到一行被过滤掉的行上 —— 纯函数要那份名册才夹得住。
      setQuery: (query) => set((s) => T.setQuery(s, query, facts())),
      openSearch: () => set(T.openSearch),
      // 收回去连词一起清 —— 清了词焦点可能落在一行只存在于搜索结果里的子行上,
      // 所以这一口也要那份名册(判据全在纯函数 `T.closeSearch`)。
      closeSearch: () => set((s) => T.closeSearch(s, facts())),
      startRename: (sessionId) => {
        set((s) => T.startRename(s, sessionId))
        /*
         * **「开的人点名、被开的那一格挂载时自己取走」**(§3.5 规则 2;与
         * `focusComposerAfterCommit` 同一副队列、同一条判词)。
         *
         * 这一句是真机 bug 修出来的,病历整段在 `components/SessionRename.tsx`
         * 的文件头上:弹这张表的菜单卸载时会做一次**结构性归还**(焦点回右键
         * 之前那个元素 —— 通常是聊天输入框),而那只框自己 focus 一下**不算
         * 「别人接管了键盘」**(它在同一个作用域内部移动焦点),于是归还照跑、
         * 焦点被拽走。所以这里由**开它的人**点一次名:`activateScopeAfterCommit`
         * 的 rAF 那一拍排在归还那一拍之后(两个队列都是 FIFO,而归还是在 React
         * 提交里才排上的),落点由 `ExposeView.restingTarget` 的第一档答 ——
         * 那一档就是改名框。
         *
         * 它落在这层壳里而不是菜单那一行上,理由与 `enterSession` 逐字相同:
         * **一件事一个编排点** —— 哪天再多一条进原地改名的路(键位 / 命令面),
         * 焦点这一半自动跟着走。
         */
        activateScopeAfterCommit('expose', { reason: 'open' })
      },
      cancelRename: () => set(T.stopRename),
      commitRename: async (sessionId, newName) => {
        // 形态先收(屏幕上那只框当场没了),再打那一发 —— 反过来会留一只
        // 「还在飞、但看起来能继续打字」的框,而律③要的反馈是**行上的字换了**,
        // 不是框变灰(改名这一口的结果全在屏幕上,与置顶同一族)。
        set(T.stopRename)
        return useSessionsSource.getState().rename(sessionId, newName)
      },
      deleteSession: async (sessionId) => {
        // 先摘格子(判词在接口注释上:反过来会被清洗路换成一条新播的会话),
        // 再删账本。摘不掉照删 —— 账本的事实不受「屏幕上摆着谁」的限制。
        useWorkbenchStore.getState().closeRef(sessionRefOf(sessionId))
        // 改名框正开在这一条上就顺手收掉:那条会话马上就不在了。
        if (get().renamingId === sessionId) set(T.stopRename)
        return useSessionsSource.getState().remove(sessionId)
      },
      enterSession: (sessionId) => {
        set((s) => T.enterSession(s, sessionId))
        /*
         * **它已经开着 → 切过去**(W7-p 裁定 6 的 B4,审计 A)。
         *
         * 病历:那条会话开在**右架子**里(架子收着)/ 开在压在底下的一扇浮窗里 /
         * 是某片叶上的非活动 tab —— 点它,屏幕上一动不动。从前这一层只有
         * `enterSessionInWorkbench` 的第①档,而那一档只 `activateTab` 一句:
         * 「点名那一格」对一条收起来的架子什么都不是。
         *
         * 今天先走**召唤**(`stage.summonRef`,与 Dock 瓦 / 快捷键同一台四态机器,
         * 意图 `reveal` —— 「切过去」没有反面,焦点已经在里面时什么都不做)。
         * 它答得出住处 = 这条会话开着,那一下已经办完(露架子 / 置顶浮窗 /
         * 点名 tab / 送焦点);答 `null` = 哪儿都没开着 → 才走原来那条
         * 「顶替焦点那片会话叶」(判词在 `content/session-open.ts` 的三档上)。
         *
         * **不新开、不顶替**正是这一格要的:一条已经摆在右架子上的会话,点它
         * 不该在中央区再开一格,更不该把中央区正看着的那条顶掉。
         */
        const where = useStageStore.getState().summonRef(sessionRefOf(sessionId), 'reveal')
        if (where === null) enterSessionInWorkbench(sessionId)
        /*
         * 「开会话 → 焦点进它的输入面板」(§3.5 规则 2)。落在这一层而不是各个
         * 入口上,理由与这个函数头上那句话逐字相同:**进会话的唯一编排点**——
         * 卡上单击、Quick Look 里的 ↵、检索面里的一行、建完一条新会话,四条路
         * 都从这儿过。输入面板还没挂起来时它答 false,什么都不做。
         *
         * **切到架子 / 浮窗里那一条时不送**(W7-p 裁定 6):焦点刚由召唤送进了
         * 那格内容自己(`focusIntoRefAfterCommit`),这里再抢一次就会把它拽回
         * 中央区那台聊天的输入框 —— 用户点的是右架子里那条会话,键盘却落在
         * 别处。中央区那一形照旧送:那时输入框正是它自己的。
         */
        if (where === null || where === 'center') focusComposerAfterCommit()
        /*
         * 进了会话,目录(钢琴键)成了「此刻要看的东西」。
         *
         * **首页消息那一发已经删掉了**(2026-09-10 工单 5 ⑧):`ensureMessages`
         * 拉的是 `sessions.getMessagesPage`,而那条读法交的是**整份抄本的尾 20
         * 条**——真店夹具上量出来 **2,295,530 字节**,比聊天区自己那一页
         * (`resources.read(page)`,134,973 B)大 17 倍,而且它与那一页在同一
         * 瞬间抢同一条连接:冷载上屏 1146ms 里有它一份。
         *
         * 它在这里从来就没有消费者:`messagesQuery` 的唯一读者是 Quick Look 那块
         * 预览面(`useSessionMessages`),而 Quick Look 自己在挂载时就 ensure 一次
         * (它必须——缓存会被 SSE 作废)。进会话预取一份**只有预览面才看的东西**,
         * 买的是「万一等会儿开 Quick Look」,付的是每一次冷开 2.3MB。
         */
        void useSessionsSource.getState().ensureChapters(sessionId)
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
      newSession: (projectId) =>
        /*
         * ⌘N 那条路的座位:**在焦点会话叶原位换成新的**。三格落点分别是
         * `openNewSessionPlaceholder`(占位 + 一口换回去)、`bindNewSessionRef`
         * (原位绑真 id)、`enterSession`(成为当前会话 + 焦点进输入面板)。
         * 创建那一半在模块级的 `createSession` 上,判词在它头上。
         */
        createSession(projectId, {
          reserve: openNewSessionPlaceholder,
          bind: (sessionId) => {
            bindNewSessionRef(sessionId)
          },
          enter: (sessionId) => {
            get().enterSession(sessionId)
          },
        }),

      newSessionInCurrentProject: () => get().newSession(currentProjectIdOf(get().envSessionId)),

      /*
       * 只建不摆(K2)。**项目判据与上面那一条逐字相同** —— 它们是同一句话的
       * 两种摆法,不是两条不同的「新建」。
       */
      newSessionDetached: () => createSession(currentProjectIdOf(get().envSessionId), null),
    }),
    {
      name: 'onething.expose',
      /*
       * ── 版本账 ────────────────────────────────────────────────────────────
       * v0(无版本号)= 一张平铺的折叠表;
       * v1 = 折叠态按工作区各持一份(T-W1);
       * v2 = **折叠组退役**(09-04 方向 A:项目组没了,分节不可折叠),换成
       *      范围(scope)与展开的房间(expandedRooms)两格;
       * v3 = 分节**可折叠了**(09-04 用户报「分组没法收」),加第三格
       *      `collapsedSections`。v2 → v3 只补一格空表 —— 存量档案里没有它,
       *      而缺席读作「一节都没收起」,正是新用户第一次打开时看见的样子。
       *
       * 它们为什么算家具:见上面 `ExposeFurniture` 逐格的理由。
       */
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted
        /*
         * v0 → v1:先把平铺的那一格折进默认空间(原样保留那一步,存量档案里
         * 真有 v0),再交给下面 v1 → v2 那一手把它丢掉 —— 两步各管各的,
         * 不写一个「一步到位」的合并版本(那会让 v0 的形状假设散进两处)。
         */
        let next = persisted as Record<string, unknown>
        if (version < 1) {
          next = foldFlatIntoDefaultSpace<{ collapsedGroups: string[] }>(
            next,
            ['collapsedGroups'],
            DEFAULT_SPACE_ID,
          ) as unknown as Record<string, unknown>
        }
        if (version < 2) {
          /*
           * v1 → v2:**丢掉 `collapsedGroups`**,一格都不折算。
           *
           * 不去「把折叠的项目组翻译成一格范围」:那两件事根本不是一回事
           * (折叠说的是「这一摞我不想看」,范围说的是「我只想看这一摞」),
           * 硬翻会让老用户一开面板发现自己被关进了某个项目里。
           * 缺席的两格由 `factory()` 补(全部 + 一间房都没展开),
           * 而那正是新用户第一次打开时看见的样子。
           */
          const byWorkspace = (next.byWorkspace ?? {}) as Record<string, Record<string, unknown>>
          const migrated: Record<string, ExposeFurniture> = {}
          for (const [spaceId, furniture] of Object.entries(byWorkspace)) {
            const { scope, expandedRooms } = (furniture ?? {}) as Partial<ExposeFurniture>
            migrated[spaceId] = {
              scope: scope ?? ALL_SCOPE,
              expandedRooms: Array.isArray(expandedRooms) ? expandedRooms : [],
              collapsedSections: [],
            }
          }
          next = { byWorkspace: migrated }
        }
        if (version < 3) {
          /*
           * v2 → v3:每个空间补一格 `collapsedSections: []`。
           * 补而不是靠 `factory()` 兜:`spreadSpace` 摊开的是**这一格存在的**
           * 那份家具,一格缺席的数组会原样摊成 `undefined`,而
           * `T.isSectionCollapsed` 会当场对着它 `.includes`。
           */
          const byWorkspace = (next.byWorkspace ?? {}) as Record<string, Record<string, unknown>>
          const migrated: Record<string, ExposeFurniture> = {}
          for (const [spaceId, furniture] of Object.entries(byWorkspace)) {
            const stored = (furniture ?? {}) as Partial<ExposeFurniture>
            migrated[spaceId] = {
              scope: stored.scope ?? ALL_SCOPE,
              expandedRooms: Array.isArray(stored.expandedRooms) ? stored.expandedRooms : [],
              collapsedSections: Array.isArray(stored.collapsedSections)
                ? stored.collapsedSections
                : [],
            }
          }
          next = { byWorkspace: migrated }
        }
        return next
      },
      // 同步摊开当前空间那一格 —— 第一帧就是对的(理由同 stage 的 merge)。
      merge: (persisted, current) => {
        const byWorkspace = ((persisted as Partial<ExposeStore> | undefined)?.byWorkspace
          ?? {}) as Record<string, ExposeFurniture>
        return { ...current, byWorkspace, ...spreadSpace(byWorkspace, EXPOSE_PER_SPACE) }
      },
      // 只持久化那两格家具:视图层每次开场都归位,不该被上次的停留点污染。
      // 当前会话与环境会话也不持久化 —— 它们现在是**树的投影**(W5-b),
      // 而树自己按 Workspace 落盘;把投影再存一份就是第二份真相,
      // 何况那个 id 到下次启动可能已经被删掉,换来的是一个指向空气的标题。
      partialize: (s) => ({ byWorkspace: stashSpace(s, s.byWorkspace, EXPOSE_PER_SPACE) }),
    },
  ),
)

/**
 * 「有会话被删掉了」→ 形态夹持(H 批)。
 *
 * 这是同一条接缝的第二个方向:`facts()` 是壳**问**数据源要事实,
 * 这一条是数据源**告诉**壳事实没了。判据仍然全在纯函数
 * (`T.sessionsRemoved`:Quick Look 退层 / 空掉的组退层 / 当前会话回空态 /
 * 焦点退到序列首),壳只负责把那份**摘除之后**的分组事实递进去。
 *
 * 订阅在模块求值时装一次,不退订 —— 它和 store 本身同寿命,而 store 是单例。
 */
onSessionsRemoved((removedIds) => {
  useExposeStore.setState((s) => T.sessionsRemoved(s, removedIds, facts()))
})
