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
import { refreshChangesOf, statusQuery, useChangesLive } from '../../data/changes-source'
import type { GitChangedFile } from '../../data/changes-source'
import { useFileOpenMode } from '../../data/file-open-mode'
import { useContentDrag } from '../../workbench/useContentDrag'
import { refId } from '../../workbench/kinds'
import { openStateOf, useWorkbenchStore } from '../../workbench/store'
import { focusIntoRefAfterCommit } from '../../workbench/focus-into'
import { anchorAtPointer } from '../file-floats'
import type { Anchor } from '../file-floats'
import { diffRef } from '../kinds/diff-ref'
import { changeRef } from '../kinds/change-ref'
import { openRefByFileMode } from '../viewer/open-target'
import { ChangeActionsMenu } from './ChangeActionsMenu'
import { ChangeFileView } from './ChangeFileView'
import { ChangeList } from './ChangeList'
import { ChangesHeader } from './ChangesHeader'
import s from './ChangesPanel.module.css'

/**
 * **一份改动面**(「改动」面,正本 `apps/desktop-react/docs/changes-panel-2026-09.md`
 * §3.4;批⑤ 改成**只有文件列**,正本 `docs/changes-file-view-2026-09.md` §6)。
 * 它是 `diff:<workdir>` 那一种内容的身子(`content/kinds/diff.tsx` 只是它的
 * 登记),与 `FilesPanel` 逐字同型:**收一格 `root` prop**,一块面一个工作目录。
 *
 * ── 批⑤:列与正文拆开 ───────────────────────────────────────────────────
 * 用户 09-14 的原话:「能否把这个 diff 的文件列表和文件拆开?查看文件的 diff 走
 * 默认的文件的 tab 行为?」于是:
 *  · **缺省这块面只有一列**(文件列铺满,没有分隔杆、没有内联正文);
 *  · 行的**单击与 ↵ 走同一条路** —— 开一格 `change:<root>|<path>`,落在哪由
 *    `data/file-open-mode` 那七档说,**与文件共用同一格偏好**(裁定:用户说的是
 *    「走默认的文件的 tab 行为」,分开设就是两处会漂的偏好);
 *  · `panel` 那一档**仍旧是这条分栏**(七档里唯一不进树的一档),内联着哪个文件是
 *    这块面的**瞬态本地状态**(不落盘 —— 它是「我此刻在这块面里看着谁」,不是家具);
 *  · 行的四件动作收进**右键菜单**(动作单产地),**双击整档退役**(壳禁令)。
 *
 * ── 形状 ────────────────────────────────────────────────────────────────
 * 檐(仓库根名 · 分支 · 合计 · 刷新 · 拖把手)/ 身:文件列(`panel` 档再多一条
 * 分隔杆 + 一份 `ChangeFileView`)。分栏比记在 `data/split-prefs` 的
 * `CHANGES_SPLIT_ID` 那一格(与文件面板共用同一张表)。
 *
 * ══ 表一 · 生命周期 ═══════════════════════════════════════════════════════
 * | 事件       | 这块面做什么                                                  |
 * |------------|---------------------------------------------------------------|
 * | 挂载       | `useChangesLive(root)`:报到(在场表)+ `statusQuery.ensure()`。|
 * |            | **幂等** —— 同一个目录开两块面只问后端一次。**它不再取任何一个 |
 * |            | 文件的正文**:那是 `ChangeFileView` 自己的两句报到(批⑤)。     |
 * | 选中一行   | 只动键盘位。**不再顺带取数** —— 取数跟着「开出来那一格」走。   |
 * | 开一行     | `openRefByFileMode(changeRef(root, path))`:进树的六档由拼贴台   |
 * |            | 接手;`panel` 那一档落进下面那格瞬态 `inlinePath`。↵ 多一件:   |
 * |            | 焦点送进开出来的那一格(`focusIntoRefAfterCommit`,点名 owner)。|
 * | 刷新       | 三条路,一条 poll 都没有:①首次可见 ②檐上那颗钮(`refreshChangesOf`|
 * |            | —— 这个仓的表 + 此刻被人看着的那几份正文)③**环境会话一轮跑完**。|
 * | **换宿主** | 面板内 / 浮窗 / 舞台 / 钉边 —— 这块面在四种落点里长得一样,      |
 * |            | 因为它整块被 `renderContent` 原样交出去。跟着换的只有 `useRowWindow`|
 * |            | 的 ResizeObserver 量到的新高度。**读数一格不动**(它按 root 键控)。|
 * | 换会话     | **这块面不动** —— 它的身份是一个目录,不是一条会话。跟着会话走的  |
 * |            | 是伴随面那条路(收放整格 tab,`workbench/companions.ts`)。      |
 * |            | 开出去的那几格 `change:` **不跟着收放**(它们不是伴随面)。      |
 * | 卸载       | 报到那一格归还。**读数留在格子里**:切回来旧内容当场在屏(律②′)。|
 * |            | 无计时器、无模块级副作用 → 不需要 HMR dispose。                  |
 *
 * ══ 表二 · UI 生命状态(七态)════════════════════════════════════════════
 * | 态         | 触发                  | 画什么                                  |
 * |------------|-----------------------|-----------------------------------------|
 * | initial    | 首载在飞              | 骨架三行(**仅** `phase==='initial'`)   |
 * | not-a-repo | `{repo:false}`        | 一行提示 + 路径,**无按钮**(接入 git 不是|
 * |            |                       | 这块面的事)                             |
 * | clean      | `files.length===0`    | 「没有未提交的改动」+ 分支名             |
 * | ready      | 有行                  | **只有列**;首次 ready 自动把键盘位落到第 |
 * |            |                       | 一行(**不打开** —— 开是人的动作)        |
 * | panel 档   | 开过一行 ∧ 档 = panel | 列 + 杆 + 那一份 `ChangeFileView`         |
 * | error      | denied/failed/invalid | 通知行(TriangleAlert)+ 后端原话 + 重试   |
 * | refetching | 有旧数据在飞          | **旧屏不动**,刷新钮自身 pending         |
 * | 超量       | 2 000 行              | 列窗口化(`useRowWindow`);正文那一半的超量|
 * |            |                       | 由 `ChangeFileView` 自己答               |
 *
 * ══ 表三 · UI 交互状态 ════════════════════════════════════════════════════
 * | 落点       | rest      | hover     | focus | active/pending | disabled  |
 * |------------|-----------|-----------|-------|----------------|-----------|
 * | 仓库根名   | 不是钮(拖把手)      | —     | —              | —         |
 * | 刷新钮     | IconButton| st-hover  | 全局环| 转一圈 + aria-busy | 首载在飞 |
 * | 文件行     | 透明      | st-hover  | 全局环| 键盘位 = st-sel| —         |
 * | 行尾开态点 | 见 `ui/OpenDot`(实心 = 开着并显示 / 空心 = 开着但藏起来 /      |
 * |            | 不画 = 没开)。它与键盘位是两件事。                              |
 * | 行右键菜单 | 见 `ui/Menu`;已删除的文件那两条按不动(盘上没有它了)           |
 * | 重试(两处)| Button ghost | st-hover | 全局环| —           | —         |
 * | 分隔杆     | 见 `ui/Splitter`;**只在 `panel` 档真长出内联正文时才在**(不可调 |
 * |            | 的 separator 进 Tab 序是纯噪音,APG)。                          |
 * 这块面**没有面板级 pending**:每一件异步事的忙态长在发起它的那个控件上(律③)。
 *
 * ── 键盘 ────────────────────────────────────────────────────────────────
 * 全是**结构键**:↑↓ / Home / End 走行(`ui/a11y/list-selection`,`homeEnd: true`
 * —— 焦点真的落在列表上),↵ 开那一格改动**并且**把焦点送进去(单击不送 ——
 * 「导航器里浏览不抢焦点」是响应链规则 4)。↵ 那一下长在**行自己**身上
 * (`ChangeList`,与 `files/TreeEntryRow` 逐字同形),所以这块面的委托里没有它。
 * **一条局部命令都没有**,所以 `FOCUS_SCOPES.diff` 上没有 `answers`;Esc **不接**。
 * `restingTarget` = 键盘位那一行,没有就第一行,一行都没有才退回根(不变量 I1)。
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
   * 它是**视图状态** —— 换一块面它该归零,而读数是要活过面板开合的。
   *
   * 批⑤ 之后它**只是键盘位**:从前它同时是「右边那条分栏画哪个文件」,现在后者
   * 是下面那格 `inlinePath`(而且只有 `panel` 那一档才有)。
   *
   * `homeEnd: true`:这一族列表的焦点**真的落在行上**(行是 `<button>`),
   * 所以 Home / End 是「到第一 / 最后一行」,不是某个输入框里的行首行尾。
   */
  const selection = useListSelection({ count: files.length, homeEnd: true })

  /**
   * **`panel` 那一档内联着哪个文件**(批⑤)。它是这块面的**瞬态**:不落盘、不进
   * 拼贴树 —— 「我此刻在这块面里看着谁」是看的人当下的事,不是这个工作区的家具。
   * (进树的那六档由拼贴台自己记,重开时它们跟着树回来。)
   */
  const [inlinePath, setInlinePath] = useState<string | null>(null)
  /**
   * 当下这一档打开方式。**与文件共用同一格偏好**(§6.4 裁定)。这块面只用它判
   * 一件事:这条分栏画不画内联正文 —— 别的六档正文住在树里,那时分栏收起来
   * (一份内容只该有一个落点,两处同时画就是重影)。
   */
  const openMode = useFileOpenMode((st) => st.mode)
  const splitOpen = inlinePath !== null && openMode === 'panel'

  /*
   * 行尾那颗开态点的**三格事实**(树 / 隐藏表 / 这块面的内联)。判据整件是纯函数
   * `openStateOf` —— 与文件树那一列读的是同一句话,只是问的 ref 从 `file:` 换成了
   * `change:`。订的正是那两格,所以任一格变了这一列点当场跟着翻。
   *
   * `panelPath` 递 `null`:那一格是**文件面板**那条分栏的路径(它说的是 `file:`
   * 那一种),而这一族的「面板内」是上面那格 `inlinePath`,两者不是一回事。
   */
  const regions = useWorkbenchStore((st) => st.regions)
  const hiddenTabs = useWorkbenchStore((st) => st.hidden)
  const restoreHidden = useWorkbenchStore((st) => st.restoreHidden)
  const openStateOfFile = useCallback(
    (file: GitChangedFile): 'shown' | 'hidden' | null => {
      if (splitOpen && inlinePath === file.path) return 'shown'
      return openStateOf(
        { regions, hidden: hiddenTabs, panelPath: null },
        changeRef(root, file.path),
      )
    },
    [regions, hiddenTabs, splitOpen, inlinePath, root],
  )

  /*
   * **首次 ready 把键盘位落到第一行**(表二)。判据是「落过没有」而不是
   * `active === 0`:`active` 的出厂值就是 0,两者分不开,于是人手动选回第一行之后
   * 再刷新一次会被判成「还没选过」。
   *
   * **它不打开任何东西**(批⑤):开一格 tab 是人的动作,一块面自己开出来的 tab
   * 是没人要过的打开。
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
    setInlinePath(null)
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

  /** 盘上那个文件的绝对路径(仓库根还没读到 = null,判词在菜单那格 prop 上)。 */
  const absPathOf = useCallback(
    (file: GitChangedFile): string | null => (view?.root ? `${view.root}/${file.path}` : null),
    [view?.root],
  )

  /**
   * **开一行的改动**(批⑤ 的主路:单击与 ↵ 同一条)。
   *
   * 落点走 `openRefByFileMode` —— 与「打开一个文件」**同一只**七档翻译
   * (判词在 `content/viewer/open-target.ts` 上)。`panel` 那一档不进树,落进这块
   * 面自己那格瞬态;别的六档进树,那时内联收起来(一份内容一个落点)。
   *
   * `viaKeyboard` 只决定一件事:**焦点送不送进开出来的那一格**(响应链规则 4:
   * 导航器里浏览不抢焦点,确认才抢)。送的那一句是 `focusIntoRefAfterCommit`
   * 而不是 `activateScope('diff')`:这块面自己就是一格 `diff` 作用域、而且是此刻
   * 的 MRU,不点名的话那一发会落回**这张列表**(W5-c 立的判例:不点名 = 让 MRU
   * 替用户猜)。点名的 owner 正是这一格的 refId,而 `ChangeFileView` 在标准档下
   * 把同一个 id 报上来。
   */
  const openChange = useCallback(
    (file: GitChangedFile, viaKeyboard: boolean) => {
      const ref = changeRef(root, file.path)
      if (openRefByFileMode(ref) === 'panel') {
        setInlinePath(file.path)
        return
      }
      setInlinePath(null)
      if (viaKeyboard) focusIntoRefAfterCommit(refId(ref), 'open')
    },
    [root],
  )

  const onRefresh = useCallback(() => {
    setSpins((n) => n + 1)
    refreshChangesOf(root)
  }, [root])

  /*
   * 行右键那张表开在**哪一行、哪一点**。两格一起记、一起清 —— 留下任何一半都是
   * 一张半开的菜单(与 `FilesPanel.dismissMenu` 逐字同一条)。
   */
  const [menu, setMenu] = useState<{ file: GitChangedFile; at: Anchor } | null>(null)

  /*
   * **被召唤时焦点落在哪**(三件声明之二)。键盘位那一行 → 第一行 → 根。
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

  return (
    <FocusScope scope="diff" rootRef={panelRef} restingTarget={restingTarget}>
      {({ scopeProps }) => (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是
         * 列里那些行(它们是真 `<button>`,落点声明指着第一行),↑↓ / Home / End
         * 从它们冒泡上来由面板按当前键盘位统一处理。与 `SearchPanel` 那一处逐字
         * 同一条判例。(↵ **不在这里** —— 它长在行自己身上,见 `ChangeList`。) */
        <div
          {...scopeProps}
          className={s.panel}
          data-testid="changes-panel"
          data-changes-root={root}
          /*
           * ↑↓ / Home / End 交给 `useListSelection`(结构键,不进任何键表)。
           * `handleKey` 答 false 的键**原样放行** —— 吞掉不认识的键是「键盘可达」
           * 最常见的反面教材。
           */
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return
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
                onOpen={openChange}
                openStateOf={openStateOfFile}
                onRestore={(file) => restoreHidden(refId(changeRef(root, file.path)))}
                onMenu={(file, origin) => setMenu({ file, at: anchorAtPointer(origin) })}
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
              {/*
               * `panel` 那一档的内联正文。**不递 `owner`** —— 它是这块面的一部分,
               * 不是一格独立内容(判词在 `ChangeFileView` 那格 prop 上)。
               */}
              {splitOpen && inlinePath && <ChangeFileView root={root} path={inlinePath} />}
            </div>
          )}

          {/*
           * 行的右键菜单 —— **动作单产地**(09-01 裁定)。双击那条路整档退役
           * (壳禁令:macOS 触控板双指点按以双击形态到达,与右键语义打架)。
           */}
          {menu && (
            <ChangeActionsMenu
              target={{ file: menu.file, absPath: absPathOf(menu.file) }}
              x={menu.at.x}
              y={menu.at.y}
              onClose={() => setMenu(null)}
              onOpenChange={() => openChange(menu.file, false)}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}
