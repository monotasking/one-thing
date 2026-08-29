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
import { tocChapters } from './transitions'
import type { SessionChapter, SessionMarker } from '../expose/types'
import type { TocChapter, TocState } from './types'

/**
 * D1:章与键都是真数据的投影 —— 章来自 `sessions.getSegments`,
 * 键来自 `sessions.getUserMarkers`。这批样本就是那两条线的形状。
 */
const MARKERS: SessionMarker[] = Array.from({ length: 9 }, (_, i) => ({
  id: `m${i}`,
  preview: `第 ${i} 条`,
}))

const SEGMENTS: SessionChapter[] = [
  { id: 's0', title: '摸清三处读取点', detail: '', kind: 'task', startMessageId: 'm0' },
  { id: 's1', title: '抽成一个判定函数', detail: '', kind: 'task', startMessageId: 'm3' },
  { id: 's2', title: '目录缓存跟着目录键走', detail: '', kind: 'question', startMessageId: 'm6' },
]

const CHAPTERS: TocChapter[] = tocChapters(SEGMENTS, MARKERS)

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
  const keys = tocKeys(CHAPTERS, MARKERS.length)

  it('键数恒等于用户消息数 —— 这是几何不变式的第一条', () => {
    expect(keys.length).toBe(MARKERS.length)
    expect(keys.map((k) => k.index)).toEqual(MARKERS.map((_, i) => i))
  })

  it('章节起点那一条属于新章(边界归下一章,不归上一章)', () => {
    expect(keys[2].chapterIdx).toBe(0)
    expect(keys[3].chapterIdx).toBe(1)
    expect(keys[5].chapterIdx).toBe(1)
    expect(keys[6].chapterIdx).toBe(2)
  })

  it('keysOfChapter 把三章切开,并起来还是原来那串', () => {
    const groups = CHAPTERS.map((_, i) => keysOfChapter(keys, i))
    expect(groups.map((g) => g.length)).toEqual([3, 3, 3])
    expect(groups.flat().map((k) => k.index)).toEqual(keys.map((k) => k.index))
  })

  it('章节表为空时不丢键:全部算第 0 章', () => {
    const none = tocKeys([], 4)
    expect(none.length).toBe(4)
    expect(none.every((k) => k.chapterIdx === 0)).toBe(true)
  })

  it('第一章不从 0 开始时,前面那些键也不丢(算第 0 章)', () => {
    const late: TocChapter[] = [{ title: 'x', startIndex: 2, kind: 'task' }]
    expect(tocKeys(late, 4).map((k) => k.chapterIdx)).toEqual([0, 0, 0, 0])
  })

  it('chapterOfTurn 与 tocKeys 逐条同口径', () => {
    for (const key of keys) {
      expect(chapterOfTurn(key.index, CHAPTERS)).toBe(key.chapterIdx)
    }
  })
})

describe('后端章节 → 目录章节(tocChapters)', () => {
  it('落位靠 startMessageId 在用户锚点列里的位置', () => {
    expect(CHAPTERS).toEqual([
      { title: '摸清三处读取点', startIndex: 0, kind: 'task' },
      { title: '抽成一个判定函数', startIndex: 3, kind: 'task' },
      { title: '目录缓存跟着目录键走', startIndex: 6, kind: 'question' },
    ])
  })

  it('kind 如实转述,不合并成一种', () => {
    expect(CHAPTERS.map((c) => c.kind)).toEqual(['task', 'task', 'question'])
  })

  it('落不了位的段整段丢掉 —— 猜一个位置会让点击跳到别处,比少一章更糟', () => {
    const orphan: SessionChapter[] = [
      { id: 'x', title: '没记起点', detail: '', kind: 'task' },
      { id: 'y', title: '起点已被删', detail: '', kind: 'task', startMessageId: 'gone' },
      ...SEGMENTS,
    ]
    expect(tocChapters(orphan, MARKERS).map((c) => c.title)).toEqual(
      SEGMENTS.map((c) => c.title),
    )
  })

  it('按 startIndex 升序出参 —— 章序乱了,章节隙就画在错的地方', () => {
    const shuffled = [SEGMENTS[2], SEGMENTS[0], SEGMENTS[1]]
    expect(tocChapters(shuffled, MARKERS).map((c) => c.startIndex)).toEqual([0, 3, 6])
  })

  it('一条锚点都没有时一章都落不下 —— 那就是空目录(rail 整个不在场)', () => {
    expect(tocChapters(SEGMENTS, [])).toEqual([])
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
