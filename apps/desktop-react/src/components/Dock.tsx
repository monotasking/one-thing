import { Fragment, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useExposeStore } from '../expose/store'
import { GLOBAL_ITEMS, SESSION_ITEMS } from '../stage/items'
import { DockTile } from './DockTile'
import { useMagnify } from './useMagnify'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import { formIn } from '../stage/transitions'
import { DOCK_AXIS } from '../stage/types'
import type { DockEdge, DockSize, OpenBehavior, StageItemSpec } from '../stage/types'
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

/** 菜单里的四选:'default' 是「不表态」,另三个是明确落点。 */
const OPEN_CHOICES: Array<{ value: OpenBehavior; labelKey: MessageKey }> = [
  { value: 'default', labelKey: 'dock.openDefault' },
  { value: 'stage', labelKey: 'dock.openStage' },
  { value: 'float', labelKey: 'dock.openFloat' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
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
 * 它自己不知道什么是舞台、什么是浮窗、什么是架子 —— 连「点开该去哪」也不知道,那是 store 里
 * resolveOpen 的事;Dock 只负责把右键菜单摆出来,并把选择转成 set*。
 *
 * 右键菜单只管「这一块」:它自己的打开方式,加一条通往设置页的门。
 * 整条 Dock 的边 / 沿边位置 / 大小是**配置**,配置形状的交互归设置页(08-29 拍板),
 * 所以那三组不在这里 —— 这条菜单短到一眼能读完是它的目的,不是偷懒。
 */
export function Dock({ dimmed }: Props) {
  const t = useT()
  const placements = useStageStore((st) => st.placements)
  const overrides = useStageStore((st) => st.openOverrides)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockSize = useStageStore((st) => st.dockSize)
  const click = useStageStore((st) => st.clickDockIcon)
  const setOpenOverride = useStageStore((st) => st.setOpenOverride)
  const toggleExpose = useExposeStore((st) => st.toggle)

  const [menu, setMenu] = useState<{ item: StageItemSpec; title: string; x: number; y: number } | null>(
    null,
  )
  const closeMenu = () => setMenu(null)

  const axis = DOCK_AXIS[dockEdge]
  const { stripRef, setTileRef, factors, tracking, onMouseMove, onMouseLeave } = useMagnify(
    TILES.length,
    axis,
  )

  return (
    <div
      ref={stripRef}
      /* 条本身的身份标记:同一块内容在舞台/浮窗里也叫同一个名字,
       * 所以「这一块是坞里的那一块」得有个不靠文案的说法。 */
      data-dock="strip"
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
              // 接管型不进 Placement,所以它没有「正在开着」这回事,运行点也就不适用。
              running={!tile.item.takeover && tile.item.id in placements}
              factor={factors[i] ?? REST_FACTOR}
              tileRef={setTileRef(i)}
              labelSide={LABEL_SIDE[dockEdge]}
              // 只有还收在坞里的才预览:已经看得见的东西不必再给一眼。
              // 接管型也不预览 —— 它没有 Placement,「换一整屏」缩成 320×220 也不是那回事。
              previewId={
                !tile.item.takeover && formIn(placements, tile.item.id) === 'dock'
                  ? tile.item.id
                  : undefined
              }
              onClick={() => (tile.item.takeover ? toggleExpose() : click(tile.item.id))}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({
                  item: tile.item,
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
          {/* 接管型只有一种打开法,所以它连这一组都没有 —— 菜单里只剩那扇门。 */}
          {!menu.item.takeover && (
            <>
              <MenuSection>{t('dock.openWith')}</MenuSection>
              {OPEN_CHOICES.map((c) => (
                <MenuItem
                  key={c.value}
                  checked={(overrides[menu.item.id] ?? 'default') === c.value}
                  onClick={() => {
                    setOpenOverride(menu.item.id, c.value)
                    closeMenu()
                  }}
                >
                  {t(c.labelKey)}
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          )}

          <MenuItem
            onClick={() => {
              // 设置页按它自己的打开方式开 —— 它也是一块普通的瓦,不该有特权。
              click('settings')
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
