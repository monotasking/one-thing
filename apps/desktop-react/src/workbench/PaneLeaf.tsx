import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Columns2, Ellipsis, Rows2 } from '../components/icons'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { FocusScope } from '../focus/FocusScope'
import { useLiveTitleStore } from '../stage/live-title'
import { useT } from '../i18n'
import { contentKindOf, mayCloseContent, refId } from './kinds'
import { LeafStrip, tabSpecOf } from './LeafStrip'
import { renderRef } from './render'
import { canDetachTab, useWorkbenchStore } from './store'
import type { TabSpec } from '../ui/Tabs'
import type { ContentRef } from './kinds'
import type { PaneLeafNode } from './tree'
import s from './PaneLeaf.module.css'

/**
 * **一片叶 = 一组 tab + 一条檐**(W1,设计 §2.2「一格一檐」)。
 *
 * 规则只有一条:**一片叶只有一条檐,那条檐就是 tab 条;内容自己不画檐。**
 * 于是从前那两颗语义不同的 ✕(查看器自己那颗 = 关文件 / 宿主檐那颗 = 收回 Dock)
 * 塌成一颗:**tab 上那颗 ✕ = 关闭这一格**。
 *
 * 本批叶檐挂在**叶顶**(样例 A 形)。W1-b 把中央叶那一条搬进窗口顶栏(样例 D),
 * 那时变的只有「这条檐画在哪儿」——它交出去的数据表(下面那张 `tabs`)与
 * 它认的那几个动作一个字都不用改。
 *
 * ── 檐本身出文件了(W1-a 修批)────────────────────────────────────────────
 * 那条带子的**画法**与它那张数据表都搬去了 `./LeafStrip`,因为它有了第二个宿主:
 * 「面板内」那一档的查看器不在树里,但它也是一「格」,该有同一条身份带
 * (修前它一条檐都没有,关文件只剩右键与 Esc)。这只文件留下的是**叶自己**的事:
 * 哪几格(树)、关一格要不要先问(种类)、⋯ 与分屏那两颗(树的动作)。
 * 三张状态表里凡属于那条带子的,现在写在 `LeafStrip` 上,这里不留第二份。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载      树里出现这片叶(出厂那一片、或一次分屏)
 *   首载      第一个 tab 的内容异步到达 —— 由内容自己说(查看器的「正在读取…」),
 *             叶檐**不画载入态**:它说的是「这儿有哪几格」,那件事是同步已知的
 *   换宿主    整棵树随区域搬(center → edge → float,W4):**叶不重挂,只换外框** ——
 *             结构共享保证的(`tree.mapLeaf` 没改到的支原样带过),不是靠自觉
 *   卸载      最后一个 tab 关掉 / 藏起来,叶被 `prune` 剪掉
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   有隐藏    檐右端多一颗 ⋯(没有隐藏时**不画**:一颗永远按不动的钮是纯噪音)
 *   (单 tab / 多 tab / 预览 / 超量这四格是**那条带子**的生命状态,
 *    写在 `LeafStrip` 上 —— 它有两个宿主,那张表不该跟着某一个宿主走)
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   檐 · ⋯ / 分屏   随 `ui/IconButton`(rest/hover/focus/active/disabled 全套)
 *   菜单项          随 `ui/Menu`(禁灰而不消失:只有一格 tab 时分屏四项禁灰)
 *   分隔杆          随 `ui/Splitter`(在 `PaneTree` 上,不在这里)
 *   (tab / ✕ / 未保存丸 / 名字那格 Tooltip 同上,在 `LeafStrip` 上)
 */
export const PaneLeaf = memo(function PaneLeaf({ leaf }: { leaf: PaneLeafNode }) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const titles = useLiveTitleStore((st) => st.titles)
  const hidden = useWorkbenchStore((st) => st.hidden)
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  const activateTab = useWorkbenchStore((st) => st.activateTab)
  const setFocusLeaf = useWorkbenchStore((st) => st.setFocusLeaf)
  const splitLeaf = useWorkbenchStore((st) => st.splitLeaf)
  const restoreHidden = useWorkbenchStore((st) => st.restoreHidden)

  /** ⋯ / 分屏两张菜单开在哪一点(null = 没开)。两张各一格,不共用一个布尔。 */
  const [hiddenAt, setHiddenAt] = useState<{ x: number; y: number } | null>(null)
  const [splitAt, setSplitAt] = useState<{ x: number; y: number } | null>(null)

  const active = leaf.tabs[leaf.active] ?? null

  /**
   * **关一格**:先问种类(`beforeClose` —— 脏文件那一问),答 `'close'` 才真关。
   * 这一问必须在**叶檐**这一侧发起:被关掉的那棵树自己问不了自己。
   */
  const closeAt = useCallback(async (index: number) => {
    const ref = leaf.tabs[index]
    if (!ref) return
    if (!(await mayCloseContent(ref))) return
    // 问那一句是异步的 —— 回来之后 index 可能已经不指着同一格了(隔壁被关掉、
    // 别处插了一格)。所以**按 refId 重新定位**,不拿旧下标去关。
    const live = useWorkbenchStore.getState()
    const region = regionOfLeaf(live, leaf.id)
    const tree = region ? live.regions[region] : undefined
    const at = tree ? leafTabsOf(tree, leaf.id).findIndex((tab) => refId(tab) === refId(ref)) : -1
    if (at < 0) return
    live.closeTab(leaf.id, at)
  }, [leaf.id, leaf.tabs])

  /**
   * tab 条那张**数据表**。身份两半合在这里:静态那一半问种类(`kind.title`),
   * 活的那一半读 `live-title`(键 = refId,由内容自己发布)—— 活的盖静的。
   */
  const tabs = useMemo<TabSpec[]>(
    () =>
      leaf.tabs.map((ref) =>
        tabSpecOf(ref, titles, {
          preview: leaf.preview === refId(ref),
          closable: canDetachTabIn(leaf, ref),
        }),
      ),
    // `titles` 是整张表 —— 它变就重算,那正是「未保存丸要跟着动」要的。
    [leaf, titles],
  )

  const canSplit = leaf.tabs.length > 1
  const toolbar = active ? contentKindOf(active.kind)?.toolbar?.(active) : null

  /** ⌘W:关当前 tab。表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.leaf.keys`。 */
  const leafKeys = useMemo(
    () => ({ closeTab: active ? () => void closeAt(leaf.active) : undefined }),
    [active, closeAt, leaf.active],
  )

  return (
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} keyHandlers={leafKeys}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.leaf}
          data-pane-leaf={leaf.id}
          data-pane-focus={focusLeafId === leaf.id || undefined}
          /*
           * 点这片叶的任何地方 = 它成为焦点叶(「新标签开在哪一片」的答案)。
           * 用 `onPointerDownCapture` 而不是 click:分屏菜单那颗钮按下去时就该
           * 先把焦点叶指过来,不然新叶会长在隔壁那片上。
           */
          onPointerDownCapture={() => setFocusLeaf(leaf.id)}
        >
          {/*
            叶檐 = **那条共用的带子**(`./LeafStrip`,面板内分栏画的是同一件)。
            这里交出去的只有叶自己知道的三样:哪几格、切/关这两口、以及**树的**
            动作组(⋯ / 分屏 —— 面板内那一档没有这两颗,因为它不是树)。
          */}
          <LeafStrip
            tabs={tabs}
            activeId={active ? refId(active) : null}
            label={t('workbench.leafTabs')}
            chromeId={leaf.id}
            tool={toolbar}
            onSelect={(id) => {
              const at = leaf.tabs.findIndex((ref) => refId(ref) === id)
              if (at >= 0) activateTab(leaf.id, at)
            }}
            onClose={(id) => {
              const at = leaf.tabs.findIndex((ref) => refId(ref) === id)
              if (at >= 0) void closeAt(at)
            }}
            actions={
              <>
                {/*
                  「隐藏的标签 ⋯」。**没有隐藏就不画**:一颗永远按不动的钮是纯噪音,
                  而「有没有藏起来的东西」本身就是这条檐的一格 UI 生命状态。
                */}
                {hidden.length > 0 && (
                  <IconButton
                    icon={Ellipsis}
                    size="xs"
                    label={t('workbench.hiddenTabs')}
                    testId={`pane-hidden:${leaf.id}`}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setHiddenAt({ x: rect.left, y: rect.bottom })
                    }}
                  />
                )}
                <IconButton
                  icon={Columns2}
                  size="xs"
                  label={t('workbench.split')}
                  testId={`pane-split:${leaf.id}`}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setSplitAt({ x: rect.left, y: rect.bottom })
                  }}
                />
              </>
            }
          />

          {/*
            身 = 这片叶里**每一个** tab 的内容(keep-alive,与架子同一条判据):
            切 tab 只换哪一层显形,不卸载谁 —— 重面板(会话总览那 400 张卡)
            不必每次切回都重建,查看器的滚动位与草稿也不会因为切走一格就没了。
          */}
          <div className={s.body} data-pane-body={leaf.id}>
            {leaf.tabs.map((ref, index) => (
              <PaneTabLayer key={refId(ref)} tabRef={ref} on={index === leaf.active} />
            ))}
          </div>

          {hiddenAt && (
            <Menu
              x={hiddenAt.x}
              y={hiddenAt.y}
              onClose={() => setHiddenAt(null)}
              label={t('workbench.hiddenTabs')}
            >
              <MenuSection>{t('workbench.hiddenTabs')}</MenuSection>
              {hidden.map((entry) => {
                const id = refId(entry.ref)
                const kind = contentKindOf(entry.ref.kind)
                return (
                  <MenuItem
                    key={id}
                    onClick={() => {
                      restoreHidden(id)
                      setHiddenAt(null)
                    }}
                  >
                    <span className={s.menuLine}>
                      <span className={s.menuMain}>{kind?.title(entry.ref).text ?? entry.ref.key}</span>
                      <span className={s.menuTrail}>{t('workbench.hiddenNote')}</span>
                    </span>
                  </MenuItem>
                )
              })}
            </Menu>
          )}

          {splitAt && (
            <Menu
              x={splitAt.x}
              y={splitAt.y}
              onClose={() => setSplitAt(null)}
              label={t('workbench.split')}
            >
              <MenuSection>{t('workbench.split')}</MenuSection>
              {SPLIT_CHOICES.map((choice) => (
                <MenuItem
                  key={choice.id}
                  /*
                   * **禁灰而不消失**:只有一格 tab 时切不动(切出去原叶就空了),
                   * 但这张菜单的形状不该随上下文变。
                   */
                  disabled={!canSplit}
                  onClick={() => {
                    splitLeaf(leaf.id, choice.dir, undefined, choice.before)
                    setSplitAt(null)
                  }}
                >
                  <span className={s.menuLine}>
                    <choice.Icon className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
                    <span className={s.menuMain}>{t(choice.labelKey)}</span>
                  </span>
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      )}
    </FocusScope>
  )
})

/**
 * 一格 tab 的内容层。**`inert` 说两遍,而且是同一个判据**(逐字照 `EdgeShelf`):
 * 一遍给 DOM(浏览器据此把这一层移出焦点序与辅助树),一遍给树
 * (`<FocusScope inert>` —— 注册表据此不选它当第一响应者,而且**路径经过它就在
 * 那儿截断**)。少了给树的那一遍,后台那格照样能被算成第一响应者,它的局部键
 * 会在看不见的地方响;少了给 DOM 的那一遍,焦点能 Tab 进一块看不见的面。
 *
 * ── 为什么它也是一格 `leaf` 作用域 ───────────────────────────────────────
 * 树上同一个 scope id 可以有好几份实例(`ScopeNode.instanceId`),取哪一份靠
 * `owner`。这里的 owner 是**这一格的 refId**,而叶根那一格的 owner 是**叶 id** ——
 * 于是 `activateScope('leaf', { owner: leafId })`(跟焦那条路)精确取到叶根,
 * 而这一层只做一件事:**把看不见的那一格从活动路径上摘掉**。
 *
 * `memo` 不许省:切一次 tab 只有翻了 `on` 的那两层该重渲,别的 tab 一动不动
 * (与 `ShelfTabLayer` 同一条读数背书)。
 */
const PaneTabLayer = memo(function PaneTabLayer({ tabRef, on }: { tabRef: ContentRef; on: boolean }) {
  const visibility = useMemo(() => ({ visible: on, interactive: on }), [on])
  return (
    <FocusScope scope="leaf" inert={!on} owner={refId(tabRef)}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={on ? s.layer : `${s.layer} ${s.layerHidden}`}
          data-pane-tab={refId(tabRef)}
          data-pane-on={on || undefined}
          inert={!on || undefined}
        >
          {renderRef(tabRef, visibility)}
        </div>
      )}
    </FocusScope>
  )
})

/** 分屏四向。**一张表**,不是四个 onClick 各写一遍。 */
const SPLIT_CHOICES = [
  { id: 'right', dir: 'row', before: false, Icon: Columns2, labelKey: 'workbench.splitRight' },
  { id: 'left', dir: 'row', before: true, Icon: Columns2, labelKey: 'workbench.splitLeft' },
  { id: 'down', dir: 'col', before: false, Icon: Rows2, labelKey: 'workbench.splitDown' },
  { id: 'up', dir: 'col', before: true, Icon: Rows2, labelKey: 'workbench.splitUp' },
] as const

/** 这一格画不画 ✕。判据整件在 `store.canDetachTab`(种类自述,不是种类名)。 */
function canDetachTabIn(leaf: PaneLeafNode, ref: ContentRef): boolean {
  const state = useWorkbenchStore.getState()
  const region = regionOfLeaf(state, leaf.id)
  const tree = region ? state.regions[region] : undefined
  if (!tree) return true
  return canDetachTab(tree, leaf.id, leaf.tabs.indexOf(ref))
}

function regionOfLeaf(
  state: ReturnType<typeof useWorkbenchStore.getState>,
  leafId: string,
): string | null {
  for (const [region, tree] of Object.entries(state.regions)) {
    if (findLeafId(tree, leafId)) return region
  }
  return null
}

function findLeafId(node: import('./tree').PaneNode, leafId: string): boolean {
  if (node.kind === 'leaf') return node.id === leafId
  return findLeafId(node.a, leafId) || findLeafId(node.b, leafId)
}

/** 这片叶此刻那几格 —— `closeAt` 在 await 之后重新定位时用。 */
function leafTabsOf(node: import('./tree').PaneNode, leafId: string): readonly ContentRef[] {
  if (node.kind === 'leaf') return node.id === leafId ? node.tabs : []
  const a = leafTabsOf(node.a, leafId)
  return a.length > 0 ? a : leafTabsOf(node.b, leafId)
}
