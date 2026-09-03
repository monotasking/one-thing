/**
 * **宿主能力** —— 不经 core 就能答的那些(C1,`docs/design/client-sdk-2026-09.md` §4.3)。
 *
 * 判据只有一句:**凡是不经 core 就能答的,不进 `@onething/client`**。系统明暗
 * (`matchMedia`)、剪贴板、打开外链、文件对话框都归这里 —— 它们是**这台宿主**
 * 的能力,不是「core 的客户端」的一格。把它们塞进客户端包会立刻把浏览器全局
 * 拖进 Node(CLI 用同一个包),而那正是包边界门禁掉的东西。
 *
 * 今天只有一格:系统明暗。它此前借道 Vue 渲染层那份 platform 的 web 实现
 * (`onSystemThemeChanged` 是一条 `prefers-color-scheme` 的 matchMedia 监听,
 * `settingsApi.getSystemTheme` 在 `environment === 'web'` 那一支同样只读
 * matchMedia,一个字节的网都不碰)。**行为逐字照搬**:同一个媒体查询、同一个
 * 「读不到就当 dark」的兜底、同一个「没有 matchMedia 就交一个 noop 退订」。
 *
 * 剪贴板 / 打开外链 / 文件对话框:新壳今天一条都没用,所以这里一条都不预造。
 */

/**
 * 此刻的系统明暗。
 *
 * 口径与产地(`packages/renderer/platform/web.ts` 的 `getPreferredColorScheme`)
 * 逐字相同:问的是 **light**,问不出来就当 dark —— 「读不到」与「用户选了浅色」
 * 是两件事,兜底只能倒向其中一件,这台壳一直倒向 dark。
 */
export function systemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 订系统明暗的变化。返回退订函数。
 *
 * 监听挂在 `(prefers-color-scheme: dark)` 上而读数走 `systemTheme()`(问 light)——
 * 这不是笔误,是产地原样:两个查询是同一件事的两面,变一次两边都会响,
 * 而读数只认一个产地。没有 `matchMedia`(jsdom 默认、老 WebView)时交一个
 * noop 退订:**订不上就是订不上**,不假装订上了再永远不响。
 */
export function onSystemThemeChanged(
  callback: (theme: 'light' | 'dark') => void,
): () => void {
  const media
    = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!media) return () => {}
  const listener = (): void => callback(systemTheme())
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
