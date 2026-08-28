import { Fragment, useState } from 'react'
import { useStageStore } from '../stage/store'
import { GLOBAL_ITEMS, SESSION_ITEMS } from '../stage/items'
import { DockTile } from './DockTile'
import { useMagnify } from './useMagnify'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import type { OpenBehavior, StageItemSpec } from '../stage/types'
import s from './Dock.module.css'

const REST = { scale: 1, lift: 0 }

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

interface Props {
  dimmed?: boolean
}

/**
 * Dock 只是形态机的投影:它读 state 算出每块的「运行点」,点击时把 id 交回 transitions。
 * 它自己不知道什么是舞台、什么是钉栏 —— 连「点开该去哪」也不知道,那是 store 里
 * resolveOpen 的事;Dock 只负责把右键菜单摆出来,并把选择转成 setOpenOverride。
 */
export function Dock({ dimmed }: Props) {
  const t = useT()
  const stageId = useStageStore((st) => st.stageId)
  const pinned = useStageStore((st) => st.pinned)
  const overrides = useStageStore((st) => st.openOverrides)
  const click = useStageStore((st) => st.clickDockIcon)
  const setOpenOverride = useStageStore((st) => st.setOpenOverride)

  const [menu, setMenu] = useState<{ id: string; title: string; x: number; y: number } | null>(null)
  const closeMenu = () => setMenu(null)

  const { stripRef, setTileRef, transforms, onMouseMove, onMouseLeave } = useMagnify(TILES.length)

  return (
    <div
      ref={stripRef}
      className={dimmed ? `${s.strip} ${s.dimmed}` : s.strip}
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
              transform={transforms[i] ?? REST}
              tileRef={setTileRef(i)}
            />
          ) : (
            <DockTile
              key={tile.item.id}
              title={t(tile.item.titleKey)}
              icon={tile.item.icon}
              badge={tile.item.badge}
              running={tile.item.id === stageId || pinned.includes(tile.item.id)}
              transform={transforms[i] ?? REST}
              tileRef={setTileRef(i)}
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
