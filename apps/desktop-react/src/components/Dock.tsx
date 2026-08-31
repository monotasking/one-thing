import { Fragment, useState } from 'react'
import { useStageStore } from '../stage/store'
import {
  GLOBAL_ITEMS,
  NOTIFICATIONS_ITEM_ID,
  SESSION_ITEMS,
  WORKSPACE_ITEM_ID,
} from '../stage/items'
import { useUnreadCount } from '../services/notify-store'
import { WorkspaceMenuRows } from '../workspace/components/WorkspaceMenuRows'
import { useWorkspacePalette } from '../workspace/components/palette-hub'
import { currentWorkspace } from '../workspace/projection'
import { useWorkspaceViews } from '../workspace/store'
import sw from '../workspace/swatch.module.css'
import { DockTile } from './DockTile'
import { useMagnify } from './useMagnify'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { useT } from '../i18n'
import { formIn, memoryIsAt } from '../stage/transitions'
import { DOCK_AXIS, OPEN_PLACEMENT_CHOICES } from '../stage/types'
import type { DockEdge, DockSize, StageItemSpec } from '../stage/types'
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

/** 「钉到边」那一组从第几行开始 —— 由表自己说,不写死一个数。 */
const PIN_FROM = OPEN_PLACEMENT_CHOICES.findIndex((c) => c.pin)

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
 * 右键菜单只管「这一块」:它自己的位置记忆,加一条通往设置页的门。
 * 那排单选显示的是**记忆**(这块瓦上次被放在哪),不是一份配置 —— 所以点一下
 * 既是「改记忆」也是「现在就放过去」,两件事同一个动作(G 批拍板:位置是记忆,不是配置)。
 * 一块从没被放过的瓦一行都不勾:它还没有位置,这时候说话的是设置页那个全局默认档。
 * 整条 Dock 的边 / 沿边位置 / 大小是**配置**,配置形状的交互归设置页(08-29 拍板),
 * 所以那三组不在这里 —— 这条菜单短到一眼能读完是它的目的,不是偷懒。
 */
export function Dock({ dimmed }: Props) {
  const t = useT()
  const placements = useStageStore((st) => st.placements)
  const memory = useStageStore((st) => st.memory)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockSize = useStageStore((st) => st.dockSize)
  const click = useStageStore((st) => st.clickDockIcon)
  const openAs = useStageStore((st) => st.openAs)
  // 未读是**当下的事实**,所以在这里对上静态的 items 表(items.ts 里那条注释同一件事)。
  const unread = useUnreadCount()
  /*
   * 当前工作区同理是**当下的事实**,不在 items 表里:表是静态声明。
   * 列表**不在这里拉** —— 它与会话 / agent / 模型三份数据源一样在 main.tsx 里
   * 连通之后起一次(Dock 是投影,不是取数的地方)。这里只读结论。
   */
  const workspace = currentWorkspace(useWorkspaceViews())
  const openWorkspacePalette = useWorkspacePalette((st) => st.setOpen)

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
              testId={`dock-tile-${tile.item.id}`}
              icon={tile.item.icon}
              badge={tile.item.badge}
              dot={tile.item.id === NOTIFICATIONS_ITEM_ID && unread > 0}
              /* 工作区那块瓦画的是**当前工作区的色与字标**,不是一枚固定图标 ——
               * 它同时就是「我在哪」的常驻指示。列表还没读到(或者读不到)时
               * workspace 是 undefined,瓦退回 items 表里那枚兜底图标:
               * 那时候确实没有「我在哪」可画,不该拿默认色冒充。 */
              face={
                tile.item.id === WORKSPACE_ITEM_ID && workspace
                  ? { letter: workspace.initial, className: sw[workspace.swatch] }
                  : undefined
              }
              running={tile.item.id in placements}
              factor={factors[i] ?? REST_FACTOR}
              tileRef={setTileRef(i)}
              labelSide={LABEL_SIDE[dockEdge]}
              // 只有还收在坞里的才预览:已经看得见的东西不必再给一眼。
              previewId={
                formIn(placements, tile.item.id) === 'dock' ? tile.item.id : undefined
              }
              onClick={() => click(tile.item.id)}
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
          {/*
            工作区那块瓦的右键 = **快切表**(08-31 追补裁定)。它借的是这条既有的
            右键菜单机制,不是另一个浮层 —— 「零新原语」说的就是这件事。
            这块瓦因此**不显示那排落点单选**:一条菜单短到一眼能读完是它的目的
            (与文件头那段同一条判据),而落点仍然改得了 —— 浮窗头 / 舞台头上
            那个「钉到边」菜单是同一件事的另一处入口。
          */}
          {menu.item.id === WORKSPACE_ITEM_ID ? (
            <WorkspaceMenuRows
              onOpenOverview={() => click(WORKSPACE_ITEM_ID)}
              /* 新建的落点是命令面板:名字在那里输,↵ 落定。
               * 不给菜单再挂一个只为收一个名字的对话框 —— 那就是新原语了。 */
              onCreate={() => openWorkspacePalette(true)}
              onDone={closeMenu}
            />
          ) : (
            <>
              {/* 每块瓦都有落点可选 —— 去接管化之后不再有「只有一种打开法」的例外。 */}
              <MenuSection>{t('dock.openWith')}</MenuSection>
              {OPEN_PLACEMENT_CHOICES.map((c, i) => (
                <Fragment key={c.key}>
                  {i === PIN_FROM && <MenuSection>{t('stage.pinToEdge')}</MenuSection>}
                  <MenuItem
                    checked={memoryIsAt(memory[menu.item.id], c.placement)}
                    onClick={() => {
                      // 既执行也写记忆:openAs 落定的那一刻自己就记下了,这里不必再记一次。
                      openAs(menu.item.id, c.placement)
                      closeMenu()
                    }}
                  >
                    {t(c.labelKey)}
                  </MenuItem>
                </Fragment>
              ))}
            </>
          )}
          <MenuSeparator />

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
