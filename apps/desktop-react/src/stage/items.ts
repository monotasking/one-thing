import type { StageItemSpec } from './types'

/**
 * 会话总览这块瓦的 id。它被三处**非本地**地引用(顶栏那道入口 / 内容表 /
 * 「进入会话就把它收回 Dock」),所以不许各写各的字面量 —— 一处改名,三处一起改。
 */
export const SESSIONS_ITEM_ID = 'sessions'

/**
 * 通知中心这块瓦的 id。与 SESSIONS_ITEM_ID 同一条理由不许各写各的字面量:
 * 它被内容表、Dock 的未读点、以及 toast 折叠丸那道「打开中心」的门三处引用。
 *
 * 它是一块**普通的瓦** —— 有内容、有落点、有打开方式,和别的瓦逐字走同一条路。
 * 「通知」不该是个特权浮层:能钉能浮能上舞台,这一条是零成本换来的。
 */
export const NOTIFICATIONS_ITEM_ID = 'notifications'

/**
 * 模型服务这块瓦的 id。与上面两个同一条理由不许各写各的字面量:
 * 它被内容表与真机门(gate:a11y 的第三屏)两处引用。
 */
export const PROVIDERS_ITEM_ID = 'providers'

/**
 * 工作区(space)切换器这块瓦的 id。与上面三个同一条理由不许各写各的字面量:
 * 它被内容表、Dock(瓦面铺当前工作区的色底、右键装快切表)、
 * 以及快捷键注册表(⌘⇧W 开命令面板那一族)三处引用。
 *
 * 它是一块**普通的瓦**(08-31 追补裁定:切换器 = 一块普通 Dock 瓦,零新原语):
 * 有内容(工作区总览)、有落点、有打开方式,和别的瓦逐字走同一条路。
 * 唯一的差别是**瓦面**:它在图标底下铺一层当前工作区的色 ——
 * 因为这块瓦同时就是「我在哪」的常驻指示(见 components/DockTile 的 face)。
 * 08-31 用户否决了原来那张「色底 + 首字母」的脸:字当图标与这套风格不符。
 */
export const WORKSPACE_ITEM_ID = 'workspace'

/**
 * 「所有应用」这块管理瓦的 id。与上面四个同一条理由不许各写各的字面量:
 * 它被内容表、Dock(它自己那一格永远在)、以及真机门(gate:a11y 第四屏)三处引用。
 *
 * 它同样是一块**普通的瓦** —— 有内容、有落点、有打开方式。唯一的两条特殊
 * 都写在 items 表那一行上,而不是散在代码里:
 *  - `alwaysInDock`:它是把别的瓦放回来的**唯一入口**,自己藏掉就没有回家的门了;
 *  - `defaultPlacement: cover`:一张铺满的清单塞进 880×520 的浮窗里就得滚动。
 */
export const APPS_ITEM_ID = 'apps'

/**
 * L1 是静态 mock 表。之后接真实数据时,只有这张表换来源,
 * 形态机 / 组件一行不改 —— 这是把 items 单独放一个文件的全部理由。
 */
/*
 * ── 瓦面图标的语义账(08-31 用户报障后逐格核对)────────────────────────────
 * 判据只有一条:**图标说的是这块面里有什么,不是它长什么样**。所以撞车的两块瓦
 * (会话总览与工作区都用「网格 / 层叠」)必须分开 —— 一个用户扫一眼 Dock 时,
 * 认的是形不是标签,两个同族的形就是两块认不出来的瓦。逐格理由:
 *
 *   files        FolderTree     一棵文件树,面里就是树
 *   diff         GitCompare     两版对照 = 改动
 *   terminal     Terminal       同名同形
 *   browser      Globe          网,不是「一个窗口」
 *   search       Search         同名同形
 *   sessions     MessagesSquare 面里是**一堆对话**。修前是 LayoutGrid,那是「网格
 *                               排布」——说的是版式不是内容,而且与工作区那块撞了族
 *   notifications Bell          同名同形
 *   providers    Boxes          几家服务商各自一箱模型;与 Layers(层叠)分得开
 *   workspace    Layers         「一层一层的空间」。瓦面另有色底(见 Dock 的 face):
 *                               色承载「我在哪」,形承载「这是什么」——字标已退役
 *   settings     Settings       同名同形
 *   apps         LayoutGrid     一格一格摆开的清单,正是 Launchpad 那个形。
 *                               它接手的正是 sessions 让出来的那枚图标
 * ────────────────────────────────────────────────────────────────────────── */
export const STAGE_ITEMS: StageItemSpec[] = [
  { id: 'files', titleKey: 'item.files', scope: 'session', icon: 'FolderTree' },
  /*
   * 「改动」与「终端」这两块瓦上原本各写死一枚徽(一个 2、一个 ✓)。08-31 删掉:
   * 那与本表下面那条自我要求正面打架 —— **表是静态声明,徽说的是当下的事实**。
   * 一枚永远写着 2 的徽不是占位,是每一秒都在撒谎(而且撒的是「你有两处改动
   * 没看」这种会让人真的去点一下的谎)。
   *
   * 真产地接上之前**不画**:未读点那一条已经把做法立好了(声明在表里,事实在
   * services/notify-store,Dock 渲染时才把两者对上)。改动数与终端状态将来照抄
   * 那条路,而不是先在表里塞一个假的等着someone替换。
   */
  { id: 'diff', titleKey: 'item.diff', scope: 'session', icon: 'GitCompare' },
  { id: 'terminal', titleKey: 'item.terminal', scope: 'session', icon: 'Terminal' },
  { id: 'browser', titleKey: 'item.browser', scope: 'global', icon: 'Globe' },
  // 检索是一块普通的瓦:参与 Placement 全套(⌘P 也只是"按它的打开方式开一下")。
  { id: 'search', titleKey: 'item.search', scope: 'global', icon: 'Search' },
  // 会话总览同样是一块普通的瓦(08-29 拍板去接管化):它有内容、有落点、有打开方式,
  // 和别的瓦逐字走同一条路 —— 「换一整屏」那种特权形态已经退役。
  { id: SESSIONS_ITEM_ID, titleKey: 'item.sessions', scope: 'global', icon: 'MessagesSquare' },
  // 未读**不在这张表里**:表是静态声明,未读是当下的事实(住在 services/notify-store)。
  // Dock 渲染时才把两者对上 —— 表里写死一个 dot 就等于让声明冒充状态。
  { id: NOTIFICATIONS_ITEM_ID, titleKey: 'item.notifications', scope: 'global', icon: 'Bell' },
  // 模型服务是**另一块瓦**,不是设置页里的一节:它有自己的左栏名册与右面分坑,
  // 而设置页的版式是「分区不分页的单列表单」(见 content/SettingsMock.tsx 顶部)。
  // 把一块两栏的面塞进那张单列表单,等于让两种版式在同一页里打架。
  { id: PROVIDERS_ITEM_ID, titleKey: 'item.providers', scope: 'global', icon: 'Boxes' },
  // 工作区切换器。icon 是**常态**(08-31 用户否决字标瓦面:字当图标与这套风格不符)——
  // 瓦面画的是「色底 + 这枚图标」:**色**承载「我在哪」,**形**承载「这是什么」。
  // 列表还没读到时就只剩这枚图标,那时候确实没有「我在哪」可画。
  // 首字母没有退役,只是退回它本来该在的地方:右键快切表与总览卡上的小色点。
  { id: WORKSPACE_ITEM_ID, titleKey: 'item.workspace', scope: 'global', icon: 'Layers' },
  { id: 'settings', titleKey: 'item.settings', scope: 'global', icon: 'Settings' },
  // 「所有应用」排在最后:它是**管理**入口,不是又一块日常要点的面。
  // 两条特殊都在这一行上,不散在代码里 —— 见 APPS_ITEM_ID 的注释。
  {
    id: APPS_ITEM_ID,
    titleKey: 'item.apps',
    scope: 'global',
    icon: 'LayoutGrid',
    alwaysInDock: true,
    defaultPlacement: { kind: 'cover' },
  },
]

export const SESSION_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'session')
export const GLOBAL_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'global')

export function findItem(id: string | null): StageItemSpec | undefined {
  if (!id) return undefined
  return STAGE_ITEMS.find((i) => i.id === id)
}
