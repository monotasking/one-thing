import { useEffect } from 'react'
import { hasModifier, lookupCommand } from '../keymap/transitions'
import { useKeymapStore } from '../keymap/store'
import { focusTree } from './registry'
import { tabStopWithin } from './tab-trap'
import { modalTrapNode, routeEscape, routeKey } from './transitions'
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
 * | ⑧ | 局部键(由深到浅) | viewer / files 各自面域根上的元素监听 |
 * | ⑨ | 全局命令表 | `keymap/dispatch` 的 window 冒泡 |
 *
 * ── 相位为什么是**捕获** ─────────────────────────────────────────────────
 * 相位从前要回答两个问题:「这一下归哪一层浮层」(靠捕获抢在前面)与「局部先接、
 * 没接住放行全局」(靠冒泡排在后面)。第一个问题现在由树答,第二个由树的深度答 ——
 * 相位于是只剩**一件**事要保:**React 元素级的结构键不被抢**。而结构键
 * (方向键 / ↵ / Space / Tab)**一格都不在局部键表里**(§4.3 的封闭裁定),
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
 * 全局命令的落点(`toggleItem` / `switchTo` / `newSessionInCurrentProject` …)
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
 *  ⑧ **局部键**:由深到浅找第一个命中的作用域;命中即 `preventDefault` 并跑
 *     它注入的处理器。
 *  ⑨ 都没命中 → 全局命令表。
 *
 * 「局部先接、没接住放行全局」这条裁定一个字没变,变的是它靠什么成立:
 * 从前靠 DOM 冒泡序(局部监听挂在面域根上,先于 window 收到),现在靠树的深度。
 * 用户报的 ⌘F 死在旧判据上 —— 查看器在活动路径上,但那一下按键没有经过它的根。
 */

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
  const overrides = useKeymapStore((st) => st.overrides)
  const { runCommand } = opts

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

      // ⑧⑨ 局部先接,没接住放行全局。
      const route = routeKey(nodes, path, e, (ev) => lookupCommand({ overrides }, ev))
      if (!route) return
      e.preventDefault()
      if (route.target === 'root') {
        runCommand(route.command as CommandId)
        return
      }
      nodes.get(route.instanceId)?.keyHandlers?.[route.action]?.()
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
  }, [overrides, runCommand])
}
