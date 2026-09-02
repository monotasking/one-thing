import { Fragment } from 'react'
import { splitHighlight, splitHighlightRanges } from '../transitions'
import s from './Highlight.module.css'

/**
 * 高亮切片由纯函数算,这里只负责给 hit=true 的片包 <mark>。
 *
 * 两条产地,**一条渲染**(09-02 正文检索):
 *  · 没给 `ranges` → 照当前的词自己切(会话 / 文件那两路是本地滤,词在手上);
 *  · 给了 `ranges` → 用产地判好的那一份(跨会话正文检索,命中是后端判的)。
 * 在场就优先 —— 一个产地已经说了「哪几段是命中」,就不该再拿词算一遍。
 */
export function Highlight({
  text,
  query,
  ranges,
}: {
  text: string
  query: string
  ranges?: readonly { start: number; end: number }[]
}) {
  const parts = ranges ? splitHighlightRanges(text, ranges) : splitHighlight(text, query)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part.hit ? <mark className={s.mark}>{part.text}</mark> : part.text}
        </Fragment>
      ))}
    </>
  )
}
