import { useEffect, useMemo } from 'react'
import { hasModifier, lookupCommands } from '../keymap/transitions'
import { currentKeymapPlatform, useKeymapStore } from '../keymap/store'
import { focusTree } from './registry'
import { tabStopWithin } from './tab-trap'
import { modalTrapNode, routeCommand, routeEscape, routeKey } from './transitions'
import { runShellCommand } from '../keymap/run-command'
import type { CommandId } from '../keymap/types'

/**
 * **全壳唯一的 window keydown 派发器**(设计 §4.3)。
 *
 * 壳里从前有 13 个 keydown 监听,分属八套机制,「这一下输入归谁」这个问题没有
 * 一个人持有答案 —— Esc 那段历史(08-30 microtask 失败 → 08-31 改相位 →
 * 09-01 立浮层栈)就是没有响应链时用 DOM 事件顺序硬凑出来的。这只文件是那 13 个
 * 的终点:一次按键先问树,树答不出才轮到全局命令表。
 *
 * ══ R2:两半合一,只剩**一个捕获相位的监听** ══════════════════════════════
 * R1 的过渡形把它切成两半(捕获管浮层 Esc / 模态 Tab / 录制独占,冒泡管面的
 * Esc / 局部键 / 全局命令),分界就是当时那条相位线 —— 因为 ExposeView /
 * composer / viewer / files 四家还挂着自己的监听,那一批守的是「与 HEAD 逐条相同」。
 * R2 把它们接进了树,于是那条线没有两侧了,两半合成这一张表:
 *
 * | # | 管什么 | 从前住在谁那儿 |
 * | --- | --- | --- |
 * | ① | 录制态独占 | `KeymapSettings` 的 window 捕获 |
 * | ② | I1 收回(焦点掉到 body 先接回来再路由) | 无(R1 新立) |
 * | ③ | 输入法组字放行 | 无(R2 新立,见下) |
 * | ④ | 瞬态 Esc 口(Tooltip / 原地编辑) | `Tooltip` 的 document 监听 |
 * | ⑤ | 路径上的 Esc,由深到浅 | `ui/float` 捕获 + `useEscapeChain` 冒泡 + composer / ExposeView / FilesPanel 各自那一份 |
 * | ⑥ | `modal` 的 Tab 圈禁 | `a11y/focus-trap` 的 document 捕获 |
 * | ⑦ | 输入面里的无修饰单键放行 | `keymap/dispatch` 的同一句 |
 * | ⑧ | 响应者的命令(由深到浅)+ 认领放行 | viewer / files 各自面域根上的元素监听 |
 * | ⑨ | 应用层兜底(`app: true` 那一条) | `keymap/dispatch` 的 window 冒泡 |
 *
 * ── 相位为什么是**捕获** ─────────────────────────────────────────────────
 * 相位从前要回答两个问题:「这一下归哪一层浮层」(靠捕获抢在前面)与「局部先接、
 * 没接住放行全局」(靠冒泡排在后面)。第一个问题现在由树答,第二个由树的深度答 ——
 * 相位于是只剩**一件**事要保:**React 元素级的结构键不被抢**。而结构键
 * (方向键 / ↵ / Space / Tab)**一格都不在命令表里**(§4.3 的封闭裁定),
 * 所以捕获相位跑在它们之前也拿不走它们:⑦ 先把输入面里的无修饰单键放掉,
 * ⑧ 只按表匹配(表里每一条都带修饰键),⑥ 只在真有 modal 时才碰 Tab。
 *
 * **Esc 是唯一的例外**,因为它是唯一由树处理的结构键:元素级也想接住这一下的
 * 那一族(原地编辑的「Esc 收回」)因此不能靠相位赢,得**在树上有个座位** ——
 * 那正是瞬态口④(`ui/inline-edit` 登记它,答 true 即认领)。用相位去解这件事
 * 就回到了 08-30 → 09-01 那三轮:相位只有两格,而要排序的东西不止两件。
 *
 * `defaultPrevented` 让位那一句留着(⑤/⑧/⑨ 三处各一次):捕获相位里它今天恒为
 * false(window 捕获是整条传播路径的第一站),但「别人真接住了就让开」是一条
 * **契约**,不是一处优化 —— 哪天前面再站一个更早的消费者,这一句就是它的出口。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ── 为什么 `runCommand` 是注入的 ─────────────────────────────────────────
 * 全局命令的落点(`summonItem` / `switchTo` / `newSessionInCurrentProject` …)
 * 长在 `keymap/` 那只 `useKeymapCommandRunner()` 里,它订阅着五个 store。
 * 抄一份进来的话那张动作表就有了两个产地,而它们迟早分叉 —— 所以是**共用一份**,
 * 由 `AppShell` 把 runner 递进来(R0 留账 4 的结清)。
 *
 * ── 输入法组字为什么单列一格(R2 新增)─────────────────────────────────────
 * 拼音输入法在候选框开着时,每一下按键先发一个 `keydown`(`isComposing === true`)
 * 给 IME,组完字再发真正那一下。捕获相位跑在最前面,所以这一格不放行的话,
 * 「选字时按 Esc」= 树把它当成「退一层」,把用户正在写字的那块面收掉 ——
 * 08-31 那条「中文输入法下回车发两次」是同一个病根的另一面
 * (`ComposerInput.isComposingKey` 的两种问法在那儿逐字写着)。
 * 这里只问标准那一条(`e.isComposing`):`keyCode === 229` 那条老约定是给
 * **元素级**的回车判的,而组字期间树本来就一格都不该动。
 *
 * ── 一次按键的顺序(与设计 §4.3 / §4.4 逐条对应)──────────────────────────
 *  ① **独占口**(录制态):它要吃所有键,含全局命令。树一格都不问。
 *  ② **I1 收回**:焦点掉到 body 了先接回来再路由 —— 被聚焦的元素被静默移除时
 *     `focusout` 都不发,这一处是三处收回里兜底的那一处(§4.1 修正段)。
 *  ③ **组字放行**:见上。
 *  ④ **瞬态口**:Tooltip / 原地编辑那一族(不占焦点、或没有自己的根)。答 true 才认领。
 *  ⑤ **Esc**:沿活动路径由深到浅问 `onEscape()`,第一个答 true 的消费掉。
 *     没人答 true → **不 preventDefault**(后面的消费者照旧)。
 *  ⑥ **Tab**:只在 `modal` 作用域被圈禁,别处一律放行(结构键不进表)。
 *  ⑦ 输入面里的**无修饰单键**归输入框(判据与旧派发器逐字相同)。
 *  ⑧ **响应者**:由深到浅找第一个答得出候选命令的作用域;命中即
 *     `preventDefault` 并跑它注入的处理器。认领(`claims`)在它之前问,命中就
 *     **不 preventDefault** 地放行(K0)。
 *  ⑨ 都没命中 → 候选里 `app: true` 的那一条(应用层兜底);还没有就放行。
 *
 * 「局部先接、没接住放行全局」这条裁定一个字没变,变的是它靠什么成立:
 * 从前靠 DOM 冒泡序(局部监听挂在面域根上,先于 window 收到),现在靠树的深度。
 * 用户报的 ⌘F 死在旧判据上 —— 查看器在活动路径上,但那一下按键没有经过它的根。
 */

/**
 * **喂一个合成键给那唯一的派发器**(B2 §9-1 的回程)。
 *
 * 一片原生视图(`WebContentsView`)拿到焦点之后,键盘进的是页面那个 webContents;
 * 主进程按「已绑定的组合键」整表把保留键截下来(`electron/browser/keymap-bridge.ts`),
 * 经 `host:native-view` 推回渲染进程 —— 推回来的那一下要走的**正是这条路**:
 * 局部先接、全局兜底、Esc 退层,一条判据都不许另起炉灶。
 *
 * 所以它**不挂第二个监听**,也不复制上面那张九格表:它只是在 window 上派发一次
 * 真的 `keydown`,于是那条捕获监听照常收到、照常路由。派发目标是 `window`,
 * 所以 `e.target` 不是 `HTMLElement`,⑦「输入框里的无修饰单键」那一格自然不命中
 * —— 键盘此刻在页面里,壳里没有任何一个输入框该认领它。
 *
 * 修饰键的名字用的是主进程 `chordOf` 那一套(`cmd` / `ctrl` / `alt` / `shift`),
 * 与 `content/native-view/keymap-downlink.ts` 推下去的表同一份词汇。
 */
export function dispatchSyntheticKey(message: {
  key: string
  code: string
  modifiers: readonly string[]
}): void {
  const mods = new Set(message.modifiers)
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: message.key,
      code: message.code,
      metaKey: mods.has('cmd'),
      ctrlKey: mods.has('ctrl'),
      altKey: mods.has('alt'),
      shiftKey: mods.has('shift'),
      bubbles: true,
      cancelable: true,
    }),
  )
}

/**
 * **宿主(菜单栏)点了一条命令**(K4 的回程)。
 *
 * 它与 `dispatchSyntheticKey` 挨着写、住同一只文件,因为它们是同一件事的两种
 * 入口:一次从**宿主**来的动作要走壳里**唯一**那条判据 —— 局部先接、没接住才
 * 应用层兜底。区别只在「这一下是什么」已经知道了(一条具名命令),所以它不必
 * 合成一个按键:合成按键会把「这条命令绑的是哪个键」变成第二个说法,而菜单项
 * 上画的那个键面本来就是同一张表投影出去的。
 *
 * `routeCommand` 是 `routeKey` 的另一半(判词写在它自己身上),所以**画灰的项
 * 按下去不会有事发生**这句话在两侧是同一段代码算出来的 —— 菜单只是投影,
 * 不是第二条键盘路。
 *
 * ── 为什么这里直接吃 `runShellCommand`,而 `useFocusDispatch` 收的是注入的 ──
 * 那条注入的理由(文件头「为什么 `runCommand` 是注入的」)是**动作表不许有第二
 * 个产地**;K2b-1 之后那张表本身就是模块级纯函数 `run-command.ts`,`useKeymapCommandRunner()`
 * 只是给 React 消费者的一层稳定引用。菜单点击没有 React 上下文(它从 IPC 进来),
 * 所以它调的是同一张表本人 —— 产地仍然只有一个。
 */
export function dispatchHostCommand(id: CommandId): boolean {
  const route = routeCommand(focusTree.nodes(), focusTree.activePath(), id)
  if (!route) return false
  if (route.target === 'root') {
    runShellCommand(route.command)
    return true
  }
  if (route.target !== 'scope') return false
  focusTree.nodes().get(route.instanceId)?.commands?.[route.command]?.()
  return true
}

/** 焦点在输入面里:无修饰的单键属于输入框,不属于快捷键。(与旧派发器逐字相同) */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

export interface FocusDispatchOptions {
  /** 全局命令的落点。见文件头「为什么是注入的」。 */
  runCommand: (id: CommandId) => void
}

export function useFocusDispatch(opts: FocusDispatchOptions): void {
  /*
   * 递**整份**键位状态,不只是覆盖那一格(K7 顺手修的 K5 真 bug):`lookupCommands`
   * → `effectiveCombos` 是三层落(覆盖 ▷ 键位组 ▷ 出厂),只递 `{ overrides }` 它读不到
   * `profileId`,当场落回出厂组 —— 于是切到 VS Code / JetBrains 组之后设置页、菜单栏、
   * 原生视图保留表三处都画新键,唯独按下去还是出厂那一套。
   */
  const overrides = useKeymapStore((st) => st.overrides)
  const profileId = useKeymapStore((st) => st.profileId)
  const userProfiles = useKeymapStore((st) => st.userProfiles)
  const keymap = useMemo(
    () => ({ overrides, profileId, userProfiles }),
    [overrides, profileId, userProfiles],
  )
  const { runCommand } = opts
  /*
   * 「主修饰键是哪一枚」(T1-fix)。两只纯函数(`routeKey` / `lookupCommand`)
   * 都要它,而它们一行都不许读 `navigator` —— 所以这台机器由**派发器**量一次
   * (与 `formatCombo` 的调用方同一条纪律)。它在一次会话里不会变,所以量在
   * effect 外面、不进依赖表。
   */
  const platform = currentKeymapPlatform()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // ① 独占(录制态)—— §5 里唯一那条例外,它仍然不许自己挂 window。
      //    `stopPropagation` 是录制态成立的前提:不掐断,录 ⌘P 时检索面会真的弹出来。
      const captured = focusTree.capturedHandler()
      if (captured) {
        if (captured(e)) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      // ② I1 的第三处收回。放在路由之前:这一下按键该由谁接,取决于焦点在哪儿。
      focusTree.recoverOrphanFocus()

      // ③ 组字期间整台树都不动(理由见文件头那一段)。
      if (e.isComposing) return

      // 别人真接住了就让开(契约,见文件头末段)。
      if (e.defaultPrevented) return

      const nodes = focusTree.nodes()
      const path = focusTree.activePath()

      if (e.key === 'Escape') {
        // ④ 瞬态口(Tooltip / 原地编辑)。答 true 才认领,tooltip 一族答 false。
        for (const handler of focusTree.transientEscapeHandlers()) {
          if (handler()) {
            e.preventDefault()
            return
          }
        }
        /*
         * ⑤ 路径上的 Esc:由深到浅,第一个答 true 的消费掉;root 的
         * `escapeTopmost` 是最后一环(§4.4)。
         * **不判 isTypingTarget** —— 退层链从来不判,输入框里按 Esc 照样退一层。
         */
        for (const node of routeEscape(nodes, path)) {
          if (node.onEscape?.()) {
            e.preventDefault()
            return
          }
        }
        return
      }

      // ⑥ Tab:只有 modal 圈禁。哪一格圈得住由 `modalTrapNode` 判(两步,见那只函数)。
      if (e.key === 'Tab') {
        const trap = modalTrapNode(nodes, path)
        if (!trap?.root) return
        const stop = tabStopWithin(trap.root, document.activeElement, e.shiftKey)
        if (!stop) return
        e.preventDefault()
        if (focusTree.policy.moveFocus) stop.focus({ preventScroll: true })
        return
      }

      // ⑦ 输入框里的无修饰单键让给输入。
      if (isTypingTarget(e.target) && !hasModifier(e)) return

      /*
       * ⑧⑨ 局部先接,没接住放行应用层。
       *
       * K0:先算**候选命令集**(一个键可以绑好几条命令,谁做由活动路径说了算),
       * 再交给 `routeKey`。`claim` 那一档是**认领并放行** —— 这一下已经有主了
       * (里面那台程序),所以既不跑什么,也**不 `preventDefault`**:xterm 收到
       * 原生 keydown 自己就会把 `^P` 写成 `\x10` 发下去。从前是壳先截下来、
       * 再自己往 PTY 写一遍同一个字节。
       */
      const candidates = lookupCommands(keymap, e, platform)
      const route = routeKey(nodes, path, e, candidates, platform)
      if (!route) return
      if (route.target === 'claim') return
      e.preventDefault()
      if (route.target === 'root') {
        runCommand(route.command)
        return
      }
      nodes.get(route.instanceId)?.commands?.[route.command]?.()
    }

    /*
     * **全壳唯一一行 window keydown**。R3 起 `keydown-outside-focus`(I2)是硬闸,
     * 允许区只有 `src/focus/` —— 这一行就住在允许区里,不需要豁免。
     * (R1/R2 期间这里还挂着一条 `float-handwritten` 的豁免:那条规则曾按
     * 「window 上的捕获相位 keydown」认人,与 I2 问的是同一件事而判得更松。
     * R3 把它那半边探针删了,豁免随之退役 —— 同一笔账不记两遍。)
     */
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [keymap, runCommand, platform])
}
