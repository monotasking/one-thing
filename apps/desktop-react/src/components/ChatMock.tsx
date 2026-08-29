import type { RefObject } from 'react'
import { CHAT_TURNS } from '../data/chat-mock'
import { useComposerStore } from '../composer/store'
import { useT } from '../i18n'
import { resolveIcon } from './icons'
import s from './ChatMock.module.css'

const FileIcon = resolveIcon('FolderTree')
const ClipIcon = resolveIcon('Paperclip')

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
 *
 * 末尾还接一段 **composer 的出站消息**(composer/store 的 outbox):
 * Composer 只负责「交出去」,谁来画由这里决定 —— 所以 store 里存的是结构
 * (发了什么、带了几个附件、拒绝了哪组问题),文案在这一层走 i18n。
 * 接真引擎时,这一段换成真的会话消息流,Composer 一行不动。
 */
export function ChatMock({ scrollRef, onScroll, flashIndex }: Props) {
  const t = useT()
  const outbox = useComposerStore((st) => st.outbox)

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

        {outbox.map((entry) => {
          if (entry.kind === 'text') {
            return (
              <div key={entry.id} className={s.user}>
                {entry.text}
                {entry.attachments > 0 && (
                  <span className={s.sentAtt}>
                    <ClipIcon className={s.sentAttIcon} strokeWidth={1.8} aria-hidden="true" />
                    {entry.attachments}
                  </span>
                )}
              </div>
            )
          }
          if (entry.kind === 'ask') {
            return (
              <div key={entry.id} className={s.user}>
                {entry.lines.map((line) => (
                  <div key={line.tag}>
                    <b>{line.tag}</b> {line.answer}
                  </div>
                ))}
              </div>
            )
          }
          // 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失,只是说得轻一点。
          return (
            <div key={entry.id} className={`${s.user} ${s.declined}`}>
              {t('ask.rejected')}
            </div>
          )
        })}
      </div>
    </div>
  )
}
