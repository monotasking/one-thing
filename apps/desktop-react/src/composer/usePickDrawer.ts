import { useCallback, useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { createFileToken } from '@shared/prompt-references'
import type { CommandEntry } from '../data/commands-source'
import { useCommandsSource } from '../data/commands-source'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../data/file-mentions-source'
import { useSessionCwd } from '../data/files-source'
import { useListSelection } from '../ui/a11y/list-selection'
import { ASK_DEMO_SPEC } from './data'
import { useComposerStore } from './store'
import { matchCommands, matchFiles } from './transitions'
import type { ComposerInputHandle } from './components/ComposerInput'
import type { AskSpec, DrawerKind, TokenHit } from './types'

/**
 * ── 切线 D:抽屉里那两位输入驱动的住户(`@` 文件 / `/` 命令)────────────────
 *
 * 一个槽四种住户,这只 hook 只管其中两位 —— 它们的共同点是**由打字驱动**:
 * token 出现就开、消失就收,候选按词收窄,↑↓ 走位,↵ 插进输入框。
 * 模型与执行状态是人主动开的,不归这里。
 *
 * 交出去的八格 `{picking, files, commands, index, move, rowRef, applyPick, onToken}`
 * 正是 `DrawerPickList` 与 `ComposerInput` 要的全部 —— `move` 是输入框那头 ↑↓
 * 的直通口(见下),少了它 `useListSelection` 就搬不整只。
 *
 * **`useListSelection` 整只跟着走**:键盘位是这两位住户的状态,不是编排点的。
 * hook 边界上一个 `mouseenter` 都不许补 —— hover ≠ active 那条法(CLAUDE.md
 * 禁令区)在这里的落地就是「改 active 的只有键盘与显式点击」,而这次拆分
 * 只是换了个文件装它,一个字都没松。
 *
 * ## 三张表
 *
 * **生命周期**:两个 effect —— ① `@` 候选的去抖拉取(抽屉不是 files 就散候选,
 * 是 files 就等 `FILE_MENTION_DEBOUNCE_MS` 再发一次,重入即撤上一发的计时器);
 * ② 命令抽屉第一次开时懒拉插件那一半。都没有卸载动作要做,除了 ① 那只计时器
 * (它由 effect 自己的清理函数收)。这只 hook 只有一种宿主(编排点),没有
 * 换宿主这回事。
 *
 * **UI 生命状态**:候选**只有 ready 一态在画**。loading / empty / error 的现状
 * 逐条记在下面 `mentions` 那段注释里 —— 本批**只记不补**。
 *
 * **UI 交互状态**:`index` 是键盘位(active),hover 一格 JS 都不占(由
 * `DrawerPickList` 的 CSS 画)。没有 disabled 档:候选行永远可点。
 */
export interface PickDrawer {
  /** files / commands 抽屉是否开着 —— 开着时上下键与回车归抽屉,不归输入框。 */
  picking: boolean
  /** 抽屉那一行画的是 label(cwd 之下的相对路径)。 */
  files: string[]
  commands: CommandEntry[]
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
  /** 内置 + 插件 + dev 三张表合过之后的命令表(编排点持有,发送那头读的是同一份)。 */
  allCommands: readonly CommandEntry[]
  sessionId: string
  inputRef: RefObject<ComposerInputHandle | null>
  /** 编排点已经在读它(抽屉开合的类名、另两位住户的分支),所以由它交下来。 */
  drawerKind: DrawerKind
  openAsk: (spec: AskSpec) => void
  closeDrawer: () => void
}

export function usePickDrawer({
  allCommands,
  sessionId,
  inputRef,
  drawerKind,
  openAsk,
  closeDrawer,
}: PickDrawerDeps): PickDrawer {
  /*
   * 这四格**只有这只 hook 读**(编排点拆分前读它们也只是为了喂这一段),
   * 所以它们自己订 —— 别人也要的那几口(`drawerKind` / `openAsk` /
   * `closeDrawer`)才由编排点交下来。
   */
  const pickQuery = useComposerStore((st) => st.pickQuery)
  const pickIndex = useComposerStore((st) => st.pickIndex)
  const setPickIndex = useComposerStore((st) => st.setPickIndex)
  const showPick = useComposerStore((st) => st.showPick)

  const picking = drawerKind === 'files' || drawerKind === 'commands'

  /*
   * ── D3 波二:`@` 候选的三条接线 ──────────────────────────────────────
   * 根与会话侧的判据一个都不在这里重写:cwd 走 files 面立下的**唯一**写法
   * (`useSessionCwd`),候选走 `files.list`(数据源),去抖归这一层 ——
   * 「人打字的节奏」是编排的事,不是数据源的事(与 SearchPanel 逐条同款)。
   *
   * **留账(只记不补)**:`useFileMentionsSource` 有 `status`(idle/loading/
   * ready/error)与 `error` 两格,但抽屉今天**一格都没画** —— 拉候选的那一瞬
   * 没有 loading、拉失败没有 error(旧候选留屏、错误只进 store)、真没匹配到
   * 时画的是 `composer.noMatch` 那句 empty(那一格是 `DrawerPickList` 自己
   * 按长度判的,不读 status)。同一条留账在 `data/file-mentions-source.ts:50`
   * 与提交 ac384704 里各记过一次;补这三态是**行为变化**,要另批拍板。
   */
  const cwd = useSessionCwd()
  const mentions = useFileMentionsSource((st) => st.mentions)
  const searchMentions = useFileMentionsSource((st) => st.search)
  const clearMentions = useFileMentionsSource((st) => st.clear)

  useEffect(() => {
    if (drawerKind !== 'files') {
      clearMentions()
      return
    }
    const timer = setTimeout(
      () => void searchMentions(pickQuery, cwd, sessionId),
      FILE_MENTION_DEBOUNCE_MS,
    )
    return () => clearTimeout(timer)
  }, [drawerKind, pickQuery, cwd, sessionId, searchMentions, clearMentions])

  /* ── D4 波二:命令表 ─────────────────────────────────────────────────
   * 内置那七条是编译期常量(合表在编排点),插件那一半懒拉一次 ——
   * 抽屉第一次开的时候才发。 */
  const ensurePluginCommands = useCommandsSource((st) => st.ensurePluginCommands)
  useEffect(() => {
    if (drawerKind === 'commands') void ensurePluginCommands()
  }, [drawerKind, ensurePluginCommands])

  /* 这几条**必须** useMemo:它们进了下面 applyPick 的依赖数组,而数组字面量
   * 每帧都是新身份 —— 不 memo 的话 applyPick 每帧重建,它的 useCallback 等于没写,
   * 吃它的子组件也就每帧重渲染一次。exhaustive-deps 揪出来的就是这条(真 bug 类:
   * 白写的 memo 化)。改的是身份稳定性,不是取值本身 —— 行为一字未变。 */
  const fileHits = useMemo(
    () => (drawerKind === 'files' ? matchFiles(mentions, pickQuery) : []),
    [drawerKind, mentions, pickQuery],
  )
  /* 抽屉那一行画的是 label(cwd 之下的相对路径);选中时要的是 path。
   * 两者同源同序,所以下标就是它们之间的对应关系。 */
  const files = useMemo(() => fileHits.map((hit) => hit.label), [fileHits])
  const commands = useMemo(
    () => (drawerKind === 'commands' ? matchCommands(allCommands, pickQuery) : []),
    [drawerKind, allCommands, pickQuery],
  )
  const pickLen = drawerKind === 'files' ? files.length : commands.length
  /*
   * 候选列表的**键盘位**。受控档:这一位住在 store 里(输入框那边的 ↑↓ 也要改它),
   * 原语只负责判走法、夹范围、把选中行滚进视野。
   * 鼠标经过**不**改它 —— hover 由 CSS 画,法条见 ui/a11y/list-selection 文件头。
   * loop=false:候选到端点就停(与从前的 movePickIndex 逐字同一个走法)。
   */
  const pick = useListSelection({
    count: pickLen,
    active: pickIndex,
    onActiveChange: setPickIndex,
    loop: false,
  })
  const index = pick.active

  /* ── 输入框吐出来的 token:有就开对应抽屉,没有就把选择器收掉 ─────────────
   * 「收掉」只收 files / commands 两位住户 —— 模型与执行状态不是输入驱动的,
   * 打字不该把它们关了。 */
  const onToken = useCallback(
    (hit: TokenHit | null) => {
      if (hit) {
        showPick(hit.kind, hit.query)
        return
      }
      const kind = useComposerStore.getState().drawerKind
      if (kind === 'files' || kind === 'commands') closeDrawer()
    },
    [showPick, closeDrawer],
  )

  /*
   * 选中一条。**两种住户都只做一件事:插进输入框** —— 命令的执行不在这一刻,
   * 在按下发送的那一刻(理由写在 data/commands-source.ts 文件头:
   * 参数是选完之后才打的,抽屉在人打第一个参数字符之前就已经收了)。
   *
   * 唯一的例外是 `/ask-demo` 那条 dev 扳机:它没有参数,也不是一句要发出去的话。
   */
  const applyPick = useCallback(
    (i: number) => {
      if (drawerKind === 'files') {
        const hit = fileHits[i]
        // chip 上写的是相对路径(人心里的名字),草稿里代表的是绝对路径的
        // `{{file:…}}`(交出去那一刻由 chat-port 展开回 `@<路径>`)。
        if (hit) inputRef.current?.insert('files', hit.label, createFileToken(hit.path))
        closeDrawer()
        return
      }
      if (drawerKind !== 'commands') return
      const cmd = commands[i]
      if (!cmd) return
      // dev-only:ask 形态今天没有真产地,`/ask-demo` 是它唯一的扳机。
      // 真接上 ask_user 事件后删掉这条分支与 data.ts 里那一条,形态本身不动。
      if (cmd.action === 'ask-demo') {
        inputRef.current?.clear()
        openAsk(ASK_DEMO_SPEC)
        return
      }
      inputRef.current?.insert('commands', cmd.name)
      closeDrawer()
    },
    [drawerKind, fileHits, commands, inputRef, closeDrawer, openAsk],
  )

  return {
    picking,
    files,
    commands,
    index,
    move: pick.move,
    rowRef: pick.rowRef,
    applyPick,
    onToken,
  }
}
