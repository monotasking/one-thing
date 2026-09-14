import { nativeViewBridge } from '../../data/browser-port'
import { installWindowFocusSource, reportWindowBlur } from '../../focus/window-focus'

/**
 * **「窗口失焦」在桌面上由主进程说**(2026-09-15;判词整段在 `focus/window-focus.ts`)。
 *
 * 这块壳里住着原生视图(`WebContentsView`),焦点在它们与壳之间换手时壳的 `window`
 * 会 `blur`,而窗口本身没有失焦。主进程盯着 `BrowserWindow` 的 `blur`,经原生视图
 * 通道推 `{ kind: 'window-blur' }` —— 只有那一发才是「用户真的离开了这扇窗」。
 *
 * 没有桥(`--mode web`)= 没有原生视图 = DOM `blur` 就是窗口 blur,这里什么都不装。
 * 与 `keymap-downlink` 同一个体例:壳启动时装一次(`AppShell`),返回拆卸。
 */
export function startWindowFocusDownlink(): () => void {
  const bridge = nativeViewBridge()
  if (!bridge) return () => {}
  const restore = installWindowFocusSource()
  const off = bridge.on((message) => {
    if (message.kind === 'window-blur') reportWindowBlur()
  })
  return () => {
    off()
    restore()
  }
}
