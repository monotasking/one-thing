/**
 * 钢琴键会话目录的形状。和 stage/ expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * TocState 只有两个字段,是刻意的:**「当前键」不在状态里**。
 * 它是「视口里最近一条用户消息」,是滚动位置的**投影**,由纯函数
 * currentTurnIndex(量出来的坐标, scrollTop, 视口高) 现算 —— 存一份就会和滚动条对不上。
 * 同理「键在哪一行」也不存:行结构由 tocKeys(chapters, turnCount) 现推。
 */
export interface TocState {
  /** panel 是否展开(悬停 150ms 或 ⌘⇧O)。 */
  open: boolean
  /** 鼠标悬停在哪一键上;null = 没停在任何一行。 */
  hoverIndex: number | null
}

/**
 * 一枚键 = 一条用户消息。index 是它在这条会话的**用户消息锚点**列里的下标
 * (`sessions.getUserMarkers` 的次序,也是 data-turn-index 的值),
 * chapterIdx 是它属于第几章 —— 键列的「章节隙」就是靠相邻两键的 chapterIdx 不同推出来的。
 */
export interface TocKey {
  index: number
  chapterIdx: number
}

/**
 * 一章 = 目录上的一段。**只存起点,不存范围** —— 范围由下一章的起点推导
 * (tocKeys),免得起点和范围两份事实互相漂移。
 *
 * 产地是 `sessions.getSegments`:title / kind 逐字来自后端那条 SessionSegment,
 * startIndex 是它的 startMessageId 在用户锚点列里的位置(见 tocChapters)。
 */
export interface TocChapter {
  title: string
  startIndex: number
  /** 后端的 'task' | 'question',如实呈现,不合并成一种。 */
  kind: 'task' | 'question'
}
