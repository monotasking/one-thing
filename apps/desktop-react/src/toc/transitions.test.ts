import { describe, expect, it } from 'vitest'
import {
  chapterOfTurn,
  closeToc,
  currentTurnIndex,
  hoverKey,
  initialTocState,
  keysOfChapter,
  openToc,
  toggleToc,
  tocKeys,
} from './transitions'
import { CHAT_CHAPTERS, CHAT_TURNS } from '../data/chat-mock'
import type { ChatChapter } from '../data/chat-mock'
import type { TocState } from './types'

const base: TocState = initialTocState
const opened = openToc(base)

describe('开合与悬停', () => {
  it('open / close / toggle 走同一条梯子', () => {
    expect(opened.open).toBe(true)
    expect(closeToc(opened).open).toBe(false)
    expect(toggleToc(base).open).toBe(true)
    expect(toggleToc(opened).open).toBe(false)
  })

  it('已经开着时 open 是恒等变换,已经关着且没悬停时 close 也是', () => {
    expect(openToc(opened)).toBe(opened)
    expect(closeToc(base)).toBe(base)
  })

  it('收起时一并清掉悬停 —— 否则下次展开会带着上次的明暗斑', () => {
    const hovered = hoverKey(opened, 4)
    expect(hovered.hoverIndex).toBe(4)
    expect(closeToc(hovered)).toEqual({ open: false, hoverIndex: null })
  })

  it('hoverKey 设同一个值是恒等变换(免得每次 mousemove 都触发重渲染)', () => {
    const hovered = hoverKey(opened, 2)
    expect(hoverKey(hovered, 2)).toBe(hovered)
    expect(hoverKey(hovered, null).hoverIndex).toBe(null)
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    openToc(base)
    hoverKey(base, 3)
    toggleToc(base)
    expect(JSON.parse(JSON.stringify(base))).toEqual(before)
  })
})

describe('键列派生', () => {
  const keys = tocKeys()

  it('键数恒等于轮次数 —— 这是几何不变式的第一条', () => {
    expect(keys.length).toBe(CHAT_TURNS.length)
    expect(keys.map((k) => k.index)).toEqual(CHAT_TURNS.map((_, i) => i))
  })

  it('章节起点那一条属于新章(边界归下一章,不归上一章)', () => {
    expect(keys[2].chapterIdx).toBe(0)
    expect(keys[3].chapterIdx).toBe(1)
    expect(keys[5].chapterIdx).toBe(1)
    expect(keys[6].chapterIdx).toBe(2)
  })

  it('keysOfChapter 把三章切开,并起来还是原来那串', () => {
    const groups = CHAT_CHAPTERS.map((_, i) => keysOfChapter(keys, i))
    expect(groups.map((g) => g.length)).toEqual([3, 3, 3])
    expect(groups.flat().map((k) => k.index)).toEqual(keys.map((k) => k.index))
  })

  it('章节表为空时不丢键:全部算第 0 章', () => {
    const none = tocKeys([], 4)
    expect(none.length).toBe(4)
    expect(none.every((k) => k.chapterIdx === 0)).toBe(true)
  })

  it('第一章不从 0 开始时,前面那些键也不丢(算第 0 章)', () => {
    const late: ChatChapter[] = [{ title: 'x', startIndex: 2 }]
    expect(tocKeys(late, 4).map((k) => k.chapterIdx)).toEqual([0, 0, 0, 0])
  })

  it('chapterOfTurn 与 tocKeys 逐条同口径', () => {
    for (const key of keys) {
      expect(chapterOfTurn(key.index)).toBe(key.chapterIdx)
    }
  })
})

describe('当前键(从滚动位置投影)', () => {
  // 一列递增的锚点坐标,视口高 100
  const tops = [0, 200, 400, 600, 800]

  it('顶部时是第一条', () => {
    expect(currentTurnIndex(tops, 0, 100)).toBe(0)
  })

  it('视口里有几条时取最靠上的那条', () => {
    expect(currentTurnIndex(tops, 150, 300)).toBe(1)
  })

  it('一条都没进视口时,取视口上方最后一条(= 正在读的那一段)', () => {
    expect(currentTurnIndex(tops, 450, 100)).toBe(2)
    expect(currentTurnIndex(tops, 799, 1)).toBe(3)
  })

  it('滚到底时是最后一条', () => {
    expect(currentTurnIndex(tops, 800, 100)).toBe(4)
  })

  it('一条锚点都没有时回 -1(没有键可以点亮,而不是假装点亮第 0 条)', () => {
    expect(currentTurnIndex([], 0, 100)).toBe(-1)
  })
})

describe('mock 数据自洽', () => {
  it('9 条用户消息、3 个章节', () => {
    expect(CHAT_TURNS.length).toBe(9)
    expect(CHAT_CHAPTERS.length).toBe(3)
  })

  it('章节起点严格递增且都落在轮次范围内', () => {
    for (let i = 0; i < CHAT_CHAPTERS.length; i += 1) {
      expect(CHAT_CHAPTERS[i].startIndex).toBeGreaterThanOrEqual(0)
      expect(CHAT_CHAPTERS[i].startIndex).toBeLessThan(CHAT_TURNS.length)
      if (i > 0) {
        expect(CHAT_CHAPTERS[i].startIndex).toBeGreaterThan(CHAT_CHAPTERS[i - 1].startIndex)
      }
    }
  })

  it('每一轮都有用户消息和回复正文', () => {
    for (const turn of CHAT_TURNS) {
      expect(turn.user.length).toBeGreaterThan(0)
      expect(turn.body.length).toBeGreaterThan(0)
    }
  })
})
