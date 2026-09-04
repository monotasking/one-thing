import { useState } from 'react'
import { Columns2, Ellipsis, Rows2 } from '../components/icons'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { useT } from '../i18n'
import { contentKindOf, refId } from './kinds'
import { useWorkbenchStore } from './store'
import type { PaneLeafNode } from './tree'
import s from './LeafActions.module.css'

/**
 * **一片叶的动作组**(W1-b 从 `PaneLeaf` 抽出来:分屏 ▸ / 隐藏的标签 ⋯ / 型工具条)。
 *
 * 设计 §2.2 的 D 稿把它摆在**顶栏右端**,而且只画**焦点叶**那一组:
 * 「顶栏从左到右:红绿灯让位 → 中央区各片叶的标签组 → 右端是焦点叶的动作组」。
 * 所以它不再是每片叶各画一份 —— 分屏出来的叶自己不画檐,也不画动作。
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
  const hidden = useWorkbenchStore((st) => st.hidden)
  const splitLeaf = useWorkbenchStore((st) => st.splitLeaf)
  const restoreHidden = useWorkbenchStore((st) => st.restoreHidden)

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
        </Menu>
      )}
    </div>
  )
}

/** 分屏四向。**一张表**,不是四个 onClick 各写一遍。 */
const SPLIT_CHOICES = [
  { id: 'right', dir: 'row', before: false, Icon: Columns2, labelKey: 'workbench.splitRight' },
  { id: 'left', dir: 'row', before: true, Icon: Columns2, labelKey: 'workbench.splitLeft' },
  { id: 'down', dir: 'col', before: false, Icon: Rows2, labelKey: 'workbench.splitDown' },
  { id: 'up', dir: 'col', before: true, Icon: Rows2, labelKey: 'workbench.splitUp' },
] as const
