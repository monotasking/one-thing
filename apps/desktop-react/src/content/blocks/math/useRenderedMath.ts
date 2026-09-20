import { useEffect, useState } from 'react'
import { isKatexReady, loadKatex, renderTex, type MathRendered } from './katex'

/**
 * 一条公式此刻的样子 —— 行内与块**共用这一口**。
 *
 * 三态,三条判词:
 *  · `pending` = 库还没到。屏幕上画那段 TeX 源码 —— 公式在排版之前有一个完全正确的
 *    样子,就是它自己(同 shiki 未到时的素文本、mermaid 未到时的图源码,三处同判)。
 *  · `done`    = 排好了,`html` 是 KaTeX 的产物。
 *  · `error`   = 这段 TeX 排不出来,`message` 是 KaTeX 的原话。
 *
 * ── 库到了就**首帧同步命中**,不许先闪一帧源码 ────────────────────────────
 * 消息行挂着 `content-visibility`、会话有停靠池,同一条公式的组件会被反复挂载。
 * 如果每次挂载都先返回 pending、再在 effect 里换成 done,滚动时满屏公式就会一起抖
 * 一下 —— 那是布局位移,不是加载态。所以库到了之后在 **render 里**当场问缓存要结果
 * (`renderTex` 此时是同步的,且同源不二渲,重复调用是一次 Map 命中)。
 *
 * ── 这只 effect 的依赖表是空的,而且是**有意**的 ──────────────────────────
 * 它做的事与这一条公式无关:拉库是全台一次的事。依赖表里写 `tex` 只会让同一台上
 * 几十条公式各排一次队去问同一个 promise。卸载之后不 setState(`alive` 闩)。
 * 拉失败同样 bump 一次:那一帧之后 `isKatexReady()` 仍是假,于是它停在 pending ——
 * 屏幕上是源码,而不是一个空洞。
 */
/**
 * @param enabled 这段 TeX 此刻**值不值得排**。流式期间未闭合的块公式每一帧都是一段
 *   半截源码:排它只会得到一次失败,而失败也进缓存 —— 几十帧下来缓存被半截货塞满,
 *   到上限一清,连带把排好的也冲掉。所以没闭合就不排,停在 pending(屏幕上是源码,
 *   与库没到时同一个样子)。拉库不受它管:库早一点到,闭合那一刻才能同步换装。
 */
export function useRenderedMath(
  tex: string,
  display: boolean,
  enabled = true,
): MathRendered | { status: 'pending' } {
  const [, bump] = useState(0)

  useEffect(() => {
    if (isKatexReady()) return
    let alive = true
    const settle = () => {
      if (alive) bump((n) => n + 1)
    }
    void loadKatex().then(settle, settle)
    return () => {
      alive = false
    }
  }, [])

  if (!enabled || !isKatexReady()) return { status: 'pending' }
  return renderTex(tex, display)
}
