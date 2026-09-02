import { useEffect } from 'react'
import { hasModifier, lookupCommand } from '../keymap/transitions'
import { useKeymapStore } from '../keymap/store'
import { focusTree } from './registry'
import { tabStopWithin } from './tab-trap'
import { modalTrapNode, routeEscape, routeKey } from './transitions'
import type { CommandId } from '../keymap/types'
import type { ScopeNode } from './types'

/**
 * **全壳唯一的 window keydown 派发器**(设计 §4.3)。
 *
 * 壳里从前有 13 个 keydown 监听,分属八套机制,「这一下输入归谁」这个问题没有
 * 一个人持有答案 —— Esc 那段历史(08-30 microtask 失败 → 08-31 改相位 →
 * 09-01 立浮层栈)就是没有响应链时用 DOM 事件顺序硬凑出来的。这只文件是那 13 个
 * 的终点:一次按键先问树,树答不出才轮到全局命令表。
 *
 * ══ R1 的**过渡形**:一个派发器,两半相位 ════════════════════════════════
 * 这一节是**过渡,不是设计的一部分**;R2 把内容面接进树之后两半合成一个。
 *
 * 今天(R1 之前)一下 Esc 的实际次序是:
 *   浮层 Esc(window 捕获)→ ExposeView(window 捕获)→ composer(window 冒泡)
 *   → 退层链(window 冒泡)→ 全局命令(window 冒泡)
 * 而 ExposeView / composer / viewer / files 四家的监听 **R1 一个都不动**(R2 才迁)。
 * 如果本批把树的路由整个塞进单一相位,这四家与浮层 / 全局的相对次序就会变 ——
 * 而 R1 守的正是「产品语义逐条与 HEAD 相同」。所以派发器分两半,**都在
 * `src/focus/`**、都由这一只 hook 装拆:
 *
 * | 半 | 相位 | 管什么 | 对应今天的谁 |
 * | --- | --- | --- | --- |
 * | 捕获半 | `window` capture | ①录制态独占 ②I1 收回 ③路径上 **float / modal** 的 Esc ④**modal** 的 Tab 圈禁 | `ui/float` 的 Esc 捕获、`a11y/focus-trap` 的 document 捕获、`KeymapSettings` 的录制捕获 |
 * | 冒泡半 | `window` bubble | ①`defaultPrevented` 让位 ②路径上 **root / layer / region** 的 Esc ③输入面单键放行 ④局部键 ⑤全局命令表 | `useEscapeChain`(退层链)、`keymap/dispatch` 的全局派发 |
 *
 * 两半的分界不是随手切的,它就是今天那条相位线:**浮层认捕获、面认冒泡**。
 * 于是 ExposeView 的捕获监听仍然排在浮层之后(它比壳晚挂载 = 晚注册),
 * composer 的冒泡监听仍然排在退层链之前(子组件的 effect 先于 AppShell 的跑)。
 * R2 把那四家迁进树之后,`region` 的 Esc 与局部键就都由树来答,两半合一。
 *
 * 冒泡半开头仍然读 `defaultPrevented`:viewer / files 的元素级局部键还挂在各自
 * 面域根上,它们接住了就是这么让位的(09-01 三层立法的原话)。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ── 为什么 `runCommand` 是注入的 ─────────────────────────────────────────
 * 全局命令的落点(`toggleItem` / `switchTo` / `newSessionInCurrentProject` …)
 * 长在 `keymap/` 那只 `useKeymapCommandRunner()` 里,它订阅着五个 store。
 * 抄一份进来的话那张动作表就有了两个产地,而它们迟早分叉 —— 所以是**共用一份**,
 * 由 `AppShell` 把 runner 递进来(R0 留账 4 的结清)。
 *
 * ── 一次按键的顺序(与设计 §4.3 / §4.4 逐条对应)──────────────────────────
 *  ① **独占口**(录制态):它要吃所有键,含全局命令。树一格都不问。
 *  ② **I1 收回**:焦点掉到 body 了先接回来再路由 —— 被聚焦的元素被静默移除时
 *     `focusout` 都不发,这一处是三处收回里兜底的那一处(§4.1 修正段)。
 *  ③ **瞬态口**:Tooltip 那一族(不占焦点、没有自己的根)。答 true 才认领。
 *  ④ **Esc**:沿活动路径由深到浅问 `onEscape()`,第一个答 true 的消费掉。
 *     没人答 true → **不 preventDefault**(输入法组字等后面的消费者照旧)。
 *  ⑤ **Tab**:只在 `modal` 作用域被圈禁,别处一律放行(结构键不进表)。
 *  ⑥ 输入面里的**无修饰单键**归输入框(判据与旧派发器逐字相同)。
 *  ⑦ **局部键**:由深到浅找第一个命中的作用域;命中即 `preventDefault` 并跑
 *     它注入的处理器。
 *  ⑧ 都没命中 → 全局命令表。
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

/** 捕获半管的那两档:浮层。冒泡半管其余(root / layer / region)。 */
function isFloatKind(node: ScopeNode): boolean {
  return node.kind === 'float' || node.kind === 'modal'
}

export interface FocusDispatchOptions {
  /** 全局命令的落点。见文件头「为什么是注入的」。 */
  runCommand: (id: CommandId) => void
}

export function useFocusDispatch(opts: FocusDispatchOptions): void {
  const overrides = useKeymapStore((st) => st.overrides)
  const { runCommand } = opts

  useEffect(() => {
    /* ── 捕获半:独占 / 收回 / 瞬态 / 浮层 Esc / 模态 Tab ──────────────── */
    const onCapture = (e: KeyboardEvent) => {
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

      if (e.key === 'Escape') {
        // ③ 瞬态口(Tooltip)。它多半**不认领**,所以问完照旧往下走。
        for (const handler of focusTree.transientEscapeHandlers()) {
          if (handler()) {
            e.preventDefault()
            return
          }
        }
        // ④ 浮层那一半的 Esc:由深到浅,第一个答 true 的消费掉。
        for (const node of routeEscape(focusTree.nodes(), focusTree.activePath())) {
          if (!isFloatKind(node)) continue
          if (node.onEscape?.()) {
            e.preventDefault()
            return
          }
        }
        return
      }

      // ⑤ Tab:只有 modal 圈禁。哪一格圈得住由 `modalTrapNode` 判(两步,见那只函数)。
      if (e.key === 'Tab') {
        const trap = modalTrapNode(focusTree.nodes(), focusTree.activePath())
        if (!trap?.root) return
        const stop = tabStopWithin(trap.root, document.activeElement, e.shiftKey)
        if (!stop) return
        e.preventDefault()
        if (focusTree.policy.moveFocus) stop.focus({ preventScroll: true })
      }
    }

    /* ── 冒泡半:让位 / 面的 Esc / 局部键 / 全局命令 ──────────────────── */
    const onBubble = (e: KeyboardEvent) => {
      // 录制态吃掉一切:捕获半已经 stopPropagation,这里其实收不到 —— 留着这一句
      // 是因为「谁在独占」不该依赖另一半的实现细节(测试直接派在 window 上时两半
      // 都会跑到,那正是这一句守着的形)。
      if (focusTree.capturedHandler()) return
      // ② 别人真消费掉了就让开(捕获半认领的、viewer/files 元素级局部键接住的)。
      if (e.defaultPrevented) return

      const nodes = focusTree.nodes()
      const path = focusTree.activePath()

      if (e.key === 'Escape') {
        // 面那一半的 Esc:root 的 `escapeTopmost` 是最后一环(§4.4)。
        // 这里**不判 isTypingTarget** —— 退层链从来不判,输入框里按 Esc 照样退一层。
        for (const node of routeEscape(nodes, path)) {
          if (isFloatKind(node)) continue
          if (node.onEscape?.()) {
            e.preventDefault()
            return
          }
        }
        return
      }

      // Tab 归捕获半(圈禁),这里一个字都不管:结构键不进表。
      if (e.key === 'Tab') return

      // ⑥ 输入框里的无修饰单键让给输入。
      if (isTypingTarget(e.target) && !hasModifier(e)) return

      // ⑦⑧ 局部先接,没接住放行全局。
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
     * ui-consume-allow: float-handwritten —— 这**就是**那个唯一产地。
     * 那条规则按「window 上的捕获相位 keydown」认人,立法时它指的是「别的地方
     * 又抄了一份浮层散场」;而 R1 之后浮层的 Esc 认领**只在这一行**发生
     * (`ui/float` 那一半已经退役,连同它的浮层栈)。让这一行去消费
     * `useFloatDismiss` 是循环:那只 hook 现在只剩点外关。
     * 设计 §8 的原话是「现有 float-handwritten 规则退役(被 I2 覆盖)」——
     * 那一步在 R3(三条棘轮归零那一批)做,这里先按规则自己的口径写豁免。
     */
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onBubble)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onBubble)
    }
  }, [overrides, runCommand])
}
