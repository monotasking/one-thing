import { useEffect, useState } from 'react'
import type { BlockModel } from '../../../model/blocks'
import { highlight, loadHighlighter, type HighlightedLines } from './highlight'
import s from './Code.module.css'

type CodeModel = Extract<BlockModel, { kind: 'code' }>

/**
 * 代码块的本体 —— **檐卡**的 body(檐由壳画,见 index.ts 的 chrome 声明)。
 *
 * 块内横滚、限高渐隐折叠、复制源码,三件都归壳(铁律 3),所以这里只有一件事:
 * 把源码画成字,有颜色就上色。
 *
 * ── 素文本先行 ────────────────────────────────────────────────────────
 * 第一帧一定是素文本(高亮器还没拉到)。拉到之后 `ready` 翻真,同一个块原位重画 ——
 * 块 key 由源偏移派生,不重挂,滚动位置和展开态都留着。拉不到就一直是素文本:
 * 「加载失败」和「还没加载完」在屏幕上是同一件事,这不是巧合,是同一条降级路径。
 */
export function Code({ model }: { model: CodeModel }) {
  const lines = useHighlight(model.source, model.lang)

  return (
    <pre className={s.pre}>
      <code className={s.code}>{lines ? renderLines(lines) : model.source}</code>
    </pre>
  )
}

/**
 * 高亮的懒加载闸。
 *
 * `ready` 只是一个「重画一次」的信号 —— 真正的结果每次渲染现算(有缓存)。把 token
 * 树塞进 state 会让它跟着组件走一份副本,而流式期间源码每帧都换,那份副本每帧都作废。
 */
function useHighlight(source: string, lang: string | null): HighlightedLines | undefined {
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

/**
 * token 树 → React。
 *
 * 用元素 + `style.color`,不用 `dangerouslySetInnerHTML`:代码块里装的是模型吐出来的
 * 任意文本,把它交给 innerHTML 就是把一条注入路径接到聊天正文上。颜色是 shiki 给的
 * **数据**,与「样式表里不许写字面色」是两件事。
 */
function renderLines(lines: HighlightedLines) {
  return lines.map((tokens, row) => (
    <span key={row} className={s.line}>
      {tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
      {'\n'}
    </span>
  ))
}
