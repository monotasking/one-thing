import { EXPOSE_FLOAT_MIN } from '../expose/float-min'
import type { FloatMinSize, StageItemSpec } from './types'

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
 *  - `defaultPlacement: full`(W2 起;从前是 `cover`):一张铺满的清单塞进
 *    880×520 的浮窗里就得滚动,而它恰恰是「看一眼、点一下、就走」的整屏内容。
 */
export const APPS_ITEM_ID = 'apps'

/**
 * 从前那块「查看器」瓦的 id。**它已经不在 `STAGE_ITEMS` 里了**(W1)。
 *
 * ── 为什么撤掉 ──────────────────────────────────────────────────────────
 * 09-04 用户原话:「Dock 上那块叫 Viewer 的瓦没有必要,它只在打开文件时才有意义」。
 * F2 时把查看器做成一块普通的瓦,是为了让「打开方式」那六档白拿形态机;代价
 * (Dock 上多一块瓦、「所有应用」里多一行)当时就写在这里。W1 把查看器降格为
 * **一种内容**(`content/kinds/file.tsx`),那六档改由拼贴树接,这块瓦于是没有
 * 任何理由继续存在 —— 一个文件的回访入口是**文件树**(T0 拍点甲)。
 *
 * ── 这个常量为什么留着 ──────────────────────────────────────────────────
 * 两个消费者:①stage persist v8 的迁移(把存量档案里所有 `viewer` 条目清掉);
 * ②`item.viewer` 那个 i18n 键仍在(它是 `file` 这一种内容的兜底名)。
 * 字面量散在两处会让「改一处漏一处」重演,所以名字留在这里。
 */
export const VIEWER_ITEM_ID = 'viewer'

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
  /*
   * **「目录」**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。id 一个字没改 ——
   * 位置记忆、隐藏配置、Dock 顺序全按 id 记,改 id 等于把用户摆了半年的东西弄丢。
   * 变的是两件:①名字从「文件」改成「目录」(它开的不再是一块面,是**一个目录**);
   * ②它是一块**启动瓦**(`stage/launchers.ts`,登记在 `content/files-launcher.tsx`)
   * —— 点它 = 开当前会话那个目录,右键 = 最近开过的 + 「打开目录…」,拖它 = 拖出
   * `dir:<那个目录>`。这一行本身照旧只是静态声明。
   *
   * `defaultPlacement: 左架子`(W6-a):真机复现出来的「拖不到聊天区」不是拖拽判据
   * 的错 —— 文件面板出厂摆法是一扇浮窗(201,171,878,518),正好停在聊天区中间,
   * 往那一放落进的是浮窗自己。**存量记忆压过它**(用户自己摆过的算数),所以这一格
   * 只改出厂档。
   *
   * ── 谁读它:**启动瓦那条路**,不是形态机那条(W7-p 裁定 7 的更正)──────────
   * 审计 A 的 A11 记的是「这一格在点/按两路永远读不到,删掉」。**读得到** ——
   * 离屏实测:空档案下点这块瓦,目录面板落在 `edge:left`,读它的是
   * `content/files-launcher.regionForLauncher`(`记忆 ?? findItem('files').defaultPlacement`)。
   * 读不到的是**另一条**路:`transitions.resolveOpen` 的 `itemDefault` 那一层 ——
   * 这块瓦是启动瓦,`summonRef` 答不出住处时走的是 `launcher.open()`,
   * 而不是 `openFromMemory`,所以形态机那一层确实碰不到这一格。
   * 两条路读同一个字段、一条读得到一条读不到,于是审计只看见了后者。
   * **不删**:删了它目录面板就落回中央区(实测),那是 W6-a 那条判词治的病
   * 换一种发作方式 —— 改行为要先问,不能靠一条被证伪的前提顺手改掉。
   */
  {
    id: 'files',
    titleKey: 'item.dirs',
    level: 'space',
    dockGroup: 'session',
    icon: 'FolderTree',
    defaultPlacement: { kind: 'edge', side: 'left' },
  },
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
  /*
   * 「查看器」那一行**撤了**(W1,09-04 用户裁定)。文件不再是一块瓦,它是
   * `file` 那一种内容 —— 回访入口是文件树,落点是拼贴树的叶。
   * 理由与两个残留消费者写在 VIEWER_ITEM_ID 上。
   */
  { id: 'diff', titleKey: 'item.diff', level: 'space', dockGroup: 'session', icon: 'GitCompare' },
  /*
   * **「终端」从一块面降格成启动瓦**(T1,方案
   * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.1-6;与 `files` 那一行
   * 逐字同一条路)。id 一个字不改 —— 位置记忆、隐藏配置、Dock 顺序全按 id 记。
   * 点它 / 右键 / 拖它三件登记在 `content/terminal-launcher.tsx`;这一行照旧只是
   * 静态声明。
   *
   * `defaultPlacement: 底架`:终端出厂落 `edge:bottom` —— 三十年来它在编辑器里
   * 就待在那儿,而中央区是内容的地。读它的是启动瓦那条路
   * (`terminal-launcher.regionForLauncher` 的 `记忆 ?? defaultPlacement`),
   * 与 `files` 那一行同一个判例(写在它上头那段末尾)。**存量记忆压过它**。
   */
  {
    id: 'terminal',
    titleKey: 'item.terminal',
    level: 'space',
    dockGroup: 'session',
    icon: 'Terminal',
    defaultPlacement: { kind: 'edge', side: 'bottom' },
  },
  /*
   * **「浏览器」从一块面降格成启动瓦**(B2,方案 §2.2-4;与「终端」那一行逐字
   * 同一条路)。id 一个字不改 —— 位置记忆、隐藏配置、Dock 顺序全按 id 记。
   * 点它 / 右键 / 拖它三件登记在 `content/browser-launcher.tsx`。
   *
   * `level` 从 `'space'` 改成 **`'app'`**:一格网页与「你此刻在做哪个项目」无关,
   * 切工作区不该让它消失(终端相反 —— 它开在项目目录里)。方案 §6「缺省不问」
   * 那一行写的就是这一格。
   *
   * **天生落中央区**,而这一格是**缺席**不是一行声明:`OpenPlacement` 里没有
   * 「中央」这一档 —— 中央是启动瓦那条路问完记忆与天生之后的**兜底**
   * (`browser-launcher.regionForLauncher` 的最后一句 `return CENTER_REGION`)。
   * 写一行 `{kind:'center'}` 需要先给那个联合加一档,而那一档在形态机里没有对应
   * 的住处(中央区是拼贴树的地,不是 Placement)。所以不写。
   * 一页网页要的地与一段对话要的地一样大,塞进架子只看得见三行;**存量记忆压过它**。
   */
  { id: 'browser', titleKey: 'item.browser', level: 'app', dockGroup: 'global', icon: 'Globe' },
  // 检索是一块普通的瓦:参与 Placement 全套(⌘P 也只是"按它的打开方式开一下")。
  { id: 'search', titleKey: 'item.search', level: 'space', dockGroup: 'global', icon: 'Search' },
  // 会话总览同样是一块普通的瓦(08-29 拍板去接管化):它有内容、有落点、有打开方式,
  // 和别的瓦逐字走同一条路 —— 「换一整屏」那种特权形态已经退役。
  /* 出厂摆法 = 左架子(W6-a,设计 §8:浮窗仍是合法落点,但不再是任何面板的出厂档
   * —— 一块出厂就停在聊天区正中的浮窗会把那块地整个接管掉)。存量记忆压过它。 */
  /* `floatMin`(W7-d 裁定 1):这块面自述「摆成浮窗至少要 800 宽」—— 低于它
   * 侧栏会整个不在场(容器阈值 761)。数与判词的产地是 `expose/float-min.ts`,
   * 这一行只是把它挂在名册上。 */
  {
    id: SESSIONS_ITEM_ID,
    titleKey: 'item.sessions',
    level: 'space',
    dockGroup: 'global',
    icon: 'MessagesSquare',
    defaultPlacement: { kind: 'edge', side: 'left' },
    floatMin: EXPOSE_FLOAT_MIN,
  },
  // 未读**不在这张表里**:表是静态声明,未读是当下的事实(住在 services/notify-store)。
  // Dock 渲染时才把两者对上 —— 表里写死一个 dot 就等于让声明冒充状态。
  { id: NOTIFICATIONS_ITEM_ID, titleKey: 'item.notifications', level: 'space', dockGroup: 'global', icon: 'Bell' },
  // 模型服务是**另一块瓦**,不是设置页里的一节:它有自己的左栏名册与右面分坑,
  // 而设置页的版式是「分区不分页的单列表单」(见 content/SettingsMock.tsx 顶部)。
  // 把一块两栏的面塞进那张单列表单,等于让两种版式在同一页里打架。
  { id: PROVIDERS_ITEM_ID, titleKey: 'item.providers', level: 'space', dockGroup: 'global', icon: 'Boxes' },
  // 工作区切换器。icon 是**常态**(08-31 用户否决字标瓦面:字当图标与这套风格不符)——
  // 瓦面画的是「色底 + 这枚图标」:**色**承载「我在哪」,**形**承载「这是什么」。
  // 列表还没读到时就只剩这枚图标,那时候确实没有「我在哪」可画。
  // 首字母没有退役,只是退回它本来该在的地方:右键快切表与总览卡上的小色点。
  { id: WORKSPACE_ITEM_ID, titleKey: 'item.workspace', level: 'app', dockGroup: 'global', icon: 'Layers' },
  /*
   * 音乐(音乐收尾 · 壳半边,2026-09-10)。**一块普通的瓦,走 `panel` 那条既有路**
   * —— 一行声明 + `content/index.tsx` 一行渲染,形态机 / Dock / 拼贴树一个字不动。
   *
   * ── 为什么它**不是**一种自己的内容(`content/kinds/music.tsx`)──────────
   * K2b-1 起壳的 `ContentRef` 与 core 的 `Ref` 是**同一套语法、同一张 scheme 表**
   * (判词整段在 `workbench/kinds.ts` 文件头)。登记一种叫 `music` 的内容,它的
   * refId 就是 `music:<key>` —— 而 `music:radio` / `music:player` / `music:provider`
   * 已经是 core 那三个资源单例的地址。同一串字符两个意思,正是那条法要消灭的
   * 「一种东西两个名字」的镜像。走 `panel` 这条路,这块面的地址是 `panel:music`,
   * 与资源地址结构上撞不上;而 `panel` 那一种本来就是「Dock 上那些瓦」的登记处,
   * 单例、标题读 `item.music`、图标读这一行 —— 一格都不必自己写。
   *
   * `dockGroup: 'global'`:这台机器上只有一个电台、一个播放器(自述里它们是恒在的
   * 单例),音乐不随会话换 —— 与浏览器 / 检索 / 通知同一档。
   * `level: 'space'`:S1 的 app 级只给 §2.2 表上那三块(工作区 / 设置 / 所有应用),
   * 其余一律 space —— 缺省 = 保持今天的行为,不顺手替用户改一格。
   */
  { id: 'music', titleKey: 'item.music', level: 'space', dockGroup: 'global', icon: 'Music' },
  { id: 'settings', titleKey: 'item.settings', level: 'app', dockGroup: 'global', icon: 'Settings' },
  // 「所有应用」排在最后:它是**管理**入口,不是又一块日常要点的面。
  // 两条特殊都在这一行上,不散在代码里 —— 见 APPS_ITEM_ID 的注释。
  {
    id: APPS_ITEM_ID,
    titleKey: 'item.apps',
    level: 'app',
    dockGroup: 'global',
    icon: 'LayoutGrid',
    alwaysInDock: true,
    defaultPlacement: { kind: 'full' },
  },
]

/*
 * **Dock 那条分隔线的两组**(拍点 1)。它们读的是 `dockGroup`(纯视觉),
 * **不是** `level`(作用域)—— 两件事两个字段,判词在 `StageItemSpec.dockGroup` 上。
 * 名字保持不动:值就是 `'session'` / `'global'`,组名与值同源。
 */
export const SESSION_ITEMS = STAGE_ITEMS.filter((i) => i.dockGroup === 'session')
export const GLOBAL_ITEMS = STAGE_ITEMS.filter((i) => i.dockGroup === 'global')

export function findItem(id: string | null): StageItemSpec | undefined {
  if (!id) return undefined
  return STAGE_ITEMS.find((i) => i.id === id)
}

/**
 * **这块瓦自述的浮窗最小身量**(W7-d 裁定 1)。不认识的 id / 没自述的瓦 =
 * `undefined`(听全体默认身量的)。
 *
 * 它是「**壳读表**」那一句:形态机的纯函数只收一对数,壳这一侧负责回答
 * 「这一格是谁、它自述了什么」。所以 `stage/transitions.ts` 里一个瓦名都没有,
 * 而这只函数是全壳唯一一处把「开窗身量」与「哪块瓦」对上的地方 —— 再来一块
 * 自述的面,只是 `STAGE_ITEMS` 那一行上多一格,形态机与这里一个字都不动。
 */
export function floatMinOfItem(id: string | null): FloatMinSize | undefined {
  return findItem(id)?.floatMin
}
