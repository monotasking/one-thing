import { focusScopeAnswersOf, focusScopeClaimsOf } from '../../focus/scopes'
import { currentKeymapPlatform, useKeymapStore } from '../../keymap/store'
import { KEYMAP_COMMANDS, effectiveCombos } from '../../keymap/transitions'
import { nativeViewBridge } from '../../data/browser-port'
import type { Combo, KeymapPlatform } from '../../keymap/types'
import type { FocusScopeId } from '../../focus/types'

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
 * `{ctrl:true}` 的绑定(出厂的 `toggle:terminal` 就是)会永远对不上。
 *
 * ## 整表覆盖,而且**整壳一份**
 *
 * 键位可以在设置里改绑,一份全表比一串增删更难对错。推表这件事与「屏幕上有几片
 * 原生视图」无关(主进程那张表是全局的),所以这里是**模块级的一份**,按引用计数
 * 开合:两片视图挂着也只有一条订阅、一份表。
 */

/** 一条绑定 → 主进程认的那个串。与 `chordOf` 同一套规则(见文件头)。 */
export function chordOfCombo(combo: Combo, platform: KeymapPlatform): string {
  const parts: string[] = []
  const primary = combo.meta === true || combo.ctrl === true
  if (primary) parts.push(platform === 'mac' ? 'cmd' : 'ctrl')
  if (combo.alt === true) parts.push('alt')
  if (combo.shift === true) parts.push('shift')
  parts.push(combo.key.toLowerCase())
  return parts.join('+')
}

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
  overrides: Record<string, Combo[] | null>,
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
    for (const combo of effectiveCombos({ overrides }, command.id)) {
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

/** 谁在挂着 → 要收哪几个作用域的局部键。引用计数,见文件头。 */
const SCOPES = new Map<FocusScopeId, number>()
let unsubscribe: (() => void) | undefined
let lastSent: string | undefined

function push(): void {
  const bridge = nativeViewBridge()
  if (!bridge) return
  const chords = boundChordsFor(
    [...SCOPES.keys()],
    useKeymapStore.getState().overrides,
    currentKeymapPlatform(),
  )
  // 整表覆盖,但**一样就不发**:键位 store 上任何一次无关的写(它还存别的东西)
  // 都会把这条订阅叫醒,而一条与上次逐字相同的表推下去只是白跑一趟 IPC。
  const signature = chords.join('\u0000')
  if (signature === lastSent) return
  lastSent = signature
  bridge.send({ verb: 'keymap', chords })
}

/**
 * 挂上这条下沉链。**启动时推一次**,之后键位表每变一次推一次;返回退订。
 *
 * 幂等到「同一个作用域挂两片视图」这一档:计数加一、表不重推(签名一样)。
 */
export function startNativeViewKeymapDownlink(scope: FocusScopeId): () => void {
  SCOPES.set(scope, (SCOPES.get(scope) ?? 0) + 1)
  unsubscribe ??= useKeymapStore.subscribe(push)
  push()
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (SCOPES.get(scope) ?? 1) - 1
    if (left > 0) SCOPES.set(scope, left)
    else SCOPES.delete(scope)
    if (SCOPES.size > 0) {
      push()
      return
    }
    unsubscribe?.()
    unsubscribe = undefined
    lastSent = undefined
    /*
     * 最后一片视图走了 —— **不推空表**。表推给的是主进程那只 `KeymapBridge`,
     * 而它是按视图挂监听的:没有视图就没有人读这张表。推一张空表等于在说
     * 「从现在起页面吃掉所有键」,而下一片视图挂上来时那句话还留在那儿。
     */
  }
}

/** 回到出厂。测试用。 */
export function resetNativeViewKeymapDownlink(): void {
  SCOPES.clear()
  unsubscribe?.()
  unsubscribe = undefined
  lastSent = undefined
}
