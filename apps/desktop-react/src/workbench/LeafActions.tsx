import { useMemo, useState } from 'react'
import {
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  Columns2,
  Ellipsis,
  PictureInPicture2,
  Rows2,
} from '../components/icons'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { announce } from '../ui/a11y/live-region'
import { useT } from '../i18n'
import { dropRef } from './drop-commit'
import { contentKindOf, refId } from './kinds'
import { hiddenInRegion, regionOfLeafIn, useWorkbenchStore } from './store'
import type { MessageKey } from '../i18n'
import type { ShelfSide } from '../stage/types'
import type { PaneLeafNode } from './tree'
import s from './LeafActions.module.css'

/**
 * **一片叶的动作组**(W1-b 从 `PaneLeaf` 抽出来:分屏 ▸ / 隐藏的标签 ⋯ / 型工具条)。
 *
 * 设计 §2.2 的 D 稿把它摆在**顶栏右端**,而且只画**焦点叶**那一组:
 * 「顶栏从左到右:红绿灯让位 → 中央区各片叶的标签组 → 右端是焦点叶的动作组」。
 * 所以在**中央区**它不再是每片叶各画一份 —— 分屏出来的叶自己不画檐,也不画动作。
 *
 * ── 第二个宿主:架子 / 浮窗那片叶的檐(W4)──────────────────────────────
 * 那两处没有第二条顶栏可借,檐就画在叶顶(`PaneLeaf` 的 `PaneLeafStrip`),
 * 这一组因此挂在那条檐的右端、宿主自己那几颗之前。**同一件**,不是第二份实现。
 *
 * ── 「隐藏的标签 ⋯」只列**本区域**藏起来的那些(W4;W1-a 的留账)─────────
 * 修前这格菜单列的是**全部**隐藏项,于是右架子的檐上会列出中央区藏起来的文件 ——
 * 点回去,它出现在你看不见的另一块地方。「回哪儿去」这件事本来就记在
 * `returnTo.region` 上,按它分组是它自己的读法(`store.hiddenInRegion`)。
 * 于是顶栏尾格(中央区)与架子叶檐两处各列各的,而判据只有这一句。
 *
 * ── 拖拽的键盘等价:**同一个动作,不是第二条路**(W3 裁定 9)────────────
 * 「不加新键位组合;每个落点都能从既有 tab 菜单到达」。分屏 ▸ 四向本来就在,
 * W3 补上另外两组:**移到架子 ▸ 四边** 与 **撕成浮窗**。三组菜单项与拖拽落定
 * 调的是**同一只** `dropRef(ref, target)` —— 两条路走两个动作,迟早在某一条上
 * 悄悄分叉(那正是「菜单里搬过去和拖过去结果不一样」这类 bug 的全部来源)。
 * 落定后 `announce()` 播报一句(「已移到右侧」/「已并入 X」/「已撕成浮窗」),
 * 与拖拽那条路共用同一句话 —— 播报是**落定**的一部分,不是菜单的装饰。
 *
 * `aria-grabbed` 已废弃,不用(裁定 9 末句)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 中央区有叶(恒有);**换住户**(焦点叶换人)不重挂,只换
 *    `leaf` 这一格 prop —— 两张菜单的开合状态因此活过一次焦点叶切换(它们是
 *    「这个动作组此刻开着哪张菜单」,不是「那片叶的状态」);卸载 = 整台壳卸载。
 * ② UI 生命状态:**有隐藏**(⋯ 才画 —— 一颗永远按不动的钮是纯噪音)/ 有型工具条
 *    (活动那一格的种类自述了 `toolbar` 才画)/ 只有一格 tab(分屏四项禁灰而不消失)。
 * ③ UI 交互状态:两颗钮随 `ui/IconButton`(rest/hover/focus/active/disabled 全套);
 *    菜单项随 `ui/Menu`。
 */
export function LeafActions({ leaf }: { leaf: PaneLeafNode }) {
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

  /** ⋯ / 分屏两张菜单开在哪一点(null = 没开)。两张各一格,不共用一个布尔。 */
  const [hiddenAt, setHiddenAt] = useState<{ x: number; y: number } | null>(null)
  const [splitAt, setSplitAt] = useState<{ x: number; y: number } | null>(null)

  const active = leaf.tabs[leaf.active] ?? null
  // 型工具条走**种类自述**那条唯一的口 —— 动作组不认识「markdown 有个渲染⇄源码开关」。
  const toolbar = active ? contentKindOf(active.kind)?.toolbar?.(active) : null
  const canSplit = leaf.tabs.length > 1

  return (
    <div className={s.actions} data-testid="leaf-actions" data-pane-actions={leaf.id}>
      {toolbar && <span className={s.tool}>{toolbar}</span>}
      {/*
        「隐藏的标签 ⋯」。**没有隐藏就不画**:一颗永远按不动的钮是纯噪音,
        而「有没有藏起来的东西」本身就是这一组的一格 UI 生命状态。
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

      {hiddenAt && (
        <Menu x={hiddenAt.x} y={hiddenAt.y} onClose={() => setHiddenAt(null)} label={t('workbench.hiddenTabs')}>
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
        <Menu x={splitAt.x} y={splitAt.y} onClose={() => setSplitAt(null)} label={t('workbench.split')}>
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

          {/*
            **拖拽的键盘等价**(W3 裁定 9)。两组都作用在**这一格活动 tab** 上,
            调的是拖拽落定那同一只 `dropRef` —— 所以「移到右侧」在菜单里与拖过去
            结果逐字相同,包括架子展开、位置记忆与落定后的焦点跟随。
            没有活动 tab(空叶,屏幕上停不到一帧)时整组禁灰而不消失。
          */}
          <MenuSeparator />
          <MenuSection>{t('drag.menuMoveTo')}</MenuSection>
          {EDGE_CHOICES.map((choice) => (
            <MenuItem
              key={choice.side}
              disabled={!active}
              onClick={() => {
                if (!active) return
                dropRef(active, { kind: 'edge', side: choice.side })
                announce(t('drag.movedToEdge', { side: t(choice.sideKey) }))
                setSplitAt(null)
              }}
            >
              <span className={s.menuLine}>
                <choice.Icon className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
                <span className={s.menuMain}>{t(choice.labelKey)}</span>
              </span>
            </MenuItem>
          ))}
          <MenuItem
            disabled={!active}
            onClick={() => {
              if (!active) return
              dropRef(active, { kind: 'float' })
              announce(t('drag.movedToFloat'))
              setSplitAt(null)
            }}
          >
            <span className={s.menuLine}>
              <PictureInPicture2 className={s.menuIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.menuMain}>{t('drag.menuTearOff')}</span>
            </span>
          </MenuItem>
        </Menu>
      )}
    </div>
  )
}

/**
 * 「移到架子」四边。**一张表**,与 `SPLIT_CHOICES` 同一条纪律 —— 四条边不是
 * 四段 onClick。`sideKey` 单列一格是因为播报那句话要的是「右侧」这个名词,
 * 而菜单项上写的是「移到右侧」这个动词短语:同一件事的两种说法,各有各的键。
 */
const EDGE_CHOICES: readonly {
  side: ShelfSide
  Icon: typeof ChevronsLeft
  labelKey: MessageKey
  sideKey: MessageKey
}[] = [
  /* 图标复用**架子那一族**的四向双箭头(`EdgeShelf` 的收 / 展用的就是它们):
   * 同一个方向词汇在两处说的是同一件事,不新造一套。 */
  { side: 'left', Icon: ChevronsLeft, labelKey: 'drag.toEdgeLeft', sideKey: 'drag.sideLeft' },
  { side: 'right', Icon: ChevronsRight, labelKey: 'drag.toEdgeRight', sideKey: 'drag.sideRight' },
  { side: 'top', Icon: ChevronsUp, labelKey: 'drag.toEdgeTop', sideKey: 'drag.sideTop' },
  { side: 'bottom', Icon: ChevronsDown, labelKey: 'drag.toEdgeBottom', sideKey: 'drag.sideBottom' },
]

/** 分屏四向。**一张表**,不是四个 onClick 各写一遍。 */
const SPLIT_CHOICES = [
  { id: 'right', dir: 'row', before: false, Icon: Columns2, labelKey: 'workbench.splitRight' },
  { id: 'left', dir: 'row', before: true, Icon: Columns2, labelKey: 'workbench.splitLeft' },
  { id: 'down', dir: 'col', before: false, Icon: Rows2, labelKey: 'workbench.splitDown' },
  { id: 'up', dir: 'col', before: true, Icon: Rows2, labelKey: 'workbench.splitUp' },
] as const
