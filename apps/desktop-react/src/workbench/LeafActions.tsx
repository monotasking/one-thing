import { useMemo, useState } from 'react'
import {
  Columns2,
  Ellipsis,
  PictureInPicture2,
  Rows2,
  Unlink,
  X,
} from '../components/icons'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSection, MenuSeparator, Submenu } from '../ui/Menu'
import { announce } from '../ui/a11y/live-region'
import { useT } from '../i18n'
import { dropRef, pairIntoIndex, unpairTab } from './drop-commit'
import { useLeafMenuAt, useLeafMenuStore } from './leaf-menu'
import { useLeafOverflow } from './leaf-overflow'
import { canDetachTabAt, useCloseLeafTab } from './leaf-tabs'
import { contentKindOf, partsOfContent, refId } from './kinds'
import {
  hiddenInRegion,
  regionOfLeafIn,
  SINGLE_LEAF_REGIONS,
  useWorkbenchStore,
} from './store'
import type { ReactNode } from 'react'
import type { MessageKey } from '../i18n'
import type { ShelfSide } from '../stage/types'
import type { PaneLeafNode } from './tree'
import s from './LeafActions.module.css'

/**
 * **一片叶的动作组**(W1-b 从 `PaneLeaf` 抽出来;W7-c 做减法之后只剩两件事:
 * 檐右端那颗「够不着的标签 ⋯」,与**标签动作表**本身)。
 *
 * ── W7-c 删掉了什么,为什么(用户 09-05「按钮太多、菜单太多」)────────────
 *  · **「分屏」那颗钮**没了。它是这张表从 W1-b 起唯一的开口,而这张表说的是
 *    「这一格标签能做什么」—— 一张作用在某个具体条目上的表,它的产地本来就该是
 *    **那个条目的右键菜单**(CLAUDE.md「动作单产地=右键上下文菜单」)。留一颗钮
 *    等于同一张表有两个入口,而其中一个还写着它第一项的名字。
 *    键盘那条路没有跟着没:`Shift+F10` / 上下文菜单键落在焦点标签上开同一张表
 *    (`ui/Tabs` 只量点、递请求,判词写在那格 prop 上)。
 *  · **型工具条那一格**没了。内容的动作单产地是它自己的右键菜单,顶栏不再有
 *    内容工具条槽位(markdown 的「渲染 / 源码」搬进了 `content/FileActionsMenu`)。
 *  · **「左移一位 / 右移一位」**两项从表里删了。换序靠拖拽(W6-b 起那套判据是
 *    「朝运动方向越过邻居中心」,真机上比按两下菜单快得多),键盘等价升格成
 *    **全局命令**(`KEYMAP_COMMANDS` 的 `workbench.moveTabLeft` / `Right`)——
 *    一件事从菜单里拿掉不等于把它拿掉。
 *  · **「拆开」改成只在两格标签上出现**,不再禁灰。禁灰说的是「此刻不行」,而
 *    一格普通标签上「拆开」根本没有对象 —— 那是**这张表在这一格上不存在这一项**。
 *    (分屏四项在中央区不画,走的是同一条判据。)
 *
 * 于是顶栏右端只剩两件:这一组(常态下只有那颗 ⋯,而它两节都空时连自己都不画)
 * 与 `AgentChip`。
 *
 * ── 第二个宿主:架子 / 浮窗那片叶的檐(W4)──────────────────────────────
 * 那两处没有第二条顶栏可借,檐就画在叶顶(`PaneLeaf` 的 `PaneLeafStrip`),
 * 这一组因此挂在那条檐的右端、宿主自己那颗之前。**同一件**,不是第二份实现。
 * W7-c 起那两处的宿主钮也做了减法(架子只剩「收起」、浮窗只剩 ✕),被拿掉的
 * 几件搬进**这张表**——由宿主自述一段 `PaneHostChrome.menuRows` 递进来,所以
 * 「叶菜单按宿主类型多几项」这件事只有一格事实,而这只组件一个宿主名都不认识。
 *
 * ── 「够不着的标签 ⋯」:一颗钮、一张表、两节(W7-t / B1)────────────────────
 * 「看不见的」(条太窄被滚出视野)与「隐藏的」(收进隐藏表)是同一句话的两种
 * 成因 —— **这一格此刻点不到**,而用户要做的事一模一样。所以它们不是两颗 ⋯:
 * 一颗钮、一张表、两节,哪一节空就不画哪一节。看不见的那一节的名单由标签条
 * 自己量(`ui/Tabs` 的 `onOverflow` → `workbench/leaf-overflow`);这一组只画表。
 *
 * ── 「隐藏的标签」只列**本区域**藏起来的那些(W4;W1-a 的留账)─────────
 * 「回哪儿去」这件事本来就记在 `returnTo.region` 上,按它分组是它自己的读法
 * (`store.hiddenInRegion`)。于是顶栏尾格(中央区)与架子叶檐两处各列各的。
 *
 * ── 拖拽的键盘等价:**同一个动作,不是第二条路**(W3 裁定 9;W3-b 补第四组)──
 * 「每个落点都能从既有 tab 菜单到达」。四组菜单项与拖拽落定调的是**同一只**动作
 * (`dropRef(ref, target)` / `pairIntoIndex` / `unpairTab`)—— 两条路走两个动作,
 * 迟早在某一条上悄悄分叉(那正是「菜单里搬过去和拖过去结果不一样」这类 bug 的
 * 全部来源)。落定后 `announce()` 播报一句,与拖拽那条路共用同一句话 —— 播报是
 * **落定**的一部分,不是菜单的装饰(所以那几句住在 `drop-commit` 里,不在这里)。
 *
 * `aria-grabbed` 已废弃,不用(裁定 9 末句)。
 *
 * ── 项名必须带宾语,不许裸方位词(W7-c / B5)────────────────────────────
 * 「右侧」是一个方位,不是一件事。折成子菜单之后动词落在父行上(「移到架子 ▸」
 * / 「分屏 ▸」),子行说的是**宾语**(「右侧栏」/「在右侧」)—— 读起来是一句
 * 完整的话,而不是一列孤零零的方向词。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 中央区有叶(恒有);**换住户**(焦点叶换人)不重挂,只换
 *    `leaf` 这一格 prop —— 「够不着的标签」那张菜单的开合因此活过一次焦点叶切换
 *    (它是「这个动作组此刻开着哪张菜单」,不是「那片叶的状态」);动作表那张
 *    的开合根本不在这只组件里(`workbench/leaf-menu` 那一格 store);
 *    卸载 = 整台壳卸载。
 * ② UI 生命状态:**有够不着的标签**(看不见的 ∪ 隐藏的;⋯ 才画 —— 一颗永远按不动
 *    的钮是纯噪音)/ **两格并排**(表里多「拆开」一项)/ **多叶区域**(架子 / 浮窗:
 *    表里多「分屏 ▸」一节)/ **宿主自带几项**(架子 / 浮窗:表尾多它们那一节)/
 *    只有一格 tab(二合一两项禁灰而不消失)/ **这一格挪不走**(中央区最后一格
 *    常驻内容:撕成浮窗 / 移到架子 ▸ / 关闭 三项禁灰而不消失,U3-b)。
 * ③ UI 交互状态:那颗 ⋯ 随 `ui/IconButton`(rest/hover/focus/active/disabled 全套);
 *    菜单项随 `ui/Menu`,子菜单随 `ui/Menu` 的 `Submenu`。
 */
export function LeafActions({ leaf, hostMenuRows }: { leaf: PaneLeafNode; hostMenuRows?: ReactNode }) {
  const t = useT()
  const allHidden = useWorkbenchStore((st) => st.hidden)
  /*
   * 选出来的是一个**字符串**,不是整张 `regions` —— 订整张表的话,别处任何一棵树
   * 动一下这一组都要重渲(判词与 `PaneLeaf` 那一格逐字同源)。
   */
  const region = useWorkbenchStore((st) => regionOfLeafIn(st.regions, leaf.id))
  const splitLeaf = useWorkbenchStore((st) => st.splitLeaf)
  const restoreHidden = useWorkbenchStore((st) => st.restoreHidden)
  const hidden = useMemo(() => hiddenInRegion(allHidden, region), [allHidden, region])
  const activateTab = useWorkbenchStore((st) => st.activateTab)
  const closeAt = useCloseLeafTab(leaf)
  /*
   * **条上有几格没露全**(W7-t / B1)。量它的是标签条自己(`ui/Tabs` 是那个横滚
   * 容器),这里只读结果 —— 判词与两头的分工写在 `workbench/leaf-overflow.ts` 上。
   * 名单是 refId,要在这条条上找回下标才能激活它。
   */
  const overflow = useLeafOverflow(leaf.id)
  const offscreen = useMemo(
    () =>
      (overflow?.ids ?? [])
        .map((id) => ({ id, at: leaf.tabs.findIndex((ref) => refId(ref) === id) }))
        .filter((row) => row.at >= 0),
    [overflow, leaf.tabs],
  )

  /**
   * 「够不着的标签 ⋯」那张开在哪一点(null = 没开)。它只有这一个开口,所以留在本地
   * —— 与动作表恰好相反,而那正是「有没有第二个开口」这条判据在两处的两个答案。
   */
  const [reachAt, setReachAt] = useState<{ x: number; y: number } | null>(null)
  /*
   * **动作表开在哪一点,住在 `workbench/leaf-menu` 里**(W6-c,设计 v3 §7)。
   *
   * 它从一格本地 `useState` 搬出去,是因为这张表有**好几个开口**:右键一格标签、
   * 键盘 `Shift+F10`、以及(架子 / 浮窗)右键檐上的空白处 —— 而在顶栏那一档里,
   * 标签条与这只组件是 `TopBar` 的两兄弟,够不着彼此的 setState。几个开口开的必须
   * 是**同一张表**,所以「开不开、开在哪」这一格事实只能有一个产地。
   * 判据、项目、动作一格都没搬 —— 它们仍旧整件在这只组件里。
   */
  const menuAt = useLeafMenuAt(leaf.id)
  const closeMenu = useLeafMenuStore((st) => st.closeLeafMenu)
  /**
   * **这张表说的是哪一格**(U3,2026-09-08)。
   *
   * 被右键的那一格(`menuAt.tabId`)优先,指不着时才落回这片叶的活动格。两个
   * 「指不着」都是正当的:右键檐上的空白处说的是「这片叶」,而一格刚被别处关掉
   * 的标签当然找不回下标 —— 两种都退回活动格,那正是 U2 之前的行为。
   *
   * 它为什么非有不可:U2 按用户裁定让**右键不再切标签**,于是「被右键的」与
   * 「活动的」从此可以是两格 —— 而这张表从 W6-c 起一直写死 `leaf.active`,
   * 结果是右键一格非活动标签,关掉的是别人、并进去的是别人的右邻。
   * Chrome / VS Code 的表都作用在被右键的那一格。
   */
  const at = useMemo(() => {
    const named = menuAt?.tabId
      ? leaf.tabs.findIndex((ref) => refId(ref) === menuAt.tabId)
      : -1
    return named >= 0 ? named : leaf.active
  }, [menuAt?.tabId, leaf.tabs, leaf.active])
  const target = leaf.tabs[at] ?? null
  /**
   * **这一格挪得走吗**(U3-b,2026-09-08)。
   *
   * 「中央区至少留一格常驻内容」那条守卫在 U3 收成了一只 `store.canDetachTab`,
   * 拖拽(`useTabDrag.residentRefusal`)与关一格(`closeTab` / `hideTab` /
   * `useCloseLeafTab`)都已经按它拒绝 —— 唯独这张右键表上「撕成浮窗」「移到架子 ▸」
   * 两项调 `dropRef` 时不问它,于是菜单还能把中央区最后一格会话搬走:`pruneRegions`
   * 当场铸一片空叶、叶 id 换人 = 整台聊天区重挂(而 `normalizeRegions` 不在这一拍跑)。
   * **菜单与拖拽是同一个动作,那就得是同一条判据、同一只产地**——这一格因此不新写
   * 判据,读的是 `leaf-tabs.canDetachTabAt`(✕ 画不画走的也是它)。
   *
   * 禁**灰**,不是点下去再拒绝:禁令区那条「一颗按不动的钮与『按了没反应』在屏幕上
   * 是同一件事」说的是**没有提示的空动作**,而 `ui/Menu` 的 `disabled` 形本身就是
   * 那句提示(原生 `disabled` + 灰底,读屏念得出来)。**不加 Tooltip** —— 菜单项上
   * 挂浮层是这张表里的第一份,不是这一批该开的口。播报那条路留在键盘那一侧
   * (`useCloseLeafTab` 的 `workbench.tabNotClosable`):那里没有屏幕上的灰可看。
   *
   * 读成一格**选择器**而不是 `getState()`:表开着的时候树可能变(别处开了第二条
   * 会话),那三项要当场解禁。选出来的是**布尔**,整张 `regions` 不进依赖。
   */
  const detachable = useWorkbenchStore(
    (st) => target !== null && canDetachTabAt(st.regions, leaf.id, at),
  )
  /*
   * **单叶政策**(W6-a,设计 §2.1 / §9):中央区不画「分屏 ▸」——
   * 那里一条标签条,一个标签最多两格,而那件事由「二合一 / 拆开」三项说。
   * 架子与浮窗照旧(设计 §12:那两处的分屏能力不删)。
   *
   * 判据问的是**这个区域收不收成一条标签条**(`SINGLE_LEAF_REGIONS`),不是
   * 「它是不是中央区」—— 政策只有一个产地,菜单与 store 读同一张表。
   */
  const singleLeaf = region !== null && SINGLE_LEAF_REGIONS.includes(region)
  const canSplit = leaf.tabs.length > 1
  /*
   * ── 二合一 / 拆开的键盘等价(W6-a,设计 §7 那张表)────────────────────────
   * 与「移到架子 ▸」逐字同一条纪律:菜单项调的是**拖拽落定同一只动作**
   * (`drop-commit.pairIntoIndex` / `.unpairTab`),两条路走两个动作迟早分叉。
   *
   * 判据一个种类名都不点:「这一格是不是已经两格了」问的是**种类自述**
   * (`partsOfContent`),不是 `active.kind === 'pair'`。
   */
  const isPair = target !== null && partsOfContent(target) !== null
  const canPairLeft = !isPair && at > 0 && partsOfContent(leaf.tabs[at - 1]) === null
  const canPairRight
    = !isPair
      && at < leaf.tabs.length - 1
      && partsOfContent(leaf.tabs[at + 1]) === null

  return (
    <div className={s.actions} data-testid="leaf-actions" data-pane-actions={leaf.id}>
      {/*
        「够不着的标签 ⋯」。**两节都空就不画**:一颗永远按不动的钮是纯噪音,
        而「有没有够不着的东西」本身就是这一组的一格 UI 生命状态。
        W7-c 之后它是这一组**唯一**一颗钮 —— 顶栏右端的两件之一。
      */}
      {(hidden.length > 0 || offscreen.length > 0) && (
        <IconButton
          icon={Ellipsis}
          size="xs"
          label={t('workbench.reachTabs')}
          testId={`pane-hidden:${leaf.id}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setReachAt({ x: rect.left, y: rect.bottom })
          }}
        />
      )}

      {reachAt && (
        <Menu x={reachAt.x} y={reachAt.y} onClose={() => setReachAt(null)} label={t('workbench.reachTabs')}>
          {/*
            ── 第一节:**看不见的**(条太窄,它被滚出了视野)────────────────
            选一格 = 激活它 **+ 滚进视野**。滚那一下由标签条自己做
            (`TabsOverflow.reveal`)—— 同一个 refId 可以在两片叶里各开一格,
            外面按 id 现查 DOM 分不出该滚哪一条。
          */}
          {offscreen.length > 0 && (
            <>
              <MenuSection>{t('workbench.offscreenTabs')}</MenuSection>
              {offscreen.map((row) => {
                const ref = leaf.tabs[row.at]
                return (
                  <MenuItem
                    key={row.id}
                    onClick={() => {
                      activateTab(leaf.id, row.at)
                      overflow?.reveal(row.id)
                      setReachAt(null)
                    }}
                  >
                    <span className={s.menuLine}>
                      <span className={s.menuMain}>
                        {contentKindOf(ref.kind)?.title(ref).text ?? ref.key}
                      </span>
                    </span>
                  </MenuItem>
                )
              })}
            </>
          )}
          {/* ── 第二节:**隐藏的**(收进了隐藏表)。判词见 `hiddenInRegion`。 ── */}
          {hidden.length > 0 && (
            <>
              <MenuSection>{t('workbench.hiddenTabs')}</MenuSection>
              {hidden.map((entry) => {
                const id = refId(entry.ref)
                const kind = contentKindOf(entry.ref.kind)
                return (
                  <MenuItem
                    key={id}
                    onClick={() => {
                      restoreHidden(id)
                      setReachAt(null)
                    }}
                  >
                    <span className={s.menuLine}>
                      <span className={s.menuMain}>{kind?.title(entry.ref).text ?? entry.ref.key}</span>
                      <span className={s.menuTrail}>{t('workbench.hiddenNote')}</span>
                    </span>
                  </MenuItem>
                )
              })}
            </>
          )}
        </Menu>
      )}

      {menuAt && (
        /*
         * **无障碍名是「标签动作」,不是「分屏」**(W6-c):这张表里装着二合一 /
         * 拆开 / 移到架子 / 撕成浮窗 / 关闭,中央区连分屏都不画。读屏软件念出来的
         * 那个名字必须说得出这张表**是什么**。
         *
         * ── 六项(W7-c 裁定 3)────────────────────────────────────────────
         *   与右边的标签二合一 / 与左边的标签二合一 / 拆开(**只在两格标签上出现**)
         *   / 撕成浮窗 / 移到架子 ▸ / 关闭
         * 架子叶与浮窗叶多一节「分屏 ▸」,再多宿主自己那几项。
         */
        <Menu x={menuAt.x} y={menuAt.y} onClose={closeMenu} label={t('workbench.tabActions')}>
          {/*
            **二合一 / 拆开**(W6-a,设计 §7)。三项作用在**这张表的目标格**上
            (U3:被右键的那一格,指不着才是活动格 —— 判词在上面 `at` 那一格),
            调的是拖拽落定同一只动作。播报一句(与换序那一句同一条纪律:
            播报是**落定**的一部分)。
          */}
          <MenuItem
            disabled={!canPairRight}
            onClick={() => {
              if (!canPairRight || !target) return
              /* **同一只落定动作**(W6-b):拖拽落定 /「放到标签上」松手 / 这一项走的都是它,
               * 播报那一句也在它里面 —— 三处各写一遍,迟早说岔。
               * 「右边」以**目标格**为准(U3):被右键的那一格的右邻,不是活动格的。 */
              pairIntoIndex(leaf.tabs[at + 1], leaf.id, at, 'right')
              closeMenu()
            }}
          >
            <span className={s.menuLine}>
              <Columns2 className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.menuMain}>{t('workbench.pairRight')}</span>
            </span>
          </MenuItem>
          <MenuItem
            disabled={!canPairLeft}
            onClick={() => {
              if (!canPairLeft || !target) return
              pairIntoIndex(leaf.tabs[at - 1], leaf.id, at, 'left')
              closeMenu()
            }}
          >
            <span className={s.menuLine}>
              <Columns2 className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.menuMain}>{t('workbench.pairLeft')}</span>
            </span>
          </MenuItem>
          {/*
            **「拆开」只在两格标签上出现**(W7-c 裁定 3)。W6-a 时它是禁灰的一行,
            理由是「这张菜单的形状不该随上下文变」;用户 09-05 说「菜单太多」,
            而这一项与那条纪律恰好是两回事 —— 禁灰说的是「此刻做不了」,普通标签上
            「拆开」**没有对象**,那与「分屏在中央区不画」是同一句话。
          */}
          {isPair && (
            <MenuItem
              onClick={() => {
                /* **同一只拆开动作**(W6-c):格缝中点那颗把手走的也是它,播报那一句
                 * 在它里面 —— 修前这里自己念一句,而那颗把手一声不吭。 */
                unpairTab(leaf.id, at)
                closeMenu()
              }}
            >
              <span className={s.menuLine}>
                <Unlink className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
                <span className={s.menuMain}>{t('workbench.unpair')}</span>
              </span>
            </MenuItem>
          )}

          {/*
            **撕成浮窗 / 移到架子 ▸**(W3 裁定 9)。两组都作用在**这张表的目标格**
            上,调的是拖拽落定那同一只 `dropRef` —— 所以「移到右侧栏」在菜单里与
            拖过去结果逐字相同,包括架子展开、位置记忆与落定后的焦点跟随。
            没有活动 tab(空叶,屏幕上停不到一帧)、**或者这一格挪不走**(中央区
            最后一格常驻内容,U3-b 的 `detachable`)时整组禁灰而不消失 ——
            「此刻不行」是禁灰,与「这个区域里不存在这件事」(分屏 / 拆开那两处
            的不画)是两句不同的话。
          */}
          <MenuSeparator />
          <MenuItem
            disabled={!detachable}
            onClick={() => {
              if (!detachable || !target) return
              dropRef(target, { kind: 'float' })
              announce(t('drag.movedToFloat'))
              closeMenu()
            }}
          >
            <span className={s.menuLine}>
              <PictureInPicture2 className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.menuMain}>{t('drag.menuTearOff')}</span>
            </span>
          </MenuItem>
          {/*
            四条边折成一格子菜单(W7-c):八行平铺是「菜单太多」的一半。
            折叠那件事本身是库件(`ui/Menu` 的 `Submenu`),这里只交出**表**。
          */}
          <Submenu label={t('drag.menuMoveTo')} disabled={!detachable}>
            {EDGE_CHOICES.map((choice) => (
              <MenuItem
                key={choice.side}
                onClick={() => {
                  if (!detachable || !target) return
                  dropRef(target, { kind: 'edge', side: choice.side })
                  announce(t('drag.movedToEdge', { side: t(choice.sideKey) }))
                  closeMenu()
                }}
              >
                <span className={s.menuLine}>
                  <span className={s.menuMain}>{t(choice.shelfKey)}</span>
                </span>
              </MenuItem>
            ))}
          </Submenu>

          {/*
            **分屏 ▸ 只在多叶区域画**(W6-a / W7-c):中央区收成一条标签条之后,
            那四项在那里根本没有落点 —— 一颗永远做不成的动作比禁灰更糟。
          */}
          {!singleLeaf && (
            <Submenu label={t('workbench.split')} disabled={!canSplit}>
              {SPLIT_CHOICES.map((choice) => (
                <MenuItem
                  key={choice.id}
                  onClick={() => {
                    splitLeaf(leaf.id, choice.dir, undefined, choice.before)
                    closeMenu()
                  }}
                >
                  <span className={s.menuLine}>
                    <choice.Icon className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
                    <span className={s.menuMain}>{t(choice.labelKey)}</span>
                  </span>
                </MenuItem>
              ))}
            </Submenu>
          )}

          {/*
            **关闭这一格**(W7-c 裁定 3 的第六项)。它走的是与 tab 上那颗 ✕、
            与 `⌘W` **同一只** `useCloseLeafTab` —— 那一口自己会先问种类
            (`beforeClose`,脏文件那一问)、自己会在关不掉时播报。
            禁灰的判据与上面两项是**同一格**(U3-b):关不掉的那一格,屏幕上那颗 ✕
            本来就不画(`ui/Tabs` 那句「一颗按不动的 ✕ 与『按了没反应』是同一件事」),
            表里再摆一行按下去只播报一句「关不掉」的项,说的是同一句自相矛盾的话。
            那句播报没有删 —— 它归键盘那条路(⌘W / Delete),那里没有灰可看。
          */}
          <MenuSeparator />
          <MenuItem
            disabled={!detachable}
            onClick={() => {
              if (!detachable || !target) return
              void closeAt(at)
              closeMenu()
            }}
          >
            <span className={s.menuLine}>
              <X className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.menuMain}>{t('workbench.tabClose')}</span>
            </span>
          </MenuItem>

          {/*
            **宿主自己那几项**(W7-c 裁定 4)。架子交「弹出为浮窗 / 关闭整栏」,
            浮窗交「钉到边 ▸ / 上舞台」—— 它们从檐上的钮搬进来,调的仍是同一只
            store 动作。这只组件一个宿主名都不认识:宿主自述,它只挂。
          */}
          {hostMenuRows}
        </Menu>
      )}
    </div>
  )
}

/**
 * 「移到架子」四边。**一张表**,与 `SPLIT_CHOICES` 同一条纪律 —— 四条边不是
 * 四段 onClick。三格键各有各的用处:`shelfKey` 是**菜单里那一行**(W7-c 起子菜单
 * 里写的是宾语「右侧栏」,父行那句动词「移到架子」写在 `Submenu` 上,合起来读成
 * 一句完整的话);`sideKey` 是**播报**里那个名词(「已移到右侧」)。
 * 图标那一格随平铺一起退役了 —— 子菜单里四行同一个方向族,四枚双箭头只是噪音。
 */
const EDGE_CHOICES: readonly {
  side: ShelfSide
  shelfKey: MessageKey
  sideKey: MessageKey
}[] = [
  /* 架子那四个名字复用 `shelf.label*`(「左侧栏」…)—— 同一件东西在檐上、在
   * 播报里、在这张表里说的是同一个词,i18n 那条「同一句话不该有第二个键」。 */
  { side: 'left', shelfKey: 'shelf.labelLeft', sideKey: 'drag.sideLeft' },
  { side: 'right', shelfKey: 'shelf.labelRight', sideKey: 'drag.sideRight' },
  { side: 'top', shelfKey: 'shelf.labelTop', sideKey: 'drag.sideTop' },
  { side: 'bottom', shelfKey: 'shelf.labelBottom', sideKey: 'drag.sideBottom' },
]

/** 分屏四向。**一张表**,不是四个 onClick 各写一遍。 */
const SPLIT_CHOICES = [
  { id: 'right', dir: 'row', before: false, Icon: Columns2, labelKey: 'workbench.splitRight' },
  { id: 'left', dir: 'row', before: true, Icon: Columns2, labelKey: 'workbench.splitLeft' },
  { id: 'down', dir: 'col', before: false, Icon: Rows2, labelKey: 'workbench.splitDown' },
  { id: 'up', dir: 'col', before: true, Icon: Rows2, labelKey: 'workbench.splitUp' },
] as const
