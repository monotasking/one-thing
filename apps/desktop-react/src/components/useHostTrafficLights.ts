/**
 * 「这扇窗上有没有那三颗红绿灯」—— 唯一产地(W1-b,设计 §2.2 最后一节:
 * 「Windows / Linux / 浏览器壳没有红绿灯:让位为 0,标签从最左开始」)。
 *
 * ── 为什么不能拿 `useHostFullScreen` 顶替 ────────────────────────────────
 * 那只 hook 在**没有宿主**时答 `false`,而 `false` 的意思是「没有进原生全屏」——
 * 也就是「有灯,而且灯正露着」。浏览器壳恰恰落在这一格上:它没有宿主,于是被判成
 * 「有灯」,顶栏白让 80px 而那儿一颗灯都没有。两件事必须分开问。
 *
 * ── 判据是**宿主报的平台**,不是 UA ──────────────────────────────────────
 * 灯是不是存在,取决于两件事,而两件都只有宿主知道:
 *  · 这个渲染层是不是跑在 Electron 壳里(浏览器里那条带是我们自绘的普通 header,
 *    窗控件归浏览器,壳里画不出也让不出);
 *  · 主进程有没有摘掉系统标题栏 —— `electron/main.ts` 的 `FRAMELESS_ON_MAC` 只在
 *    `process.platform === 'darwin'` 时给 `titleBarStyle: 'hiddenInset'`,
 *    Windows / Linux 照旧用系统边框,壳里那条顶带上一颗灯都没有。
 * 所以 preload 把 `process.platform` 原样交出来(**事实**,不是结论),
 * 这里做那一句判断。`navigator.platform` 那条路刻意不走:它是 UA 的一部分,
 * 会被伪装、被弃用,而且它答的是「用户的操作系统」,不是「这扇窗有没有灯」——
 * 在 macOS 上开着的浏览器壳会被它判成有灯,正好判反。
 *
 * 它是一格**启动就定死**的事实(平台不会中途变),所以不订阅、不进 state:
 * 一次读取,渲染期间直接用。
 */
type HostPlatformBridge = { platform?: string }

export function useHostTrafficLights(): boolean {
  if (typeof window === 'undefined') return false
  const host = (window as unknown as { onethingHost?: HostPlatformBridge }).onethingHost
  // 没有宿主 = 浏览器壳:没有灯。有宿主但不是 macOS:系统边框,壳里也没有灯。
  return host?.platform === 'darwin'
}
