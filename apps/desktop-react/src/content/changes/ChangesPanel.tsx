import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { TriangleAlert } from '../../components/icons'
import { Button } from '../../ui/Button'
import { Splitter } from '../../ui/Splitter'
import { useListSelection } from '../../ui/a11y/list-selection'
import { useT } from '../../i18n'
import { FocusScope } from '../../focus/FocusScope'
import { useQuery } from '../../data/kernel'
import {
  CHANGES_SPLIT_ID,
  DEFAULT_SPLIT_RATIOS,
  SPLIT_MAX,
  SPLIT_MIN,
  useSplitPrefs,
  useSplitRatio,
} from '../../data/split-prefs'
import { fileQueryOf, statusQuery, useChangesLive, useFileLive } from '../../data/changes-source'
import type { GitChangedFile } from '../../data/changes-source'
import { useContentDrag } from '../../workbench/useContentDrag'
import { diffRef } from '../kinds/diff-ref'
import { openFileInCurrentTarget } from '../viewer/open-target'
import { ChangeFileView } from './ChangeFileView'
import { ChangeList } from './ChangeList'
import { ChangesHeader } from './ChangesHeader'
import s from './ChangesPanel.module.css'

/**
 * **一份改动面**(「改动」面,正本 `apps/desktop-react/docs/changes-panel-2026-09.md`
 * §3.4)。它是 `diff:<workdir>` 那一种内容的身子(`content/kinds/diff.tsx` 只是它的
 * 登记),与 `FilesPanel` 逐字同型:**收一格 `root` prop**,一块面一个工作目录。
 *
 * ── 形状 ────────────────────────────────────────────────────────────────
 * 檐(仓库根名 · 分支 · 合计 · 刷新 · 拖把手)/ **身:两列**(文件列 | diff 体)。
 * 分栏比记在 `data/split-prefs` 的 `CHANGES_SPLIT_ID` 那一格(与文件面板共用同一张
 * 表 —— 那张表头上写着「第二处分栏零成本接入」,这就是它)。
 *
 * ══ 表一 · 生命周期 ═══════════════════════════════════════════════════════
 * | 事件       | 这块面做什么                                                  |
 * |------------|---------------------------------------------------------------|
 * | 挂载       | `useChangesLive(root)`:报到(在场表)+ `statusQuery.ensure()`。|
 * |            | **幂等** —— 同一个目录开两块面只问后端一次。                    |
 * | 选中一行   | 那一格 `diffQuery.ensure()`(同一个文件切来切去只问一次)。     |
 * | 刷新       | 三条路,一条 poll 都没有:①首次可见 ②檐上那颗钮 ③**环境会话一轮 |
 * |            | 跑完**(`changes-source` 订的 `onRunEnded`)。判词在那只文件上。 |
 * | **换宿主** | 面板内 / 浮窗 / 舞台 / 钉边 —— 这块面在四种落点里长得一样,      |
 * |            | 因为它整块被 `renderContent` 原样交出去。跟着换的只有 `useRowWindow`|
 * |            | 的 ResizeObserver 量到的新高度。**读数一格不动**(它按 root 键控)。|
 * | 换会话     | **这块面不动** —— 它的身份是一个目录,不是一条会话。跟着会话走的  |
 * |            | 是伴随面那条路(收放整格 tab,`workbench/companions.ts`)。      |
 * | 卸载       | 报到那一格归还。**读数留在格子里**:切回来旧内容当场在屏(律②′)。|
 * |            | 无计时器、无模块级副作用 → 不需要 HMR dispose。                  |
 *
 * ══ 表二 · UI 生命状态(六态)════════════════════════════════════════════
 * | 态         | 触发                  | 画什么                                  |
 * |------------|-----------------------|-----------------------------------------|
 * | initial    | 首载在飞              | 骨架三行(**仅** `phase==='initial'`)   |
 * | not-a-repo | `{repo:false}`        | 一行提示 + 路径,**无按钮**(接入 git 不是|
 * |            |                       | 这块面的事)                             |
 * | clean      | `files.length===0`    | 「没有未提交的改动」+ 分支名             |
 * | ready      | 有行                  | 列 + 体;**首次 ready 自动选第一行**      |
 * | error      | denied/failed/invalid | 通知行(TriangleAlert)+ 后端原话 + 重试   |
 * | refetching | 有旧数据在飞          | **旧屏不动**,刷新钮自身 pending         |
 * | 超量       | 2 000 行 / 20 000 行  | 列窗口化(`useRowWindow`);diff 体逐 hunk |
 * |            |                       | `content-visibility: auto`               |
 *
 * ══ 表三 · UI 交互状态 ════════════════════════════════════════════════════
 * | 落点       | rest      | hover     | focus | active/pending | disabled  |
 * |------------|-----------|-----------|-------|----------------|-----------|
 * | 仓库根名   | 不是钮(拖把手)      | —     | —              | —         |
 * | 刷新钮     | IconButton| st-hover  | 全局环| 转一圈 + aria-busy | 首载在飞 |
 * | 文件行     | 透明      | st-hover  | 全局环| 选中 = st-sel  | —         |
 * | 重试(两处)| Button ghost | st-hover | 全局环| —           | —         |
 * | 分隔杆     | 见 `ui/Splitter`;**只在两列都在场时才在**(不可调的 separator |
 * |            | 进 Tab 序是纯噪音,APG)。                                      |
 * 这块面**没有面板级 pending**:每一件异步事的忙态长在发起它的那个控件上(律③)。
 *
 * ── 键盘 ────────────────────────────────────────────────────────────────
 * 全是**结构键**:↑↓ / Home / End 走行(`ui/a11y/list-selection`,`homeEnd: true`
 * —— 焦点真的落在列表上),↵ 开那个文件,双击同 ↵。**一条局部命令都没有**,所以
 * `FOCUS_SCOPES.diff` 上没有 `answers`;Esc **不接**(判词在那一行上)。
 * `restingTarget` = 选中的那一行,没有就第一行,一行都没有才退回根(不变量 I1)。
 */

export function ChangesPanel({ root }: { root: string }) {
  const t = useT()
  useChangesLive(root)

  const status = useQuery(statusQuery.get(root))
  const view = status.data
  const files: readonly GitChangedFile[] = view?.files ?? []

  /** 「重新读取」按了几次 —— 那枚图标每按一次多转一圈(单调递增)。 */
  const [spins, setSpins] = useState(0)

  /*
   * 键盘位。**受控档由这块面自己持有**(`useListSelection` 的自持档就够了):
   * 选中是**视图状态** —— 换一块面它该归零,而读数是要活过面板开合的。
   *
   * `homeEnd: true`:这一族列表的焦点**真的落在行上**(行是 `<button>`),
   * 所以 Home / End 是「到第一 / 最后一行」,不是某个输入框里的行首行尾
   * (那只原语头上那段判词的另一半)。
   */
  const selection = useListSelection({ count: files.length, homeEnd: true })
  const selected = files[selection.active]

  /*
   * 选中那个文件的**两个版本原文**(批 ③-b:整文件视图吃 `file` 那条读法,
   * 不再吃 `diff`)。**query 的身份跟着 (root, path) 走**,所以切来切去不会互相污染。
   *
   * 报到与首载都在 `useFileLive`(数据层那一只):它同时把这一格记进「正看着哪几个
   * 文件」那本引用计数账,`refreshOpenChanges` 据此对**看得见的那一格**发真的
   * `refetch`、对别的只标脏。这块面因此一句 `ensure` 都不写 —— 与 `useChangesLive`
   * 是同一条纪律(取数的生命周期归数据层,面只声明「我在看什么」)。
   *
   * 没有选中行时读的是 `fileQueryOf(root, '')` 那一格占位:它**永远没人 `ensure`**,
   * 快照恒是出厂那一份。判词与 `data/file-peek-source.useFilePeek` 那句「路径为空时
   * 订空串那一格」逐字同源,`refreshOpenChanges` 也照着跳过它。
   */
  const fileSource = selected ? fileQueryOf(root, selected.path) : undefined
  const fileText = useQuery(fileSource ?? fileQueryOf(root, ''))
  useFileLive(root, selected?.path ?? '')

  /*
   * **首次 ready 自动选第一行**(表二)。判据是「读到了 ∧ 有行 ∧ 还没选过」——
   * 用一格 ref 记「选过没有」而不是判 `active === 0`:`active` 的出厂值就是 0,
   * 两者分不开,于是人手动选回第一行之后再刷新一次会被判成「还没选过」。
   */
  const picked = useRef(false)
  useEffect(() => {
    if (picked.current || files.length === 0) return
    picked.current = true
    selection.select(0)
  }, [files.length, selection])
  /* 换了一个目录 = 换一块面:重新起算。 */
  useEffect(() => {
    picked.current = false
  }, [root])

  /* 分栏比例。拖动那一段一帧都不经过 React(杆直接写下面那个 CSS 变量)。 */
  const splitRef = useRef<HTMLDivElement>(null)
  const splitRatio = useSplitRatio(CHANGES_SPLIT_ID)
  const setSplitRatio = useSplitPrefs((st) => st.setRatio)

  /*
   * **檐上的拖把手**(与文件面板的树行同一只 `useContentDrag`)。拖出去的是
   * `diff:<root>` —— 这一格的身份,不是仓库根:摆到别处去的应该是**这一块面**。
   */
  const startDrag = useContentDrag({ ref: () => diffRef(root) })

  const openFile = useCallback(
    (file: GitChangedFile) => {
      /*
       * 开的是**磁盘上那个文件**,所以要把仓库根相对路径接回绝对路径。
       * 根答不出来(还在读)就不开 —— 拼一条半截路径去开一个不存在的文件,
       * 比什么都不做糟。
       */
      const repoRoot = view?.root
      if (!repoRoot) return
      /*
       * `deleted` 那一档开不出来(盘上没有那个文件了),而这块面知道这件事 ——
       * 让它去撞查看器的「读不到」比当场不开更糟:那是一句没人能修的报错。
       */
      if (file.status === 'deleted') return
      openFileInCurrentTarget(`${repoRoot}/${file.path}`)
    },
    [view?.root],
  )

  const onRefresh = useCallback(() => {
    setSpins((n) => n + 1)
    void statusQuery.get(root).refetch()
    if (fileSource) void fileSource.refetch()
  }, [root, fileSource])

  /*
   * **被召唤时焦点落在哪**(三件声明之二)。选中那一行 → 第一行 → 根。
   * 取件口是行自己那格 `data-change-path`(门与用例用的同一格;文案会跟着语言变,
   * 路径不会)。查在这块面自己的列子树里,所以两块改动面同时开着时各找各的。
   */
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const restingTarget = useCallback(() => {
    const body = listRef.current
    if (!body) return panelRef.current
    const hit =
      body.querySelector('[data-change-selected="true"]') ?? body.querySelector('[data-change-path]')
    return hit instanceof HTMLElement ? hit : panelRef.current
  }, [])

  /** 两列都在场才画分隔杆(不可调的 separator 不该进 Tab 序,APG)。 */
  const splitOpen = files.length > 0 && Boolean(selected)

  return (
    <FocusScope scope="diff" rootRef={panelRef} restingTarget={restingTarget}>
      {({ scopeProps }) => (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是
         * 列里那些行(它们是真 `<button>`,落点声明指着第一行),↑↓ / Home / End / ↵
         * 从它们冒泡上来由面板按当前键盘位统一处理。与 `SearchPanel` 那一处逐字
         * 同一条判例。 */
        <div
          {...scopeProps}
          className={s.panel}
          data-testid="changes-panel"
          data-changes-root={root}
          /*
           * ↑↓ / Home / End 交给 `useListSelection`(结构键,不进任何键表);
           * ↵ 开那个文件。`handleKey` 答 false 的键**原样放行** —— 吞掉不认识的
           * 键是「键盘可达」最常见的反面教材。
           */
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return
            if (event.key === 'Enter') {
              if (!selected) return
              event.preventDefault()
              openFile(selected)
              return
            }
            if (selection.handleKey(event.key)) event.preventDefault()
          }}
        >
          <ChangesHeader
            root={root}
            view={view}
            spins={spins}
            onRefresh={onRefresh}
            refreshing={status.inflight}
            onDragPointerDown={startDrag}
            t={t}
          />

          {/*
           * 错误:一条通知行 + **后端原话** + 重试。旧屏不清(律②)—— 下面那一列
           * 上一次读到的行留着,人至少还看得见刚才那一份。
           */}
          {status.error && (
            <p className={s.notice} role="alert" data-testid="changes-error">
              <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.noticeText}>{status.error}</span>
              <Button size="sm" variant="ghost" onClick={onRefresh}>
                {t('diff.retry')}
              </Button>
            </p>
          )}

          {status.phase === 'initial' && !status.error ? (
            /* 首载骨架三行。**只看 `phase`** —— 重拉期间下面那一列一动不动。 */
            <div className={s.skel} aria-hidden="true" data-testid="changes-skeleton">
              <span className={`${s.skelBar} ${s.skelBar1}`} />
              <span className={`${s.skelBar} ${s.skelBar2}`} />
              <span className={`${s.skelBar} ${s.skelBar3}`} />
            </div>
          ) : view && !view.repo ? (
            /*
             * 「这里不是 git 仓库」。**一行提示 + 路径,没有按钮** —— `git init`
             * 是一次有后果的写操作,而这块面本单零做法;给一个点不动的钮或者一个
             * 会偷偷建仓的钮,两种都比说清楚差。
             */
            <p className={s.empty} data-testid="changes-not-repo">
              <span className={s.emptyText}>{t('diff.notRepo')}</span>
              <span className={s.emptyPath}>{root}</span>
            </p>
          ) : view && files.length === 0 ? (
            /* 干净。分支名跟在后面 —— 「哪一条分支是干净的」才是完整的一句话。 */
            <p className={s.empty} data-testid="changes-clean">
              <span className={s.emptyText}>{t('diff.clean')}</span>
              {view.branch && <span className={s.emptyPath}>{view.branch}</span>}
            </p>
          ) : (
            <div
              className={s.split}
              ref={splitRef}
              data-body={splitOpen ? 'open' : 'closed'}
              /* 比例进一个**无单位数**的自定义属性,列宽由样式表按它算 ——
               * 组件里不算像素,拖拽期间杆改的也正是这一格。 */
              style={{ '--changes-split': `${splitRatio}` } as CSSProperties}
            >
              <ChangeList
                files={files}
                active={selection.active}
                onSelect={selection.select}
                onOpen={openFile}
                rowRef={selection.rowRef}
                t={t}
                bodyRef={(el) => {
                  listRef.current = el
                }}
              />
              {splitOpen && (
                <Splitter
                  containerRef={splitRef}
                  value={splitRatio}
                  min={SPLIT_MIN}
                  max={SPLIT_MAX}
                  defaultValue={DEFAULT_SPLIT_RATIOS[CHANGES_SPLIT_ID]}
                  label={t('diff.splitLabel')}
                  controls="changes-list-column"
                  liveVar="--changes-split"
                  testId="changes-splitter"
                  onCommit={(next) => setSplitRatio(CHANGES_SPLIT_ID, next)}
                />
              )}
              {selected && (
                <ChangeFileView
                  file={selected}
                  snapshot={fileText}
                  onRetry={() => void fileSource?.refetch()}
                  t={t}
                />
              )}
            </div>
          )}
        </div>
      )}
    </FocusScope>
  )
}
