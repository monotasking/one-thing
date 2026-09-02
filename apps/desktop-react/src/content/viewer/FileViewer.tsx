import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from '../../components/icons'
import { Dialog } from '../../ui/Dialog'
import { IconButton } from '../../ui/IconButton'
import { Spinner } from '../../ui/Spinner'
import { Tooltip } from '../../ui/Tooltip'
import { Button } from '../../ui/Button'
import { AsyncButton } from '../../ui/AsyncButton'
/*
 * 状态栏那一排是**结构性交互元素**(视觉本该定制:mono、极小、无底、贴着读数站),
 * 所以它们消费的是 `ui/ButtonBase`(只清 UA、一个像素都不画),不是 `ui/Button`
 * ——套一颗 ghost 按钮进 26 高的状态栏,那一行就不再是读数带了。
 */
import { ButtonBase } from '../../ui/ButtonBase'
import { announce } from '../../ui/a11y/live-region'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { baseNameOf, formatBytes, useFilesSource } from '../../data/files-source'
import { glyphOf } from '../../data/file-icons'
import { closeViewerEverywhere } from './open-target'
import {
  isDirty,
  isEditableFile,
  useViewerSource,
  viewerSaveKey,
  viewerSaveMutation,
} from '../../data/viewer-source'
import type { ViewerFile, ViewerView } from '../../data/viewer-source'
import { useAsyncPending } from '../../data/kernel/react'
import { FileGlyphMark } from '../FileGlyph'
import { FileActionsMenu } from '../FileActionsMenu'
import { DETAIL_POPOVER_GAP, FileDetailPopover } from '../FileDetailPopover'
import { commandFor, keymapById, listKeymaps, resolveViewer } from './registry'
import type { ViewerBodyProps } from './registry'
import { JumpBar } from './JumpBar'
// 三张注册表的注册 barrel:import 它们**就是**「这台上认得哪些型 / 哪些跳法 /
// 哪些键位档」。放在这里而不是应用入口 —— 谁要查表,谁负责保证表是装好的
// (与 blocks/BlockView 的同款判例)。
import './kinds'
import { SEARCH_SIGIL } from './navigators'
import './keymaps'
import s from './FileViewer.module.css'

/**
 * **文件查看器 = 壳**(08-31 claude design 定稿)。
 *
 * 它自己只做**公共**的那几件:头(身份与去向)、脚(状态栏)、⌘L 跳转条、
 * 轻编辑与关闭确认、键位派发。「这种文件长什么样」「能跳到哪儿」「哪个键做哪件事」
 * 分别由 `registry.ts` 那三张表回答 —— 所以加一种型 / 一种跳法 / 一个键位档,
 * **这个文件一行都不用改**。
 *
 * ── 它是一块内容,不是文件面板的一部分 ─────────────────────────────────────
 * 状态全在 `data/viewer-source`(文件的事实 + 看的姿势 + 没存的改动),画法全在
 * 这个目录里 —— 它对「自己被摆在哪儿」几乎一无所知:`placement` 只决定外框那
 * 一层几何类名。F1 唯一的落点是文件面板里那条分栏,F2 点亮主区域 / 四边钉 /
 * 浮窗时,**内核零改动**(状态在 store 上,换落点只换外框)。
 *
 * 唯一从宿主收的东西是 `onReveal`:「在文件管理器里定位」不是一份文件内容的
 * 事实,它是宿主那一侧的能力(桌面做得到,联网面结构化降级)。
 *
 * ── 落点生命周期表(09-01「状态先行」立法后补,判例就是本条回炉)────────────
 * **换一种宿主就是一次生命周期事件**,三件事必须逐格回答:
 *
 *   落点        檐(身份+关闭)      型工具条        滚动谁管       尺寸从哪来
 *   ──────────────────────────────────────────────────────────────────────
 *   panel      查看器自己那条       **并进名条**     查看器 .body   grid 列宽 × 面板高
 *   float      **浮窗檐**(合一)    自成一条        查看器 .body   浮窗 rect
 *   stage      **舞台檐**(合一)    自成一条        查看器 .body   舞台 panel 尺寸
 *   cover      **盖檐**(合一)      自成一条        查看器 .body   内容栏尺寸
 *   edge-*     查看器自己那条       **并进名条**     查看器 .body   架子厚度 × 视口
 *
 * 工具条:有名条的落点里它并进名条右端(40 高那一排放得下);合檐的落点里名条
 * 整条不画,宿主那条 header 是通用的、塞不进一个这一型专用的分段器,所以它自成
 * 一条。窄到放不下时回到自己那一行(`@container viewer`,阈值与算式在 tokens)。
 *
 * ── 09-01 自查走查补的一格:**panel 宿主里横带太多** ───────────────────────
 * 走查读数(面板高 478):面包屑 45 + 查看器名条 40 + 型工具条 51 + 正文 **291**
 * + 状态条 26 + 底部提示行 25 —— **五条带围着 291px 正文**(60.9%)。
 * panel 那一格的檐**不合**(面包屑说的是「我在哪个目录」,名条说的是「在看哪个
 * 文件」,是两件事,合了就丢一件),但那五条里有两条是能省的:
 *   · **型工具条收进名条右端**(Rendered|Source 那一排 40 高的檐里放得下);
 *   · **底部提示行只在分栏没开时画**(它是「怎么打开一个文件」的用法提示,
 *     文件都已经开着了,它还在占 25px)。
 * 于是 panel 这一格变成:面包屑 + 名条(含工具条)+ 正文 + 状态条 = **2 条檐 + 状态条**。
 *
 * 檐:浮窗 / 舞台 / 盖三种宿主**自带一条 header**,查看器再画一条就是两条叠着
 * (09-01 真机读数 `chromes: 2`,两条 40px 白占掉 520 高浮窗的 15%,而且文件
 * 内容被挤没了)。架子不合檐 —— 它那条是 **Tabs 条**(多块内容共用),说的是
 * 「这条边上有哪几块面」,塞不进一个文件名。合檐之后文件身份由
 * `stage/live-title` 交给宿主檐说(ViewerPanel 发布,三个宿主共用 HostTitle 读)。
 *
 * 滚动:**永远是查看器 `.body` 自己管**(overflow:auto)。这条不随落点变,
 * 但它有一个前提 —— `.body` 得拿得到**确定高度**。修前 `.viewer` 没有 height,
 * 在宿主那个 block 容器里高度是内容撑的(真机 8409px),于是 `.body` 的
 * clientHeight == scrollHeight,浏览器当然不给滚动条;内容被宿主的
 * `overflow:hidden` 齐边剪掉。修法是 `.viewer { height: 100% }` 一行 ——
 * 四种宿主的内容盒都有确定高度(浮窗/舞台/盖是定高 flex 列里的 flex 项,
 * 架子那层是 `position:absolute; inset:0`),所以百分比解得出来。
 * 面板那一档本来就对:grid 项默认 stretch,所以只有它一开始就能滚。
 *
 * ── 三层 + 一条(§ 定稿的形)───────────────────────────────────────────────
 *   头 40:类型字标 · 名(截断)· 路径(点即复制)· 未保存丸 · 铅笔 · Finder ·
 *          打开方式 · 关闭。**大小与时间不在这里** —— 那是双击详情面的事。
 *   工具条:这一型自己的那一格(markdown 的渲染⇄源码 …),处理器给。
 *   身:处理器的 Body(或编辑态的等宽文本域)。
 *   脚 26:左 Vim 模式标 · 语言/编码/换行符;中 载入进度;右 Vim 开关 · 折行 ·
 *          「行 n:1 ⌘L」。
 *
 * ── UI 状态纪律(四律,逐条落在这里)──────────────────────────────────────
 *  ① **切文件 / 载入中,旧内容留着**:`file` 与 `pending` 是两格(判据在 store),
 *     檐上那格读数说出「正在读取…」,屏幕上没有任何一帧是空的;
 *  ② **骨架只首载**:第一次打开(手上什么都没有)才画那一行「正在读取…」,
 *     之后一律不画(09-02 批 6:那里从前是一颗 Spinner,而禁令区只许它出现在
 *     按钮内或状态栏 —— 状态栏那一颗留着,内容区这一颗退成文字);
 *  ③ **所有异步钮有 pending 态**:存盘那颗禁用并换字,忙态读自写路
 *     `viewerSaveMutation` 的**逐格** pending(`save:<path>`),不是一颗共享布尔;
 *  ④ **跳转滚动不闪**:落点用 `scrollIntoView({block:'center'})`,不重挂 body。
 */
/**
 * **这些落点的宿主自带一条檐** —— 那时查看器整条檐不画,身份交给宿主檐说
 * (见文件头那张落点生命周期表)。判据在这里定一次,不散在 JSX 的条件里:
 * 加一种自带檐的宿主 = 这张表加一格。
 */
const HOST_OWNS_CHROME = new Set(['float', 'stage', 'cover'])

export function FileViewer({
  onReveal,
  placement = 'panel',
}: {
  onReveal?: (path: string) => void
  /**
   * 落点。**只决定外框几何**(F2 的七格:panel / stage / edge-* / float)。
   * F1 只有 panel 一格真接上,其余的骨架在这里,内容与状态一个字都不看它。
   */
  placement?: string
}) {
  const t = useT()
  const file = useViewerSource((st) => st.file)
  const pending = useViewerSource((st) => st.pending)
  const view = useViewerSource((st) => st.view)
  const edit = useViewerSource((st) => st.edit)
  /*
   * 关掉 = 内容清掉 **+ 那块瓦收回 Dock**(F2)。少了第二步,摆在舞台 / 浮窗 /
   * 钉栏上的那一份会剩一个空壳子。编排在 open-target 那一处,不在这里判。
   */
  const close = closeViewerEverywhere
  const loadMore = useViewerSource((st) => st.loadMore)
  const setScrollTop = useViewerSource((st) => st.setScrollTop)
  const setView = useViewerSource((st) => st.setView)
  const setEditing = useViewerSource((st) => st.setEditing)
  const setDraft = useViewerSource((st) => st.setDraft)
  const save = useViewerSource((st) => st.save)
  /*
   * 存盘的忙态**读自写路**(09-02 批 6),不是 store 上一颗共享布尔:
   * `viewerSaveMutation` 按 `save:<path>` 逐格记账(律③),所以两个落点各开一个
   * 文件时,一颗钮忙不会把另一颗按住。`file` 缺席时不给 key —— hook 不能有条件
   * 地调,所以给的是 undefined 而不是在这里分一条支。
   */
  const saveKey = file ? viewerSaveKey(file.path) : undefined
  const saving = useAsyncPending(viewerSaveMutation, saveKey)

  const rootRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /**
   * 跳转条:**null = 没开**,字符串 = 开着而且这是它开条时那串字。
   * 一个格而不是「布尔 + 初值」两个格 —— 两个格必然出现「开着但初值是上一次的」
   * 那种半状态(⌘L 之后再 ⌘F,条里会留着上次的前缀)。
   */
  const [jumpQuery, setJumpQuery] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  /**
   * 身上右键弹出来的动作菜单开在哪个点(null = 没开)。
   * **表本身不在这里** —— 它是 `content/FileActionsMenu`,与树行那张是同一件
   * (09-01 裁定:动作单产地)。这里只决定「在哪儿弹」。
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  /** 详情浮层贴在哪儿。与菜单同一条口径:内容是共用件,锚点是宿主自己的事。 */
  const [detailAt, setDetailAt] = useState<{ x: number; y: number } | null>(null)
  const detail = useFilesSource((st) => st.detail)
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)

  /** 这一档落点的宿主自带檐吗 —— 自带就合一(查看器整条檐不画)。 */
  const chromeless = HOST_OWNS_CHROME.has(placement)
  const path = file?.path ?? pending ?? ''
  const name = file?.name ?? (pending ? baseNameOf(pending) : '')
  const glyph = useMemo(() => glyphOf(name || '?', 'file'), [name])
  const dirty = isDirty(file, edit)

  const handler = file ? resolveViewer(file) : undefined
  const bodyProps: ViewerBodyProps | undefined = file
    ? {
        file,
        view,
        onView: setView,
        onReveal: onReveal ? () => onReveal(file.path) : undefined,
      }
    : undefined
  const lineCount =
    handler?.lineCount && bodyProps ? handler.lineCount(bodyProps) : undefined
  /**
   * 这一型自己那一格(markdown 的渲染⇄源码 …)。**只造一次**,两个落点各自决定
   * 把它挂在哪儿:有名条就并进名条右端,合檐时自成一条。编辑态不画 ——
   * 那时屏幕上是一块可写文本,没有「渲染 ⇄ 源码」这回事。
   */
  const toolbar =
    handler?.Toolbar && bodyProps && !edit.editing ? <handler.Toolbar {...bodyProps} /> : null

  /* ── ④ 跳转滚动不闪:落点之后把那一行滚到视野中间 ───────────────────── */
  useEffect(() => {
    if (!view.currentLine) return
    const el = bodyRef.current?.querySelector(`[data-line="${view.currentLine}"]`)
    // 不重挂 body、不改高度 —— 只是滚过去。行跳渲(content-visibility)下同样成立:
    // 浏览器会为滚动目标先把那一行排出来。
    el?.scrollIntoView({ block: 'center' })
  }, [view.currentLine, file?.path])

  /*
   * ── 换落点不丢滚动位(F2 兑现 F1 那条留账)────────────────────────────
   * 换一档打开方式 = 换宿主 = 这棵组件树真的重挂。挂上来的第一帧就把 store 里
   * 那个数贴回去,用户看到的是「同一份内容还停在原地」,而不是弹回顶上。
   *
   * `useLayoutEffect` 而不是 `useEffect`:后者在**画完之后**才跑,屏幕上会先闪
   * 一帧顶部。高亮是懒加载的,所以极长的文件在首帧可能还没排到那么高 ——
   * 那时贴不满是事实(浏览器把 scrollTop 钳到当下的可滚范围),
   * 记在这里:要做到逐像素还原得等一台影子布局,不值当。
   */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // 读 `getState()` 而不是订阅:订阅了就等于每一帧滚动都重渲这块面。
    el.scrollTop = useViewerSource.getState().scrollTop
  }, [placement, file?.path])

  /* ── 关闭:有未保存的改动就先问 ─────────────────────────────────────── */
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    close()
  }, [dirty, close])

  /* ── ③ 存盘:异步钮的 pending 态 ────────────────────────────────────── */
  const runSave = useCallback(async () => {
    const outcome = await save()
    announce(t(outcome.ok ? 'viewer.saved' : 'viewer.saveFailed'))
    return outcome
  }, [save, t])

  /**
   * 键位派发。档由 store 说了算,映射由注册表说了算 —— 这里只负责执行。
   *
   * 它挂在**根元素上、用 addEventListener**,不是 JSX 的 `onKeyDown`:一个
   * `<section>` 不是控件,给它挂键盘监听会被 jsx-a11y 抓(那条规则拦得对 ——
   * 它防的是「把 div 当按钮使」)。这里要的是**捕获这块面里发生的按键**,
   * 语义上是容器级快捷键,不是这个元素自己的交互,所以走 DOM 这一路。
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (event: KeyboardEvent) => {
      const command = commandFor(keymapById(view.keymap), event)
      if (!command) return
      // 只有真的接住了才 preventDefault:**消费掉的键才有资格挡住别人**。
      switch (command) {
        case 'save':
          if (!edit.editing) return
          event.preventDefault()
          void runSave()
          return
        case 'jump':
          if (lineCount === undefined) return
          event.preventDefault()
          setJumpQuery('')
          return
        case 'find':
          // ⌘F = 同一条跳转条,前缀先打上。这一型不按行寻址(图 / 播放条 /
          // 诚实态)时**不接**这一下 —— 让它原样冒上去,别处也许还用得着。
          if (lineCount === undefined) return
          event.preventDefault()
          setJumpQuery(SEARCH_SIGIL)
          return
        case 'toggleWrap':
          event.preventDefault()
          setView({ wrap: !view.wrap })
          return
        case 'toggleEdit':
          if (!handler?.editable) return
          event.preventDefault()
          setEditing(!edit.editing)
          return
        case 'close':
          event.preventDefault()
          requestClose()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [
    view.keymap,
    view.wrap,
    edit.editing,
    lineCount,
    handler?.editable,
    runSave,
    setView,
    setEditing,
    requestClose,
  ])

  return (
    <section
      ref={rootRef}
      className={`${s.viewer} ${s[`frame-${placement}`] ?? ''}`}
      data-testid="file-viewer"
      /*
       * **面域局部键的落点**(09-01 三层立法,表在 keymap/scopes.ts)。
       * ⌘S / ⌘L / ⌘F 只在焦点落在这块面里时才响 —— 监听挂在这个根上,
       * 于是它天然先于 window 上那个全局派发器收到按键;接住了就 preventDefault,
       * 全局那边开头一句 `if (e.defaultPrevented) return` 让开。
       *
       * `tabIndex={-1}` 是那条路的前提:一个 `<section>` 默认不可落焦,点在
       * 代码上焦点会留在 body,按键根本到不了这个根。-1 = **只接程序焦点**,
       * 不进 Tab 序(它不是控件,不该在 Tab 上占一站)。
       */
      data-key-scope="viewer"
      tabIndex={-1}
      onPointerDown={(e) => {
        // 点在里面的真控件上时不抢焦点(那颗钮自己会拿);点在正文上才把焦点
        // 收到面域根上 —— 那正是「我在看这块面」的意思。
        if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
        rootRef.current?.focus({ preventScroll: true })
      }}
      data-placement={placement}
      data-viewer-kind={handler?.id}
      aria-label={t('viewer.label')}
    >
      {/*
       * 这一条是 `<div>` 而不是 `<header>`:`<header>` 在无障碍树里会变成一枚
       * **banner 地标**,而一块面板内部的檐不是「整份文档的页眉」—— 真机 axe
       * 当场报 landmark-no-duplicate-banner(外壳自己已经有一枚)。同理下面那条脚
       * 不是 `<footer>`(那会变成 contentinfo)。语义靠 aria-label 与角色说,
       * 不靠一个会顺手宣布地标的标签名。
       */}
      {/*
       * ── 檐上只剩身份(09-01 用户裁定)────────────────────────────────
       * 修前这条 40 高的檐上挤着七件:类型徽 · 名 · 路径复制钮 · 未保存丸 ·
       * 读取中 · 铅笔 · Finder · 打开方式下拉 · 关闭。真机上文件名被挤成
       * `kimi-sli…`,而其中四件在树行右键菜单里**又有一份**。
       *
       * 裁定:**头只放身份与关闭,动作全归右键菜单**(CLAUDE.md 禁令区)。
       * 于是这里只剩三件 —— 类型徽 + 名(截断,Tooltip 说全名)+ 未保存丸,
       * 加行尾一颗关闭。「正在读取…」搬去脚上那条状态栏(脚是读数的地方)。
       *
       * 撤掉的四件各自的新家:
       *   复制路径 / 在 Finder 显示 / 编辑 / 打开方式 → 身上右键那张
       *   `FileActionsMenu`(与树行同一张表,同一份定义)。
       */}
      {/*
       * 宿主自带檐时**整条不画**(09-01 合檐):不是把里面几件藏掉 —— 那样还剩
       * 一条 40px 的空带子,而这正是报障里「空间利用度很低」的那 40px。
       */}
      {!chromeless && (
      <div className={s.chrome} data-viewer-chrome="">
        {/*
         * ── 没有文件就**不画身份**(09-01 gate:a11y 的 `_chromeGlyph` 2.68 红)──
         * F2 之前查看器只可能在「有文件」的情况下出现,所以这两格无条件画。
         * F2 把它变成一块普通的瓦之后,「一个文件都没打开」成了真会到达的一帧,
         * 而那时 `glyphOf(name || '?', 'file')` 会造一枚**不存在的文件**的徽
         * (认不出 → `···` 那一格)。它有两重错:
         *  ① 它在说谎 —— 屏幕上并没有一个叫 `?` 的文件;
         *  ② 那一格的底/字是 --fb-unknown 那对灰,对比度 2.68 < 4.5(axe 当场红)。
         * 修法是**别画**:没有身份的时候檐上就只剩关闭。对比度那一格另修
         * (tokens 里 --fb-unknown-fg / --fb-bin-fg 压深到 AA),两件事各修各的。
         */}
        {path && <FileGlyphMark glyph={glyph} className={s.chromeGlyph} />}
        {/*
         * 名字截断,Tooltip 说全名(禁令区:标题截断须配 Tooltip 全名)。
         * 提示里给的是**整条路径**而不只是文件名 —— 两个同名文件在两个目录里
         * 是这一格最常见的歧义,而路径钮已经不在檐上了。
         */}
        {path && (
          <Tooltip content={path}>
            <span className={s.name} data-testid="viewer-name" data-viewer-path={path}>
              {name}
            </span>
          </Tooltip>
        )}
        {dirty && (
          <span className={s.dirty} data-testid="viewer-dirty">
            <span className={s.dirtyDot} aria-hidden="true" />
            {t('viewer.unsaved')}
          </span>
        )}
        {/*
         * 型工具条**长在名条右端**(09-01 自查走查:panel 宿主一屏五条横带)。
         * 它从前自成一条 51 高的带子,而 40 高的名条右边空着一大片 —— 一排放得下,
         * 就不该占两排(原则:正文优先)。它排在动作组之前:身份在左、这一型自己的
         * 那一格居中偏右、关闭永远在最右。
         */}
        {toolbar && <span className={s.chromeTool}>{toolbar}</span>}
        <span className={s.actions}>
          <IconButton
            icon={X}
            label={t('viewer.close')}
            testId="viewer-close"
            onClick={requestClose}
          />
        </span>
      </div>
      )}

      {/*
       * 合檐的落点里名条整条不画,那时工具条**自己成一条**(宿主那条 header 是
       * 通用的,塞不进一个这一型专用的分段器)。没有工具条就整条不画,
       * 不留一条空带子。
       */}
      {chromeless && toolbar && (
        <div className={s.toolbar} data-testid="viewer-toolbar">
          {toolbar}
        </div>
      )}

      <div
        className={s.body}
        ref={bodyRef}
        data-testid="viewer-body"
        /* 抄进 store 好让换落点之后贴得回去。没有组件订阅 `scrollTop`,
         * 所以这一口每帧调都不引起重渲(理由写在 viewer-source 文件头 ④)。 */
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        /*
         * 身上右键 = 这个文件的动作菜单(09-01 裁定:动作单产地)。
         * 与树行右键弹的是**同一件组件**,所以两处的项与次序不可能分叉。
         *
         * **落在编辑框里的那一下不接**:那时右键该是文本域自己的那一套
         * (粘贴 / 撤销 / 拼写)。判据是「点在哪儿」而不是「在不在编辑态」——
         * 后者会把编辑态下点在别处的右键也一起吞掉,而那时用户找不到出口。
         */
        onContextMenu={(e) => {
          if (!file) return
          if ((e.target as HTMLElement).closest('textarea')) return
          e.preventDefault()
          setMenuAt({ x: e.clientX, y: e.clientY })
        }}
      >
        {jumpQuery !== null && lineCount !== undefined && file && (
          <JumpBar
            file={file}
            lineCount={lineCount}
            initialQuery={jumpQuery}
            onClose={() => setJumpQuery(null)}
            /* 落点只做一件事:改当前行。**关不关条由那一档说了算**(检索要连着走,
             * 行号跳完就收)—— 判据在 navigator.cycle 上,不在这里。 */
            onJump={(line) => setView({ currentLine: line })}
          />
        )}
        {file && bodyProps && handler ? (
          edit.editing ? (
            <EditArea
              key={file.path}
              file={file}
              draft={edit.draft ?? ''}
              onDraft={setDraft}
              t={t}
            />
          ) : (
            /*
             * **按 path 作 key**:换文件时本体整个换掉(滚动位、缩放、图的失败态
             * 都不该从上一个文件继承),而头、脚、宿主、乃至左边那棵树一动不动。
             */
            <handler.Body key={file.path} {...bodyProps} />
          )
        ) : pending ? (
          /*
           * ② 骨架**只首载**:走到这里必然是「手上什么都没有、而且正在读」的
           * 第一帧。之后再切文件,上面那一支永远成立(旧内容还在),不会再来。
           */
          /*
           * **这里不转圈**(09-02 批 6 兑现禁令):Spinner 只许出现在按钮内或
           * 状态栏,内容区的加载态用文字或骨架。从前这一格是「转圈 + 同一句话」
           * ——转圈说的话与它旁边那行字逐字相同,删掉一个字都没少。
           * 那一颗在状态栏里的仍然留着(它在允许的两处之一,见下面 StatusBar)。
           */
          <p className={s.note} data-testid="viewer-first-load">
            <span className={s.noteDetail}>{t('viewer.reading')}</span>
          </p>
        ) : (
          /*
           * **空态**(F2 才有得着):查看器成了一块普通的瓦,于是它可以在
           * 「一个文件都没打开」的情况下被点开(Dock 上点那块瓦)。这一格说的是
           * 实话 —— 不转圈(没有东西在读),也不假装是个错误。
           */
          <p className={s.note} data-testid="viewer-empty">
            <span className={s.noteDetail}>{t('viewer.noFile')}</span>
          </p>
        )}
      </div>

      <StatusBar
        t={t}
        file={file}
        view={view}
        lineCount={lineCount}
        status={handler?.status && bodyProps ? handler.status(bodyProps) : undefined}
        statusItems={handler?.statusItems && bodyProps ? handler.statusItems(bodyProps) : []}
        saving={saving}
        saveKey={saveKey}
        savedAt={edit.savedAt}
        saveError={edit.error}
        conflict={edit.conflict}
        editing={edit.editing}
        reading={pending !== null}
        onSave={() => void runSave()}
        onEditDone={() => setEditing(false)}
        onJump={() => setJumpQuery('')}
        onFind={() => setJumpQuery(SEARCH_SIGIL)}
        onKeymap={(id) => setView({ keymap: id })}
        onLoadMore={() => void loadMore()}
      />

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title={t('viewer.confirmTitle')}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>{t('common.cancel')}</Button>
            <Button
              className={s.dangerBtn}
              onClick={() => {
                setConfirmClose(false)
                close()
              }}
            >
              {t('viewer.discard')}
            </Button>
            {/*
              * 这一颗**本来就是 `ui/Button`**,所以它换成 `ui/AsyncButton` 是零像素的:
              * 忙态改由写路逐格给(`pendingKey`),还顺带白拿了那件的 150ms 防闪闸
              * ——比 150ms 更快回来的那一发不该报告自己在忙(E 型闪的判例)。
              * disabled 仍然立刻生效:它挡的是连点,而连点就发生在头 150ms 里。
              */}
            <AsyncButton
              variant="primary"
              action={viewerSaveMutation}
              pendingKey={saveKey}
              pendingLabel={t('common.saving')}
              onClick={() => {
                void runSave().then((outcome) => {
                  if (!outcome.ok) return
                  setConfirmClose(false)
                  close()
                })
              }}
            >
              {t('viewer.saveAndClose')}
            </AsyncButton>
          </>
        }
      >
        <p className={s.confirmText}>{t('viewer.confirmBody', { name })}</p>
      </Dialog>

      {/*
       * 身上右键那张动作菜单 —— 与树行**同一件**(动作单产地)。
       * 目录那一支在这里不可能出现:查看器手上永远是一个文件。
       */}
      {menuAt && file && (
        <FileActionsMenu
          target={{ path: file.path, name: file.name, type: 'file' }}
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          onDetail={() => {
            setDetailAt({ x: menuAt.x, y: menuAt.y + DETAIL_POPOVER_GAP })
            void openDetail({ path: file.path, name: file.name, type: 'file' })
          }}
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
    </section>
  )
}

/* ── 编辑区 ────────────────────────────────────────────────────────────── */

/**
 * 轻编辑(定稿确认案)。**等宽、无高亮、无补全的一块可写文本** —— 它诚实地
 * 定位成「改配置、改几行」,不是一台编辑器。高亮编辑将来若真需要再议,
 * 那时才轮到「要不要一台真编辑器」这个问题。
 *
 * 行号在编辑态**不画**:一块 textarea 里的行号要么跟着内容重排(要一台影子渲染
 * 层),要么就是错的 —— 画一列错的数字比不画糟得多。
 */
function EditArea({
  file,
  draft,
  onDraft,
  t,
}: {
  file: ViewerFile
  draft: string
  onDraft: (text: string) => void
  t: TFn
}) {
  return (
    <textarea
      className={s.editor}
      data-testid="viewer-editor"
      value={draft}
      spellCheck={false}
      aria-label={t('viewer.editing', { name: file.name })}
      onChange={(e) => onDraft(e.target.value)}
    />
  )
}

/* ── 脚:26 的状态栏 ───────────────────────────────────────────────────── */

function StatusBar({
  t,
  file,
  view,
  lineCount,
  status,
  statusItems,
  saving,
  saveKey,
  savedAt,
  saveError,
  conflict,
  editing,
  reading,
  onSave,
  onEditDone,
  onJump,
  onFind,
  onKeymap,
  onLoadMore,
}: {
  t: TFn
  file: ViewerFile | null
  view: ViewerView
  lineCount: number | undefined
  status: string | undefined
  statusItems: { id: string; labelKey: Parameters<TFn>[0]; on?: boolean; onToggle(): void }[]
  /**
   * 存盘这一格在不在飞。**它是 `viewerSaveMutation` 逐格算出来的读数**
   * (`useAsyncPending(…, saveKey)`),不是 store 上一颗共享布尔 ——
   * 门规则 `async-busy-boolean` 只扫 `.ts`,组件收一个布尔 prop 是合规的下游写法。
   */
  saving: boolean
  /** 那一格的键(`save:<path>`)。没开文件时缺席。 */
  saveKey: string | undefined
  savedAt: number | undefined
  saveError: string | undefined
  conflict: boolean
  editing: boolean
  /** 手上有没有在飞的读。**从檐上搬下来的**(09-01 裁定:头只放身份,脚放读数)。 */
  reading: boolean
  onSave: () => void
  onEditDone: () => void
  onJump: () => void
  onFind: () => void
  onKeymap: (id: string) => void
  onLoadMore: () => void
}) {
  const vim = view.keymap === 'vim'
  const keymaps = listKeymaps()
  const truncated = file && 'truncated' in file && file.truncated ? file : null
  const percent = truncated ? Math.min(99, Math.round((truncated.loaded / truncated.size) * 100)) : 0

  return (
    <div className={s.status} data-testid="viewer-status">
      {vim && (
        <span
          className={`${s.vimMode} ${view.vimMode === 'insert' ? s.vimInsert : s.vimNormal}`}
          data-testid="viewer-vim-mode"
        >
          {view.vimMode === 'insert' ? 'INSERT' : 'NORMAL'}
        </span>
      )}
      {status && <span className={s.statusFact}>{status}</span>}

      {/* 中段:载入进度 / 存盘读数。它是这一行里唯一的弯腰件。 */}
      <span className={s.statusMid}>
        {/*
         * 「正在读取…」从檐上搬到了这里(裁定:头只放身份与关闭)。它排在最前 ——
         * 「还在读」压过「载入了百分之几」,后者说的是上一份已经到手的内容。
         * Spinner 出现在状态栏是允许的两处之一(禁令区:钮内或状态栏)。
         */}
        {reading ? (
          <span className={s.statusNote} data-testid="viewer-inflight">
            {/* ui-consume-allow: spinner-placement — 这里是查看器**底部状态栏**那条带子
                (.statusMid 是它的中段),不是内容区、不是卡:允许位的第二个。
                批 6 已经把这一面**其余四处**判掉了(首载内容区 / 详情浮层 /
                工具行 / 研究段),留下的就是这一颗。 */}
            <Spinner label={t('viewer.reading')} />
            {t('viewer.reading')}
          </span>
        ) : truncated ? (
          <>
            <span className={s.statusNote}>
              {t('viewer.loadedPercent', { percent: `${percent}`, size: formatBytes(truncated.size) })}
            </span>
            <ButtonBase className={s.statusLink} onClick={onLoadMore}>
              {t('viewer.loadMore')}
            </ButtonBase>
          </>
        ) : conflict ? (
          <span className={s.statusWarn}>{t('viewer.conflict')}</span>
        ) : saveError ? (
          <span className={s.statusWarn}>{saveError}</span>
        ) : savedAt ? (
          <span className={s.statusNote} data-testid="viewer-saved">
            {t('viewer.saved')}
          </span>
        ) : null}
      </span>

      {editing && (
        /*
         * ③ 异步钮的 pending 态:存盘在飞时禁用并换字,不给第二次机会。
         *
         * **这一颗不换 `ui/AsyncButton`**(09-02 批 6 的一处如实偏离):那件的身子
         * 是 `ui/Button`(28 高、描边、字重 600),而这一排是 26 高状态栏里的
         * mono 动作链接 —— 换过去这一行就不再是读数带了,那不是等价替换。
         * 律③要的两件(禁用 + 换字)这里一件不少;**忙态的产地**已经按批 6 的
         * 本意换成了写路逐格(`saving` 由 `useAsyncPending(mutation, saveKey)` 算),
         * 这正是这次迁移真正要治的那一格。`saveKey` 在这里不消费,但它跟着
         * 传下来一格 —— 读数是按哪一格算的,状态栏说得出口。
         */
        <ButtonBase
          className={s.statusLink}
          disabled={saving}
          aria-busy={saving || undefined}
          data-save-key={saveKey}
          data-testid="viewer-save"
          onClick={onSave}
        >
          {t(saving ? 'common.saving' : 'viewer.save')}
        </ButtonBase>
      )}
      {editing && (
        /*
         * 「完成编辑」。铅笔退役之后,**编辑框自己那一屏上得有一个出口** ——
         * 右键在编辑框里让给了文本域(粘贴 / 撤销),菜单那条路要先把指针挪出
         * 编辑区才走得通,那不该是唯一的出口。它与旁边那颗「保存」同族:
         * 状态栏上本来就有动作链接,这里不是新开一类。
         */
        <ButtonBase className={s.statusLink} data-testid="viewer-edit-done" onClick={onEditDone}>
          {t('viewer.editDone')}
        </ButtonBase>
      )}

      {/* Vim 开关。档只是一张表,换档即时生效且不重挂查看器。 */}
      {keymaps.length > 1 && (
        <ButtonBase
          className={vim ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={vim}
          data-testid="viewer-vim-toggle"
          onClick={() => onKeymap(vim ? 'default' : 'vim')}
        >
          {t('viewer.keymapVim')}
        </ButtonBase>
      )}

      {statusItems.map((item) => (
        <ButtonBase
          key={item.id}
          className={item.on ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={item.on}
          onClick={item.onToggle}
        >
          {t(item.labelKey)}
        </ButtonBase>
      ))}

      {/*
       * 检索(⌘F)。它是**键盘那条路的鼠标口** —— 组件消费义务的同款道理:
       * 一件只有快捷键能做到的事,对不知道那个键的人等于不存在。
       * 与「行 n:1 ⌘L」同一族(两者开的是同一条跳转条,只差一个前缀)。
       */}
      {lineCount !== undefined && (
        <ButtonBase className={s.statusLink} data-testid="viewer-find" onClick={onFind}>
          {t('viewer.findReadout')}
        </ButtonBase>
      )}
      {lineCount !== undefined && (
        <ButtonBase className={s.statusLink} data-testid="viewer-jump" onClick={onJump}>
          {t('viewer.lineReadout', { line: `${view.currentLine || 1}` })}
        </ButtonBase>
      )}
    </div>
  )
}

export { isEditableFile }
