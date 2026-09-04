import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronsUp, Info, RotateCcw } from '../components/icons'
import { ButtonBase } from '../ui/ButtonBase'
import { IconButton } from '../ui/IconButton'
import { Splitter } from '../ui/Splitter'
import { useT } from '../i18n'
import type { MessageKey, TFn } from '../i18n'
import { useExposeStore } from '../expose/store'
import {
  flattenTree,
  revealMutation,
  useDirStates,
  useFileDetail,
  useFilesSource,
  useSessionCwd,
} from '../data/files-source'
import type { FileFailure, RootStatus } from '../data/files-source'
import { useFileOpenMode } from '../data/file-open-mode'
import {
  DEFAULT_SPLIT_RATIOS,
  FILES_SPLIT_ID,
  SPLIT_MAX,
  SPLIT_MIN,
  useSplitPrefs,
  useSplitRatio,
} from '../data/split-prefs'
import { FileActionsMenu } from './FileActionsMenu'
import { FileDetailPopover } from './FileDetailPopover'
import { FocusScope } from '../focus/FocusScope'
import { focusTree } from '../focus/registry'
import { useFileFloats } from './file-floats'
import type { FloatOrigin, OpenDetailOptions } from './file-floats'
import { NoWorkdirNotice } from './files/NoWorkdirNotice'
import { RootCrumbs } from './files/RootCrumbs'
import { TreeEntryRow, depthVar } from './files/TreeEntryRow'
import type { EntryRow } from './files/TreeEntryRow'
import { useRowWindow } from './files/useRowWindow'
import { FileViewer } from './viewer/FileViewer'
import { closeFileEverywhere, fileRef, openFileInCurrentTarget } from './viewer/open-target'
import { openStateOf, useWorkbenchStore } from '../workbench/store'
import { refId } from '../workbench/kinds'
import { SoloLeafStrip } from '../workbench/LeafStrip'
import s from './FilesPanel.module.css'

/**
 * 文件树 = 一块**普通的 Dock 内容**(id 'files'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 *
 * ── 形状(08-31 claude design 定稿 + 查看器 F1 的面板内分栏)────────────────
 * 头(面包屑 + 全部收起 + 重新读取)/ 告知条(只在没绑工作目录时)/ **身:两列**
 * (常驻的窗口化树 | 0fr⇄1fr 长出来的查看区)/ 底(一句用法提示)+ 两层浮起来的
 * 东西(行菜单 / 详情浮层)。
 *
 * ── 这块面自己剩下什么(09-02 批 9d 拆分之后)──────────────────────────────
 * 它是**编排**:取数、把三形行摊到窗口里、把两层浮层的落点接上、判分栏开不开。
 * 四件有自己名字的东西已经各自出文件,一件都不该再回来:
 *   · `files/useRowWindow`   量视口 + 跟卷轴(窗口化的那一半量测,与文件无关)
 *   · `files/RootCrumbs`     头上那一排路径(纯投影)
 *   · `files/NoWorkdirNotice` 告知条 + 绑定行(它有自己的四态与一口后端写)
 *   · `files/TreeEntryRow`   树上一行(含 ⌘I/⌘↵ 那条面域局部键的落点)
 * 浮层的**落点**在 `content/file-floats`(9b 立件,与查看器共用一份锚点算式)。
 *
 * ── 分栏:树是**常驻**的,不是被替换的(F1 §0 铁律 3)────────────────────────
 * 从前那层「预览」是 `position:absolute; inset:0` —— 它**盖住**整棵树:回来时
 * 滚动位置还在,但那一屏里你什么都干不了(点不到第二个文件,只能先关掉)。
 * F1 换成两列:单击一个文件 = 右列长出来,再单击别的文件 = **就地换内容**,
 * 树的展开态 / 滚动位 / 选中行一动不动。Esc 收起右列回全树。
 *
 * 结构上兑现这条铁律的只有一件事:那棵树的 DOM 位置**恒定** —— 它永远是
 * `.split` 的第一个孩子,查看区在它旁边出现或消失。所以「开一个文件 / 换一个
 * 文件 / 关掉查看器」三下都不会让 React 重挂树上任何一行(有三条断言钉着),
 * 而且 `.split` 里**不许再插任何包裹层**:`gate:files` 那一步问的是
 * `[data-testid="files-tree"] + [data-testid="file-viewer"]` 这条**相邻兄弟**。
 *
 * 「打开方式」那七档里,**「面板内」指的就是这条分栏**。F2 把另外六档也接上了
 * (查看器成了一块普通的瓦),所以这条分栏现在只在 `panel` 档长出来 ——
 * 一份内容只该有一个落点,两处同时画就是重影。档→落点的翻译只有一份,
 * 在 data/file-open-mode.ts 的 placementOfFileOpenMode。
 *
 * 定稿相对上一版(989dd3b6)的六处改判,每一处各自的理由:
 *
 * ① **类型标识拆成二形**。语言画**品牌色字标**(TS / PY / LUA / SH / MD /『{ }』),
 *    说不出语言的画 lucide 图标 —— 判据与两张表都在 `data/file-icons.ts`。
 *    理由:lucide 没有语言 logo,一屏里全是同一张「带尖括号的纸」,扫的时候
 *    读不出是哪一门。画法在 `content/FileGlyph`(查看器檐上那枚徽是第二个消费方)。
 *
 * ② **「打开」与「选中」分离**。选中 = 底色(此刻手指头点在哪一行),打开 = 行尾
 *    一颗 accent 圆点(这个文件的内容正开着)。它们是两件事:你可以选中 A 而开着 B。
 *
 * ③ **行尾 ⋯ / 右键出菜单**。09-01 起它升格为**动作单产地**:一个文件的全部动作
 *    (打开 / 打开方式七档 / 编辑 / 详情 / 复制路径 / 在 Finder 显示)都在这一张表里,
 *    而且与查看区右键弹的是**同一件组件**(content/FileActionsMenu)。
 *
 * ④ **详情从 Dialog 改成附属浮层**(ui/Popover)。理由是语义:详情是「瞄一眼」,
 *    不是「答一道题」——Dialog 压一层遮罩,把树整个盖住,而回来时滚动位置已经变了。
 *    浮层不遮树、点别处即散、Esc 关;焦点照 Menu 的手圈禁,但**不谎称 modal**。
 *    它 09-01 搬去了 content/FileDetailPopover —— 查看区右键也要弹它,一件东西
 *    两个宿主各画一遍必然分叉。入口是 ⌘I 与菜单里那一行(**双击那条路已删**)。
 *
 * ⑤ **窗口化渲染**。只画可视窗 + 上下各 8 行,前后各垫一块空撑子 —— 卷轴长度与
 *    「全画出来」逐像素相同。行高恒定 27 是它的前提,所以骨架 / 空 / 失败三种注行
 *    与条目行**同高**(那不是审美对齐,那是算式的前提)。算术在 `rowWindow`(纯
 *    函数),量测在 `files/useRowWindow`。
 *
 * ⑥ **三种「还没有内容」各说各的**:懒展开画两条骨架短横(不是「正在读取…」四个字
 *    ——那四个字在一屏树里读起来像一行文件名)、空目录画一行斜体、读失败画一句
 *    danger 小字 + 一颗「重试」(只重拉出错那一层,不是整棵树重来)。
 *
 * ══ 表一 · 生命周期 ═══════════════════════════════════════════════════════
 * | 事件            | 这块面做什么                                             |
 * |-----------------|----------------------------------------------------------|
 * | 挂载            | 订阅两个 store(files / viewer)+ 一格会话 id;`setRoot(cwd)`|
 * |                 | 幂等地把根交下去(判据在 `useSessionCwd`,不在这里)。       |
 * | 换会话          | `cwd` 变 → 同一条 `setRoot`;**选中态归零靠的不是它** ——     |
 * |                 | 选中是视图状态,换根之后那条路径自然不在树上了。            |
 * | **换宿主**      | 面板内 / 浮窗 / 舞台 / 钉边 —— 这块面在四种落点里**长得一样**,|
 * |                 | 因为它整块被 `renderContent('files')` 原样交出去。真正跟着换 |
 * |                 | 的只有两件:①`useRowWindow` 的 ResizeObserver 量到新高度(换 |
 * |                 | 宿主 = 一次真的尺寸变化,那条 `onScroll` 里的补量正是为「观察 |
 * |                 | 者还没回调而用户已经在卷」的那一帧留的);②两格浮层锚点归零   |
 * |                 | (它们贴的是**屏幕坐标**,换了宿主原来那一点不再指向任何东西)。|
 * |                 | 查看器自己的换宿主由 `viewer/` 那一面管,不在这块表里。       |
 * | 开 / 换 / 关文件 | **零重挂**:树的 DOM 位置恒定,`key` 是 `row.path`。三条断言  |
 * |                 | 钉着(files-panel.test「树不卸载」那一组)。                 |
 * | 卸载            | **一条监听都不摘了**(R2:Esc 与 ⌘I 都成了作用域声明)。      |
 * |                 | 无计时器、无模块级副作用 → 不需要 HMR dispose。              |
 *
 * ══ 表二 · UI 生命状态 ════════════════════════════════════════════════════
 * 「还没有内容」在这块面里有**六个不同的产地**,从前各说各的,这里收成一张表:
 * | 档              | 谁在说              | 画成什么                                |
 * |-----------------|---------------------|-----------------------------------------|
 * | 根还没定        | rootStatus idle/load| 头上一句「正在定」(RootCrumbs 第一档)   |
 * | 根定不下来      | rootStatus error    | 头上一句「定不下来」+ **底注**一句后端原话|
 * | 没绑工作目录    | rootOrigin 'home'   | 告知条(NoWorkdirNotice)——它带着一个可做 |
 * |                 |                     | 的动作,所以不是一句躺在底部的灰字。      |
 * | 某一层还在读    | 行 kind 'skeleton'  | 两条骨架短横(**只第一条报 status**:两条 |
 * |                 |                     | 合起来才是一句话)                        |
 * | 某一层是空的    | 行 note 'empty'     | 一行斜体灰,占一格**正常行高**            |
 * | 某一层读失败    | 行 note denied/     | 一句 danger 小字 + 后端原话 + 一颗「重试」|
 * |                 | missing/failed      | (只重拉那一层)                          |
 * | **超量**        | rows.length 很大    | 窗口化:只画可视窗 ± 8 行,前后两块空撑子 |
 * |                 |                     | 把卷轴撑成整表那么长(`useRowWindow`)。   |
 * 三档失败共用一张 `NOTE_LABELS`,**每一档一句不同的话** —— 不拿一句「读不到」
 * 糊三种原因(没权限 / 不存在 / 别的)。
 *
 * ══ 表三 · UI 交互状态 ════════════════════════════════════════════════════
 * | 落点          | rest      | hover      | focus | active/pending | disabled     |
 * |---------------|-----------|------------|-------|----------------|--------------|
 * | 面包屑祖先段  | text-2    | 换底       | 全局环| —              | —            |
 * | 面包屑尾段/…  | 不是钮    | —          | —     | —              | —            |
 * | 全部收起      | IconButton| st-hover   | 全局环| st-active      | 没展开的层时 |
 * | 重新读取      | IconButton| st-hover   | 全局环| st-active +    | 根没 ready 时|
 * |               |           |            |       | 图标转一圈     |              |
 * | 树行 / 行尾 ⋯ | 见 `files/TreeEntryRow` 的表三(选中 / 打开 / 隐藏三格另算)   |
 * | 注行「重试」  | ButtonBase| 下划线     | 全局环| —              | —            |
 * | 分隔杆        | 见 `ui/Splitter`;**只在分栏真长出来时才在**(不可调的        |
 * |               | separator 进 Tab 序是纯噪音,APG)。                            |
 * | 告知条 / 绑定 | 见 `files/NoWorkdirNotice` 的表三(pending 的唯一产地在那儿)  |
 * 这块面自己**没有 pending 档**:它发起的每一件异步事(展开 / 重拉 / reveal /
 * 绑目录)的忙态都长在**发起它的那个控件**旁边(律③),不在面板级的一颗布尔上。
 *
 * ── 键盘:两条键都是**声明**(09-03 R2)──────────────────────────────────
 * ⌘I / ⌘↵ 唤详情、Esc 收起查看区 —— 从前前者长在行自己的 keydown 上、后者是
 * 面板根上一条 addEventListener;R2 之后这块面是响应链上的一格 `region`:
 * 键表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.files.keys`、落点是下面交给
 * `<FocusScope>` 的 `keyHandlers` 与 `onEscape`,**答 true 才算接住**。
 * 「作用在哪一行」由这块面自己记账(见 `onCurrent`),不去读 activeElement。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 注行的两档失败 + 一档非失败,各一句人话。 */
const NOTE_LABELS: Record<'empty' | FileFailure, MessageKey> = {
  empty: 'files.dirEmpty',
  denied: 'files.dirDenied',
  missing: 'files.dirMissing',
  failed: 'files.dirFailed',
}

export function FilesPanel() {
  const t = useT()
  // 「哪种语言」这件事跟着详情浮层一起搬走了(它是那块内容自己的事,不是面板的)。
  const cwd = useSessionCwd()
  const sessionId = useExposeStore((st) => st.currentSessionId)
  const root = useFilesSource((st) => st.root)
  const rootStatus = useFilesSource((st) => st.rootStatus)
  const rootOrigin = useFilesSource((st) => st.rootOrigin)
  const rootError = useFilesSource((st) => st.rootError)
  const expanded = useFilesSource((st) => st.expanded)
  /*
   * 目录内容住在 `dirsQuery` 那一族里(7d)。**键面由屏幕给定** —— 根 + 此刻展着的
   * 那几支,一个不多:没展开的目录一格都不订(也就不会为它们建格)。
   */
  const dirPaths = useMemo(
    () => (root ? [root, ...Object.keys(expanded)] : []),
    [root, expanded],
  )
  const dirs = useDirStates(dirPaths)
  const detail = useFileDetail()
  const setRoot = useFilesSource((st) => st.setRoot)
  const navigateRoot = useFilesSource((st) => st.navigateRoot)
  const toggleDir = useFilesSource((st) => st.toggleDir)
  const collapseAll = useFilesSource((st) => st.collapseAll)
  const retryDir = useFilesSource((st) => st.retryDir)
  const refresh = useFilesSource((st) => st.refresh)
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)

  /*
   * 查看器住**另一个 store**(data/viewer-source)。面板从它这里只取两件事:
   * 「此刻开着的是哪个文件」(树上那颗打开点要知道)与那两口开 / 关。
   * 文件内容一个字节都不经过这里 —— 那正是两个 store 分家的意思。
   */
  /*
   * W1:这条分栏此刻在看哪个文件,由**拼贴台**说(`panelPath`)。它是那一格
   * 「不进树」的落点(设计 §2.1 明写保留:面板内仍是 FilesPanel 自己的分栏)。
   * 从前它读的是「全应用那一份查看器手上是哪个文件」—— 查看器多实例之后
   * 那句话不成立了:同时可能有五份,而这条分栏问的是**它自己**这一份。
   */
  const panelPath = useWorkbenchStore((st) => st.panelPath)
  /*
   * 树行那颗点的**三态**(实心 = 显示中,空心 = 隐藏,无 = 没开,设计 §2.3)。
   * 判据整件是纯函数 `openStateOf` —— 渲染层不自己判一次,而这块面订的正是
   * 那三格事实(树 / 隐藏表 / 分栏路径),所以任一格变了这一列点当场跟着翻。
   */
  const regions = useWorkbenchStore((st) => st.regions)
  const hiddenTabs = useWorkbenchStore((st) => st.hidden)
  const restoreHidden = useWorkbenchStore((st) => st.restoreHidden)
  const openStateOfPath = useCallback(
    (path: string) => openStateOf({ regions, hidden: hiddenTabs, panelPath }, fileRef(path)),
    [regions, hiddenTabs, panelPath],
  )
  /*
   * 「打开一个文件」的编排在 content/viewer/open-target 那一处(读它 + 按当下
   * 这一档摆好落点),三个入口共用 —— 面板这里只是调用方,不判落点。
   */
  const openFile = openFileInCurrentTarget
  const closeViewer = useCallback(() => {
    if (panelPath) closeFileEverywhere(panelPath)
  }, [panelPath])
  /**
   * 当下这一档打开方式。面板只用它判**一件事**:这条分栏画不画查看器
   * (`panel` 档才画;别的六档查看器住在舞台 / 浮窗 / 钉栏里,那时这条分栏
   * 收起来 —— 一份内容只该有一个落点,两处同时画就是重影)。
   */
  const openMode = useFileOpenMode((st) => st.mode)
  /*
   * 「这个文件正开着」的判据:**正在读的那条压过已经画出来的那条**。
   * 点下去的一瞬间打开点就跟着走(手感),而内容要等读回来 —— 两者不同步是
   * 事实,不是缺陷:檐上那格读数正是为了说出这件事。
   */
  const openPath = panelPath
  const viewerOpen = openPath !== null
  /** 这条分栏此刻长不长出来。**落点是 `panel` 才算**(理由见上面 openMode)。 */
  const splitOpen = viewerOpen && openMode === 'panel'

  /**
   * 选中 = **视图状态**,所以它住在这里而不是 store 里:换一块面它就该归零,
   * 而 store 里那份「树展开到哪儿」是要活过面板开合的(树不卸载铁律)。
   */
  const [selected, setSelected] = useState<string | null>(null)
  /*
   * 两层浮层**开在哪一点**走 `content/file-floats`(9b 立件,与查看器共用)。
   * 这里只多留一格:菜单开在**哪一行**上 —— 那是这块面自己的事(锚点件管坐标,
   * 不管坐标底下站着谁),而菜单收起时两者必须一起清。
   */
  const { menuAt, detailAt, openMenuAt, openDetailAt, closeMenu, closeDetail: closeDetailAt } =
    useFileFloats()
  const [menuRow, setMenuRow] = useState<EntryRow | null>(null)
  /** 「重新读取」按了几次 —— 那枚图标每按一次多转一圈(单调递增,见下面的注)。 */
  const [spins, setSpins] = useState(0)

  /*
   * 分栏比例(09-01 报障:「file open 之后,没办法调整宽度」)。
   * 记忆住 `data/split-prefs`(照 file-open-mode 那份偏好 store 的先例:
   * zustand + persist + 钳制的 merge)。这里只读一个数,拖动那段一帧都不经过
   * React —— 杆把实时值直接写进下面那个 CSS 变量(见 ui/Splitter 的「跟手定律」)。
   */
  const splitRef = useRef<HTMLDivElement>(null)
  const splitRatio = useSplitRatio(FILES_SPLIT_ID)
  const setSplitRatio = useSplitPrefs((st) => st.setRatio)

  /**
   * Esc = 收起查看区回全树。**一句声明,不再是一个监听**(09-03 R2)。
   *
   * 从前它挂在面板根元素上、用 `addEventListener`(理由是「一个 div 不是控件,
   * 给它挂 JSX 的 onKeyDown 会被 jsx-a11y 抓」)。R2 之后这块面是响应链上的一格
   * `region`,认不认这一下 Esc 是 `<FocusScope onEscape>` 的返回值:**答 true =
   * 这一下归我**,由那唯一的派发器代劳 `preventDefault` 并停止往外问。
   *
   * 两条护栏一个字没改:① 行菜单 / 详情浮层开着时**不接**(它们在树上是这块面
   * 的孩子,由深到浅本来就先问到它们 —— 这一句是那条结构的复述,不是第二套判据);
   * ② 查看器没开就不接,让这一下继续往外传(外壳还有它自己的退层链)。
   */
  const panelRef = useRef<HTMLDivElement>(null)
  const onEscape = useCallback(() => {
    if (menuAt || detail) return false
    // 查看器不在这条分栏里(摆去了舞台 / 浮窗 / 钉栏)时**不接**:那一下 Esc
    // 属于摆着它的那一层,不属于这块面。
    if (!splitOpen) return false
    closeViewer()
    return true
  }, [menuAt, detail, splitOpen, closeViewer])

  // 根跟着活跃会话走。判据不在这里 —— useSessionCwd 是它唯一的产地,
  // 这里只负责把结果交给数据源(setRoot 自己幂等)。
  useEffect(() => {
    void setRoot(cwd)
  }, [cwd, setRoot])

  const rows = useMemo(() => flattenTree(root, dirs, expanded), [root, dirs, expanded])
  /* 窗口化:量视口 + 跟卷轴那一半在 `files/useRowWindow`,算术在 `rowWindow`。 */
  const { bodyRef, onScroll, shown, padTop, padBottom } = useRowWindow(rows)

  /*
   * 两条「开浮层」都收**来源**往下递(一次指针事件 / 一块元素矩),自己一格
   * 坐标都不算:锚点算式只有一处产地(`content/file-floats`)。批 9d 的真机
   * 前后对照量出过这条 —— 行上先算一遍、这里再算一遍,浮层就多隔了一条缝。
   */
  const openMenuFor = useCallback(
    (row: EntryRow, origin: FloatOrigin) => {
      setSelected(row.path)
      setMenuRow(row)
      openMenuAt(origin)
    },
    [openMenuAt],
  )

  /** 关菜单 = 那一格坐标与「开在哪一行」一起清:留下任何一半都是一张半开的菜单。 */
  const dismissMenu = useCallback(() => {
    setMenuRow(null)
    closeMenu()
  }, [closeMenu])

  const openDetailFor = useCallback(
    (
      row: { path: string; name: string; type: 'file' | 'directory' },
      origin: FloatOrigin,
      options?: OpenDetailOptions,
    ) => {
      setSelected(row.path)
      openDetailAt(origin, options)
      void openDetail({ path: row.path, name: row.name, type: row.type })
    },
    [openDetailAt, openDetail],
  )

  const footNote = footNoteOf(rootStatus, rootError, t)
  const noWorkdir = rootStatus === 'ready' && rootOrigin === 'home'

  /*
   * ── ⌘I / ⌘↵ 作用在**哪一行**(09-03 R2)────────────────────────────────
   * 从前这两条键长在行自己的 `onKeyDown` 上,所以「哪一行」= 那一行拿着 DOM 焦点。
   * R2 把它们迁进作用域声明(`FOCUS_SCOPES.files.keys`),落点成了这块面的
   * `keyHandlers.detail` —— 于是必须在这一层回答同一个问题,而且**不许去读
   * `document.activeElement`**(那正是设计 §7「谁都不许」的第三条)。
   *
   * 答法是逐行记账:行拿到焦点时把自己报上来,失去时销号(下面 `onCurrent`)。
   * 设计说的是「读面板自己的选择状态(list-selection / roving 的当前项)」——
   * 文件树今天没有那两只原语中的任何一只,而它的行**是真的可聚焦**
   * (Tab 走得进去),所以「当前项」按定义就是拿到焦点的那一行;逐行 onFocus
   * 记的正是它,不是一次全局 activeElement 查询。留账在交卷报里。
   *
   * `selected`(点击落的那格底色)**没有被合并进来**:今天键盘 Tab 过一行不上
   * 底色,合并等于给这块面加一种可感知的新态,那是拍板件。
   *
   * 一行都没拿焦点时 `detail` **交不出处理器** —— `routeKey` 当没命中处理,
   * 这一下 ⌘I 原样落到全局命令表去,与从前「焦点不在任何一行上时行监听根本
   * 收不到这一下」逐字同义。
   */
  /*
   * ── ↵ 开文件之后把焦点送进查看器(§11 拍点 1 的另一半)────────────────────
   * 送不了的那一刻是**常态**而不是错误:`openFile` 先摆落点、再异步读内容,
   * 查看器要到下一次提交才挂上来,所以按下 ↵ 的那一帧树上根本没有 `viewer`
   * 那一格。于是这里立一个旗、由下面那条 effect 在「查看器真的到位」之后兑现,
   * **兑现成功才把旗放下**。
   *
   * 用 `activateScope('viewer')` 而不是去猜某一份实例:查看器可能在这条分栏里,
   * 也可能被摆去了舞台 / 浮窗 / 四条边(「打开方式」七档)—— 一块文件树不该
   * 知道那件事,树自己在可交互的那几份里挑(见 `FocusTree.activateScope`)。
   */
  const wantViewer = useRef(false)
  /**
   * 「用键盘开了第几次」。**它是这条 effect 的触发器**,不是一个读数 ——
   * 少了它,「↵ 开的正是此刻已经开着的那个文件」当场失灵:那一下 `openPath` 与
   * `viewerOpen` 都没变,依赖表一格不动,effect 根本不跑,焦点留在树上。
   * (真机门场景 10 的第二条读数逮到的就是这一形。)
   */
  const [openTick, setOpenTick] = useState(0)
  useEffect(() => {
    if (!wantViewer.current) return
    if (focusTree.activateScope('viewer', { reason: 'open' })) wantViewer.current = false
  }, [openTick, viewerOpen, openPath])

  const [current, setCurrent] = useState<{ row: EntryRow; el: HTMLElement } | null>(null)
  const onCurrent = useCallback((row: EntryRow, el: HTMLElement | null) => {
    setCurrent((at) => {
      if (el) return { row, el }
      // 销号只认自己那一行:两行之间移焦点时,新那一行先报到、旧那一行才销号。
      return at && at.row.path === row.path ? null : at
    })
  }, [])

  const filesKeys = {
    detail: current
      ? () =>
          openDetailFor(
            current.row,
            // 那一行的矩交出去 → 矩锚(贴着左下角隔一条缝),与行上那一手同源。
            current.el.isConnected ? current.el.getBoundingClientRect() : undefined,
          )
      : undefined,
  }

  return (
    <FocusScope scope="files" rootRef={panelRef} onEscape={onEscape} keyHandlers={filesKeys}>
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="files-panel">
          <div className={s.head} data-panel-head="">
            {/*
             * `data-testid="files-root"` 留在原地不动。**但取件口从 textContent 换成了
             * `data-root`**:面包屑的中段现在会折成 `…`(深路径下平铺一排会把整条头
             * 挤成一条滚轨),折过之后 textContent 就不再逐字等于那条路径了。
             * 屏幕上说的是「我在哪儿」(可折),`data-root` 说的是「那条路径本身」
             * (永不折)—— 门与单测问后者,那才是它们真正要问的事实。
             */}
            <nav
              className={s.crumbs}
              aria-label={t('files.breadcrumb')}
              data-testid="files-root"
              data-root={root ?? ''}
            >
              <RootCrumbs root={root} status={rootStatus} t={t} onJump={(at) => void navigateRoot(at)} />
            </nav>
            {/*
             * 头上这两颗从 `Button iconOnly` 迁成 `ui/IconButton`(09-01 立法:图标钮
             * 必须消费图标钮那件库件)。`size="md"` 与 `--btn-sm` 同为 28,字形同为
             * 14 —— **几何逐像素相同**;两处规范修正逐条记在批报告里:①多了 `:active`
             * (按住比悬停深一档 —— Button.iconOnly 从来没有这一格);②悬停多一条
             * `ui/Tooltip`(库件的硬规矩:只有「旁边就写着同一句话」才关得掉,这两颗
             * 旁边什么都没写)。
             */}
            <IconButton
              icon={ChevronsUp}
              size="md"
              label={t('files.collapseAll')}
              disabled={Object.keys(expanded).length === 0}
              onClick={collapseAll}
            />
            {/*
             * 「重新读取」按下去转一圈。**是一次过渡,不是一段循环动画**:它说的是
             * 「你刚才那一下到了」,不是「我在忙」(忙由树上那两条骨架说)。所以角度
             * 单调递增(每按一次 +360),靠 .headSpin 上那条 transform 过渡走完 ——
             * 一个 @keyframes 都不用加(全仓关键帧只在 styles/motion.css 里长)。
             * 圈数走一格无单位自定义属性(与 `--depth` / `--files-split` 同一手):
             * 转的**只有那枚字形**,不是整颗钮 —— 钮连同它的悬停底一起转是另一种动效。
             */}
            <IconButton
              icon={RotateCcw}
              size="md"
              className={s.headSpin}
              style={{ '--files-spin': spins } as CSSProperties}
              label={t('files.refresh')}
              disabled={rootStatus !== 'ready'}
              onClick={() => {
                setSpins((n) => n + 1)
                void refresh()
              }}
            />
          </div>

          {noWorkdir && <NoWorkdirNotice sessionId={sessionId} t={t} />}

          {/*
           * 身 = 两列。树**永远是第一个孩子**,查看区在它旁边出现或消失 ——
           * 这一条就是「树常驻」铁律在 DOM 上的全部实现:树的位置不随查看器的开合
           * 变动,于是 React 没有任何理由重挂它(零重挂的三条断言钉的正是这件事)。
           * 列宽由 CSS 按 data-viewer 翻(0fr ⇄ 1fr),不在 JS 里算像素。
           * **这里不许再插一层包裹**:门那一步问的是树与查看器的相邻兄弟关系。
           */}
          <div
            className={s.split}
            ref={splitRef}
            data-viewer={splitOpen ? 'open' : 'closed'}
            /* 比例进一个**无单位数**的自定义属性,列宽由样式表按它算
             * (`calc(var(--files-split) * 1%)`)—— 组件里不算像素,拖拽期间
             * 杆改的也正是这一格。 */
            style={{ '--files-split': `${splitRatio}` } as CSSProperties}
          >
          <div
            className={s.body}
            ref={bodyRef}
            id="files-tree-column"
            aria-label={t('files.treeLabel')}
            data-testid="files-tree"
            onScroll={onScroll}
          >
            {/* 窗口前后的两块空撑子:它们不是内容,只是让卷轴与「全画出来」一样长。 */}
            {padTop > 0 && <div style={{ height: padTop }} aria-hidden="true" />}
            {shown.map((row) =>
              row.kind === 'skeleton' ? (
                <div
                  key={row.id}
                  className={s.skelRow}
                  style={depthVar(row.depth)}
                  /* 两条短横合起来才是一句话「这一层还在读」,所以只让第一条报出来。 */
                  role={row.bar === 1 ? 'status' : undefined}
                  aria-label={row.bar === 1 ? t('files.dirLoading') : undefined}
                >
                  <span
                    className={row.bar === 1 ? `${s.skelBar} ${s.skelBar1}` : `${s.skelBar} ${s.skelBar2}`}
                    aria-hidden="true"
                  />
                </div>
              ) : row.kind === 'note' ? (
                <div key={row.id} className={s.note} style={depthVar(row.depth)}>
                  <span className={row.note === 'empty' ? s.noteEmpty : s.noteFail}>
                    {t(NOTE_LABELS[row.note])}
                  </span>
                  {row.error && <span className={s.noteDetail}>{row.error}</span>}
                  {row.note !== 'empty' && (
                    <ButtonBase className={s.noteRetry} onClick={() => void retryDir(row.dir)}>
                      {t('files.retry')}
                    </ButtonBase>
                  )}
                </div>
              ) : (
                <TreeEntryRow
                  key={row.path}
                  row={row}
                  t={t}
                  selected={selected === row.path}
                  openState={openStateOfPath(row.path)}
                  onRestore={() => restoreHidden(refId(fileRef(row.path)))}
                  onActivate={(viaKeyboard) => {
                    setSelected(row.path)
                    if (row.type === 'directory') {
                      void toggleDir(row.path)
                      return
                    }
                    // ↵ 才把焦点送进查看器(§11 拍点 1);鼠标那一下焦点留在树上。
                    wantViewer.current = viaKeyboard
                    if (viaKeyboard) setOpenTick((n) => n + 1)
                    /*
                     * **单击 = 预览,↵ = 固定**(§2.1 拍点 ①)。判据现成:
                     * `viaKeyboard` 已经是这一行区分两条路的那一格(它从前只用来
                     * 决定送不送焦点)。浏览一棵树时单击十个文件不该留下十个 tab。
                     */
                    openFile(row.path, { preview: !viaKeyboard })
                  }}
                  onCurrent={onCurrent}
                  onMenu={(origin) => openMenuFor(row, origin)}
                />
              ),
            )}
            {padBottom > 0 && <div style={{ height: padBottom }} aria-hidden="true" />}
          </div>

            {/*
             * 分隔杆。**只在分栏真长出来时才在**:一条调不动任何东西的杆进 Tab 序
             * 是纯噪音(APG:不可调的 separator 不该可聚焦)。
             */}
            {splitOpen && (
              <Splitter
                containerRef={splitRef}
                value={splitRatio}
                min={SPLIT_MIN}
                max={SPLIT_MAX}
                defaultValue={DEFAULT_SPLIT_RATIOS[FILES_SPLIT_ID]}
                label={t('files.splitLabel')}
                controls="files-tree-column"
                liveVar="--files-split"
                testId="files-splitter"
                onCommit={(next) => setSplitRatio(FILES_SPLIT_ID, next)}
              />
            )}
            {/*
              * reveal 走 `revealMutation`(7d)。**这一处不加二次闸**:查看器身上那颗
              * 「在 Finder 里显示」长在 content/viewer/HonestState 里,面板这边只是
              * 一条透传的回调 —— 闸要长在**发起它的那个控件**旁边(律③),
              * 隔着两层组件去猜它此刻的样子是把闸装错了地方。记档:那颗钮的
              * aria-busy 与二次闸属于 viewer/ 那一面,不在本批的可动面里。
              */}
            {splitOpen && openPath && (
              /*
               * 分栏里那一份查看器。**它也有一条檐**(W1-a 修批)——
               * 与中央叶单 tab 时**同一件**(`workbench/LeafStrip` 的 `SoloLeafStrip`:
               * 图标 + 文件名 + 未保存丸 + ✕,右端是这一型自己的工具条)。
               *
               * 修前这一档一条檐都没有:关一个文件只剩右键与 Esc,而「面板内」正是
               * 出厂缺省档 —— 多数用户第一眼看到的就是它。设计 §2.2 的规则是「一片叶
               * 只有一条檐」,而**面板内这一格也是一「格」**,所以它该有同一条,
               * 不是没有。
               *
               * ✕ 交给下面那口 `closeViewer`;「先问一句脏文件」由那条檐按种类问
               * (`ContentKind.beforeClose`),与中央叶逐字相同。**不画「隐藏」
               * 「分屏」** —— 那两件是树的动作,这一档不在树里。
               *
               * 它经 `strip` 交进查看器**盒子里面**,不是包在外面:上面那条相邻兄弟
               * (树 + 查看器)是 `gate:files` 的判据,插一层包裹会当场断掉它。
               */
              <FileViewer
                path={openPath}
                strip={
                  <SoloLeafStrip
                    contentRef={fileRef(openPath)}
                    onClose={closeViewer}
                    testId="viewer-strip"
                  />
                }
                onReveal={(path) => void revealMutation.run(path)}
              />
            )}
          </div>

          {footNote && <p className={s.foot}>{footNote}</p>}

          {/*
           * 底部提示条:一句**用法**(怎么打开一个文件、菜单在哪儿)。
           *
           * 09-01 自查走查改判:它从前「永远在」。分栏开着的时候它还占着 25px,
           * 而那 25px 是从正文里扣的 —— 而且这句话此刻已经没有用了:文件都开着了,
           * 说明用户早就知道怎么开。所以**分栏开着时不画,收起来就回来**。
           * 判据只有一条(splitOpen),不额外记「用户见过没有」那种状态 ——
           * 那会让同一块面在两台机器上长得不一样。
           */}
          {!splitOpen && (
          <p className={s.hint} data-panel-hint="">
            <Info className={s.hintIcon} strokeWidth={1.75} aria-hidden="true" />
            <span className={s.hintText}>{t('files.hint')}</span>
          </p>
          )}

          {/*
           * 行的右键 / ⋯ 菜单 —— **动作单产地**(09-01 裁定):这张表与查看区右键
           * 弹出来的是同一件组件,所以「一个文件能做什么」全仓只有一份定义。
           */}
          {menuRow && menuAt && (
            <FileActionsMenu
              target={{
                path: menuRow.path,
                name: menuRow.name,
                type: menuRow.type,
                expanded: menuRow.expanded,
              }}
              x={menuAt.x}
              y={menuAt.y}
              onClose={dismissMenu}
              /*
               * 从菜单里开详情:**落在菜单那一点上,不再隔一条缝**(9b 留给 9d 的
               * 那格拍板,已裁:承认两种用法)。理由是这张菜单自己已经贴在行矩下方
               * 隔过一条缝了,详情再隔一条就是两条 —— 那格空白说不出任何事实。
               * 查看器那一面的菜单是从光标点开出来的,所以它照旧隔一条(缺省档)。
               */
              onDetail={() => openDetailFor(menuRow, menuAt, { gap: false })}
            />
          )}

          {detail && detailAt && (
            <FileDetailPopover
              detail={detail}
              x={detailAt.x}
              y={detailAt.y}
              onClose={() => {
                closeDetailAt()
                closeDetail()
              }}
            />
          )}

        </div>
      )}
    </FocusScope>
  )
}

/**
 * 底注。**「显示的是主目录」那一句已经搬去告知条了**(定稿:它带着一个可做的
 * 动作,一句躺在底部的灰字承不住)。这里只剩下真·失败那一档。
 */
function footNoteOf(status: RootStatus, error: string | undefined, t: TFn): string | null {
  if (status === 'error') return error ?? t('files.rootFailed')
  return null
}
