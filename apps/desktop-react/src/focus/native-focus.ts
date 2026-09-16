import { nativeViewBridge } from '../data/browser-port'
import { registerFocusHost } from './target'

let revision = 0
let observing = 0
let users = 0
let uninstall: (() => void) | undefined

// Wall time keeps new renderer modules ahead of an older HMR instance's intents.
function nextRevision(): number {
  revision = Math.max(revision + 1, Date.now())
  return revision
}

export function requestNativeFocus(element: HTMLElement, viewId: string): void {
  if (!element.isConnected) return
  observing += 1
  try { element.focus({ preventScroll: true }) } finally { observing -= 1 }
  if (!observing) nativeViewBridge()?.send({ verb: 'focus', viewId, revision: nextRevision() })
}

/** Native notifications report ownership; they must not issue another focus command. */
export function observeNativeFocus(element: HTMLElement, reportedRevision: number | undefined, adopt: () => void): void {
  if (reportedRevision !== undefined && reportedRevision < revision) return
  if (document.hasFocus() && document.activeElement !== element) return
  observing += 1
  try { adopt() } finally { observing -= 1 }
}

/** One listener for all slots. Restoring the window to a native placeholder does
 * nothing; a real shell interaction explicitly supersedes older native requests. */
export function installNativeFocusSync(): () => void {
  users += 1
  if (users === 1) {
    const requestShell = (): void => {
      if (!observing) nativeViewBridge()?.send({ verb: 'focus-shell', revision: nextRevision() })
    }
    const unregisterHost = registerFocusHost(document, requestShell)
    const onShellIntent = (event: Event): void => {
      if (observing || !document.hasFocus()) return
      const target = event.target
      if (!(target instanceof Element) || target.closest('[data-native-view]')) return
      requestShell()
    }
    document.addEventListener('focusin', onShellIntent, true)
    document.addEventListener('pointerdown', onShellIntent, true)
    uninstall = () => {
      unregisterHost()
      document.removeEventListener('focusin', onShellIntent, true)
      document.removeEventListener('pointerdown', onShellIntent, true)
    }
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    users -= 1
    if (!users) { uninstall?.(); uninstall = undefined }
  }
}
