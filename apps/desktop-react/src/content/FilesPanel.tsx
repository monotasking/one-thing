import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Copy,
  Check,
  Ellipsis,
  Eye,
  Info,
  RotateCcw,
  TriangleAlert,
  resolveIcon,
} from '../components/icons'
import { COPY_FEEDBACK_MS } from '../components/motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuItem, MenuSeparator, MenuSection } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { Spinner } from '../ui/Spinner'
import { announce } from '../ui/a11y/live-region'
import { formatCombo, platformOf } from '../keymap/transitions'
import { useT, resolveLang } from '../i18n'
import type { Lang, MessageKey, TFn } from '../i18n'
import { useStageStore } from '../stage/store'
import { useExposeStore } from '../expose/store'
import { useSessionsSource } from '../data/sessions-source'
import {
  breadcrumbsOf,
  flattenTree,
  formatBytes,
  formatMtime,
  rowWindow,
  useFilesSource,
  useSessionCwd,
} from '../data/files-source'
import type { Crumb, FileDetailState, FileFailure, RootStatus, TreeRow } from '../data/files-source'
import {
  FILE_OPEN_MODES,
  FILE_OPEN_MODE_LABELS,
  isWiredFileOpenMode,
  useFileOpenMode,
} from '../data/file-open-mode'
import { glyphOf, isHiddenName } from '../data/file-icons'
import { useViewerSource } from '../data/viewer-source'
import { copyText } from '../services/clipboard'
import { FileGlyphMark } from './FileGlyph'
import { FileViewer } from './viewer/FileViewer'
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
 * 「打开方式」那七档里,**「面板内」指的就是这条分栏** —— 它是 F1 唯一接上的
 * 一档(判据仍在 data/file-open-mode.ts 的 WIRED_FILE_OPEN_MODES,这里不重复)。
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
 * ③ **行尾 ⋯ / 右键出菜单**。菜单里那一组「打开方式」今天只有「面板内」真生效,
 *    其余六档**记住选择 + 一句注脚**(诚实降级,判据在 data/file-open-mode.ts)。
 *
 * ④ **详情从 Dialog 改成附属浮层**(ui/Popover)。理由是语义:详情是「瞄一眼」,
 *    不是「答一道题」——Dialog 压一层遮罩,把树整个盖住,而回来时滚动位置已经变了。
 *    浮层不遮树、点别处即散、Esc 关;焦点照 Menu 的手圈禁,但**不谎称 modal**。
 *    双击那条路一个字没改(它仍然开详情),菜单里的「详情 ⌘I」是它的第二个入口。
 *
 * ⑤ **窗口化渲染**。只画可视窗 + 上下各 8 行,前后各垫一块空撑子 —— 卷轴长度与
 *    「全画出来」逐像素相同。行高恒定 27 是它的前提,所以骨架 / 空 / 失败三种注行
 *    与条目行**同高**(那不是审美对齐,那是算式的前提)。算术在 `rowWindow`,纯函数。
 *
 * ⑥ **三种「还没有内容」各说各的**:懒展开画两条骨架短横(不是「正在读取…」四个字
 *    ——那四个字在一屏树里读起来像一行文件名)、空目录画一行斜体、读失败画一句
 *    danger 小字 + 一颗「重试」(只重拉出错那一层,不是整棵树重来)。
 *
 * ── 键盘:⌘I 的裁定(记档)──────────────────────────────────────────────────
 * 定稿要 ⌘I 唤详情。查了 `keymap/transitions.ts` 的出厂表:**没有任何命令占着
 * `i`**(⌘P/⌘E/⌘J/⌘N/⌘⇧O/⌘1-3 是全部),所以不存在冲突,无需按次序裁决。
 *
 * 但它**没有进 KEYMAP_COMMANDS**,这是有意的:那张表里的每一条都是**全局命令**
 * (开一块面 / 建一条会话),而「看这一项的详情」需要一个**目标** —— 焦点不在某一行
 * 上时它无事可做。这与 `keymap/types.ts` 顶上那条「结构导航键不经过派发器」是同一
 * 条纪律,所以 ⌘I 长在行自己的 keydown 上。副作用是好的:`lookupCommand` 认不出
 * ⌘I → 全局派发器不 preventDefault → 这一下原样落到行上。
 * 留账:哪天用户把某条命令改绑到 ⌘I,`bindCombo` 看不见这条行内键,会静默把它盖住
 * (焦点在行上时两者都想响)。要根治得让行内键也进注册表,那是另一批的事。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 「在文件管理器里定位」的钮(详情浮层底部动作组)。 */
const RevealIcon = resolveIcon('FolderOpen')

/** 面包屑最多平铺几段;再多就把**中段**折成一个 `…`(首段与末两段永远在)。 */
const CRUMB_MAX = 4

/** 详情浮层离锚点行的那一点空隙。 */
const POPOVER_GAP = 4

/** 注行的两档失败 + 一档非失败,各一句人话。 */
const NOTE_LABELS: Record<'empty' | FileFailure, MessageKey> = {
  empty: 'files.dirEmpty',
  denied: 'files.dirDenied',
  missing: 'files.dirMissing',
  failed: 'files.dirFailed',
}

/**
 * 详情面的三档失败**自己一套话**,不借预览那一套:预览说的是「这个文件」,
 * 而详情可能问的是一个目录 —— 借过来会当场说错话。
 */
const DETAIL_FAILURE_LABELS: Record<FileFailure, MessageKey> = {
  denied: 'files.detailDenied',
  missing: 'files.detailMissing',
  failed: 'files.detailFailed',
}

/**
 * 缺席格画的那道破折号。**它是符号不是文案**(与 formatBytes 的单位符号同一条
 * 口径):换一门语言它不该变,所以不进字典。它说的是「这台没给这一格」,
 * 不是 0 B,也不是 1970-01-01。
 */
const ABSENT = '—'

/** 一处浮层的落点(视口坐标)。菜单与详情浮层共用这一个形状。 */
interface Anchor {
  x: number
  y: number
}

export function FilesPanel() {
  const t = useT()
  const lang = resolveLang(useStageStore((st) => st.locale))
  const cwd = useSessionCwd()
  const sessionId = useExposeStore((st) => st.currentSessionId)
  const root = useFilesSource((st) => st.root)
  const rootStatus = useFilesSource((st) => st.rootStatus)
  const rootOrigin = useFilesSource((st) => st.rootOrigin)
  const rootError = useFilesSource((st) => st.rootError)
  const dirs = useFilesSource((st) => st.dirs)
  const expanded = useFilesSource((st) => st.expanded)
  const detail = useFilesSource((st) => st.detail)
  const setRoot = useFilesSource((st) => st.setRoot)
  const navigateRoot = useFilesSource((st) => st.navigateRoot)
  const toggleDir = useFilesSource((st) => st.toggleDir)
  const collapseAll = useFilesSource((st) => st.collapseAll)
  const retryDir = useFilesSource((st) => st.retryDir)
  const refresh = useFilesSource((st) => st.refresh)
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)
  const reveal = useFilesSource((st) => st.reveal)

  /*
   * 查看器住**另一个 store**(data/viewer-source)。面板从它这里只取两件事:
   * 「此刻开着的是哪个文件」(树上那颗打开点要知道)与那两口开 / 关。
   * 文件内容一个字节都不经过这里 —— 那正是两个 store 分家的意思。
   */
  const viewerFile = useViewerSource((st) => st.file)
  const viewerPending = useViewerSource((st) => st.pending)
  const openFile = useViewerSource((st) => st.openFile)
  const closeViewer = useViewerSource((st) => st.close)
  /*
   * 「这个文件正开着」的判据:**正在读的那条压过已经画出来的那条**。
   * 点下去的一瞬间打开点就跟着走(手感),而内容要等读回来 —— 两者不同步是
   * 事实,不是缺陷:檐上那格读数正是为了说出这件事。
   */
  const openPath = viewerPending ?? viewerFile?.path ?? null
  const viewerOpen = openPath !== null

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
      if (!viewerOpen) return
      event.stopPropagation()
      closeViewer()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [menu, detail, viewerOpen, closeViewer])

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
      <div className={s.head}>
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
      <div className={s.split} data-viewer={viewerOpen ? 'open' : 'closed'}>
      <div
        className={s.body}
        ref={bodyRef}
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
                <button
                  type="button"
                  className={s.noteRetry}
                  onClick={() => void retryDir(row.dir)}
                >
                  {t('files.retry')}
                </button>
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
                else void openFile(row.path)
              }}
              onDetail={(at) => openDetailFor(row, at)}
              onMenu={(at) => openMenuFor(row, at)}
            />
          ),
        )}
        {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
      </div>

        {viewerOpen && <FileViewer onReveal={(path) => void reveal(path)} />}
      </div>

      {footNote && <p className={s.foot}>{footNote}</p>}

      {/* 底部提示条:一句用法,不是一条状态 —— 所以它永远在,而且不抢眼。 */}
      <p className={s.hint}>
        <Info className={s.hintIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.hintText}>{t('files.hint')}</span>
      </p>

      {menu && (
        <RowMenu
          row={menu.row}
          at={menu.at}
          t={t}
          onClose={() => setMenu(null)}
          onActivate={() => {
            if (menu.row.type === 'directory') void toggleDir(menu.row.path)
            else void openFile(menu.row.path)
          }}
          onDetail={() => openDetailFor(menu.row, menu.at)}
          onReveal={() => void reveal(menu.row.path)}
        />
      )}

      {detail && detailAt && (
        <FileDetailPopover
          detail={detail}
          at={detailAt}
          lang={lang}
          t={t}
          onClose={() => {
            setDetailAt(null)
            closeDetail()
          }}
          onReveal={() => void reveal(detail.path)}
          onOpen={() => {
            setDetailAt(null)
            closeDetail()
            void openFile(detail.path)
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
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const dir = value.trim()
    if (!dir || busy) return
    setBusy(true)
    const outcome = await setWorkingDirectory(sessionId, dir)
    setBusy(false)
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
          <button type="button" className={s.noticeAction} onClick={() => setEditing(true)}>
            {t('files.bind')}
          </button>
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
      <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void submit()}>
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
              <button type="button" className={s.crumb} onClick={() => onJump(crumb.path)}>
                {crumb.name}
              </button>
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
 * 单击 / 双击共存的那一处细节:`e.detail` 是原生的点击计数,双击时第二下的
 * `detail === 2`,直接返回 —— 于是「双击一个目录」只翻一次展开,而不是翻两次。
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
    return { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + POPOVER_GAP }
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
      <button
        type="button"
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
        onClick={(e) => {
          if (e.detail > 1) return
          onActivate()
        }}
        onDoubleClick={() => onDetail(anchorOfRow())}
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
      </button>
      {/* 「这个文件正开着」。它与选中态是两件事,所以是两处画法(圆点 vs 底色)。 */}
      {opened && <span className={s.openDot} data-testid="files-open-dot" aria-hidden="true" />}
      <button
        type="button"
        className={s.more}
        aria-label={t('files.rowMenu')}
        data-file-more={row.path}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          onMenu({ x: rect.left, y: rect.bottom + POPOVER_GAP })
        }}
      >
        <Ellipsis className={s.moreIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * 行菜单(行尾 ⋯ 与右键出的是**同一个**菜单 —— 两个手势,一张表)。
 *
 * 「打开方式」那一组是本批唯一一处诚实降级:七档全在、勾在当下那一档、选了就记住,
 * 而底下一句注脚明说只有「面板内」已经接上。判据(哪些接上了)在
 * `data/file-open-mode.ts` 的 WIRED_FILE_OPEN_MODES,不散在这里的条件里。
 *
 * 「复制路径」按下之后**菜单不关**:反馈要落在被按的那一条上,关掉就没地方落了。
 */
function RowMenu({
  row,
  at,
  t,
  onClose,
  onActivate,
  onDetail,
  onReveal,
}: {
  row: EntryRow
  at: Anchor
  t: TFn
  onClose: () => void
  onActivate: () => void
  onDetail: () => void
  onReveal: () => void
}) {
  const mode = useFileOpenMode((st) => st.mode)
  const setMode = useFileOpenMode((st) => st.setMode)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const platform = platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const detailKeys = formatCombo({ meta: true, key: 'i' }, platform)

  const copyPath = () => {
    void copyToClipboard(row.path, t).then((ok) => {
      setCopied(ok)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }

  const openLabel =
    row.type === 'directory'
      ? t(row.expanded ? 'files.menuCollapse' : 'files.menuExpand')
      : t('files.menuOpen')

  return (
    <Menu
      x={at.x}
      y={at.y}
      onClose={onClose}
      label={t('files.rowMenu')}
      minWidth="var(--files-menu-w)"
    >
      <MenuSection>{row.name}</MenuSection>
      <MenuItem
        onClick={() => {
          onActivate()
          onClose()
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{openLabel}</span>
          {/* 右缘那一格说的是**当下的打开方式**(文件才有意义 —— 目录没有查看器)。 */}
          {row.type === 'file' && (
            <span className={s.menuTrail}>{t(FILE_OPEN_MODE_LABELS[mode])}</span>
          )}
        </span>
      </MenuItem>

      <MenuSeparator />
      <MenuSection>{t('files.openWith')}</MenuSection>
      {FILE_OPEN_MODES.map((option) => (
        <MenuItem key={option} checked={option === mode} onClick={() => setMode(option)}>
          <span className={s.menuLine}>
            <span className={s.menuMain}>{t(FILE_OPEN_MODE_LABELS[option])}</span>
            {!isWiredFileOpenMode(option) && (
              <span className={s.menuTrail}>{t('files.openModeSoon')}</span>
            )}
          </span>
        </MenuItem>
      ))}
      {/* 注脚:一句实话,不是一项。用 div 而不是 MenuSection —— 它要能折行。 */}
      <div className={s.menuNote} role="presentation">
        {t('files.openModeNote')}
      </div>

      <MenuSeparator />
      <MenuItem
        onClick={() => {
          onClose()
          onDetail()
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{t('files.detailAction')}</span>
          <span className={s.menuKeys}>
            {detailKeys.map((cap) => (
              <Kbd key={cap}>{cap}</Kbd>
            ))}
          </span>
        </span>
      </MenuItem>
      <MenuItem onClick={copyPath}>
        <span className={s.menuLine}>
          <span className={copied ? `${s.menuMain} ${s.menuDone}` : s.menuMain}>
            {t(copied ? 'files.copiedPath' : 'files.copyPath')}
          </span>
        </span>
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose()
          onReveal()
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{t('files.reveal')}</span>
        </span>
      </MenuItem>
    </Menu>
  )
}

/**
 * 复制一条路径。写剪贴板 + 报给读屏 —— 两处调用方(行菜单、详情浮层)共用这一口,
 * 免得「复制成功了没有」在两处各判一次。**不产生通知**(08-31 拍板:复制走就地反馈)。
 */
async function copyToClipboard(text: string, t: TFn): Promise<boolean> {
  // 写那一下归 services/clipboard(查看器檐上那颗复制钮走的是同一口);
  // 说给读屏听那一句归这里 —— 「怎么反馈」是各处现场自己的事。
  const ok = await copyText(text)
  announce(t(ok ? 'common.copied' : 'common.copyFailed'))
  return ok
}

/**
 * 详情 —— **附属浮层**(定稿改判,上一版是 ui/Dialog)。
 *
 * 三条它比 Dialog 强的地方,正是当初选 Dialog 的三条理由的反面:
 * ① 树不被遮:回来时滚动位置、展开形状、选中行一个都没变;
 * ② 它不吃面板的宽度(浮层挂在 body 上),所以「完整路径」那一行照样站得下 ——
 *    这一条 Dialog 也做得到,不是改判的理由,记在这里免得被当成理由;
 * ③ 它不打断:`role="dialog"` 但没有 `aria-modal`,读屏软件仍然看得见那棵树。
 * 换来的代价是**没有遮罩**,所以「点别处即散」这件事必须真的成立 —— 那是
 * ui/Popover 的事(pointerdown 落在浮层外就关),不是这里的。
 *
 * 「复制」这颗钮长在**路径那一行上**而不是底部动作组里:反馈要落在被复制的
 * 那件东西旁边(⧉ 换 ✓ 一拍,COPY_FEEDBACK_MS 后还原)。
 */
function FileDetailPopover({
  detail,
  at,
  lang,
  t,
  onClose,
  onReveal,
  onOpen,
}: {
  detail: FileDetailState
  at: Anchor
  lang: Lang
  t: TFn
  onClose: () => void
  onReveal: () => void
  /** 详情面上那颗「打开查看」—— 它是查看器的第三个入口(另两个:单击、行菜单)。 */
  onOpen: () => void
}) {
  const glyph = glyphOf(detail.name, detail.type)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyPath = () => {
    void copyToClipboard(detail.path, t).then((ok) => {
      setCopied(ok)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }

  const ready = detail.status === 'ready'
  const sizeText = ready && detail.size !== undefined ? formatBytes(detail.size) : ABSENT
  const mtimeText = (ready && formatMtime(detail.mtimeMs, lang)) || ABSENT

  return (
    /*
     * `testId` 落在**浮层根**上(08-31 真机走查的出入):从前它挂在里面那层 div,
     * 于是 `[data-testid="files-detail"]` 取到的那个元素 `role` 是空的 ——
     * role="dialog" 一直在,只是在它的父节点(Popover 的根)上。门的文件头写着
     * 「它仍然是 role=dialog + data-testid=files-detail」,那句话在这个错位下是假的。
     * 把取件口挪到根上,两件事从此在同一个元素上,门可以真的按 role 验。
     * `data-file-path` 留在里面那层(它是这块**内容**的事实,不是浮层的属性),
     * 门改按后代取:`[data-testid="files-detail"] [data-file-path]`。
     */
    <Popover x={at.x} y={at.y} onClose={onClose} label={detail.name} testId="files-detail">
      <div className={s.detail} data-file-path={detail.path}>
        <div className={s.detailHead}>
          <FileGlyphMark glyph={glyph} className={s.detailGlyph} size="lg" />
          <span className={s.detailName}>{detail.name}</span>
        </div>

        <div className={s.detailPathRow}>
          <span className={s.detailPath}>{detail.path}</span>
          <button
            type="button"
            className={copied ? `${s.detailCopy} ${s.detailCopyDone}` : s.detailCopy}
            onClick={copyPath}
          >
            {copied ? (
              <Check className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            )}
            {t(copied ? 'common.copied' : 'files.copyPath')}
          </button>
        </div>

        {detail.status === 'loading' && (
          <p className={s.detailNote}>
            <Spinner label={t('files.detailLoading')} />
            <span className={s.noteDetail}>{t('files.detailLoading')}</span>
          </p>
        )}
        {detail.status === 'error' && (
          <p className={s.detailNote}>
            <span className={s.noteFail}>{t(DETAIL_FAILURE_LABELS[detail.failure ?? 'failed'])}</span>
            {detail.error && <span className={s.noteDetail}>{detail.error}</span>}
          </p>
        )}

        <dl className={s.detailList}>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailTypeLabel')}</dt>
            <dd className={s.detailValue}>
              {t(detail.type === 'directory' ? 'files.typeDirectory' : 'files.typeFile')}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailSizeLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-size">
              {sizeText}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailModifiedLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-mtime">
              {mtimeText}
            </dd>
          </div>
        </dl>

        <div className={s.detailFoot}>
          <Button onClick={onReveal}>
            <RevealIcon className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            {t('files.reveal')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {detail.type === 'file' && (
            <Button variant="primary" onClick={onOpen}>
              <Eye className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
              {t('files.menuOpen')}
            </Button>
          )}
        </div>
      </div>
    </Popover>
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
