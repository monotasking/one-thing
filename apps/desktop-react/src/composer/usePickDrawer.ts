import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { createFileToken } from '@onething/runtime/prompts/prompt-references'
import type { CommandEntry } from '../data/commands-source'
import { useCommandsSource } from '../data/commands-source'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../data/file-mentions-source'
import type { FileMentionsStatus } from '../data/file-mentions-source'
import { useSessionCwd } from '../data/files-source'
import { useSkillsSource } from '../data/skills-source'
import { useListSelection } from '../ui/a11y/list-selection'
import { ASK_DEMO_SPEC } from './data'
import { useComposerStore } from './store'
import { groupCommands, matchCommands, matchFiles } from './transitions'
import type { CommandGroup } from './transitions'
import type { ComposerInputHandle } from './components/ComposerInput'
import type { AskSpec, DrawerKind, TokenHit } from './types'

/**
 * ── 切线 D:抽屉里那两位输入驱动的住户(`@` 文件 / `/` 命令)────────────────
 *
 * 一个槽四种住户,这只 hook 只管其中两位 —— 它们的共同点是**由打字驱动**:
 * token 出现就开、消失就收,候选按词收窄,↑↓ 走位,↵ 插进输入框。
 * 模型与执行状态是人主动开的,不归这里。
 *
 * 交出去的十格 `{picking, files, fileStatus, commands, commandGroups, index, move,
 * rowRef, applyPick, onToken}` 正是 `DrawerPickList` 与 `ComposerInput` 要的全部
 * —— `move` 是输入框那头 ↑↓ 的直通口(见下),少了它 `useListSelection` 就搬不整只。
 * (09-12 多出来的两格:`fileStatus` 让抽屉画得出 loading / error,
 * `commandGroups` 让命令切成命令 / 技能 / 插件三组 —— 两格都与 `commands` /
 * `files` 同源同一次计算,不是第二份事实。)
 *
 * **`useListSelection` 整只跟着走**:键盘位是这两位住户的状态,不是编排点的。
 * hook 边界上一个 `mouseenter` 都不许补 —— hover ≠ active 那条法(CLAUDE.md
 * 禁令区)在这里的落地就是「改 active 的只有键盘与显式点击」,而这次拆分
 * 只是换了个文件装它,一个字都没松。
 *
 * ## 三张表
 *
 * **生命周期**:两个 effect —— ① `@` 候选的拉取(抽屉不是 files 就散候选;
 * **刚切到 files 的那一拍当场发一次**,此后每次改词才等 `FILE_MENTION_DEBOUNCE_MS`,
 * 重入即撤上一发的计时器 —— 09-12 第二批:去抖是给打字的节奏准备的,首开没有节奏);
 * ② 命令抽屉第一次开时懒拉插件与技能那两半(技能按 cwd 缓存)。都没有卸载动作
 * 要做,除了 ① 那只计时器(它由 effect 自己的清理函数收)。这只 hook 只有一种
 * 宿主(编排点),没有换宿主这回事。
 *
 * **UI 生命状态**:09-12 起四态齐全 —— `fileStatus` 原样交给 `DrawerPickList`,
 * 由它在「正在找…」/ 旧候选留屏 / 「无匹配」/ 错误行之间选。命令那一半没有
 * 取数态可言(内置是编译期常量,插件与技能拉不到就是那一组不出现,静默降级)。
 *
 * **UI 交互状态**:`index` 是键盘位(active),hover 一格 JS 都不占(由
 * `DrawerPickList` 的 CSS 画)。没有 disabled 档:候选行永远可点。
 */
export interface PickDrawer {
  /** files / commands 抽屉是否开着 —— 开着时上下键与回车归抽屉,不归输入框。 */
  picking: boolean
  /** 抽屉那一行画的是 label(cwd 之下的相对路径)。 */
  files: string[]
  /**
   * `@` 候选此刻处在哪一态。抽屉据此在「正在找…」/ 旧候选留屏 / 「无匹配」/
   * 错误行之间选一种画法 —— 09-12 之前它只按长度判,于是拉候选的那 120ms 里
   * 屏幕上写的是「无匹配」(用户报的「出现的动画很突兀」有一半是这一句)。
   */
  fileStatus: FileMentionsStatus
  /**
   * 命令的**扁平序**(= 屏幕上从上到下的顺序)。`applyPick` 与键盘位都按它算。
   */
  commands: CommandEntry[]
  /**
   * 同一批命令切成的组(命令 / 技能 / 插件,空组不出现)。各组 `items` 顺次
   * 相连**恒等于** `commands` —— 一条列表不许有两种序,所以两格同源同一次计算。
   */
  commandGroups: CommandGroup<CommandEntry>[]
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

/**
 * 尾巴上补一个 `/`(已经有了就一个字不动)。
 *
 * 它不是格式化,是**把候选自己说的那句话写进那条路径里**:这条是目录。
 * 幂等,所以后端哪天开始发带尾巴的目录路径,这里也不会长出 `//`。
 */
function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
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
   * ── 09-12 结清:那条留账(loading / error 一格都没画)补上了 ──────────────
   * 从前 `status` 这一格没人读,抽屉只按候选**长度**判 —— 于是刚敲下 `@`、
   * 去抖窗口还没走完的那 120ms 里,屏幕上白纸黑字写着「无匹配」,一次往返之后
   * 再整列换成真候选。用户报的「command / file 出现的动画很突兀」有一半是它:
   * 突兀的不是过渡曲线,是**先说了一句不成立的话再改口**。
   * 今天 `status` 交给 `DrawerPickList`,那四态各有各的画法(见它的文件头)。
   * `clearMentions()` 仍旧只在**抽屉不是 files** 时发 —— 切到 files 的那一拍
   * 一个字都不清,所以「开抽屉」本身从不制造一次空列表。
   */
  const cwd = useSessionCwd()
  const mentions = useFileMentionsSource((st) => st.mentions)
  const fileStatus = useFileMentionsSource((st) => st.status)
  const searchMentions = useFileMentionsSource((st) => st.search)
  const clearMentions = useFileMentionsSource((st) => st.clear)

  /**
   * 「抽屉是不是刚切到 files 的那一拍」。ref 而不是 state:它只是给下面那只
   * effect 认门,读它的人不需要重渲染。
   */
  const filesJustOpened = useRef(false)
  useEffect(() => {
    if (drawerKind !== 'files') {
      filesJustOpened.current = false
      clearMentions()
      return
    }
    /*
     * ── 首开不去抖(09-12 第二批)────────────────────────────────────────
     * 去抖是给**打字的节奏**准备的:人一个字一个字地敲,每个字都发一发是浪费。
     * 而 `@` 刚敲下去的那一拍**没有节奏可言** —— 它是一次明确的「我要看候选」,
     * 后面跟着的 120ms 纯粹是白等:屏幕上写着「正在找…」,而请求还没出门。
     * 所以首开当场发一次,去抖只管此后每一次改词。
     *
     * 这不是把等待变短了一点,是把等待**少一段**:抽屉今天是固定高的框,
     * 框里那行字从「正在找…」换成候选不改变任何几何,于是首开的全部体感
     * 就剩这一次往返 —— 去抖 120ms 在它上面是整整一半。
     */
    if (!filesJustOpened.current) {
      filesJustOpened.current = true
      void searchMentions(pickQuery, cwd, sessionId)
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
  /*
   * 技能那一半同样懒(09-12)。**键是 cwd**:「项目根下的技能按它发现」是契约上
   * 那一格自己的注释,换一条工作目录看得见的技能表就不同 —— 所以依赖表里带 cwd,
   * 而 store 自己按 cwd 判要不要真发(拉过同一个 cwd 就是恒等)。
   */
  const ensureSkills = useSkillsSource((st) => st.ensureSkills)
  useEffect(() => {
    if (drawerKind !== 'commands') return
    void ensurePluginCommands()
    void ensureSkills(cwd)
  }, [drawerKind, cwd, ensurePluginCommands, ensureSkills])

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
  /*
   * 命令:先筛(名字前缀 → 说明 / 用法子串),再切组(命令 / 技能 / 插件)。
   * **两步的顺序不能反**:分组是外层分区,匹配的排序只在组内说话 ——
   * 反过来就会切出两次「命令」组头(判词整段在 `transitions.groupCommands`)。
   */
  const commandGroups = useMemo(
    () => (drawerKind === 'commands' ? groupCommands(matchCommands(allCommands, pickQuery)) : []),
    [drawerKind, allCommands, pickQuery],
  )
  /** 扁平序 = 各组顺次相连。屏幕上的顺序、键盘位、`applyPick` 的下标都是它。 */
  const commands = useMemo(
    () => commandGroups.flatMap((group) => group.items),
    [commandGroups],
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
        // chip 上写的是相对路径(人心里的名字),它代表的是绝对路径的
        // `{{file:…}}`(交出去那一刻由输入面的草稿出口展成 `@<路径>`)。
        //
        // **目录带尾斜杠,而且判据只在这一处**(09-12):候选自己说得清是
        // `directory` 还是 `file`(`FileMention.type`),而下游谁都没有 stat ——
        // 气泡里那枚 chip 判「这是目录吗」的唯一判据就是路径尾巴上那个 `/`
        // (`content/user-message.tsx` 的 `dirRef`),模型看见的也只是那一条路径。
        // 不在 `file-mentions-source` 改 `path` 本身:那张表还有别的读者
        // (匹配、念法、去重),给它们喂一条带尾巴的路径是另一件事。
        if (hit) {
          const path = hit.type === 'directory' ? ensureTrailingSlash(hit.path) : hit.path
          const label = hit.type === 'directory' ? ensureTrailingSlash(hit.label) : hit.label
          inputRef.current?.insert('files', label, { token: createFileToken(path) })
        }
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
      /*
       * 参数提示跟着命令一起插进去(09-12):`argHint` 是这条命令自己带的一格
       * (产地 `commands-source.argHintOf`),输入面只负责把它挂成一枚幽灵占位。
       * 不收参数的命令没有这一格,于是插完就只剩命令徽加一个空格 —— 与从前逐字相同。
       */
      inputRef.current?.insert('commands', cmd.name, { argHint: cmd.argHint })
      closeDrawer()
    },
    [drawerKind, fileHits, commands, inputRef, closeDrawer, openAsk],
  )

  return {
    picking,
    files,
    fileStatus,
    commands,
    commandGroups,
    index,
    move: pick.move,
    rowRef: pick.rowRef,
    applyPick,
    onToken,
  }
}
