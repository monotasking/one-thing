import type { MessageKey } from '../i18n'
import type { ShelfSide } from '../stage/types'

/**
 * 快捷键注册表的形状。和 stage/ expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * ── 三层(09-01 立法)→ 一张表 + 响应者(K0,2026-09-12)────────────────────
 * 立法一个字没变,变的是「表长什么样」(方案
 * `docs/keymap-responder-2026-09.md` §4):从前**全局命令**在这张表里、
 * **面域局部键**在 `focus/scopes.ts` 的 `keys` 里、**终端礼让表**在
 * `content/terminal/key-courtesy.ts` 里,一个键的意义散在三个产地。
 * K0 起只有两种对象:
 *  · **命令**(`KeymapCommand`)—— 键 ↔ 意义,唯一的一张表(`commands.ts`)。
 *    `app` 那一格说的是「活动路径上没人接时,应用层有没有兜底实现」:
 *    `true` 就是从前的全局档(呼出一块面 / 做一件全局的事),`false` 就是从前的
 *    面域局部键(它需要一个**由焦点决定的目标**,没人答就不响)。
 *  · **响应者**(一格作用域实例)—— 「我此刻能做哪些命令」,落点是实例注入的
 *    `commands`(`focus/FocusScope` 的同名 prop),声明是 `FOCUS_SCOPES[id].answers`。
 * 撞键裁决照旧:**局部先接,没接住放行全局** —— 由活动路径的深度保证
 * (`focus/transitions.routeKey`),不靠冒泡序。
 * ③ **行内结构键**(方向 / ↵ / Space / Tab / Esc)照旧**不进任何表**,见下。
 *
 * ── 什么进这张表,什么永远不进 ───────────────────────────────────────────────
 * 进:**命令**。一次按键 = 触发一个具名动作(呼出某块面、开关总览、收展右钉栏、
 *     在这块面里查找)。它们互相之间没有顺序、没有层次,少一个多一个都不影响
 *     别的,所以可配置。
 * 不进:**结构导航键**。它们不是命令,而是这套形态语法本身的一部分:
 *     - Esc 逐层退出(浮窗 → 舞台 → 总览 Quick Look → 总览);
 *     - 总览里的方向键 / Enter / Space(移焦、进入、Quick Look);
 *     - 浮窗的拖拽与缩放手柄。
 *     理由是同一条:它们在**每一层**都必须是同一个手感,一旦可配置,
 *     「Esc 就是退一层」这条全局承诺就没了 —— 那不是自由度,是不一致。
 *     所以这几个键住在各自的层里(ExposeView / StageOverlay / FloatWindow),
 *     不经过派发器,也不出现在设置页。
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * 一个组合键。
 *
 * key 是 KeyboardEvent.key 的**小写规范形**('p' / 'escape' / 'arrowup' / ' '),
 * 所以 'P' 与 'p' 是同一个键,大小写不再是第二种真相。
 *
 * meta 与 ctrl 在**匹配与冲突判定**里是同一件事 ——「主修饰键」在 mac 上是 ⌘、
 * 在别处是 Ctrl,同一条绑定要在两种键盘上都好使。两者的区别只活在**显示**里
 * (formatCombo 按平台选字);规则只有一条,写在 transitions 的 primaryOf 上。
 */
export interface Combo {
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /**
   * **就是「另一枚」那一枚修饰键**(K2;mac = Ctrl,Win / Linux = Meta/Win)。
   *
   * ── 它为什么是第五格,而不是「写 ctrl 就好了」 ──────────────────────────
   * 上面 `meta` 与 `ctrl` 在**匹配**里是同义的(都读作「主修饰键」),所以这张
   * 表从前**说不出**「我要的就是 Ctrl 那一枚」:写 `{ctrl:true,key:'tab'}` 在
   * mac 上读作 ⌘Tab,而 ⌃Tab 恰恰是跨应用三十年的「下一个标签」。
   * T1 立法时把「另一枚永远不参与绑定」写成了 `offHandPressed`(按下侧的闸),
   * K2 把它补成**声明侧也说得出**的一格:`offHand: true` = 「按住另一枚,而且
   * 主修饰键**没**按」。
   *
   * 与 `meta` / `ctrl` **互斥**(一条绑定要么要主修饰键、要么要另一枚,两枚
   * 都要的组合这台壳不收);`matchCombo` 的 offHand 那一支先判,`sameCombo`
   * 把它算进身份,`formatCombo` 在 mac 上画 ⌃、别处画 Win。
   */
  offHand?: true
  key: string
}

/**
 * 命令 id。四族:
 *  - `toggle:<itemId>` —— 每块 Dock 瓦一条(会话总览去接管化之后也在其中),
 *    语义 = **召唤**(`stage/summon.summonTransition` 的四态:没打开就按它的打开
 *    方式开、看不见就露出来、看得见没聚焦就只把键盘送进去、焦点已经在里面就收起来。
 *    S1/09-04,设计 §14)。从前是 `togglePlacement`(纯开关),那一口随 S2 删掉;
 *  - `shelf.<side>.toggle` —— 四条架子各一条,收 / 展那一侧(09-01 用户放权键位:
 *    出厂 ⌘⌥← / → / ↓ / ↑)。语义是**折叠/展开**,不是关掉整栏 —— 关整栏会把
 *    架子上的瓦全收回 Dock,那是有后果的写操作,不该被一个盲按的键直接触发
 *    (与 agent.menu 那条纪律同源);收起来的架子按同一个键就回来了。
 *    从前这里只有 `shelf.right.toggle` 一条,而且出厂没绑键。
 *  - `toc.toggle` —— 目录面板收 / 展;
 *  - `agent.menu` —— 顶栏 agent 切换器的菜单开 / 关。**只是开菜单**,
 *    不做「按一下换下一个人」的轮换 —— 换人是有后果的写操作(改这条会话
 *    从下一条消息起归谁),不该被一个盲按的快捷键直接触发。轮换语义留账。
 *  - ~~`session.new`~~ —— **K2 退役**(09-12 用户裁定 1:「我正在看浏览器,
 *    点了 ⌘N,后面新建了一条会话,怎么个事」)。「新建」不是一件全局的事,
 *    它要一个**由焦点决定的目标** —— 换成下面那条 `content.new`(`app: false`)。
 *    老档案里挂在它上头的覆盖由 v4 迁移搬去 `content.new`。
 *  - `workspace.palette` —— 呼出工作区命令面板(过滤 + ↵ 切换)。同 agent.menu:
 *    它**只开一块面**,不替用户切;真正切到哪个是面里那一下 ↵。
 *  - `workspace.slot:<n>` —— 直达第 n 个工作区。**K2 起出厂不绑键**
 *    (09-12 用户裁定 2:「非常讨厌这个设计」,推翻 08-31 那条):⌘1–9 归
 *    焦点叶的第 n 格标签(`tab.select:n`),与浏览器 / 终端惯例一致。命令仍在
 *    表上 —— 想要的人自己绑一个,能力没少,少的只是出厂占着的那三个键位。
 * 加命令 = 在 KEYMAP_COMMANDS 里加一行,别处零改动。
 */
export type CommandId =
  | `toggle:${string}`
  | `shelf.${ShelfSide}.toggle`
  | 'toc.toggle'
  | 'agent.menu'
  | 'workspace.palette'
  | `workspace.slot:${number}`
  /* 真全屏(W2)。它不呼出任何一块面,它**对焦点叶的活动 tab 做一件事** ——
   * 与 `session.new` 同一族。落点在 `workbench.toggleFull`。 */
  | 'workbench.toggleFull'
  /*
   * **把焦点叶的活动标签往左 / 往右挪一位**(W7-c 裁定 3)。
   *
   * 它们从**菜单**里升上来:W3-b 时「左移一位 / 右移一位」是标签动作表里的两行,
   * 而 W7-c 把那张表收成六项时把它们拿掉了 —— 换序在真机上靠拖拽(W6-b 那套
   * 「朝运动方向越过邻居中心」的判据比按两下菜单快得多)。**一件事从菜单里拿掉
   * 不等于把它拿掉**:键盘那条路必须还在,而它本来就该是一条全局命令 ——
   * 判据与 `workbench.toggleFull` 逐字相同:它要的目标是「焦点叶的活动 tab」,
   * 那是 store 答得出的一句话,不需要键盘落在那片叶里。
   *
   * 落定走的仍是**拖拽落定同一只** `drop-commit.reorderTab`(播报在它里面)。
   */
  | 'workbench.moveTabLeft'
  | 'workbench.moveTabRight'
  /*
   * ── 从前的**面域局部键**,K0 起是九条同样形状的命令 ─────────────────────
   * 它们与上面那些的唯一区别是 `app: false`:**没有应用层兜底**,活动路径上
   * 没有响应者答得出这一条时,这一下就放行(页面 / PTY / 系统菜单接着走)。
   * 谁答得出由 `FOCUS_SCOPES[id].answers` 声明、由实例注入的 `commands` 落地。
   *
   * 名字按方案 §4 ①,一条命令一个意义(不是一块面一行):
   *  · `view.find` —— 在这块内容里查找。**一条命令三个响应者**(查看器 / 终端 /
   *    浏览器),三块面各自的说法挂在 `answers` 那一格的 `labelKey` 上;
   *  · `view.save` —— 存这份内容(今天只有查看器答);
   *  · `viewer.gotoLine` / `browser.address` —— 同一个键(⌘L)上的两条命令。
   *    它们合法,因为 `viewer` 与 `browser` 不会同时在一条活动路径上
   *    (冲突规则见 `commands.ts` 的 `comboConflictBetween`);
   *  · `files.detail` —— 文件树的详情。**一条命令两个出厂键**(⌘I 与 ⌘↵),
   *    所以 `defaultCombos` 是数组而不是一格;
   *  · `nav.back` / `nav.forward` —— 后退 / 前进。今天的响应者是检索面的查询历史,
   *    浏览器的前进后退是 K3 的事(**同一条命令**,不会是第三个产地);
   *  · `expose.pin` —— 会话总览置顶活动行;
   *  · `tab.close` —— 关当前 tab(响应者是叶)。
   */
  | 'view.find'
  | 'view.save'
  | 'viewer.gotoLine'
  | 'browser.address'
  | 'files.detail'
  | 'nav.back'
  | 'nav.forward'
  | 'expose.pin'
  | 'tab.close'
  /*
   * ── **标签族**(K2,方案 §3 那张跨应用对照表的「本壳应当」列)──────────
   * 六条,全是 `app: false`:它们要的目标是**焦点那片叶的那一排标签**,
   * 活动路径上没有叶就不响(而不是退一步找个人做掉 —— 那正是 ⌘N 从前
   * 「在浏览器里开出一条会话」的病根)。
   *
   *  · `tab.new`(⌘T)—— **在这一排里紧挨着当前那一格再开一格同类**。
   *    「同类」由那一格内容自己答(`ContentKind.spawn`);答不出的种类
   *    (查看器 / 面板)这一条就是 `undefined`,派发器穿过去,什么都不发生;
   *  · `content.new`(⌘N)—— **新建这一种内容,按这种内容自己的打开方式摆**。
   *    与 `tab.new` 的区别只在**摆法**:⌘T 永远是「这一排里的下一格」,⌘N 让
   *    这种内容自己说(会话按 `sessions.openMode`,浏览器 / 终端只有标签一种
   *    摆法,所以在它们里两个键同义)。会话总览与 composer 也答它 —— 它们是
   *    「焦点在会话这种内容里」的另外两种形;
   *  · `tab.reopen`(⌘⇧T)—— 重开这片叶最近关掉的那一格。快照由种类自述
   *    (`ContentKind.snapshot` / `restore`;缺席 = 用 ref 本身当快照);
   *  · `tab.next` / `tab.prev`(⌘⇧] ⌘⇧[ 与 ⌃Tab ⌃⇧Tab)—— **环绕**:
   *    最后一格的下一格是第一格(浏览器惯例)。单格叶不响;
   *  · `tab.select:<n>`(⌘1–⌘9)—— 第 n 格,**9 = 最后一格**(浏览器惯例)。
   *    n 超过这一排的格数就不响。
   */
  | 'tab.new'
  | 'content.new'
  | 'tab.reopen'
  | 'tab.next'
  | 'tab.prev'
  | `tab.select:${number}`

/**
 * 焦点在一片原生视图(`WebContentsView`)里时,这条命令要不要**先于页面**被截下来。
 *
 * `reserve` = 保留键(Chrome 自己对 ⌘P / ⌘L 的做法):主进程的 `before-input-event`
 * 把它 `preventDefault` 并推回壳,走唯一那个派发器。`yield` = 让给页面。
 * 今天全表都是 `reserve`(K0 零行为变化);让出 ⌘P 那一条是 K2 的拍点。
 */
export type NativeViewPolicy = 'reserve' | 'yield'

export interface KeymapCommand {
  id: CommandId
  /** 命令名是界面文案,所以只持有 key —— 同 StageItemSpec.titleKey 的判例。 */
  labelKey: MessageKey
  /**
   * 出厂绑定。**空数组 = 出厂就没绑**(用户可以自己绑一个);
   * 一条命令可以有**好几个**出厂键 —— `files.detail` 的 ⌘I 与 ⌘↵ 就是一条命令
   * 两个键面。从前那一格 `defaultCombo: Combo | null` 说不出这件事,于是文件树
   * 那两个键在旧表里是**两行**,而两行意味着两个意义。
   */
  defaultCombos: readonly Combo[]
  /**
   * **应用层有没有兜底实现**。活动路径上一格响应者都没接住时:`true` 交给
   * `keymap/run-command.ts` 的那张动作表(从前的「全局档」),`false` 就放行。
   */
  app: boolean
  /** 焦点在原生视图里时的去向,见 `NativeViewPolicy`。 */
  nativeView: NativeViewPolicy
}

/**
 * 只存**覆盖**。缺席 = 用后厂默认;显式的 null = 用户把它解绑了。
 * 「缺席」与「null」是两件事,所以这里不能用 `Combo[] | undefined` 糊过去。
 *
 * 值是**一串**组合(K0,跟着 `defaultCombos`):一条命令可以有好几个键面。
 * 设置页今天录一次写一格数组(整条换成那一个键),多键改绑是 K5 的事 ——
 * 但**形状先对**,否则 `files.detail` 的 ⌘↵ 一旦被覆盖就永远回不来。
 * 老档案里存的是单个 `Combo`,`migrateKeymapPersisted` 的 v3 段把它包成 `[Combo]`。
 */
export interface KeymapState {
  overrides: Record<string, Combo[] | null>
}

/** 显示用的平台。只影响键面写 ⌘ 还是 Ctrl,不影响匹配。 */
export type KeymapPlatform = 'mac' | 'other'

/**
 * 匹配只需要这五个字段。用结构类型而不是 KeyboardEvent,
 * 是为了纯函数能在没有 DOM 的地方被测 —— 真事件天然满足它。
 */
export interface ComboEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 录制态里一次按键的判读结果。抽成数据(而不是在组件里就地分支)
 * 的唯一理由:这四条分支要能被测。
 */
export type RecordOutcome =
  | { kind: 'ignore' }
  | { kind: 'cancel' }
  | { kind: 'unbind' }
  | { kind: 'bind'; combo: Combo }
