import { useCallback, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { baseNameOf, useFileDetail, useFilesSource } from '../../data/files-source'
import { announce } from '../../ui/a11y/live-region'
import { closeViewerEverywhere } from './open-target'
import { isDirty, isEditableFile, useViewerSource, viewerSaveKey, viewerSaveMutation } from '../../data/viewer-source'
import { useAsyncPending } from '../../data/kernel/react'
import { FileActionsMenu } from '../FileActionsMenu'
import { FileDetailPopover } from '../FileDetailPopover'
import { useFileFloats } from '../file-floats'
import { resolveViewer } from './registry'
import type { ViewerBodyProps } from './registry'
import { JumpBar } from './JumpBar'
import { ViewerChrome, hostOwnsChrome } from './ViewerChrome'
import { ViewerCloseConfirm } from './ViewerCloseConfirm'
import { ViewerEditArea } from './ViewerEditArea'
import { ViewerStatusBar } from './ViewerStatusBar'
import { useViewerKeymap } from './useViewerKeymap'
import { useViewerScroll } from './useViewerScroll'
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
 * ── 09-02 批 9b:壳自己也拆成了「一件事一个文件」───────────────────────
 * 这个文件从前 809 行,里面装着五件互不相干的事。拆完之后它只剩**编排**:
 * 从 store 取事实、算出几格派生量、把它们分给下面这些件。每一件的判据、
 * 状态表、判例原文都跟着那件走(改它的人不必读这整个文件):
 *
 *   `ViewerChrome`      头 40:身份与关闭 + 那张「哪些宿主自带檐」表
 *   `ViewerStatusBar`   脚 26:读数带(19 格 props,零 store 订阅)
 *   `ViewerEditArea`    身:轻编辑那块可写文本
 *   `ViewerCloseConfirm` 关掉前问一句(三条出路)
 *   `useViewerKeymap`   面域局部键的派发(六条命令 → 五个动作)
 *   `useViewerScroll`   滚动三件(跳行滚 / 换宿主贴回 / 抄进 store)
 *   `content/file-floats` 右键菜单与详情浮层**开在哪一点**(与文件树共用)
 *
 * ── 它是一块内容,不是文件面板的一部分 ─────────────────────────────────
 * 状态全在 `data/viewer-source`(文件的事实 + 看的姿势 + 没存的改动),画法全在
 * 这个目录里 —— 它对「自己被摆在哪儿」几乎一无所知:`placement` 只决定外框那
 * 一层几何类名。F1 唯一的落点是文件面板里那条分栏,F2 点亮主区域 / 四边钉 /
 * 浮窗时,**内核零改动**(状态在 store 上,换落点只换外框)。
 *
 * 唯一从宿主收的东西是 `onReveal`:「在文件管理器里定位」不是一份文件内容的
 * 事实,它是宿主那一侧的能力(桌面做得到,联网面结构化降级)。
 *
 * ── 表一:落点生命周期表(09-01「状态先行」立法后补,判例就是本条回炉)──
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
 * 挂载 / 卸载那两格:**换落点 = 这棵树真的重挂**(不是换个类名)——所以
 * `useViewerScroll` 那件把 `placement` 列进依赖,挂上来第一帧就把滚动位贴回去;
 * 而合檐与否决定 `ViewerChrome` 整块挂不挂,不是把里面几件藏掉。
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
 * ── 表二:UI 生命状态(四律,逐条落在这里)──────────────────────────────
 *  ① **切文件 / 载入中,旧内容留着**:`file` 与 `pending` 是两格(判据在 store),
 *     檐上那格读数说出「正在读取…」,屏幕上没有任何一帧是空的;
 *  ② **骨架只首载**:第一次打开(手上什么都没有)才画那一行「正在读取…」,
 *     之后一律不画(09-02 批 6:那里从前是一颗 Spinner,而禁令区只许它出现在
 *     按钮内或状态栏 —— 状态栏那一颗留着,内容区这一颗退成文字);
 *  ③ **所有异步钮有 pending 态**:存盘那颗禁用并换字,忙态读自写路
 *     `viewerSaveMutation` 的**逐格** pending(`save:<path>`),不是一颗共享布尔;
 *  ④ **跳转滚动不闪**:落点用 `scrollIntoView({block:'center'})`,不重挂 body。
 *
 * 身那一格的四档按次序判一次(下面 JSX 就是这张表):
 *   有文件 → 内容(编辑态换成文本域)/ 正在首载 → 一行「正在读取…」/
 *   什么都没有 → 空态 / ——没有第四档:失败由脚上那条状态栏说。
 *
 * ── 表三:UI 交互状态(09-02 批 9b 补,逐格说出 pending 落在哪儿)───────
 *   件                     rest hover focus active pending          disabled
 *   ─────────────────────────────────────────────────────────────────────────
 *   檐·名                   ✓   Tooltip 全路径   —   —              —
 *   檐·关闭(IconButton)    ✓    ✓     ✓    ✓    —                —
 *   檐·未保存丸             —(不是控件:不进 Tab 序,只是一枚状态点)
 *   身·文本域               ✓    —     ✓    —    —                **永不**(存盘
 *                                                  在飞时不锁,理由在 ViewerEditArea)
 *   身·右键                 —    —     —    —    —                —(落在 textarea
 *                                                  里的那一下不接,让给文本域自己)
 *   脚·存盘                 ✓    ✓     ✓    —    `save:<path>` 逐格  = pending
 *                                                  (禁用 + 换字 + aria-busy)
 *   脚·完成编辑/读更多/检索/行号 ✓ ✓  ✓    —    —(同步动作)       —
 *   脚·Vim 开关 / 型开关     ✓    ✓     ✓  aria-pressed  —          —
 *   对话框·保存并关闭       ✓    ✓     ✓    —    同一格 `save:<path>` = pending
 *                                                  (AsyncButton,150ms 防闪)
 *   对话框·取消 / 丢弃      ✓    ✓     ✓    —    —                —
 *
 * **pending 只有一个产地**:`viewerSaveMutation` 按 `save:<path>` 逐格记账。
 * 状态栏那颗与对话框那颗读的是**同一格**,所以它们永远同时忙、同时闲 ——
 * 两颗钮读两个布尔就会出现「一颗在转另一颗还能按」。
 */
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
   * 身上右键弹出来的动作菜单 / 详情浮层**开在哪一点**。
   * **表本身不在这里** —— 它是 `content/FileActionsMenu`,与树行那张是同一件
   * (09-01 裁定:动作单产地);**锚点算式也不在这里** —— 它是
   * `content/file-floats`,与文件树共用同一份(09-02 批 9b:内容共用而锚点各写,
   * 结果就是同一张菜单在两块面里贴的位置不一样)。
   */
  const floats = useFileFloats()
  const detail = useFileDetail()
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)

  /** 这一档落点的宿主自带檐吗 —— 自带就合一(表在 ViewerChrome)。 */
  const chromeless = hostOwnsChrome(placement)
  const path = file?.path ?? pending ?? ''
  const name = file?.name ?? (pending ? baseNameOf(pending) : '')
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

  const { onScroll } = useViewerScroll(bodyRef, {
    currentLine: view.currentLine,
    path: file?.path,
    placement,
  })

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

  // 面域局部键(⌘S / ⌘L / ⌘F / …)。判据与撞键裁决在 useViewerKeymap 文件头。
  useViewerKeymap(rootRef, {
    keymap: view.keymap,
    wrap: view.wrap,
    editing: edit.editing,
    lineCount,
    editable: Boolean(handler?.editable),
    onSave: () => void runSave(),
    onJump: setJumpQuery,
    onWrap: (wrap) => setView({ wrap }),
    onEdit: setEditing,
    onClose: requestClose,
  })

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
       * 宿主自带檐时**整条不画**(09-01 合檐):不是把里面几件藏掉 —— 那样还剩
       * 一条 40px 的空带子,而这正是报障里「空间利用度很低」的那 40px。
       */}
      {!chromeless && (
        <ViewerChrome
          t={t}
          path={path}
          name={name}
          dirty={dirty}
          toolbar={toolbar}
          onClose={requestClose}
        />
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
        onScroll={onScroll}
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
          floats.openMenuAt(e)
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
            <ViewerEditArea key={file.path} file={file} draft={edit.draft ?? ''} onDraft={setDraft} t={t} />
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
           *
           * **这里不转圈**(09-02 批 6 兑现禁令):Spinner 只许出现在按钮内或
           * 状态栏,内容区的加载态用文字或骨架。从前这一格是「转圈 + 同一句话」
           * ——转圈说的话与它旁边那行字逐字相同,删掉一个字都没少。
           * 那一颗在状态栏里的仍然留着(它在允许的两处之一,见 ViewerStatusBar)。
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

      <ViewerStatusBar
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

      <ViewerCloseConfirm
        t={t}
        open={confirmClose}
        name={name}
        saveKey={saveKey}
        onCancel={() => setConfirmClose(false)}
        onDiscard={() => {
          setConfirmClose(false)
          close()
        }}
        onSave={runSave}
        onSaved={() => {
          setConfirmClose(false)
          close()
        }}
      />

      {/*
       * 身上右键那张动作菜单 —— 与树行**同一件**(动作单产地)。
       * 目录那一支在这里不可能出现:查看器手上永远是一个文件。
       */}
      {floats.menuAt && file && (
        <FileActionsMenu
          target={{ path: file.path, name: file.name, type: 'file' }}
          x={floats.menuAt.x}
          y={floats.menuAt.y}
          onClose={floats.closeMenu}
          onDetail={() => {
            floats.openDetailAt(floats.menuAt)
            void openDetail({ path: file.path, name: file.name, type: 'file' })
          }}
        />
      )}
      {detail && floats.detailAt && (
        <FileDetailPopover
          detail={detail}
          x={floats.detailAt.x}
          y={floats.detailAt.y}
          onClose={() => {
            floats.closeDetail()
            closeDetail()
          }}
        />
      )}
    </section>
  )
}

export { isEditableFile }
