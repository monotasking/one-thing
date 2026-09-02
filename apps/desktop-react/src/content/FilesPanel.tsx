import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Ellipsis,
  Info,
  RotateCcw,
  TriangleAlert,
} from '../components/icons'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { IconButton } from '../ui/IconButton'
import { Splitter } from '../ui/Splitter'
import { Input } from '../ui/Input'
import { useT } from '../i18n'
import type { MessageKey, TFn } from '../i18n'
import { useExposeStore } from '../expose/store'
import { useSessionsSource } from '../data/sessions-source'
import {
  breadcrumbsOf,
  flattenTree,
  revealMutation,
  rowWindow,
  useDirStates,
  useFileDetail,
  useFilesSource,
  useSessionCwd,
} from '../data/files-source'
import type { Crumb, FileFailure, RootStatus, TreeRow } from '../data/files-source'
import { useAsyncPending } from '../data/kernel'
import { sessionMutation, workdirKey } from '../data/sessions-source'
import { useFileOpenMode } from '../data/file-open-mode'
import {
  DEFAULT_SPLIT_RATIOS,
  FILES_SPLIT_ID,
  SPLIT_MAX,
  SPLIT_MIN,
  useSplitPrefs,
  useSplitRatio,
} from '../data/split-prefs'
import { glyphOf, isHiddenName } from '../data/file-icons'
import { useViewerSource } from '../data/viewer-source'
import { FileGlyphMark } from './FileGlyph'
import { FileActionsMenu } from './FileActionsMenu'
import { DETAIL_POPOVER_GAP, FileDetailPopover } from './FileDetailPopover'
import { FileViewer } from './viewer/FileViewer'
import { closeViewerEverywhere, openFileInCurrentTarget } from './viewer/open-target'
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
 * ── 分栏:树是**常驻**的,不是被替换的(F1 §0 铁律 3)────────────────────────
 * 从前那层「预览」是 `position:absolute; inset:0` —— 它**盖住**整棵树:回来时
 * 滚动位置还在,但那一屏里你什么都干不了(点不到第二个文件,只能先关掉)。
 * F1 换成两列:单击一个文件 = 右列长出来,再单击别的文件 = **就地换内容**,
 * 树的展开态 / 滚动位 / 选中行一动不动。Esc 收起右列回全树。
 *
 * 结构上兑现这条铁律的只有一件事:那棵树的 DOM 位置**恒定** —— 它永远是
 * `.split` 的第一个孩子,查看区在它旁边出现或消失。所以「开一个文件 / 换一个
 * 文件 / 关掉查看器」三下都不会让 React 重挂树上任何一行(有三条断言钉着)。
 *
 * 「打开方式」那七档里,**「面板内」指的就是这条分栏**。F2 把另外六档也接上了
 * (查看器成了一块普通的瓦),所以这条分栏现在只在 `panel` 档长出来 ——
 * 一份内容只该有一个落点,两处同时画就是重影。档→落点的翻译只有一份,
 * 在 data/file-open-mode.ts 的 placementOfFileOpenMode。
 *
 * 定稿相对上一版(989dd3b6)的六处改判,每一处各自的理由:
 *
 * ① **类型标识拆成二形**。语言画**品牌色字标**(TS / PY / LUA / SH / MD /『{ }』),
 *    说不出语言的画 lucide 图标 —— 判据与两张表都在 `data/file-icons.ts`,
 *    这里只把交出来的名字兑成组件与变量。理由:lucide 没有语言 logo,一屏里
 *    全是同一张「带尖括号的纸」,扫的时候读不出是哪一门。
 *
 * ② **「打开」与「选中」分离**。选中 = 底色(此刻手指头点在哪一行),打开 = 行尾
 *    一颗 accent 圆点(这个文件的内容正开着)。它们是两件事:你可以选中 A 而开着 B。
 *
 * ③ **行尾 ⋯ / 右键出菜单**。09-01 起它升格为**动作单产地**:一个文件的全部动作
 *    (打开 / 打开方式七档 / 编辑 / 详情 / 复制路径 / 在 Finder 显示)都在这一张表里,
 *    而且与查看区右键弹的是**同一件组件**(content/FileActionsMenu)。
 *    七档打开方式 F2 全接上了,「还没接上」那句注脚随之退役。
 *
 * ④ **详情从 Dialog 改成附属浮层**(ui/Popover)。理由是语义:详情是「瞄一眼」,
 *    不是「答一道题」——Dialog 压一层遮罩,把树整个盖住,而回来时滚动位置已经变了。
 *    浮层不遮树、点别处即散、Esc 关;焦点照 Menu 的手圈禁,但**不谎称 modal**。
 *    它 09-01 搬去了 content/FileDetailPopover —— 查看区右键也要弹它,一件东西
 *    两个宿主各画一遍必然分叉。入口是 ⌘I 与菜单里那一行(**双击那条路已删**)。
 *
 * ⑤ **窗口化渲染**。只画可视窗 + 上下各 8 行,前后各垫一块空撑子 —— 卷轴长度与
 *    「全画出来」逐像素相同。行高恒定 27 是它的前提,所以骨架 / 空 / 失败三种注行
 *    与条目行**同高**(那不是审美对齐,那是算式的前提)。算术在 `rowWindow`,纯函数。
 *
 * ⑥ **三种「还没有内容」各说各的**:懒展开画两条骨架短横(不是「正在读取…」四个字
 *    ——那四个字在一屏树里读起来像一行文件名)、空目录画一行斜体、读失败画一句
 *    danger 小字 + 一颗「重试」(只重拉出错那一层,不是整棵树重来)。
 *
 * ── 键盘:⌘I 是一条**面域局部键**(09-01 三层立法,F1 那条留账结清)────────────
 * ⌘I / ⌘↵ 唤详情,它们长在行自己的 keydown 上 —— 因为「看这一项的详情」需要一个
 * **目标**,焦点不在某一行上时它无事可做,所以它不属于全局命令那一族。
 *
 * F1 时它**不在任何表里**,留账写着「用户把某条命令改绑到 ⌘I 会静默把它盖住」。
 * 09-01 立了第二层:声明进 `keymap/scopes.ts` 的 SCOPED_KEYS(一处查得全、撞车
 * 说得出口),裁决靠一条机制 —— 行上接住了就 `preventDefault()`,全局派发器开头
 * 一句 `if (e.defaultPrevented) return` 让开。两处会不会分叉由
 * `keymap/__tests__/keymap-scopes.test.ts` 钉着。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 面包屑最多平铺几段;再多就把**中段**折成一个 `…`(首段与末两段永远在)。 */
const CRUMB_MAX = 4

/** 注行的两档失败 + 一档非失败,各一句人话。 */
const NOTE_LABELS: Record<'empty' | FileFailure, MessageKey> = {
  empty: 'files.dirEmpty',
  denied: 'files.dirDenied',
  missing: 'files.dirMissing',
  failed: 'files.dirFailed',
}

/** 一处浮层的落点(视口坐标)。菜单与详情浮层共用这一个形状。 */
interface Anchor {
  x: number
  y: number
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
  const viewerFile = useViewerSource((st) => st.file)
  const viewerPending = useViewerSource((st) => st.pending)
  /*
   * 「打开一个文件」的编排在 content/viewer/open-target 那一处(读它 + 按当下
   * 这一档摆好落点),三个入口共用 —— 面板这里只是调用方,不判落点。
   */
  const openFile = openFileInCurrentTarget
  const closeViewer = closeViewerEverywhere
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
  const openPath = viewerPending ?? viewerFile?.path ?? null
  const viewerOpen = openPath !== null
  /** 这条分栏此刻长不长出来。**落点是 `panel` 才算**(理由见上面 openMode)。 */
  const splitOpen = viewerOpen && openMode === 'panel'

  /**
   * 选中 = **视图状态**,所以它住在这里而不是 store 里:换一块面它就该归零,
   * 而 store 里那份「树展开到哪儿」是要活过面板开合的(树不卸载铁律)。
   */
  const [selected, setSelected] = useState<string | null>(null)
  /** 行菜单:开在哪一行、开在哪个点。 */
  const [menu, setMenu] = useState<{ row: EntryRow; at: Anchor } | null>(null)
  /** 详情浮层贴在哪儿(它跟着开它的那一行走,不是屏幕中央)。 */
  const [detailAt, setDetailAt] = useState<Anchor | null>(null)
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
   * Esc = 收起查看区回全树。
   *
   * 它挂在**面板根元素上、用 addEventListener** 而不是 JSX 的 onKeyDown:一个
   * `<div>` 不是控件,给它挂键盘监听会被 jsx-a11y 抓(那条规则防的是「把 div
   * 当按钮使」)。这里要的是「这块面里发生的一下 Esc」——容器级手势,不是这个
   * 元素自己的交互。
   *
   * 两条护栏:① 行菜单 / 详情浮层开着时**不接** —— 它们各自的 Esc 是关自己;
   * ② 查看器没开就不接,让这一下原样往上冒(外壳还有它自己的 Esc 分层)。
   * 真的收了才 stopPropagation:**消费掉的键才有资格挡住别人**。
   */
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (menu || detail) return
      // 查看器不在这条分栏里(摆去了舞台 / 浮窗 / 钉栏)时**不接**:那一下 Esc
      // 属于摆着它的那一层,不属于这块面。
      if (!splitOpen) return
      event.stopPropagation()
      closeViewer()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [menu, detail, splitOpen, closeViewer])

  // 根跟着活跃会话走。判据不在这里 —— useSessionCwd 是它唯一的产地,
  // 这里只负责把结果交给数据源(setRoot 自己幂等)。
  useEffect(() => {
    void setRoot(cwd)
  }, [cwd, setRoot])

  const rows = useMemo(() => flattenTree(root, dirs, expanded), [root, dirs, expanded])

  /* ── 窗口化:量视口 + 跟卷轴 ─────────────────────────────────────────── */
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const win = rowWindow(rows.length, scrollTop, viewportH)
  const shown = rows.slice(win.start, win.end)

  const openMenuFor = useCallback((row: EntryRow, at: Anchor) => {
    setSelected(row.path)
    setMenu({ row, at })
  }, [])

  const openDetailFor = useCallback(
    (row: { path: string; name: string; type: 'file' | 'directory' }, at: Anchor) => {
      setSelected(row.path)
      setDetailAt(at)
      void openDetail({ path: row.path, name: row.name, type: row.type })
    },
    [openDetail],
  )

  const footNote = footNoteOf(rootStatus, rootError, t)
  const noWorkdir = rootStatus === 'ready' && rootOrigin === 'home'

  return (
    <div className={s.panel} data-testid="files-panel" ref={panelRef}>
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
        <Button
          iconOnly
          aria-label={t('files.collapseAll')}
          disabled={Object.keys(expanded).length === 0}
          onClick={collapseAll}
        >
          <ChevronsUp className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <Button
          iconOnly
          aria-label={t('files.refresh')}
          disabled={rootStatus !== 'ready'}
          onClick={() => {
            setSpins((n) => n + 1)
            void refresh()
          }}
        >
          {/*
           * 「重新读取」按下去转一圈。**是一次过渡,不是一段循环动画**:它说的是
           * 「你刚才那一下到了」,不是「我在忙」(忙由树上那两条骨架说)。所以角度
           * 单调递增(每按一次 +360),靠 .headIcon 上那条 transform 过渡走完 ——
           * 一个 @keyframes 都不用加(全仓关键帧只在 styles/motion.css 里长)。
           */}
          <RotateCcw
            className={s.headIcon}
            style={{ transform: `rotate(${spins * -360}deg)` }}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </Button>
      </div>

      {noWorkdir && <NoWorkdirNotice sessionId={sessionId} t={t} />}

      {/*
       * 身 = 两列。树**永远是第一个孩子**,查看区在它旁边出现或消失 ——
       * 这一条就是「树常驻」铁律在 DOM 上的全部实现:树的位置不随查看器的开合
       * 变动,于是 React 没有任何理由重挂它(零重挂的三条断言钉的正是这件事)。
       * 列宽由 CSS 按 data-viewer 翻(0fr ⇄ 1fr),不在 JS 里算像素。
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
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop)
          /*
           * 顺手把视口高度也读一遍。ResizeObserver 是**主要**产地,这里是补丁:
           * 面板刚从收起态展开、或宿主换了形态的那一帧,观察者还没来得及回调,
           * 而用户已经在卷了 —— 那一帧按旧高度算窗口会短一截。
           * 代价是一次 clientHeight 读(我们本来就在读 scrollTop,同一次布局),
           * 而且值没变时 setState 会被 React 直接短路,不引起重渲染。
           */
          setViewportH(e.currentTarget.clientHeight)
        }}
      >
        {/* 窗口前后的两块空撑子:它们不是内容,只是让卷轴与「全画出来」一样长。 */}
        {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
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
              opened={openPath === row.path}
              onActivate={() => {
                setSelected(row.path)
                if (row.type === 'directory') void toggleDir(row.path)
                else openFile(row.path)
              }}
              onDetail={(at) => openDetailFor(row, at)}
              onMenu={(at) => openMenuFor(row, at)}
            />
          ),
        )}
        {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
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
        {splitOpen && <FileViewer onReveal={(path) => void revealMutation.run(path)} />}
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
      {menu && (
        <FileActionsMenu
          target={{
            path: menu.row.path,
            name: menu.row.name,
            type: menu.row.type,
            expanded: menu.row.expanded,
          }}
          x={menu.at.x}
          y={menu.at.y}
          onClose={() => setMenu(null)}
          onDetail={() => openDetailFor(menu.row, menu.at)}
        />
      )}

      {detail && detailAt && (
        <FileDetailPopover
          detail={detail}
          x={detailAt.x}
          y={detailAt.y}
          onClose={() => {
            setDetailAt(null)
            closeDetail()
          }}
        />
      )}

    </div>
  )
}

type EntryRow = Extract<TreeRow, { kind: 'entry' }>

/** 缩进不写字面 px:深度以无单位数进 CSS 变量,一格多宽由样式表说了算。 */
function depthVar(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

/**
 * 底注。**「显示的是主目录」那一句已经搬去告知条了**(定稿:它带着一个可做的
 * 动作,一句躺在底部的灰字承不住)。这里只剩下真·失败那一档。
 */
function footNoteOf(status: RootStatus, error: string | undefined, t: TFn): string | null {
  if (status === 'error') return error ?? t('files.rootFailed')
  return null
}

/**
 * 无工作目录告知条。**一条带子,不是一块面**:它说一句事实,并给出唯一那个
 * 能改变这件事实的动作。
 *
 * 「绑定…」为什么是**一行输入**而不是一个系统目录选择器:这层壳里没有 dialog 桥
 * (`shell:invoke` 的 `dialog` 域住在 Electron 宿主里,而这块面在 web 面上也要能用)。
 * 与其画一颗点了什么都不发生的「浏览…」,不如老老实实收一条绝对路径 ——
 * 后端 `updateWorkingDirectory` 本来收的也正是一条路径。记档:有了 dialog 桥之后
 * 这里应当补一颗「浏览…」,而不是把这条输入行删掉(键盘用户仍然要它)。
 */
function NoWorkdirNotice({ sessionId, t }: { sessionId: string; t: TFn }) {
  const setWorkingDirectory = useSessionsSource((st) => st.setWorkingDirectory)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  /*
   * ── 忙态**读**自 mutation,不再自己记一格(7d 结掉批 6 留的那笔账)────────
   * 它护的不是一个文件操作,而是 `sessions-source` 的 `setWorkingDirectory`
   * ——「把这条会话挪到这个目录」那一口后端写。7e 已经把那一口迁进了
   * `sessionMutation`(键 `workdir:<sessionId>`),所以这里的 `useState(busy)`
   * 从「唯一产地」降格成了「第二份真相」,当场退役:忙态由那一格 pending 说,
   * 逐会话记账(律③要的**逐格**,不是整面一颗)。
   *
   * `useState` 管 async pending 是 kernel 手册明令禁止的一条(「自己记一份必然
   * 与真相漂开」),而 `ui-consume` 的 `async-busy-boolean` 刻意只扫 `.ts` ——
   * 组件里这一格是它的**盲区**,所以这一处由本批人工结掉并在报告里点名。
   *
   * 律③的另一半(忙起来钮上换字)本批**不补**:换文案是可感知的改版,
   * 而这一颗今天只上无障碍语义 —— `aria-busy` + 那道二次闸,零新像素。
   */
  const busy = useAsyncPending(sessionMutation, workdirKey(sessionId))

  const submit = async () => {
    const dir = value.trim()
    if (!dir || busy) return
    const outcome = await setWorkingDirectory(sessionId, dir)
    if (outcome.ok) {
      setEditing(false)
      setValue('')
      setError(null)
      return
    }
    // 失败**留在原地说**:输入行不收,用户刚打的那条路径还在,改一个字就能重试。
    setError(outcome.error)
  }

  if (!editing) {
    return (
      <div className={s.notice} data-testid="files-no-workdir">
        <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.noticeText}>{t('files.rootFallback')}</span>
        {/* 没有当前会话就没有可绑的对象 —— 那时只说事实,不画一颗按不响的钮。 */}
        {sessionId && (
          <ButtonBase className={s.noticeAction} onClick={() => setEditing(true)}>
            {t('files.bind')}
          </ButtonBase>
        )}
      </div>
    )
  }

  return (
    <div className={s.bindRow} data-testid="files-bind-row" ref={focusFieldOnMount}>
      <Input
        size="sm"
        className={s.bindInput}
        value={value}
        onValueChange={setValue}
        invalid={Boolean(error)}
        aria-label={t('files.bindPlaceholder')}
        placeholder={t('files.bindPlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
      <Button
        variant="primary"
        disabled={!value.trim() || busy}
        aria-busy={busy || undefined}
        onClick={() => void submit()}
      >
        {t('common.confirm')}
      </Button>
      <Button onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
      {error && (
        <span className={s.bindError}>
          {t('files.bindFailed')}
          <span className={s.noteDetail}>{error}</span>
        </span>
      )}
    </div>
  )
}

/**
 * 输入行一出现就把光标放进去。
 *
 * **不用 `autoFocus`**:那个属性是「页面一加载就抢焦点」,jsx-a11y 拦它拦得对 ——
 * 但这里的语义完全不同:用户刚**亲手点了**「绑定…」,焦点跟着那一下走是他要的结果
 * (与 Menu 开启时把焦点移进容器同一条口径)。所以走一颗回调 ref:元素挂上来的
 * 那一刻放焦点,元素卸载时(ref 收到 null)什么都不做。
 */
function focusFieldOnMount(node: HTMLDivElement | null): void {
  node?.querySelector('input')?.focus()
}

/**
 * 头上那一排路径。**这是投影**(breadcrumbsOf 是纯函数,判据不在这里)。
 * 三档各说各的,**不拿一个假路径去顶**还没定下来的根。
 *
 * 段数超过 CRUMB_MAX 时把**中段**折成一个 `…`:首段(通常是 `/Users`)与末两段
 * (「我在哪儿」与「从哪儿来的」)是这条路径上唯一还在被读的三格,中间那几层
 * 在窄面板里只会把整条头挤成一条横向滚轨。折的是**显示**不是事实 ——
 * 那条完整路径仍然原样挂在 `data-root` 上。
 */
function RootCrumbs({
  root,
  status,
  t,
  onJump,
}: {
  root: string | null
  status: RootStatus
  t: TFn
  onJump: (path: string) => void
}) {
  if (status === 'loading' || status === 'idle') {
    return <span className={s.crumbNote}>{t('files.rootLoading')}</span>
  }
  if (status === 'error' || !root) {
    return <span className={s.crumbNote}>{t('files.rootFailed')}</span>
  }
  const crumbs = breadcrumbsOf(root)
  // 根就是 `/`:一段可点的都没有,屏幕上只剩那条领头的斜杠。这是事实不是缺陷。
  if (crumbs.length === 0) return <span className={s.crumbSep}>/</span>
  const shown: (Crumb | 'ellipsis')[] =
    crumbs.length > CRUMB_MAX
      ? [crumbs[0], 'ellipsis', ...crumbs.slice(-2)]
      : crumbs
  return (
    <>
      {shown.map((crumb, index) => {
        if (crumb === 'ellipsis') {
          return (
            <Fragment key="ellipsis">
              <span className={s.crumbSep}>/</span>
              {/* 折起来的那几段。它不可点 —— 点它没有一个确定的去处。 */}
              <span className={s.crumbFold} aria-hidden="true">
                …
              </span>
            </Fragment>
          )
        }
        const last = index === shown.length - 1
        return (
          <Fragment key={crumb.path}>
            {/* 分隔斜杠是**真的文本**(不是 CSS ::before):读屏与门看到的是同一句话。 */}
            <span className={s.crumbSep}>/</span>
            {last ? (
              <span className={s.crumbCurrent} aria-current="location">
                {crumb.name}
              </span>
            ) : (
              <ButtonBase className={s.crumb} onClick={() => onJump(crumb.path)}>
                {crumb.name}
              </ButtonBase>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

/*
 * 类型标识那两形的画法搬去了 `content/FileGlyph.tsx`(F1)。搬家的理由只有一条:
 * 查看器檐上那枚类型徽是它的第二个消费方,而两处各画一遍必然分叉。
 * 判据(哪个文件画哪一枚)一个字没动,仍在 data/file-icons.ts。
 */

/**
 * 一行 = 一颗按钮(箭头 / 标识 / 名字)+ 两件挂在行尾的东西。
 *
 * 为什么行尾那两件是按钮的**兄弟**而不是它的孩子:`<button>` 里不许再套
 * `<button>`(HTML 明令,而且读屏软件会把内层那颗念丢)。所以外面裹一层 div
 * 管悬停底色与右键,`data-file-*` 那一族仍然挂在**按钮本身**上 —— 门与单测
 * `querySelector('[data-file-path=…]').click()` 走的还是同一条路,一个字不用改。
 *
 * ── 09-01 裁定:**没有双击**,动作全在右键菜单里 ────────────────────────
 * 报障原话是「file 的双击,间隔多久了,还能出现?」。查下去发现两件事:
 *  · 这台壳对「隔多久还算双击」**一个判据都没有** —— 挂的是 `onDoubleClick`,
 *    而 Blink 自己不计时,它只看平台递进来的 `clickCount` 是不是 2;那个数在
 *    macOS 上由 AppKit 按**系统偏好里的「双击速度」**算,滑杆调慢就没有上限;
 *  · 更要命的是**触控板双指点按到达时就是双击形态**,与右键语义正面打架 ——
 *    用户想开右键菜单,得到的是详情浮层。
 * 用户的裁定不是「把窗口收紧」,是**整条删掉**:打开 = 单击 / ↵,动作 = 右键菜单,
 * 详情不再设双击入口(它的两个入口是 ⌘I 与右键菜单里的那一行)。
 * CLAUDE.md 禁令区「禁双击作为动作触发」就是这条判例。
 *
 * 于是这一行上只剩两种手势:**单击 = 打开 / 展开**,**右键(或行尾 ⋯)= 动作菜单**。
 */
function TreeEntryRow({
  row,
  t,
  selected,
  opened,
  onActivate,
  onDetail,
  onMenu,
}: {
  row: EntryRow
  t: TFn
  selected: boolean
  opened: boolean
  onActivate: () => void
  onDetail: (at: Anchor) => void
  onMenu: (at: Anchor) => void
}) {
  const Caret = row.expanded ? ChevronDown : ChevronRight
  const glyph = glyphOf(row.name, row.type, row.expanded)
  const hidden = isHiddenName(row.name)
  const wrapRef = useRef<HTMLDivElement>(null)

  /** 浮层贴着这一行的左下角长出来(不是屏幕中央 —— 它是这一行的附属)。 */
  const anchorOfRow = (): Anchor => {
    const rect = wrapRef.current?.getBoundingClientRect()
    return { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + DETAIL_POPOVER_GAP }
  }

  const cls = [s.rowWrap, selected && s.rowSel, hidden && s.rowHidden].filter(Boolean).join(' ')

  return (
    <div
      ref={wrapRef}
      className={cls}
      style={depthVar(row.depth)}
      onContextMenu={(e: ReactMouseEvent) => {
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/*
       * 一行是**结构件**(视觉本该定制:缩进、标识槽、名字),所以它消费
       * `ui/ButtonBase`(只清 UA)而不是 `ui/Button` —— 套一颗 ghost 钮上来,
       * 27 高的紧凑树当场变成一列按钮。
       */}
      <ButtonBase
        className={s.row}
        aria-expanded={row.type === 'directory' ? row.expanded : undefined}
        /* 门用的稳定选择器(与 EdgeShelf 的 data-shelf / data-panel 同一条判例):
         * 文案会跟着语言变,路径不会。标识也留两格 —— 「这一行画的是哪一枚」
         * 是可断言的事实,而 SVG 里的 path 数据不是。 */
        data-file-path={row.path}
        data-file-type={row.type}
        data-file-depth={row.depth}
        data-file-form={glyph.kind}
        data-file-icon={glyph.kind === 'icon' ? glyph.icon : undefined}
        data-file-tone={glyph.kind === 'icon' ? glyph.tone : undefined}
        data-file-brand={glyph.kind === 'brand' ? glyph.brand : undefined}
        data-file-hidden={hidden ? 'true' : undefined}
        data-file-open={opened ? 'true' : undefined}
        data-file-selected={selected ? 'true' : undefined}
        onClick={onActivate}
        onKeyDown={(e) => {
          // ⌘I / Ctrl+I = 详情(裁定与留账写在文件头)。⌘↵ 是它从上一版继承下来
          // 的第二个键面,留着不动:删一个已经好使的键位是可感知的能力损失。
          if ((e.key === 'i' || e.key === 'I' || e.key === 'Enter') && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onDetail(anchorOfRow())
          }
        }}
      >
        {row.type === 'directory' ? (
          <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          // 文件没有箭头,但**位子留着** —— 不留,同一层的文件名就会比目录名靠左一截。
          <span className={s.caret} aria-hidden="true" />
        )}
        <FileGlyphMark glyph={glyph} className={s.glyph} />
        <span className={s.rowName}>{row.name}</span>
      </ButtonBase>
      {/* 「这个文件正开着」。它与选中态是两件事,所以是两处画法(圆点 vs 底色)。 */}
      {opened && <span className={s.openDot} data-testid="files-open-dot" aria-hidden="true" />}
      {/*
       * 行尾的 ⋯。**消费 ui/IconButton**(09-01 立法:图标钮必须用库件)——
       * 从前它是一颗自绘的 `.more`,hover 配方与别处各写各的,正是那条法的判例。
       * `tip` 关掉:菜单本身就叫「更多操作」,悬停再弹一句同样的话是噪音,
       * 而且它盖在紧挨着的下一行上。
       */}
      <IconButton
        icon={Ellipsis}
        size="xs"
        label={t('files.rowMenu')}
        tip={false}
        className={s.more}
        /* 稳定取件口。从前是 `data-file-more={path}`(自绘钮上的一个自定义属性);
         * 换库件之后走库件那一格 `testId`,值仍然带着路径 —— 门与单测要的是
         * 「按这一行取它的 ⋯」,那一格叫什么名字不是它们关心的事。 */
        testId={`files-more:${row.path}`}
        onClick={() => {
          const rect = wrapRef.current?.getBoundingClientRect()
          onMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + DETAIL_POPOVER_GAP })
        }}
      />
    </div>
  )
}


/*
 * ── 「预览层」整块退役了(查看器 F1)────────────────────────────────────────
 * 它从前是一层 `position:absolute; inset:0` 的覆盖物,四态各画各的,正文走一个
 * 代码块。取代它的是 `content/viewer/` 那块内容 + 面板里那条分栏:
 *   · 盖住 → 并排(树常驻,再点一个文件就地换内容);
 *   · 一种画法(代码块)→ 四形(code / markdown / image / 诚实态);
 *   · 四态 → 六格(五形 + 读失败),仍然是「一种都不回退到别的那一种」。
 * 那四句预览文案也随之从字典里删掉了 —— 查看器有自己的一套(viewer.*)。
 */
