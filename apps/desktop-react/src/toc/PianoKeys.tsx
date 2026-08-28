import { Fragment } from 'react'
import { useT } from '../i18n'
import type { ChatChapter } from '../data/chat-mock'
import { keysOfChapter } from './transitions'
import type { TocKey } from './types'
import s from './PianoKeys.module.css'

interface Props {
  keys: TocKey[]
  chapters: ChatChapter[]
  /** 每一轮的用户消息文本,下标与 TocKey.index 对齐 */
  labels: string[]
  open: boolean
  currentIndex: number
  hoverIndex: number | null
  onHover: (index: number | null) => void
  onPick: (index: number) => void
}

/**
 * 键列 —— 常态与展开态**唯一**的那份行结构(几何不变式写在 PianoKeys.module.css 顶部)。
 *
 * 这里只做一件事:把 tocKeys 推出来的行画出来。它不知道自己为什么会展开、
 * 也不管展开是谁触发的(那是 TocPanel 的事),更不碰滚动 ——
 * onPick 抛出去,由渲染层的 useChatToc 决定「跳」这个动作怎么做。
 *
 * 每章前面都摆一个章节隙(**含第一章**):这样每一章都有地方放小标签,
 * 而常态下那是一格 16px 的空白,看不见也不影响键的坐标。
 * 代价是键列整体比「只在章节之间留隙」高 16px —— 换来的是行结构不分叉。
 */
export function PianoKeys({
  keys,
  chapters,
  labels,
  open,
  currentIndex,
  hoverIndex,
  onHover,
  onPick,
}: Props) {
  const t = useT()

  return (
    <div className={open ? `${s.keys} ${s.open}` : s.keys}>
      {/* 白面是绝对定位的兄弟节点,永不参与行栈布局 —— 不变式 4 */}
      <div className={s.backdrop} aria-hidden="true" />

      <div className={s.rows}>
        {chapters.map((chapter, chapterIdx) => (
          <Fragment key={chapter.startIndex}>
            <div className={s.gap}>
              <span className={s.chapter}>{chapter.title}</span>
            </div>
            {keysOfChapter(keys, chapterIdx).map((key) => {
              const cls = [
                s.row,
                key.index === currentIndex ? s.current : '',
                key.index === hoverIndex ? s.rowHover : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <button
                  key={key.index}
                  type="button"
                  className={cls}
                  data-testid={`toc-key-${key.index}`}
                  data-current={key.index === currentIndex ? 'true' : undefined}
                  aria-label={t('toc.jumpTo', { index: key.index + 1 })}
                  onMouseEnter={() => onHover(key.index)}
                  onFocus={() => onHover(key.index)}
                  onClick={() => onPick(key.index)}
                >
                  <span className={s.label}>{labels[key.index]}</span>
                  <span className={s.key} aria-hidden="true" />
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
