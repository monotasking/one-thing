import { Fragment } from 'react'
import { splitHighlight } from '../transitions'
import s from './Highlight.module.css'

/** 高亮切片由纯函数算,这里只负责给 hit=true 的片包 <mark>。 */
export function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((part, i) => (
        <Fragment key={i}>
          {part.hit ? <mark className={s.mark}>{part.text}</mark> : part.text}
        </Fragment>
      ))}
    </>
  )
}
