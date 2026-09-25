import { Fragment, useRef, useState } from 'react'
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
import { FocusScope } from '../focus/FocusScope'
import { DockTile } from './DockTile'
import { panelRef } from '../stage/panel-ref'
import { stageLauncherOf } from '../stage/launchers'
import { openStageItem } from '../stage/open-item'
import { useContentDrag } from '../workbench/useContentDrag'
import { useDockLens } from './useDockLens'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { useT } from '../i18n'
import { isItemHidden, memoryIsAt } from '../stage/transitions'
import { DOCK_AXIS, OPEN_PLACEMENT_CHOICES } from '../stage/types'
import type { DockEdge, DockMagnifyLevel, DockSize, StageItemSpec } from '../stage/types'
import type { LabelSide } from './DockTile'
import s from './Dock.module.css'

/** 瓷砖在条上的线性次序 —— 磁性放大按这个次序索引,分隔线不占位。 */
type Tile =
  | { kind: 'item'; item: StageItemSpec }
  | { kind: 'plus' }

/**
 * 条上此刻摆哪几块。**每次渲染现算**而不是一张模块级常量表(08-31 加「藏起来的瓦」
 * 之后):藏起来的瓦不占格,而磁性放大是按格子的线性次序索引的 —— 表里留着一个
 * 不画的格,放大就会算错人。分隔线的落点同理必须跟着当下的会话组长走。
 *
 * 「藏」只发生在这一层:它是 Dock 的投影规则,形态机不知道有这回事(藏起来的瓦
 * 照样有落点、有记忆、⌘P 打得开)。
 */
function tilesFor(hiddenItems: readonly string[]): { tiles: Tile[]; sepAfter: number } {
  const shown = (items: StageItemSpec[]) => items.filter((i) => !isItemHidden(hiddenItems, i.id))
  const session = shown(SESSION_ITEMS)
  return {
    tiles: [
      ...session.map((item) => ({ kind: 'item' as const, item })),
      ...shown(GLOBAL_ITEMS).map((item) => ({ kind: 'item' as const, item })),
      { kind: 'plus' },
    ],
    // 会话组空了就没有分隔线可画(-1 永远不等于任何一格的下标)。
    sepAfter: session.length - 1,
  }
}

/** 「钉到边」那一组从第几行开始 —— 由表自己说,不写死一个数。 */
const PIN_FROM = OPEN_PLACEMENT_CHOICES.findIndex((c) => c.pin)

const SIZE_CLASS: Record<DockSize, string> = {
  sm: s.sizeSm,
  md: s.sizeMd,
  lg: s.sizeLg,
}

/** 放大幅度三档 → 条上覆写 --dock-lens-max 的那三条类。与 SIZE_CLASS 同一手。 */
const MAGNIFY_CLASS: Record<DockMagnifyLevel, string> = {
  sm: s.magnifySm,
  md: s.magnifyMd,
  lg: s.magnifyLg,
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
export function Dock() {
  const t = useT()
  const placements = useStageStore((st) => st.placements)
  const memory = useStageStore((st) => st.memory)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockSize = useStageStore((st) => st.dockSize)
  /*
   * 放大的三格配置(09-02 追补,对齐 macOS Dock 偏好)。开关与幅度是**两件事**:
   * 关掉是「这条链不跑」,幅度只是条上一个 CSS 变量 —— 所以一个进 hook、一个进类名。
   * 运行点那格更是第三件事:它跟放大毫无关系,只决定画不画那颗点。
   */
  const dockMagnify = useStageStore((st) => st.dockMagnify)
  const dockMagnifyLevel = useStageStore((st) => st.dockMagnifyLevel)
  const dockRunningDot = useStageStore((st) => st.dockRunningDot)
  /*
   * 沿边对齐档在这里**只有磁性放大读它** —— 它决定条长大时朝哪边退,
   * 见 dock-lens.ts 的 GROWTH_BIAS。条自己摆在哪(贴边 + 沿边)整件在 AppShell
   * 那一层:常驻档下是让位带里的 `justify-content`,自动隐藏档下是那两条百分比
   * 定位,两条路 Dock 都不参与。
   */
  const dockAlign = useStageStore((st) => st.dockAlign)
  /*
   * **条不知道此刻是哪一档**(09-13 晚用户拍板「dock 的长度不要默认占满,他应该
   * 该多长就多长」「他就是一个独立的悬浮的块」,推翻同日早些那版「常驻 = 整边浮栏」):
   * 两档同一个形,条永远是一枚长度 = 瓦之和的药丸,差别只有**让位** —— 常驻档
   * 主区朝那条边退一截,药丸摆在那条带里,而带**不设底色**、别人的 background
   * 一个字不动。所以这里**不订阅 `dockDisplay`**:订了也没有一个字要因它而变,
   * 而多一份订阅就是多一次重渲。
   */
  // 藏起来的瓦不在条上露面。它是**配置**(见 StageSettings.hiddenItems),
  // 与「这块瓦此刻在哪」无关 —— 所以它与 placements 是两条独立的订阅。
  const hiddenItems = useStageStore((st) => st.hiddenItems)
  const click = useStageStore((st) => st.clickDockIcon)
  const openAs = useStageStore((st) => st.openAs)
  // 右键那一行「在 Dock 上隐藏」(A10)。与「所有应用」那颗开关同一口。
  const setItemHidden = useStageStore((st) => st.setItemHidden)
  // 未读是**当下的事实**,所以在这里对上静态的 items 表(items.ts 里那条注释同一件事)。
  const unread = useUnreadCount()
  /*
   * 当前工作区同理是**当下的事实**,不在 items 表里:表是静态声明。
   * 列表**不在这里拉** —— 它与会话 / agent / 模型三份数据源一样在 main.tsx 里
   * 连通之后起一次(Dock 是投影,不是取数的地方)。这里只读结论。
   */
  const workspace = currentWorkspace(useWorkspaceViews())
  const openWorkspacePalette = useWorkspacePalette((st) => st.setOpen)

  /*
   * **拖一块瓦**(W3 裁定 10)。按下时记一格瓦 id、起拖时读它 —— 与文件树行、
   * 项目行逐字同型(`useContentDrag` 的 `ref()` 无参:它不认识 Dock)。
   * `panelRef` 是形态机与拼贴台之间那条缝上唯一的一句翻译(判词在
   * `stage/panel-ref.ts`),所以这里既不拼字面量也不认识 `'panel'` 这三个字。
   */
  const dragTileId = useRef<string | null>(null)
  const startTileDrag = useContentDrag({
    /*
     * **启动瓦拖出去的不是它自己**(W6-a):「目录」那块瓦拖出来的是
     * `dir:<当前会话的工作目录>`,不是 `panel:files`(那块面已经不存在了)。
     * 判据**读表不写 if**(`stage/launchers.ts`):表上没有这块瓦就照旧 `panelRef`。
     */
    ref: () => {
      const id = dragTileId.current
      if (!id) return null
      const launcher = stageLauncherOf(id)
      return launcher?.dragRef ? launcher.dragRef() : panelRef(id)
    },
  })

  const [menu, setMenu] = useState<{ item: StageItemSpec; title: string; x: number; y: number } | null>(
    null,
  )
  const closeMenu = () => setMenu(null)
  /** 这块瓦是不是启动瓦、它自己那几行菜单是什么(W6-a,读表)。 */
  const MenuRows = menu ? stageLauncherOf(menu.item.id)?.MenuRows : undefined
  const menuLauncherRows = MenuRows ? <MenuRows onDone={closeMenu} /> : null

  const axis = DOCK_AXIS[dockEdge]
  const { tiles, sepAfter } = tilesFor(hiddenItems)
  /*
   * ── 悬停预览泡已退役(09-02 用户裁定「不需要这个功能了」)───────────────
   *
   * 条这一层曾经还养着一只 hover-intent(跨瓦的「一次只有一个泡」主角制 + 朝泡
   * 走的瞄准三角区),以及交给放大那只 hook 的「主人瓦钉满档」下标。泡没了,那两件
   * 连同 ui/hover-intent、stage/transitions 的三角区几何一起删干净 —— 条上剩下的
   * 悬停只有瓦自己那条 300ms 名字标签,它从不需要跨瓦仲裁。
   */
  /*
   * 磁性放大只问两件事:**停哪条边**(定轴)与**沿边怎么对齐**(定条长大时朝哪边退)。
   * 09-02 之前它还要被喂瓦数 / 分隔线落点 / 大小档三样,因为静止坐标系是「一个锚点 +
   * 一串常量」算出来的,那三样一变锚点就得作废。现在基准直接从布局现读(瓦的
   * offsetLeft / offsetWidth,transform 改不动它们),没有旧值可过期,那三格就不必递了。
   */
  const { stripRef, onMouseMove, onMouseLeave } = useDockLens({
    edge: dockEdge,
    align: dockAlign,
    enabled: dockMagnify,
  })

  /*
   * ── Dock 是响应链上的一格 `region`(09-03 R2)──────────────────────────────
   * 它**不声明落点**:条上的瓦本来就是按钮,焦点落在瓦上(浏览器自己干),
   * 落在条这块「面」上没有意义 —— 所以走缺省档(根)。它也没有局部键、不认 Esc。
   *
   * 那它为什么要接树:①有了它,「焦点此刻在 Dock 上」是一个说得出名字的答案,
   * 于是从瓦上开出来的浮层(右键菜单)在树上是它的孩子,一下 Esc 先关菜单;
   * ②`stripRef` 与树登记**共用同一只 ref 回调**(`<FocusScope rootRef>`),
   * 磁性放大量锚点那一路一个字没动。
   *
   * **指针点瓦不 `activate()`**(§7 宿主的义务那一条:指针操作不调,点击自己
   * 落焦)。「从 Dock 开一块面,焦点进不进那块面」在键盘那条路上由
   * `useKeymapCommandRunner` 答(规则 2),鼠标那条路维持今天 —— 焦点留在瓦上,
   * 连着按两下同一块瓦仍然是「开、关」,而不是「开了之后按键落在别处」。
   */
  return (
    <FocusScope scope="dock" rootRef={stripRef}>
      {({ scopeProps }) => (
        <div
          /* 条本身的身份标记:同一块内容在舞台/浮窗里也叫同一个名字,
           * 所以「这一块是坞里的那一块」得有个不靠文案的说法。 */
          {...scopeProps}
          data-dock="strip"
          /* `data-nodrop`(W6-b,设计 v3 §5 第一行):**Dock 自述「一律不收」**。
           * 它本身是一排**入口**而不是落点 —— 把一格标签丢在瓦上没有任何语义,
           * 而没有这一句时它落进的是条底下那片叶(判据在按几何工作,但那不是
           * 用户瞄准的地方)。判据不认识 Dock,只扫 `[data-nodrop]`。 */
          data-nodrop=""
          className={[
            s.strip,
            SIZE_CLASS[dockSize],
            MAGNIFY_CLASS[dockMagnifyLevel],
            axis === 'y' && s.vertical,
            ANCHOR_START[dockEdge] && s.anchorStart,
          ]
            .filter(Boolean)
            .join(' ')}
          /* 这条 move 今天只有一个消费者:磁性放大读它算系数
           * (09-02 之前还有第二个 —— 预览泡的瞄准区,随泡一起退役)。 */
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          {/* 底板。它是条的一个**子元素**而不是条自己的背景:放大时底板要朝主轴两头
            * 长出去,而条的盒子必须一动不动(瓦的放大走 transform,条的布局宽度是
            * 那 13 块瓦的静止宽度之和,任何一帧都不该重排)。长出多少由
            * --dock-grow-before / -after 两格给,乘上 --dock-amount 那格开合标量。 */}
          <span className={s.bg} data-dock="plate" aria-hidden="true" />
          {/* 感应面(09-25):「在坞上」那块地 —— 外侧伸到窗边,镜头开着时内侧伸到
            * 放大后瓦的最远处。磁性放大的交叉轴判据读它的矩形;几何全在 CSS
            * (Dock.module.css 的 `.hit`)。排在瓦前面,瓦盖在它上面。 */}
          <span className={s.hit} data-dock="hit" aria-hidden="true" />
          {tiles.map((tile, i) => {
            const node =
              tile.kind === 'plus' ? (
                <DockTile
                  key="__plus"
                  title={t('dock.add')}
                  plus
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
                  /* 工作区那块瓦画的是**当前工作区的色底 + 这块瓦自己的图标**。
                   * 色承载「我在哪」(它同时就是那条常驻指示),形承载「这是什么」——
                   * 两件事各归各的,一个都不少。
                   *
                   * 08-31 用户否决了原来的「色底 + 首字母」:拿字当图标与这套风格不符
                   * (整条 Dock 上只有它一块是字,扫一眼就跳出来,而它并不比别人重要)。
                   * 首字母没有退役,只是退回它本来该在的地方 —— 右键快切表与总览卡上
                   * 的小色点,那两处它是**列表里的区分记号**而不是一块瓦的脸。
                   *
                   * 列表还没读到(或者读不到)时 workspace 是 undefined,瓦退回没有色底
                   * 的普通图标:那时候确实没有「我在哪」可画,不该拿默认色冒充。 */
                  face={
                    tile.item.id === WORKSPACE_ITEM_ID && workspace
                      ? { className: sw[workspace.swatch] }
                      : undefined
                  }
                  running={dockRunningDot && tile.item.id in placements}
                  labelSide={LABEL_SIDE[dockEdge]}
                  /* **启动瓦自己说点它意味着什么**(W6-a,读表不写 if)。 */
                  onClick={() => openStageItem(tile.item.id)}
                  /* **一块瓦就是一个拖拽来源**(W3 裁定 10)。W4 之后瓦是
                   * `panel:<id>`,与文件在拼贴台里是同一条路,所以这里递的只是
                   * 「按下了哪一块」——拖成什么、能落到哪儿全在统一那条路上。 */
                  onDragPointerDown={(e) => {
                    dragTileId.current = tile.item.id
                    startTileDrag(e)
                  }}
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
            if (i === sepAfter) {
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
              ) : menuLauncherRows ? (
                /*
                 * **启动瓦自己那几行**(W6-a,`stage/launchers.ts`)。它**替掉**
                 * 那一排落点单选:「目录」那块瓦开的不是一块面,选「浮窗 / 钉到右边」
                 * 说不出它要开哪一个目录。落点仍旧改得了 —— 目录面板开出来之后,
                 * 它那条檐与右键菜单里的「移到 ▸」是同一件事的另一处入口。
                 */
                menuLauncherRows
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

              {/*
                **在 Dock 上隐藏**(W7-p 裁定 7,审计 A 的 A10)。它与「所有应用」
                那块面里那颗开关是**同一格状态**(`stage.hiddenItems`,判据在
                `transitions.setItemHidden`)—— 那颗开关不动,这里只是把同一个
                动作放到用它的地方:一块瓦要收走,人正在右键的就是它。

                常驻 Dock 的那几块瓦**禁灰而不消失**(`disabled`,判词在 ui/Menu 上):
                同一张菜单在每块瓦上形状一样,而「这一项此刻做不了」说得比「它不见了」
                清楚。真正挡住它的仍旧是纯函数那一句(UI 是绕得过去的)。
              */}
              <MenuItem
                disabled={menu.item.alwaysInDock === true}
                onClick={() => {
                  setItemHidden(menu.item.id, true)
                  closeMenu()
                }}
              >
                {t('dock.hideTile')}
              </MenuItem>

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
      )}
    </FocusScope>
  )
}
