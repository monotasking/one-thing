import { describe, expect, it } from 'vitest'
import {
  BUBBLE_GAP_PX,
  BUBBLE_INSET_PX,
  MUTTER_HOLD_MAX_MS,
  MUTTER_HOLD_MIN_MS,
  mutterHoldMs,
  placeBubble,
  splitGlyphs,
  TYPE_CHAR_MS,
  TYPE_PUNCT_MS,
  typeDelayAfter,
} from '../bubble'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('气泡节拍(§7.4)', () => {
  it('中文标点后停 260ms,其余 95ms', () => {
    expect(TYPE_CHAR_MS).toBe(95)
    expect(TYPE_PUNCT_MS).toBe(260)
    for (const p of ['，', '。', '？', '！', '、']) expect(typeDelayAfter(p)).toBe(260)
    expect(typeDelayAfter('雨')).toBe(95)
    expect(typeDelayAfter(undefined)).toBe(95)
  })

  it('嘀咕停留:台词表指定就用它,否则落在 1.4–1.8s', () => {
    expect(mutterHoldMs(900)).toBe(900)
    expect(mutterHoldMs(undefined, () => 0)).toBe(MUTTER_HOLD_MIN_MS)
    expect(mutterHoldMs(undefined, () => 1)).toBe(MUTTER_HOLD_MAX_MS)
  })

  it('按字切,不劈 emoji', () => {
    expect(splitGlyphs('喵🐾')).toEqual(['喵', '🐾'])
  })
})

describe('气泡定位(§7.4 定位列)', () => {
  it('居中在头顶上方,尾巴指着头', () => {
    const g = placeBubble({ perchW: 400, anchorX: 200, anchorY: 150, bubbleW: 100, bubbleH: 40 })
    expect(g).toEqual({ left: 150, top: 150 - 40 - BUBBLE_GAP_PX, tailX: 50 })
  })

  it('左右夹在栖位内侧 12px,尾巴跟着头走但不进圆角', () => {
    const right = placeBubble({ perchW: 240, anchorX: 230, anchorY: 150, bubbleW: 200, bubbleH: 40 })
    expect(right.left).toBe(240 - 200 - BUBBLE_INSET_PX)
    expect(right.tailX).toBe(200 - 18)
    const left = placeBubble({ perchW: 240, anchorX: 5, anchorY: 150, bubbleW: 200, bubbleH: 40 })
    expect(left.left).toBe(BUBBLE_INSET_PX)
    expect(left.tailX).toBe(18)
  })

  it('上边放不下时贴栖位顶', () => {
    expect(placeBubble({ perchW: 400, anchorX: 200, anchorY: 20, bubbleW: 100, bubbleH: 80 }).top).toBe(0)
  })

  it('JS 镜像与 tokens.css 同一个数', () => {
    const css = readFileSync(path.resolve(__dirname, '../../styles/tokens.css'), 'utf-8')
    expect(css).toContain(`--pet-bubble-inset: ${BUBBLE_INSET_PX}px;`)
    expect(css).toContain(`--pet-bubble-gap: ${BUBBLE_GAP_PX}px;`)
  })
})
