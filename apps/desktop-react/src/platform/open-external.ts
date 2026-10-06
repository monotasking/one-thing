import { openExternalViaHost } from './host'

/**
 * 「点了要出去」的**唯一**帮手(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1)。
 *
 * - **桌面**(有 `window.onethingHost`):经 preload 的 `host:client-action` 交给主进程的
 *   `shell.openExternal`,开的是系统默认浏览器(第④步批 1 起不再绕后端)。**不许退到
 *   `window.open`**:在 Electron 里那一句开出来的是一扇壳自己的窗(没有导航策略、没有会话隔离),
 *   比什么都不做坏。
 * - **网页壳**:`window.open(url, '_blank', 'noopener')`。注意带 `noopener` 时规范要求
 *   它**恒回 `null`**(新页拿不到 opener,调用方也拿不到新页),所以回值不能拿来判成败 ——
 *   从前 `references/kinds/link.ts` 正是拿它判,于是网页壳里点外链永远被读成「没开成」。
 *
 * 失败 = 抛(带宿主那句原话);成功 = resolve。调用方要知道开没开成(登录卡据此选状态句)
 * 就 try/catch。
 */
export async function openExternal(url: string): Promise<void> {
  if (typeof window === 'undefined') throw new Error('no window to open from')
  if (!hasDesktopHost()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const result = await openExternalViaHost(url)
  if (!result) throw new Error('this client cannot open links')
  if (!result.ok) throw new Error(result.error || 'could not open the link')
}

/** 这台壳是不是桌面(有 Electron 宿主)。判据与 `platform/connection` 同源。 */
export function hasDesktopHost(): boolean {
  return typeof window !== 'undefined' && Boolean(window.onethingHost)
}
