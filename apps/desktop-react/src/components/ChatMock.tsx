import type { RefObject } from 'react'
import { CHAT_TURNS } from '../data/chat-mock'
import { resolveIcon } from './icons'
import s from './ChatMock.module.css'

const FileIcon = resolveIcon('FolderTree')

interface Props {
  /** 滚动容器的 ref:TOC 要靠它量坐标、滚过去 */
  scrollRef?: RefObject<HTMLDivElement | null>
  onScroll?: () => void
  /** 正在高亮淡出的那一轮;null = 没有 */
  flashIndex?: number | null
}

/**
 * 内容全部来自 data/chat-mock.ts:这里是「怎么摆」,不是「摆什么」。
 *
 * 每一轮外框上挂 data-turn-index —— 这是 TOC 与聊天区之间**唯一**的约定:
 * 键的 index 就是这个值,两边共用 CHAT_TURNS 的下标,不存第二份映射表。
 */
export function ChatMock({ scrollRef, onScroll, flashIndex }: Props) {
  return (
    <div ref={scrollRef} className={s.scroll} onScroll={onScroll}>
      <div className={s.column}>
        {CHAT_TURNS.map((turn, i) => (
          <section
            key={i}
            data-turn-index={i}
            className={i === flashIndex ? `${s.turn} ${s.flash}` : s.turn}
          >
            <div className={s.user}>{turn.user}</div>

            <p className={s.body}>{turn.body}</p>

            {turn.tool && (
              <div className={s.toolCard}>
                <span className={s.seq}>{turn.tool.seq}</span>
                <FileIcon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
                <span className={s.file}>{turn.tool.file}</span>
                <span className={s.done}>{turn.tool.status}</span>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
