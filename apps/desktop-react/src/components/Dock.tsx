import { Fragment, useState } from 'react'
import { useStageStore } from '../stage/store'
import { GLOBAL_ITEMS, SESSION_ITEMS } from '../stage/items'
import { DockTile } from './DockTile'
import { useMagnify } from './useMagnify'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import { DOCK_AXIS } from '../stage/types'
import type {
  DockAlign,
  DockEdge,
  DockSize,
  OpenBehavior,
  StageItemSpec,
} from '../stage/types'
import type { LabelSide } from './DockTile'
import s from './Dock.module.css'

const REST_FACTOR = 1

/** 瓷砖在条上的线性次序 —— 磁性放大按这个次序索引,分隔线不占位。 */
type Tile =
  | { kind: 'item'; item: StageItemSpec }
  | { kind: 'plus' }

const TILES: Tile[] = [
  ...SESSION_ITEMS.map((item) => ({ kind: 'item' as const, item })),
  ...GLOBAL_ITEMS.map((item) => ({ kind: 'item' as const, item })),
  { kind: 'plus' },
]
const SEP_AFTER = SESSION_ITEMS.length - 1

/** 菜单里的三选:'default' 是「不表态」,另两个是明确落点。 */
const OPEN_CHOICES: Array<{ value: OpenBehavior; labelKey: MessageKey }> = [
  { value: 'default', labelKey: 'dock.openDefault' },
  { value: 'stage', labelKey: 'dock.openStage' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
]

const EDGE_CHOICES: Array<{ value: DockEdge; labelKey: MessageKey }> = [
  { value: 'bottom', labelKey: 'dock.edgeBottom' },
  { value: 'top', labelKey: 'dock.edgeTop' },
  { value: 'left', labelKey: 'dock.edgeLeft' },
  { value: 'right', labelKey: 'dock.edgeRight' },
]

const ALIGN_CHOICES: Array<{ value: DockAlign; labelKey: MessageKey }> = [
  { value: 'start', labelKey: 'dock.alignStart' },
  { value: 'center', labelKey: 'dock.alignCenter' },
  { value: 'end', labelKey: 'dock.alignEnd' },
]

const SIZE_CHOICES: Array<{ value: DockSize; labelKey: MessageKey }> = [
  { value: 'sm', labelKey: 'dock.sizeSm' },
  { value: 'md', labelKey: 'dock.sizeMd' },
  { value: 'lg', labelKey: 'dock.sizeLg' },
]

const SIZE_CLASS: Record<DockSize, string> = {
  sm: s.sizeSm,
  md: s.sizeMd,
  lg: s.sizeLg,
}

/** 名字标签永远翻到「朝内」那一侧 —— 停下边就浮在上方,停左边就浮在右侧。 */
const LABEL_SIDE: Record<DockEdge, LabelSide> = {
  bottom: 'top',
  top: 'bottom',
  left: 'right',
  right: 'left',
}

/** 瓦朝内长:下/右边锚末端(默认),上/左边锚起点。 */
const ANCHOR_START: Record<DockEdge, boolean> = {
  bottom: false,
  right: false,
  top: true,
  left: true,
}

interface Props {
  dimmed?: boolean
}

/**
 * Dock 只是形态机的投影:它读 state 算出每块的「运行点」,点击时把 id 交回 transitions。
 * 它自己不知道什么是舞台、什么是钉栏 —— 连「点开该去哪」也不知道,那是 store 里
 * resolveOpen 的事;Dock 只负责把右键菜单摆出来,并把选择转成 set*。
 *
 * 停靠(边 / 沿边位置 / 大小)同理:Dock 不判「贴哪儿」—— 那是 AppShell 那层浮层容器的事;
 * 它只按边决定自己的**朝向**(排成行还是列、瓦朝哪边长、标签翻到哪一侧)。
 */
export function Dock({ dimmed }: Props) {
  const t = useT()
  const stageId = useStageStore((st) => st.stageId)
  const pinned = useStageStore((st) => st.pinned)
  const overrides = useStageStore((st) => st.openOverrides)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const dockSize = useStageStore((st) => st.dockSize)
  const click = useStageStore((st) => st.clickDockIcon)
  const setOpenOverride = useStageStore((st) => st.setOpenOverride)
  const setDockEdge = useStageStore((st) => st.setDockEdge)
  const setDockAlign = useStageStore((st) => st.setDockAlign)
  const setDockSize = useStageStore((st) => st.setDockSize)

  const [menu, setMenu] = useState<{ id: string; title: string; x: number; y: number } | null>(null)
  const closeMenu = () => setMenu(null)

  const axis = DOCK_AXIS[dockEdge]
  const { stripRef, setTileRef, factors, tracking, onMouseMove, onMouseLeave } = useMagnify(
    TILES.length,
    axis,
  )

  return (
    <div
      ref={stripRef}
      className={[
        s.strip,
        SIZE_CLASS[dockSize],
        axis === 'y' && s.vertical,
        ANCHOR_START[dockEdge] && s.anchorStart,
        dimmed && s.dimmed,
        tracking && s.tracking,
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {TILES.map((tile, i) => {
        const node =
          tile.kind === 'plus' ? (
            <DockTile
              key="__plus"
              title={t('dock.add')}
              plus
              factor={factors[i] ?? REST_FACTOR}
              tileRef={setTileRef(i)}
              labelSide={LABEL_SIDE[dockEdge]}
            />
          ) : (
            <DockTile
              key={tile.item.id}
              title={t(tile.item.titleKey)}
              icon={tile.item.icon}
              badge={tile.item.badge}
              running={tile.item.id === stageId || pinned.includes(tile.item.id)}
              factor={factors[i] ?? REST_FACTOR}
              tileRef={setTileRef(i)}
              labelSide={LABEL_SIDE[dockEdge]}
              onClick={() => click(tile.item.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({
                  id: tile.item.id,
                  title: t(tile.item.titleKey),
                  x: e.clientX,
                  y: e.clientY,
                })
              }}
            />
          )
        if (i === SEP_AFTER) {
          return (
            <Fragment key={`group-${i}`}>
              {node}
              <span className={s.sep} aria-hidden="true" />
            </Fragment>
          )
        }
        return node
      })}

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={closeMenu} label={menu.title}>
          {/* 第一组是「这一块」的事,余下三组是「整条 Dock」的事 —— 分隔线就是这条界。 */}
          <MenuSection>{t('dock.openWith')}</MenuSection>
          {OPEN_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              checked={(overrides[menu.id] ?? 'default') === c.value}
              onClick={() => {
                setOpenOverride(menu.id, c.value)
                closeMenu()
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}

          <MenuSeparator />
          <MenuSection>{t('dock.edge')}</MenuSection>
          {EDGE_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              checked={dockEdge === c.value}
              onClick={() => {
                setDockEdge(c.value)
                closeMenu()
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}

          <MenuSeparator />
          <MenuSection>{t('dock.align')}</MenuSection>
          {ALIGN_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              checked={dockAlign === c.value}
              onClick={() => {
                setDockAlign(c.value)
                closeMenu()
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}

          <MenuSeparator />
          <MenuSection>{t('dock.size')}</MenuSection>
          {SIZE_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              checked={dockSize === c.value}
              onClick={() => {
                setDockSize(c.value)
                closeMenu()
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}

          <MenuSeparator />
          <MenuItem
            onClick={() => {
              // 「设置…」永远是弹窗,不受它自己的打开方式影响 —— 菜单里点它就是要看一眼。
              click('settings', 'stage')
              closeMenu()
            }}
          >
            {t('dock.settings')}
          </MenuItem>
        </Menu>
      )}
    </div>
  )
}
