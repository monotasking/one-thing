import { useCallback } from 'react'
import type { RefObject } from 'react'
import { useSessionCwd } from '../data/files-source'
import { usePickRoots } from '../references/roots'
import { useListSelection } from '../ui/a11y/list-selection'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与 `workbench/
 * CenterRegion` 对内容种类那一条逐字同判例)。生产那条路由 `main.tsx` 先 import
 * 一次;这一行管的是「不经过 main.tsx 的宿主」(用例、将来的第二个壳)。 */
import '../references'
import { buildPickView, pickEntryAt, PICK_EMPTY } from '../references/drawer'
import { referenceKindOf, referencePickKinds } from '../references/registry'
import type { PickInput, PickView } from '../references/drawer'
import type { TokenHit } from '../references/registry'
import { composerStoreFor, useComposerStoreOf } from './store'
import { isPickDrawer } from './types'
import type { ComposerInputHandle } from './components/ComposerInput'
import type { AskSpec, DrawerKind } from './types'

/**
 * ── 切线 D:抽屉里那位**打字驱动**的住户 ─────────────────────────────────────
 *
 * 一个槽四位住户,这只 hook 只管由打字驱动的那一位:token 出现就开、消失就收,
 * 候选按词收窄,↑↓ 走位,↵ 插进输入框。模型与执行状态是人主动开的,不归这里。
 *
 * ── 09-12:它从「两位住户」收成「一个触发字符」──────────────────────────────
 * 从前这里有八处 `drawerKind === 'files'` / `'commands'` 的分支:候选怎么取、
 * 一行画什么、选中之后插什么,各写两遍。今天这只 hook**一个种类名都不认得** ——
 * 它做的是四件与种类无关的事:
 *   ① 把现场(触发字符 / 查询词 / cwd / 会话)交给**这个字符下的每一种**去查;
 *   ② 把各家的答案按登记序装成一列(`references/drawer.buildPickView`);
 *   ③ 键盘位(`ui/a11y/list-selection`,受控档);
 *   ④ 选中一条时,问它**落稿时算哪一种**,再照那一种的自述插进输入框。
 * 加一种从 `@` 或 `/` 进来的引用,这只文件一个字都不用改(正本 §3 的演练)。
 *
 * **`useListSelection` 整只跟着走**:键盘位是这位住户的状态,不是编排点的。
 * hook 边界上一个 `mouseenter` 都不许补 —— hover ≠ active 那条法(CLAUDE.md
 * 禁令区)在这里的落地就是「改 active 的只有键盘与显式点击」。
 *
 * ## 三张表
 *
 * **生命周期**:这只 hook 自己**一个 effect 都没有**了 —— 取数的时机(首开不去抖、
 * 离场即散、懒拉一次)归各种引用自己的 `useQuery`(它们是 hook)。这只 hook 按
 * `referencePickKinds()` 的登记序逐个调它们,所以**注册表在渲染期间不许变**:
 * 登记发生在模块装载那一刻(barrel),演练与测试要在 render 之前登记 —— 渲染
 * 中途多一家就是 hook 数量变了,React 会当场喊。它只有一种宿主(编排点),
 * 没有换宿主这回事。
 *
 * **UI 生命状态**:四态(正在找 / 旧候选留屏 / 失败并陈 / 真无匹配)从
 * `PickView.note` / `.errorNote` 读,判据在 `references/drawer.ts`,
 * 而每一种自己那一格 `status` 是它自述的一部分 —— 没有取数可言的照实答 `ready`。
 *
 * **UI 交互状态**:`index` 是键盘位(active),hover 一格 JS 都不占(由
 * `DrawerPickList` 的 CSS 画)。没有 disabled 档:候选行永远可点。
 */
export interface PickDrawer {
  /** 打字驱动的那一位在不在场 —— 在场时上下键与回车归抽屉,不归输入框。 */
  picking: boolean
  /** 这一列长什么样(组、扁平序、那一行说什么)。 */
  view: PickView
  /** 键盘位(active)。 */
  index: number
  /**
   * 走一格。输入框那头的 ↑↓ 直通它 —— 那块面是 contenteditable,键必须在它身上
   * 接,所以「谁按的」在那边、「怎么走」在这边(`useListSelection` 的 `move`)。
   */
  move: (delta: number) => void
  /** 下标 → 行 ref。滚入视野靠它认行。 */
  rowRef: (i: number) => (el: HTMLElement | null) => void
  applyPick: (i: number) => void
  onToken: (hit: TokenHit | null) => void
}

export interface PickDrawerDeps {
  sessionId: string
  inputRef: RefObject<ComposerInputHandle | null>
  /** 编排点已经在读它(抽屉开合的类名、另两位住户的分支),所以由它交下来。 */
  drawerKind: DrawerKind
  openAsk: (spec: AskSpec) => void
  closeDrawer: () => void
}

export function usePickDrawer({
  sessionId,
  inputRef,
  drawerKind,
  openAsk,
  closeDrawer,
}: PickDrawerDeps): PickDrawer {
  /*
   * 这三格**只有这只 hook 读**(编排点拆分前读它们也只是为了喂这一段),
   * 所以它们自己订 —— 别人也要的那几口(`drawerKind` / `openAsk` /
   * `closeDrawer`)才由编排点交下来。
   */
  const pickQuery = useComposerStoreOf(sessionId, (st) => st.pickQuery)
  const pickIndex = useComposerStoreOf(sessionId, (st) => st.pickIndex)
  const setPickIndex = useComposerStoreOf(sessionId, (st) => st.setPickIndex)
  const showPick = useComposerStoreOf(sessionId, (st) => st.showPick)

  const picking = isPickDrawer(drawerKind)
  const trigger = picking ? drawerKind.trigger : null

  /*
   * cwd 走 files 面立下的**唯一**写法(`useSessionCwd`)。拿不到时留空,
   * 而不是在渲染层拼一个 `~` —— 判词整段在 `data/file-mentions-source.ts` 文件头。
   */
  const cwd = useSessionCwd()
  /*
   * `@` 从哪些目录里找(09-18,`references/roots.ts` 是唯一产地):工作目录第一,其后是此刻
   * 开着、自述了 `referenceRoot` 的内容。答案按值稳定,切标签不会让候选重取。
   */
  const roots = usePickRoots(cwd)

  /*
   * 这个触发字符下的每一种,按登记序各查各的。
   *
   * **每一家都问一遍,不管它此刻在不在场** —— 那几只是 hook,条件调用就是
   * hook 数量会变。在不在场由 `ctx.active` 告诉它自己,离场时该清的它自己清
   * (文件那一种的 `clear()` 就在那儿)。
   */
  const kinds = referencePickKinds()
  const inputs: PickInput[] = kinds.map((kind) => ({
    kind,
    result: kind.source!.useQuery({
      trigger,
      query: pickQuery,
      cwd,
      roots,
      sessionId,
      active: trigger !== null && kind.source!.trigger === trigger,
    }),
  }))

  /*
   * 这一列。不在场时是空视图 —— 不是「空列表」,是「没有这一列」。
   *
   * **不 memo**:依赖是「各家这一拍的答案」,而那是一个**长度随注册表变**的数组,
   * 塞进依赖表会在加一种引用的那一天变成一条 React 警告(依赖数量变了)。
   * 各家的 `useQuery` 自己已经 memo 过候选了,这一层只是按序装配 —— 真正贵的那
   * 一段(取数、匹配)一次都没有多跑。
   */
  const view: PickView =
    trigger === null
      ? PICK_EMPTY
      : buildPickView(inputs.filter((i) => i.kind.source!.trigger === trigger))

  /*
   * 候选列表的**键盘位**。受控档:这一位住在 store 里(输入框那边的 ↑↓ 也要改它),
   * 原语只负责判走法、夹范围、把选中行滚进视野。
   * 鼠标经过**不**改它 —— hover 由 CSS 画,法条见 ui/a11y/list-selection 文件头。
   * loop=false:候选到端点就停(与从前的 movePickIndex 逐字同一个走法)。
   */
  const pick = useListSelection({
    count: view.total,
    active: pickIndex,
    onActiveChange: setPickIndex,
    loop: false,
  })

  /* ── 输入框吐出来的 token:有就开对应抽屉,没有就把这位住户收掉 ─────────────
   * 「收掉」只收打字驱动的那一位 —— 模型与执行状态不是输入驱动的,
   * 打字不该把它们关了。 */
  const onToken = useCallback(
    (hit: TokenHit | null) => {
      if (hit) {
        showPick(hit.trigger, hit.query)
        return
      }
      if (isPickDrawer(composerStoreFor(sessionId).getState().drawerKind)) closeDrawer()
    },
    [sessionId, showPick, closeDrawer],
  )

  /**
   * 选中一条。三步,一个种类名都不出现:
   *   ① 这条候选是谁产出的、**落稿时算哪一种**(`source.kindOf`,缺席就是产出它
   *      的那一种);② 先问那一种要不要自己消化掉这一下(`draft.onPick`,今天唯一
   *      的用户是那条 dev 扳机);③ 照它的自述插进输入框。
   *
   * **落稿永远只是插文本**:命令的执行不在这一刻,在按下发送的那一刻(理由写在
   * `data/commands-source.ts` 文件头:参数是选完之后才打的,抽屉在人打第一个参数
   * 字符之前就已经收了)。
   */
  const applyPick = useCallback(
    (i: number) => {
      const found = pickEntryAt(view, i)
      if (!found) return
      const source = referenceKindOf(found.kindId)?.source
      const hit = found.entry.hit
      const targetId = source?.kindOf?.(hit) ?? found.kindId
      const draft = referenceKindOf(targetId)?.draft
      if (!draft) return
      if (draft.onPick?.(hit, { clearDraft: () => inputRef.current?.clear(), openAsk })) return
      /*
       * 落下去的是**那一枚引用本身**(`draft.toRef`),不是「chip 上写什么」——
       * 09-14 之前这里递的是 `draft.chip(hit)`,于是同一枚引用在草稿里一种写法、
       * 在气泡里另一种写法。记号(`draft.token`)由输入面自己按 Ref 现算,画成
       * 什么由 `render(ref)` 说;这只 hook 两样都不认识。
       */
      inputRef.current?.insert(targetId, draft.toRef(hit), { argHint: draft.argHint?.(hit) })
      closeDrawer()
    },
    [view, inputRef, openAsk, closeDrawer],
  )

  return {
    picking,
    view,
    index: pick.active,
    move: pick.move,
    rowRef: pick.rowRef,
    applyPick,
    onToken,
  }
}
