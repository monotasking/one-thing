import { chatSources } from '../data/chat-source'
import { currentSessions, onSessionsRemoved, useSessionsSource } from '../data/sessions-source'
import { useExposeStore } from '../expose/store'
import { useWorkbenchStore } from '../workbench/store'
import {
  scheduleCompanionSwap,
  startCompanionUpkeep,
  stopCompanionUpkeep,
} from './session-companions'
import { parkedSessionIds, reconcileSessionParks, stopSessionParks } from './session-park'
import {
  currentSessionOf,
  leafHoldsSession,
  openSessionIdsIn,
  sessionRefAlive,
} from './session-ref'
import type { ContentRef } from '../workbench/kinds'

/**
 * **树 → 「当前会话」那一格**(W5-b 裁定 3;与 W4 的 `placements` 投影同型,
 * 判词与接线体例逐字照 `stage/store.ts` 的 `syncStageResidency`)。
 *
 * ── 从「一格被写的字段」变成「一条被算出来的值」──────────────────────────
 * W5-a 之前 `expose.currentSessionId` 是一格**被写的状态**:`enterSession`
 * 写它,会话被删清它,而屏幕上那片聊天区读它。会话多开之后这句话说不下去了 ——
 * 屏幕上有两片会话叶,「当前」只可能是**焦点叶那一片**在看的那条。
 *
 * 于是方向反过来:**树是事实,`currentSessionId` 是它的投影**。这只文件是
 * 全壳唯一的写者;11 处读点(输入框 / 模型抽屉 / agent 徽 / 列表高亮 / ⌘N /
 * 目录键 / 文件树根 …)一个字都没改 —— 它们读的还是同一个字段名。
 *
 * ── 三格,三种问法(裁定 3 的「劈成三义」)────────────────────────────────
 *  ① `currentSessionId` —— **纯投影**,判据整件是纯函数
 *    `session-ref.currentSessionOf(regions, focusLeafId)`(那条从窄到宽的梯子
 *    写在它头上)。零粘性:焦点叶换一片,它当场跟着换;
 *  ② `envSessionId` —— **环境会话,带粘性**。它只在**焦点叶自己装着会话**的
 *    那一拍跟着更新;焦点落到一片文件叶(或者架子上某块面)时**一格不动**。
 *    这就是裁定 3 那句「焦点落到文件叶不换根」:文件树的根、检索的 cwd、
 *    ⌘N 继承哪个项目,都不该因为你点了一下旁边那个文件而换掉。
 *    两片会话叶并排时它们真的会分家:焦点从 B 移到一片文件叶,`currentSessionId`
 *    按梯子回落到阅读序第一片(A),而 `envSessionId` 仍然停在 B;
 *  ③ 数据机器那本**引用账** —— 「树里 ∪ 隐藏表里 ∪ 视图停靠池里」有哪些会话,
 *    就 `acquire` 哪些,不在的松手。它不是一格状态,是一次集合差。
 *    第三项是 2026-09-10 组件级停靠加的:一格停靠着的会话叶**照旧挂在屏幕上**
 *    (只是 `content-visibility: hidden`),它当然该继续收流 —— 与「hidden 的
 *    会话叶实例留着」逐字同一条理由,只是这一份不在树上也不在隐藏表里。
 *
 * ── 引用账为什么是集合差,而不是挂在组件挂载上 ──────────────────────────
 * 派工规格写的是「关闭才 release(`ContentKind.dispose`)」。真按 `dispose`
 * 写,`acquire` 那一头**没有对应的钩子**(种类表没有 `onOpen`),而放手那一头
 * 有**六条**路会让一格会话离开树:关一格 / 把隐藏的那份丢掉 / 原位换 ref /
 * 摘掉(收回 Dock)/ 整区隐藏 / 死会话清洗。六条各写一遍 release 的下场是它们
 * 迟早漏一条,而漏掉的表现是「一条早就关掉的会话还在后台收流」——不可观测,
 * 直到内存长起来。
 *
 * 一次**集合差**把六条路连同 `acquire` 那一头一起答完,而且幂等:
 * 树上有它 = 机器活着;不在 = 松手。**隐藏的那些照样在账上**(裁定:hidden 的
 * 会话叶实例留着继续收流),因为 `openSessionIdsIn` 把隐藏表也算进去了。
 *
 * ── 接线不在模块作用域 ──────────────────────────────────────────────────
 * 与 `stage/store.ts` 末尾那段判例逐字同源:这台壳里那条存量 import 环会让
 * 模块作用域里的接线读到 TDZ。所以模块只导出动作,由 `main.tsx`(以及不经过
 * main.tsx 的宿主 —— 用例,在 `AppShell` 那一句 layout effect 里)显式调一次。
 * 模块级订阅的寿命 = 这个模块实例,所以配一段 HMR 退役(复用已有那口拆卸)。
 */

/** 「这一格背后那条会话还活着吗」——清洗那一口 `alive` 的落点(裁定 5)。 */
export function sessionAlive(ref: ContentRef): boolean {
  return sessionRefAlive(ref, liveSessionIds())
}

function liveSessionIds(): Set<string> {
  return new Set(currentSessions().map((session) => session.id))
}

/**
 * 按此刻的树算一次投影,该写就写。**唯一产地**。
 *
 * 四件事一次做完(它们读的是同一份树,分四条订阅只会让它们在同一拍里各算一遍):
 * 对齐视图停靠池、写 `currentSessionId` / `envSessionId`、把「当前会话」那一格
 * 告诉数据机器注册表、对齐引用账。没变就不 `set` —— 一次无谓的 set 会让列表、
 * 输入框、agent 徽全重渲。
 *
 * **视图停靠池排在最前**:它的对账会把「已经变成标签的」「叶没了的」那几格摘掉,
 * 而下面那本引用账要读它的结果(`parkedSessionIds()`)。反过来排的话,一格刚被
 * 摘掉的停靠会在这一拍里多按一次引用,下一拍才松手 —— 不是错,但没有必要。
 */
export function syncSessionProjection(): void {
  const workbench = useWorkbenchStore.getState()
  reconcileSessionParks(workbench.regions)
  const next = currentSessionOf(workbench.regions, workbench.focusLeafId)
  const state = useExposeStore.getState()
  /*
   * 粘性那一格:**焦点叶自己装着会话**才跟着换。否则原样留着 —— 除非它指着的
   * 那条会话此刻已经不在任何一片叶里了(被关掉 / 被删掉),那时留着就是在骗
   * 文件树画一个不存在的根。
   */
  const open = openSessionIdsIn(workbench.regions, workbench.hidden)
  /*
   * 「焦点叶自己装着**一条真会话**」才更新环境会话:一片还没绑会话的叶
   * (⌘N 刚开出来的那一瞬)不该把文件树的根清空 —— 它还没有会话可言。
   */
  const focusBound = leafHoldsSession(workbench.regions, workbench.focusLeafId) && next !== ''
  /*
   * 粘性:只要它指着的那条会话**还在名册上**就原样留着 —— 哪怕那片叶已经
   * 被换走 / 关掉了。「我上一次在哪条会话里干活」是一句关于过去的话,而
   * 「那条会话还在不在」才是它失效的唯一理由(指着一条被删的会话去画文件树的根
   * 就是在骗人)。
   */
  const envStays = !focusBound
    && state.envSessionId !== ''
    && currentSessions().some((session) => session.id === state.envSessionId)
  const env = envStays ? state.envSessionId : next

  if (state.currentSessionId !== next || state.envSessionId !== env) {
    useExposeStore.setState({ currentSessionId: next, envSessionId: env })
    /*
     * **环境会话换了那一拍 = 伴随面收放那一拍**(C3,设计 §3.3)。
     *
     * 它挂在这里而不是别处,理由与 `envSessionId` 自己住在这里是同一句:这只文件
     * 是那格事实的**唯一产地**,而「上一条是谁」只有写它的那一瞬才知道
     * (`state.envSessionId` 是**换之前**那一格 —— 上面那句 `setState` 已经把
     * 新的写进去了,所以这一行必须读上面捕获的那份旧 state,不能再 `getState()`)。
     *
     * 真正的收放排在微任务里(判词在 `./session-companions.ts`),所以这一句
     * 不会在投影里再引一次投影。
     */
    if (state.envSessionId !== env) scheduleCompanionSwap(state.envSessionId, env)
  }

  /*
   * 「当前会话」那一格由投影宣布(W5-a 在 `chatSources.setCurrent` 上留的账:
   * 「今天由唯一在场的那片会话叶宣布,W5-b 换成焦点叶投影」)。它对同一条会话
   * 是恒等,所以这一句在没换会话的那些拍里不做任何事。
   */
  chatSources.setCurrent(next)

  // 引用账:树上有的、停靠着的持一份并起底,都不在的松手。幂等 —— 差集为空时零动作。
  reconcileSessionRefs([...open, ...parkedSessionIds()])
}

/**
 * **对齐引用账**。`held` 是这只文件自己记的一份「我持有着哪些」——
 * 它不是可渲染状态,而是「这个模块实例替谁按着引用」,与
 * `data/chat-source.ts` 那张注册表同源(那儿记的是「谁在看」,这儿记的是
 * 「拼贴台替谁按着」)。`stopSessionProjection()` 会把它整份还回去。
 */
const held = new Set<string>()

function reconcileSessionRefs(open: readonly string[]): void {
  const want = new Set(open)
  for (const id of want) {
    if (held.has(id)) continue
    held.add(id)
    chatSources.acquire(id)
  }
  for (const id of [...held]) {
    if (want.has(id)) continue
    held.delete(id)
    chatSources.release(id)
  }
}

/** 已经接上了没有。幂等靠它 —— 这是「这个进程接过一次没有」,不是可渲染状态。 */
let stopSubscription: (() => void) | null = null

/** 名册那两条接缝的退订口(见 `startSessionProjection`)。 */
let stopRoster: (() => void) | null = null

/**
 * 接上投影。**幂等**:重复调用先把上一次退役掉,不会攒出两条订阅。
 * 由 `main.tsx` 与不经过它的宿主(用例)各自调一次都安全。
 *
 * 三条订阅,各答一句话:
 *  · 树变了 → 重算投影(`currentSessionId` / `envSessionId` / 引用账);
 *  · 名册**首达**(从空到有)→ 扫一遍死会话(裁定 5 的第一个发起点)。
 *    它订的是数据源那台 store,而不是等谁来叫 —— 「列表到了」是一次事实的到达,
 *    没有别的时刻能代表它;
 *  · 有会话**被摘掉**(删掉 / 换空间离场)→ 同一遍清洗(第二个发起点,
 *    与 `expose/store` 那条焦点夹持订阅并列 —— 两条各管各的,互不认识)。
 */
export function startSessionProjection(): () => void {
  stopSessionProjection()
  syncSessionProjection()
  stopSubscription = useWorkbenchStore.subscribe(syncSessionProjection)
  let hadRoster = currentSessions().length > 0
  const offRoster = useSessionsSource.subscribe((st) => {
    const has = st.sessions.length > 0
    if (has && !hadRoster) sweepDeadSessions()
    hadRoster = has
  })
  const offRemoved = onSessionsRemoved(() => sweepDeadSessions())
  /*
   * 「会话被删 → 它的伴随面记录一起删」(C3,设计 §3.4)。它接的是**另一条**
   * 接缝(`onSessionsDeleted`,只从 `deleted` 那一支发),理由整段在那只文件上:
   * 换工作区不该清这本账 —— 它正被收进 `byWorkspace` 留着切回来用。
   */
  const offCompanions = startCompanionUpkeep()
  stopRoster = () => {
    offRoster()
    offRemoved()
    offCompanions()
  }
  if (hadRoster) sweepDeadSessions()
  return stopSessionProjection
}

export function stopSessionProjection(): void {
  stopSubscription?.()
  stopSubscription = null
  stopRoster?.()
  stopRoster = null
  // 接上过没有都要收一次:队里那一条待办的寿命也是这个模块实例。
  stopCompanionUpkeep()
  /*
   * 视图停靠池的寿命与这条投影逐字相同(它是在这一遍里被对账的),所以退役
   * 一起收 —— 留着的话热更之后旧模块那几棵停靠的树还挂在 `kept-contents` 表上。
   */
  stopSessionParks()
  for (const id of [...held]) {
    held.delete(id)
    chatSources.release(id)
  }
}

/**
 * **死会话清洗**(裁定 5)。两个发起点,都是「名册这一刻说话了」那一拍:
 * 会话列表首达、以及 `onSessionsRemoved`(两条订阅都在 `startSessionProjection`)。
 *
 * 它**不挂在同步的 merge 上**:那时名册还没到,一问就会把整棵树洗空。
 * 判据本体是纯函数(`session-ref.sessionRefAlive`),动作是
 * `workbench.sweepRefs`(最后一格常驻原位换成新播的那一格,其余摘掉)。
 *
 * 排在**微任务**里跑:换工作区那一拍会同时惊动名册(republish)与家具
 * (`bindPerSpace` 换树),两者都是那一次通知的同步反应,而它们的先后不由
 * 这只文件决定。微任务一定排在两者之后,于是这一遍问到的名册与树是同一个世界的。
 */
let sweeping = false

export function sweepDeadSessions(): void {
  if (sweeping) return
  sweeping = true
  queueMicrotask(() => {
    sweeping = false
    // 名册还没到(空表)时**一格都不扫**:那不是「会话都被删了」,是还没读到。
    if (currentSessions().length === 0) return
    useWorkbenchStore.getState().sweepRefs(sessionAlive)
  })
}

/*
 * 模块级订阅 = 这个模块实例的寿命(09-01 立法)。退役复用已有那一口拆卸,
 * 不写第二套;幂等。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(stopSessionProjection)
}
