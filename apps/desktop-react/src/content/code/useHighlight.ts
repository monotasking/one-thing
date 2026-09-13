import { useEffect, useState } from 'react'
import { highlight, loadHighlighter, type HighlightedLines } from './highlight'

/**
 * **高亮的懒加载闸**(2026-09-13 批 ② 收成一处;此前代码块、查看器、diff 各抄一份
 * 逐字相同的 12 行)。
 *
 * `ready` 只是一个「重画一次」的信号 —— 真正的结果**每次渲染现算**(`highlight`
 * 自带缓存)。把 token 树塞进 state 会让它跟着组件走一份副本,而流式期间源码每帧
 * 都换,那份副本每帧都作废。
 *
 * ── 素文本先行,而且失败与未完成是同一条路 ────────────────────────────────
 * 第一帧一定是素文本(高亮器还没拉到);拉到之后原位重画。拉不到就一直是素文本 ——
 * 「加载失败」和「还没加载完」在屏幕上是同一件事,这不是巧合,是同一条降级路径。
 * 所以调用方永远只有一种兜底:`undefined` = 照原样画字。
 *
 * `lang` 为 null(认不出的语言 / 没有语言)时连高亮器都不拉:那趟往返白跑。
 */
export function useHighlight(source: string, lang: string | null): HighlightedLines | undefined {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!lang) return
    let alive = true
    void loadHighlighter().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [lang])

  return ready ? highlight(source, lang) : undefined
}
