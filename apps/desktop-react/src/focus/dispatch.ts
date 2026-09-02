import { useEffect } from 'react'
import { hasModifier, lookupCommand } from '../keymap/transitions'
import { useKeymapStore } from '../keymap/store'
import { focusTree } from './registry'
import { tabStopWithin } from './tab-trap'
import { routeEscape, routeKey } from './transitions'
import type { CommandId } from '../keymap/types'

/**
 * **全壳唯一的 window keydown**(设计 §4.3)。
 *
 * 今天壳里有 13 个 keydown 监听,分属八套机制,「这一下输入归谁」这个问题
 * 没有一个人持有答案 —— Esc 那段历史(08-30 microtask 失败 → 08-31 改相位 →
 * 09-01 立浮层栈)就是没有响应链时用 DOM 事件顺序硬凑出来的。这只文件是那 13 个
 * 的终点:一次按键先问树,树答不出才轮到全局命令表。
 *
 * ── R0 的位置:实现 + 单测,**不挂载** ─────────────────────────────────────
 * `AppShell` 现在仍然挂旧的 `useKeymapDispatch`。两个派发器同时上线会让每一下
 * 按键跑两遍(旧的那个开头只认 `defaultPrevented`,拦不住这里),所以换是 R1
 * 那一批的事 —— 那时旧监听删掉、四个 Placement 宿主接树,同一批里进出。
 *
 * ── 为什么 `runCommand` 是注入的 ─────────────────────────────────────────
 * 全局命令的落点(`toggleItem` / `switchTo` / `newSessionInCurrentProject` …)
 * 今天长在 `keymap/dispatch.ts` 那只 hook 的 `run()` 里,它订阅着五个 store。
 * R0 把它抄一份进来的话,那张动作表就有了两个产地,而它们迟早分叉。
 * 所以这里收一个 `runCommand` —— **留账**:R1 换派发器时应当把 `run()` 从
 * `keymap/dispatch.ts` 里提成一只 `useKeymapCommandRunner()`,两边共用一份,
 * 而不是复制。
 *
 * ── 一次按键的顺序(与设计 §4.3 / §4.4 逐条对应)──────────────────────────
 *  ① **独占口**(录制态):它要吃所有键,含全局命令。树一格都不问。
 *  ② `defaultPrevented`:别人真消费掉了就让开(与旧派发器同一句)。
 *  ③ **Esc**:沿活动路径由深到浅问 `onEscape()`,第一个答 true 的消费掉。
 *     没人答 true → **不 preventDefault**(输入法组字等后面的消费者照旧)。
 *  ④ **Tab**:只在 `modal` 作用域被圈禁,别处一律放行(结构键不进表)。
 *  ⑤ 输入面里的**无修饰单键**归输入框(判据与旧派发器逐字相同)。
 *  ⑥ **局部键**:由深到浅找第一个命中的作用域;命中即 `preventDefault` 并跑
 *     它注入的处理器。
 *  ⑦ 都没命中 → 全局命令表。
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
    const onKey = (e: KeyboardEvent) => {
      // ① 独占(录制态)—— §5 里唯一那条例外,它仍然不许自己挂 window。
      const captured = focusTree.capturedHandler()
      if (captured) {
        if (captured(e)) e.preventDefault()
        return
      }
      // ② 别人真消费掉了就让开。
      if (e.defaultPrevented) return

      const nodes = focusTree.nodes()
      const path = focusTree.activePath()

      // ③ Esc:退一层。
      if (e.key === 'Escape') {
        for (const node of routeEscape(nodes, path)) {
          if (node.onEscape?.()) {
            e.preventDefault()
            return
          }
        }
        return
      }

      // ④ Tab:只有 modal 圈禁。
      if (e.key === 'Tab') {
        for (let i = path.length - 1; i >= 0; i -= 1) {
          const node = nodes.get(path[i])
          if (!node || node.kind !== 'modal') continue
          const root = node.root
          if (!root) break
          const stop = tabStopWithin(root, document.activeElement, e.shiftKey)
          if (!stop) break
          e.preventDefault()
          if (focusTree.policy.moveFocus) stop.focus({ preventScroll: true })
          return
        }
        return
      }

      // ⑤ 输入框里的无修饰单键让给输入。
      if (isTypingTarget(e.target) && !hasModifier(e)) return

      // ⑥⑦ 局部先接,没接住放行全局。
      const route = routeKey(nodes, path, e, (ev) => lookupCommand({ overrides }, ev))
      if (!route) return
      e.preventDefault()
      if (route.target === 'root') {
        runCommand(route.command as CommandId)
        return
      }
      nodes.get(route.instanceId)?.keyHandlers?.[route.action]?.()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overrides, runCommand])
}
