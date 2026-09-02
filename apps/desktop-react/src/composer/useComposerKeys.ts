import { useEffect } from 'react'
import { useComposerStore } from './store'
import { isTypingTarget } from './transitions'
import type { ComposerMode } from './types'

/**
 * ── 切线 B:这块面的全局键 ──────────────────────────────────────────────────
 *
 * **Esc 分三层,次序即「退掉最近打开的那一层」**:
 *   ① ask 形态在场 → 整单拒绝;
 *   ② 抽屉开着     → 收抽屉;
 *   ③ 焦点在这块面板里且引擎在跑 → **停止**(两段式,整只在 `useEscStop` 里,
 *      这里只按次序叫最后那一口)。
 * 三种都 preventDefault —— 外层(舞台 / 浮窗)按既有约定只在 `!defaultPrevented`
 * 时才轮到它,所以「Esc 逐层退出」那条全局承诺没有被抢。
 *
 * ③ 排在最后而不是最前:ask 与抽屉是**看得见的一层**,先退看得见的那层是 Esc
 * 在这套壳里一以贯之的语义;没有任何一层浮着时,Esc 才落到「停下这一轮」。
 *
 * **← → 只在焦点不在任何输入面里时才翻题**:写字的人按方向键是在移动光标。
 * 判据本身是纯的,住在 `transitions.isTypingTarget`(配单测);这里只负责把
 * 宿主的事实(`document.activeElement`)量给它。
 *
 * ## 三张表
 *
 * **生命周期**:挂载即装一个 window keydown 监听,卸载摘掉。监听在
 * `mode` / 四个动作任一换身份时**重装** —— 重装会把它移到 window 监听队列的
 * 末尾,而全局快捷键派发器(`keymap/dispatch.ts`)也在 window 上,所以队列次序
 * 是有意义的。`drawerKind` 因此**不进依赖**:它每敲一个字都在变,进了依赖就是
 * 每敲一个字重排一次队列。它改用 `getState()` 当场现读 —— 事件发生那一刻读到的
 * 永远是最新值,与订阅它等价,却不动队列(这一条是从拆分前逐字搬来的写法,
 * 不是这次新加的口径)。
 *
 * **UI 生命状态**:这只 hook 不画东西,没有 empty / loading / error。
 *
 * **UI 交互状态**:同上 —— 它的全部输出是「谁吃掉了这一下按键」。
 */
interface ComposerKeysDeps {
  /** write ⇄ ask。ask 在场时 Esc 是整单拒绝,且 ← → 才翻题。 */
  mode: ComposerMode
  closeDrawer: () => void
  rejectAsk: () => void
  moveAsk: (delta: number) => void
  /** Esc 第③层。返回 true = 已被两段式停止消费掉(见 `useEscStop`)。 */
  tryStop: () => boolean
}

export function useComposerKeys({
  mode,
  closeDrawer,
  rejectAsk,
  moveAsk,
  tryStop,
}: ComposerKeysDeps): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'ask') {
          e.preventDefault()
          rejectAsk()
          return
        }
        if (useComposerStore.getState().drawerKind) {
          e.preventDefault()
          closeDrawer()
          return
        }
        // 没有任何一层浮着:焦点在这块面板里、且引擎在跑 → 两段式停止。
        if (tryStop()) e.preventDefault()
        return
      }
      if (mode !== 'ask' || isTypingTarget(document.activeElement)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        moveAsk(-1)
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        moveAsk(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, closeDrawer, rejectAsk, moveAsk, tryStop])
}
