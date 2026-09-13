import { focusScopeAnswersOf, focusScopeClaimsOf } from '../../focus/scopes'
import { dispatchHostCommand } from '../../focus/dispatch'
import { focusTree } from '../../focus/registry'
import { routeCommand } from '../../focus/transitions'
import { chordOfCombo } from '../../keymap/chord'
import { projectAppMenu } from '../../keymap/menu-projection'
import { currentKeymapPlatform, useKeymapStore } from '../../keymap/store'
import { KEYMAP_COMMANDS, effectiveCombos } from '../../keymap/transitions'
import { useStageStore } from '../../stage/store'
import { nativeViewBridge } from '../../data/browser-port'
import type { AppMenuSpec, NativeViewPush } from '../../data/browser-port'
import type { CommandId, KeymapPlatform, KeymapState } from '../../keymap/types'
import type { FocusScopeId } from '../../focus/types'

/**
 * 串那一份规范 **K5 起住在 `keymap/chord.ts`**(两个方向挨着写:键位组的
 * 导入 / 导出要把同一句话**读回来**,而一个只能正着走的函数不是一份规范)。
 * 这里原样再导出,既有调用点(门 / 用例)一个字不用改 —— 与 `transitions.ts`
 * 再导出命令表逐字同一手。
 */
export { chordOfCombo } from '../../keymap/chord'

/**
 * **键位下沉**(方案 §9-1,v2 里最大的那个洞)。
 *
 * ## 病
 *
 * 一片原生视图拿到焦点之后,键盘事件进的是**页面那个 webContents**;渲染进程
 * `focus/dispatch.ts` 上那条 window 捕获监听一个键都收不到。⌘K / ⌘P / 全部全局
 * 命令、`browser` 作用域自己的 ⌘L 统统死掉。
 *
 * ## 治法:保留键先于页面
 *
 * 渲染进程把「**已绑定的组合键**」整表推给主进程(`verb: 'keymap'`);主进程给
 * 每片视图挂 `before-input-event`,在表里的 `preventDefault()` 并推回来,交给壳里
 * 唯一那个派发器照常走(局部先接、全局兜底),不在表里的归页面。这正是 Chrome
 * 自己「保留键先于页面」的形,也是 VS Code 对 webview 的做法。
 *
 * ## 规范化只有一份判据,而它住在主进程
 *
 * 两端要对同一个键说同一个名字。那句话的产地是
 * `electron/browser/keymap-bridge.ts` 的 `chordOf`:修饰键固定次序
 * `cmd → ctrl → alt → shift`、主键小写。这一侧**按同一套规则把 `Combo` 写成串**
 * —— 它不是第二份判据,是同一套规则的另一次调用(主进程收到一次真按键时再算
 * 一遍,两串比对)。
 *
 * ## 「主修饰键」这一格必须在这里落地
 *
 * `Combo` 里 `meta` 与 `ctrl` 只是**两种拼法**,都读作「主修饰键」;真按下的是哪
 * 一枚由平台定(`keymap/transitions.ts` 的 `matchCombo`,T1-fix)。主进程收到的是
 * 一次**真按键**(mac 上 `meta: true`),所以推下去的串必须已经解释过平台:
 * mac 写 `cmd+…`、其余写 `ctrl+…`。把 `meta`/`ctrl` 原样推下去,mac 上一条写成
 * `{ctrl:true}` 的绑定会永远对不上。
 *
 * **K2 起还有第三种拼法** `offHand: true`(「另一枚」,判词在 `Combo.offHand`):
 * 它同样在这里落地 —— mac 写 `ctrl+…`(⌃Tab / ⌃\`),Win / Linux 写 `cmd+…`
 * (主进程把 `meta: true` 写成 `cmd`,那一侧不认识「另一枚」这个词,它只认
 * 真按下的那几枚修饰键)。
 *
 * ## 整表覆盖,而且**整壳一份**
 *
 * 键位可以在设置里改绑,一份全表比一串增删更难对错。推表这件事与「屏幕上有几片
 * 原生视图」无关(主进程那张表是全局的),所以这里是**模块级的一份**,按引用计数
 * 开合:两片视图挂着也只有一条订阅、一份表。
 */

/**
 * 此刻「已绑定的**保留键**」全表(K0 起它从命令表派生,判据写成了数据)。
 *
 * 一条命令进表要同时满足三件:
 *  · `nativeView === 'reserve'`(它要先于页面被截下来。今天全表都是 —— 让出 ⌘P
 *    给网页打印是 K2 的拍点,而那一天改的是**表上一格**,不是这只函数);
 *  · **此刻真绑着键**(解绑的那条该归页面);
 *  · 应用级(`app`),**或者**这几格在场的作用域里有人答得出它。
 *
 * 第三条是「⌘S 不该被推下去」的判据:`view.save` 只有查看器答得出,而查看器与
 * 那片原生视图不会同时在场;推下去只会让页面自己的 ⌘S 变成一个什么都不做的键。
 * 收哪几个作用域由调用方给 —— 这只文件因此不认识 `browser`。
 *
 * **`claims` 不下沉**:那几个键归里面那台程序,页面本来就该拿到它们。所以最后
 * 减掉在场作用域认领的那些(今天浏览器一格都没有,终端不走这条路 —— 留着这一
 * 句是因为下一片原生视图可能两样都有)。
 */
export function boundChordsFor(
  scopes: readonly FocusScopeId[],
  state: KeymapState,
  platform: KeymapPlatform,
): string[] {
  const answered = new Set<string>()
  for (const scope of scopes) {
    for (const answer of focusScopeAnswersOf(scope)) answered.add(answer.command)
  }
  const out = new Set<string>()
  for (const command of KEYMAP_COMMANDS) {
    if (command.nativeView !== 'reserve') continue
    if (!command.app && !answered.has(command.id)) continue
    for (const combo of effectiveCombos(state, command.id)) {
      out.add(chordOfCombo(combo, platform))
    }
  }
  /*
   * 认领的那几个减掉。比的是**串**不是 `Combo` —— `chordOfCombo` 已经把平台
   * 解释过了(mac 写 `cmd+…`、其余写 `ctrl+…`),所以「⌘P 与 Ctrl+P 是同一条」
   * 这件事在这一层是逐字相等,不需要再问一次 `sameCombo`。
   */
  for (const scope of scopes) {
    for (const claim of focusScopeClaimsOf(scope)) out.delete(chordOfCombo(claim, platform))
  }
  return [...out].sort()
}

/**
 * **一片原生视图永远住在一格 tab 里**(K2)。
 *
 * 所以「叶答得出的那一族」与这片视图自己那一格作用域一样在活动路径上,一样要
 * 先于页面被截下来:⌘T 同类再开一格、⌘W 关这一格、⌘⇧T 重开、⌘⇧[ ⌘⇧] 与
 * ⌃Tab 换格、⌘1–9 直达 —— 这正是 Chrome / Safari 对自己那几个键的做法
 * (网页拿不到 ⌘T / ⌘W / ⌘1–9)。
 *
 * ── 它为什么是这只文件里的一格常量,而不是 `NativeViewSlot` 传进来的 ──────
 * 「视图住在一格 tab 里」是**这条下沉链的结构前提**,不是某一片视图的属性:
 * 下一种原生视图(PDF 阅读器)照样住在一格 tab 里,不该再想一遍这件事。
 * 占位格那一侧只报**它自己**那一格作用域(`browser` / 将来的 `pdf`),这里补上
 * 它必然的宿主。
 *
 * ── 与 K0 的口径差在哪(**可感知的行为变化,逐条列在交卷报里**)────────────
 * K0 的判据是「`app` ∨ **在场作用域**答得出」,而那时在场的只有 `browser` 一格,
 * 于是 ⌘W 这类只有叶答得出的命令被让给了页面 —— 结果是「焦点在网页里按 ⌘W
 * 什么都不发生」。K2 把叶补进在场集合,那一档因此变成「关掉这一格」。
 */
export const NATIVE_VIEW_HOST_SCOPES: readonly FocusScopeId[] = ['leaf']

/** 谁在挂着 → 要收哪几个作用域的局部键。引用计数,见文件头。 */
const SCOPES = new Map<FocusScopeId, number>()
/**
 * **应用级那条链的引用计数**(K4)。
 *
 * 键位表只有原生视图在场时才有人读,**菜单栏不是** —— 它在壳起来的那一刻就画在
 * 屏幕顶上,一格浏览器都没开也得是对的。所以这条链有两种挂法:
 *  · `startKeymapDownlink()` —— `AppShell` 挂一次,整台壳的寿命;
 *  · `startNativeViewKeymapDownlink(scope)` —— 每片原生视图挂一次,只为了把
 *    **它那一格作用域**的局部键补进保留键表。
 * 两种都只是给同一只 `push()` 加一个理由,表还是一份、订阅还是一条。
 */
let appLinks = 0
let unsubscribers: (() => void)[] = []
let lastSent: string | undefined
/** 上一次算出来的 locale —— stage store 上任何一次写都会叫醒订阅,只有它变了才重投影。 */
let lastLocale: string | undefined

/** 一条命令此刻答不答得出。**与派发器同一条判据**(判词在 `routeCommand` 上)。 */
function commandEnabled(id: CommandId): boolean {
  return routeCommand(focusTree.nodes(), focusTree.activePath(), id) !== null
}

function currentMenu(platform: KeymapPlatform): AppMenuSpec {
  return projectAppMenu({
    state: useKeymapStore.getState(),
    platform,
    isEnabled: commandEnabled,
  })
}

function push(): void {
  const bridge = nativeViewBridge()
  if (!bridge) return
  const platform = currentKeymapPlatform()
  const chords = boundChordsFor(
    [...SCOPES.keys(), ...NATIVE_VIEW_HOST_SCOPES],
    /*
     * **整份状态**,不是只有覆盖那一格(K5):有效键是三层落出来的,换一个
     * 键位组就是换一张保留键表 —— 只递 `overrides` 的话,切到 VS Code 组之后
     * 主进程收到的还是出厂那张表,网页里按 ⌘⇧P 会落到页面自己手里。
     */
    useKeymapStore.getState(),
    platform,
  )
  const menu = currentMenu(platform)
  /*
   * 整表覆盖,但**一样就不发**:三条订阅(键位 store / 焦点树 / 语言)里任何一次
   * 无关的写都会把这只函数叫醒,而一条与上次逐字相同的帧推下去只是白跑一趟 IPC
   * —— 主进程那一侧收到菜单就会重建一次 `Menu`(Electron 的菜单不可变),
   * 所以这道签名不只是省一次 IPC,它是「同签名不重建」的第一道。
   *
   * 签名把两半都算进去:菜单变了而键表没变(换了个焦点)照样要发。
   */
  const signature = `${chords.join('\u0000')}\u0001${JSON.stringify(menu)}`
  if (signature === lastSent) return
  lastSent = signature
  bridge.send({ verb: 'keymap', chords, menu })
}

/**
 * 三条订阅。**三处都走同一只 `push()`**(签名去重在那里),所以「什么时候重投影」
 * 这句话只有一个产地:
 *  · **键位表变**(改绑 / 换键位组)—— 保留键表与菜单上的键面同时变;
 *  · **活动路径变**(焦点换人)—— `enabled` 那一格是活动路径算出来的;
 *  · **换语言** —— 标签是当场翻好的串,主进程没有字典重翻不了。
 */
function subscribe(): void {
  if (unsubscribers.length > 0) return
  lastLocale = useStageStore.getState().locale
  unsubscribers = [
    useKeymapStore.subscribe(push),
    focusTree.subscribe(push),
    useStageStore.subscribe(() => {
      // stage store 存的东西多得很(浮窗次序、Dock 形状…),只有语言这一格与菜单有关。
      const locale = useStageStore.getState().locale
      if (locale === lastLocale) return
      lastLocale = locale
      push()
    }),
    /*
     * 菜单栏上点一项 → 主进程推 `{ kind: 'command' }` 回来 → 交给壳里**唯一**那个
     * 派发口。收它的是**这条链**而不是占位格(`NativeViewSlot`):占位格只在有
     * 原生视图时才挂载,而菜单在没开浏览器时照样点得动。
     */
    bridgeOn(message => {
      if (message.kind !== 'command') return
      dispatchHostCommand(message.id as CommandId)
    }),
  ]
}

/** 订阅推送口。没有宿主(`--mode web`)时是一只空退订。 */
function bridgeOn(handler: (message: NativeViewPush) => void): () => void {
  return nativeViewBridge()?.on(handler) ?? (() => {})
}

function unsubscribeAll(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
  lastSent = undefined
  lastLocale = undefined
}

/** 还有人要这条链吗。 */
function linked(): boolean {
  return appLinks > 0 || SCOPES.size > 0
}

function release(): void {
  if (linked()) {
    push()
    return
  }
  unsubscribeAll()
}

/**
 * **整台壳那一条链**(K4)。`AppShell` 挂一次,活到壳被卸载。
 *
 * 它在的时候菜单表一直是新的;它是 K4 之前那条「最后一片视图走了就退订」的
 * 判词改口的地方 —— 从前没有视图就没有人读这张表,今天菜单栏一直有人读。
 */
export function startKeymapDownlink(): () => void {
  appLinks += 1
  subscribe()
  push()
  let released = false
  return () => {
    if (released) return
    released = true
    appLinks -= 1
    release()
  }
}

/**
 * 挂上这条下沉链。**启动时推一次**,之后键位表每变一次推一次;返回退订。
 *
 * 幂等到「同一个作用域挂两片视图」这一档:计数加一、表不重推(签名一样)。
 */
export function startNativeViewKeymapDownlink(scope: FocusScopeId): () => void {
  SCOPES.set(scope, (SCOPES.get(scope) ?? 0) + 1)
  subscribe()
  push()
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (SCOPES.get(scope) ?? 1) - 1
    if (left > 0) SCOPES.set(scope, left)
    else SCOPES.delete(scope)
    /*
     * 最后一片视图走了 —— **不推空表**(表本来也不会空:叶那一族永远在里面,
     * 判词在 `NATIVE_VIEW_HOST_SCOPES` 上)。K4 之前这里连订阅一起拆,理由是
     * 「没有视图就没有人读这张表」;今天菜单栏一直在读同一条帧的另一半,所以
     * 拆不拆由 `linked()` 说了算,而不是由「有没有视图」说了算。下一片视图挂上来
     * 时照样会推一次带它那一格作用域的全表(上面那句 `push()`)。
     */
    release()
  }
}

/** 回到出厂。测试用。 */
export function resetNativeViewKeymapDownlink(): void {
  SCOPES.clear()
  appLinks = 0
  unsubscribeAll()
}
