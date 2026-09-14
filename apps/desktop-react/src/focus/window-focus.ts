/**
 * **「这扇窗失焦了」的唯一产地**(2026-09-14/15)。
 *
 * ── 病历:浏览器 tab 拖不出来 ────────────────────────────────────────────────
 * 用户三轮真手势(记录器逐毫秒记下):按下浏览器 tab → 这扇窗刚被这一下点成 key
 * 窗 → macOS 在 40ms 后把第一响应者还给上次拿着它的那块 NSView(WebContentsView)
 * → 壳的 `window` 收到一次 DOM `blur`。拖拽会话(`ui/drag/DragSession`)与浮窗拖动
 * (`ui/drag/pointer-track`)都把「窗口 blur」当「用户切走了应用」,起手前就把这一场
 * 拆掉;鼠标事件一发没丢,壳里却没有拖拽了。目录 / 文件 tab 没这个病:它们的内容
 * 焦点留在 DOM 里,窗口不 blur。
 *
 * 先试过两版判据都在真机上被证伪:①「第一响应者是不是原生面」—— 那一瞬第一响应者
 * 是叶(tab 自己拿着 DOM 焦点);②「占位格自报拿着键盘」—— 自报刚被 tab 的 focusin
 * 清掉,1ms 后窗口就 blur。渲染进程手上**没有一格同步事实**能区分「焦点换到了同一扇
 * 窗里的另一块 NSView」与「用户 Cmd-Tab 走了」:DOM `blur` 说的是 webContents 失焦,
 * 不是窗口失焦。
 *
 * ── 治法:问知道真相的那一头 ────────────────────────────────────────────────
 * 主进程知道 `BrowserWindow` 有没有真的失去 key 状态(焦点在它的子视图之间换手时
 * 窗口**不** blur)。所以桌面上「窗口失焦」由主进程经原生视图通道推下来
 * (`{ kind: 'window-blur' }`,`content/native-view/window-focus-downlink.ts` 接),
 * 这只模块把 DOM 那条源让开;web 壳没有主进程,DOM `blur` 就是窗口 blur,照旧。
 * 消费方(两处拖拽)只认这只模块的 `subscribeWindowBlur`,不再各自挂 `window` 的
 * `blur` 监听 —— 一个事实一个产地。
 *
 * 模块级状态 = 这个模块实例的寿命,文件末尾配 HMR 退役(CLAUDE.md 那条法)。
 */

type Listener = () => void

const listeners = new Set<Listener>()
/** `'dom'` = 没有宿主源,DOM `blur` 就是窗口 blur;`'host'` = 宿主(主进程)说了算。 */
let source: 'dom' | 'host' = 'dom'
let domAttached = false

function fire(): void {
  for (const listener of [...listeners]) listener()
}

const onDomBlur = (): void => {
  if (source === 'dom') fire()
}

function ensureDom(): void {
  if (domAttached || typeof window === 'undefined') return
  window.addEventListener('blur', onDomBlur)
  domAttached = true
}

/** 订阅「这扇窗失焦了」。返回退订。 */
export function subscribeWindowBlur(listener: Listener): () => void {
  ensureDom()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 宿主接管这格事实:从此 DOM `blur` 不算,只有 `reportWindowBlur()` 算。
 * 返回归还(卸载宿主源时调;幂等)。
 */
export function installWindowFocusSource(): () => void {
  source = 'host'
  let released = false
  return () => {
    if (released) return
    released = true
    source = 'dom'
  }
}

/** 宿主报「窗口真的失焦了」。 */
export function reportWindowBlur(): void {
  fire()
}

/** 此刻是谁在说这格事实(给用例与排障读)。 */
export function windowFocusSource(): 'dom' | 'host' {
  return source
}

/** 唯一那口拆卸(用例 `afterEach` 与 HMR 退役共用)。幂等。 */
export function resetWindowFocus(): void {
  listeners.clear()
  source = 'dom'
  if (domAttached && typeof window !== 'undefined') {
    window.removeEventListener('blur', onDomBlur)
    domAttached = false
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetWindowFocus()
  })
}
