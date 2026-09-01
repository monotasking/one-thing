import { Fragment } from 'react'
import { ButtonBase } from '../ui/ButtonBase'
import { useT } from '../i18n'

import { keysOfChapter } from './transitions'
import type { TocChapter, TocKey } from './types'
import type { MessageKey } from '../i18n'
import s from './PianoKeys.module.css'

/** 段的类型:后端只有这两种(runtime/src/toc:动过文件 = task,否则 question)。 */
const CHAPTER_KIND_KEY: Record<TocChapter['kind'], MessageKey> = {
  task: 'toc.chapterTask',
  question: 'toc.chapterQuestion',
}

interface Props {
  keys: TocKey[]
  chapters: TocChapter[]
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
          <Fragment key={`${chapter.startIndex}:${chapter.title}`}>
            <div className={s.gap}>
              {/* kind 如实呈现:任务与问答是后端分好的两种段,不合并成一种。 */}
              <span className={s.chapterKind}>{t(CHAPTER_KIND_KEY[chapter.kind])}</span>
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
                /* 琴键是裸钮三类判第③类点名的那一形(瓦 / 卡 / 行 / **琴键** / 选项):
                 * 视觉本该定制,所以只接 `ui/ButtonBase` 清 UA。hoverIndex 与
                 * currentIndex 是两个独立状态(见文件头),这次迁移一个字都没动。 */
                <ButtonBase
                  key={key.index}
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
                </ButtonBase>
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
