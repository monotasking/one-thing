import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { baseNameOf, useFileDetail, useFilesSource } from '../../data/files-source'
import { useLiveTitleStore } from '../../stage/live-title'
import { refId } from '../../workbench/kinds'
import { announce } from '../../ui/a11y/live-region'
import { isDirty, isEditableFile, useViewerInstance, useViewerSource, viewerSaveKey, viewerSaveMutation } from '../../data/viewer-source'
import { useAsyncPending } from '../../data/kernel/react'
import { FileActionsMenu } from '../FileActionsMenu'
import { FileDetailPopover } from '../FileDetailPopover'
import { useFileFloats } from '../file-floats'
import { resolveViewer } from './registry'
import type { ViewerBodyProps } from './registry'
import { FocusScope } from '../../focus/FocusScope'
import { JumpBar } from './JumpBar'
import { ViewerEditArea } from './ViewerEditArea'
import { ViewerStatusBar } from './ViewerStatusBar'
import { useViewerScroll } from './useViewerScroll'
// 三张注册表的注册 barrel:import 它们**就是**「这台上认得哪些型 / 哪些跳法 /
// 哪些键位档」。放在这里而不是应用入口 —— 谁要查表,谁负责保证表是装好的
// (与 blocks/BlockView 的同款判例)。
import './kinds'
import { SEARCH_SIGIL } from './navigators'
import './keymaps'
import s from './FileViewer.module.css'

/**
 * **文件查看器 = 壳**(08-31 claude design 定稿;W1 改成一份内容、一个 path)。
 *
 * 它自己只做**公共**的那几件:脚(状态栏)、⌘L 跳转条、轻编辑、键位派发。
 * 「这种文件长什么样」「能跳到哪儿」「哪个键做哪件事」分别由 `registry.ts`
 * 那三张表回答 —— 所以加一种型 / 一种跳法 / 一个键位档,**这个文件一行都不用改**。
 *
 * ── W1:**檐不由内容画**(设计 §2.2「一格一檐」)──────────────────────────
 * 从前这里有两条檐的判据:自己画一条(`ViewerChrome`),或者宿主自带一条时
 * 整条不画(`HOST_OWNS_CHROME`)。两条都退役了 —— 规则现在只有一条:
 * **一片叶只有一条檐,那条檐就是 tab 条;内容自己不画檐。** 于是:
 *  · 文件名 / 未保存丸:由这里发布进 `stage/live-title`(键 = `refId`),
 *    檐读表画(`workbench/LeafStrip`);
 *  · ✕:tab 上那一颗,语义**只有一个** = 关闭这一格(修前那两个含义不同的 ✕
 *    正是用户报的「有误导」);
 *  · 型工具条(markdown 的渲染 ⇄ 源码):由 `ContentKind.toolbar?(ref)` 自述,
 *    挂进那条檐的工具位(`FileViewerToolbar`)。
 * `placement` / `chromeless` / `HOST_OWNS_CHROME` 三格一起没了:查看器现在
 * 对「自己被摆在哪儿」**一无所知**,那正是「换宿主只换外框」这条约束该有的样子。
 *
 * ── W1-a 修批:`strip` —— 「檐画在我盒子里」而不是「我画一条檐」──────────
 * 「打开方式」的出厂缺省档「面板内」不在拼贴树里,它是 `FilesPanel` 自己那条
 * 分栏(设计 §2.1 明写保留);W1-a 交卷时那一档因此**一条檐都没有**,关一个
 * 文件只剩右键与 Esc。修法不是让查看器把檐画回来 —— 那就又有了「谁画檐」这个
 * 分支。而是宿主**把它自己那条身份带交进来**(`SoloLeafStrip`,与中央叶单 tab
 * 时同一件),查看器只负责挂在自己盒子的顶上。
 *
 * 为什么必须挂在**盒子里面**:那条分栏的结构是硬约束 ——
 * `[data-testid="files-tree"] + [data-testid="file-viewer"]` 这条**相邻兄弟**
 * 是 `gate:files` 的判据(树常驻铁律的 DOM 面),中间插任何包裹层都会断掉它。
 * 所以檐只能长在查看器这个盒子里。查看器仍然对「那条带子上写着什么」一无所知:
 * 它收到的是一个 ReactNode。
 *
 * ── W1:**一个 path 一份实例** ──────────────────────────────────────────
 * `path` 是必填的 prop,不再从全局 store 上读「屏幕上那一份」。两份实例同时开着
 * 互不串:各自的草稿、滚动位、视图设置、存盘忙态(`save:<path>` 逐格)全分家。
 *
 * ── 表一:宿主生命周期表(09-01「状态先行」立法后补;W1 重写)─────────────
 * **换一种宿主就是一次生命周期事件**,三件事逐格回答:
 *
 *   宿主        檐(身份+关闭)      型工具条      滚动谁管       尺寸从哪来
 *   ────────────────────────────────────────────────────────────────────────
 *   中央叶      叶檐 tab 条(叶画)  同一条檐上    查看器 .body   叶的内容盒
 *   面板分栏    **同一条身份带**     同一条檐上    查看器 .body   grid 列宽 × 面板高
 *                (宿主经 `strip` 交进来,挂在盒子顶上)
 *   (W4)架子/浮窗 叶檐 tab 条        同一条檐上    查看器 .body   架子厚度 / 浮窗 rect
 *
 * 三档现在只有**一个**分支:这条檐画在盒子外面(有叶)还是盒子里面(没有叶)。
 * 判据是 `strip` 这个 prop 给不给,不是「我在哪儿」—— 查看器照旧不知道自己在哪儿。
 *
 * 挂载 / 卸载:换宿主 = 这棵树真的重挂,所以 `useViewerScroll` 挂上来第一帧就把
 * 滚动位贴回去(数在 store 的 `scrolls` 表里,那张表没有订阅者)。
 *
 * ── 表二:UI 生命状态(四律,逐条落在这里)──────────────────────────────
 *  ① **切文件 / 载入中,旧内容留着**:`file` 与 `pending` 是两格(判据在 store);
 *  ② **骨架只首载**:第一次打开(手上什么都没有)才画那一行「正在读取…」;
 *  ③ **所有异步钮有 pending 态**:存盘那颗禁用并换字,忙态读自写路
 *     `viewerSaveMutation` 的**逐格** pending(`save:<path>`);
 *  ④ **跳转滚动不闪**:落点用 `scrollIntoView({block:'center'})`,不重挂 body。
 *
 * ── 表三:UI 交互状态 ────────────────────────────────────────────────────
 *   件                     rest hover focus active pending          disabled
 *   ─────────────────────────────────────────────────────────────────────────
 *   檐(`strip`)            —— 整张表在 `workbench/LeafStrip` 上(它是宿主的件)
 *   身·文本域               ✓    —     ✓    —    —                **永不**
 *   身·右键                 —    —     —    —    —                —(落在 textarea
 *                                                  里的那一下不接)
 *   脚·存盘                 ✓    ✓     ✓    —    `save:<path>` 逐格  = pending
 *   脚·完成编辑/读更多/检索/行号 ✓ ✓  ✓    —    —(同步动作)       —
 *   脚·Vim 开关 / 型开关     ✓    ✓     ✓  aria-pressed  —          —
 *   (身份 / 关闭 / 未保存丸都搬去了叶檐 —— 它们的交互状态表在 `PaneLeaf` 上)
 */
export function FileViewer({
  path,
  onReveal,
  strip,
}: {
  /** 这一份实例是哪个文件。**必填** —— 查看器不再有「屏幕上那一份」这回事。 */
  path: string
  onReveal?: (path: string) => void
  /**
   * **宿主自己那条檐**,画在查看器盒子的顶上(W1-a 修批)。
   *
   * 中央叶那一档不给:檐由叶画在盒子**外面**(`workbench/PaneLeaf`)。
   * 面板内那条分栏不在树里,又不许在树与查看器之间插包裹层(`gate:files` 的
   * 相邻兄弟判据),所以它把自己那条身份带(`SoloLeafStrip`)交进来。
   * 查看器不看它是什么 —— 它只是一个挂在顶上的节点。
   */
  strip?: ReactNode
}) {
  const t = useT()
  const { file, pending, view, edit } = useViewerInstance(path)
  const loadMore = useViewerSource((st) => st.loadMore)
  const setView = useViewerSource((st) => st.setView)
  const setEditing = useViewerSource((st) => st.setEditing)
  const setDraft = useViewerSource((st) => st.setDraft)
  const save = useViewerSource((st) => st.save)
  /*
   * 存盘的忙态**读自写路**(09-02 批 6),不是 store 上一颗共享布尔:
   * `viewerSaveMutation` 按 `save:<path>` 逐格记账(律③),所以两份实例
   * 各开一个文件时,一颗钮忙不会把另一颗按住。
   */
  const saveKey = viewerSaveKey(path)
  const saving = useAsyncPending(viewerSaveMutation, saveKey)

  /*
   * ── 身份发布(W1;从前住在 `ViewerPanel` 那件已退役的壳里)──────────────
   * 「一格一檐」之后文件名与未保存丸由**叶檐**说,而叶檐怎么知道?就是这条发布:
   * 键从瓦 id 换成 **refId**(`file:<path>`),形状一个字没变(`stage/live-title`)。
   *
   * 发布点从 `ViewerPanel` 搬进查看器本体,是因为那件壳没有了 —— 而「有没有宿主」
   * 这件事现在不再需要判:**每一份实例都发布自己的身份**,读不读由檐决定
   * (分栏那一档没有檐,那份发布就没有消费者,零成本)。
   * 卸载即收回 —— 一格 tab 关掉之后檐上不该留着它的名字。
   */
  const setLiveTitle = useLiveTitleStore((st) => st.setLiveTitle)
  const liveName = file?.name ?? (pending ? baseNameOf(pending) : baseNameOf(path))
  const liveDirty = isDirty(file, edit)
  useEffect(() => {
    const id = refId({ kind: 'file', key: path })
    setLiveTitle(id, { text: liveName, dirty: liveDirty, tip: path })
    return () => setLiveTitle(id, null)
  }, [path, liveName, liveDirty, setLiveTitle])

  const rootRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /**
   * 跳转条:**null = 没开**,字符串 = 开着而且这是它开条时那串字。
   */
  const [jumpQuery, setJumpQuery] = useState<string | null>(null)
  /**
   * 身上右键弹出来的动作菜单 / 详情浮层**开在哪一点**。
   * **表本身不在这里** —— 它是 `content/FileActionsMenu`,与树行那张是同一件;
   * **锚点算式也不在这里** —— 它是 `content/file-floats`,与文件树共用同一份。
   */
  const floats = useFileFloats()
  const detail = useFileDetail()
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)

  const handler = file ? resolveViewer(file) : undefined
  const bodyProps: ViewerBodyProps | undefined = file
    ? {
        file,
        view,
        onView: (patch) => setView(path, patch),
        onReveal: onReveal ? () => onReveal(file.path) : undefined,
      }
    : undefined
  const lineCount =
    handler?.lineCount && bodyProps ? handler.lineCount(bodyProps) : undefined
  const { onScroll } = useViewerScroll(bodyRef, { currentLine: view.currentLine, path })

  /* ── ③ 存盘:异步钮的 pending 态 ────────────────────────────────────── */
  const runSave = useCallback(async () => {
    const outcome = await save(path)
    announce(t(outcome.ok ? 'viewer.saved' : 'viewer.saveFailed'))
    return outcome
  }, [save, path, t])

  /*
   * **面域局部键的落点**(R2:从元素监听迁进作用域声明)。
   *
   * 表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.viewer.keys`(⌘S / ⌘L / ⌘F 三行),
   * 这里交出的是**同名的处理器**;路由由响应链按活动路径的深度做。
   *
   * 三格 `undefined` 是**判据本身**,不是防御:交不出处理器的那一格,
   * `routeKey` 当没命中处理,这一下原样落到外层(叶的 ⌘W / 全局命令表)去。
   */
  const viewerKeys = {
    save: edit.editing ? () => void runSave() : undefined,
    jump: lineCount === undefined ? undefined : () => setJumpQuery(''),
    find: lineCount === undefined ? undefined : () => setJumpQuery(SEARCH_SIGIL),
  }

  return (
    <FocusScope scope="viewer" rootRef={rootRef} keyHandlers={viewerKeys}>
      {({ scopeProps }) => (
        <section
          {...scopeProps}
          className={s.viewer}
          data-testid="file-viewer"
          data-viewer-path={path}
          data-viewer-kind={handler?.id}
          aria-label={t('viewer.label')}
        >
          {/*
           * 宿主那条檐(有叶的宿主不给 —— 它画在盒子外面)。**第一个孩子**:
           * 身份带在顶、身在中、脚在底,与中央叶那一档逐格相同。
           * 型工具条也在这条带子上(`ContentKind.toolbar` 自述),所以查看器
           * 身上**永远**没有第二条工具带子。
           */}
          {strip}

          <div
            className={s.body}
            ref={bodyRef}
            data-testid="viewer-body"
            onScroll={onScroll}
            /*
             * 身上右键 = 这个文件的动作菜单(09-01 裁定:动作单产地)。
             * 与树行右键弹的是**同一件组件**,所以两处的项与次序不可能分叉。
             *
             * **落在编辑框里的那一下不接**:那时右键该是文本域自己的那一套。
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
                /* 落点只做一件事:改当前行。**关不关条由那一档说了算** */
                onJump={(line) => setView(path, { currentLine: line })}
              />
            )}
            {file && bodyProps && handler ? (
              edit.editing ? (
                <ViewerEditArea
                  key={file.path}
                  file={file}
                  draft={edit.draft ?? ''}
                  onDraft={(text) => setDraft(path, text)}
                  t={t}
                />
              ) : (
                /*
                 * **按 path 作 key**:一份实例的 path 不会变,所以这一格今天恒定 ——
                 * 留着是因为它同时表达「换文件就是换一棵本体」这条判据。
                 */
                <handler.Body key={file.path} {...bodyProps} />
              )
            ) : pending ? (
              /*
               * ② 骨架**只首载**:走到这里必然是「手上什么都没有、而且正在读」的
               * 第一帧。**这里不转圈**(禁令:Spinner 只许出现在按钮内或状态栏)。
               */
              <p className={s.note} data-testid="viewer-first-load">
                <span className={s.noteDetail}>{t('viewer.reading')}</span>
              </p>
            ) : (
              /*
               * **空态**:实例已经建好、读还没发出去(或者被 dispose 之后这一帧
               * 还没卸载)。这一格说的是实话 —— 不转圈,也不假装是个错误。
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
            onEditDone={() => setEditing(path, false)}
            onJump={() => setJumpQuery('')}
            onFind={() => setJumpQuery(SEARCH_SIGIL)}
            onKeymap={(id) => setView(path, { keymap: id })}
            onLoadMore={() => void loadMore(path)}
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
      )}
    </FocusScope>
  )
}

export { isEditableFile, isDirty }
