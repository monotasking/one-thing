import { describe, expect, it } from 'vitest'
import {
  BUBBLE_SIZE,
  PAD_MIN_HEIGHT,
  PAD_MIN_WIDTH,
  clampBubble,
  clampRect,
  defaultBubble,
  defaultRect,
  parsePadState,
  resizeRect,
} from '../floating-pad-state'

const VIEWPORT = { width: 1280, height: 800 }

describe('悬浮草稿垫 · 几何', () => {
  it('首次落在右下角,并让开输入框那一截', () => {
    const rect = defaultRect(VIEWPORT)

    expect(rect.width).toBe(380)
    expect(rect.height).toBe(480)
    // 右沿离视口右边 24px;下沿在输入框上方(离底 > 100px)。
    expect(VIEWPORT.width - (rect.x + rect.width)).toBe(24)
    expect(VIEWPORT.height - (rect.y + rect.height)).toBeGreaterThan(100)
  })

  it('窄窗口下缺省尺寸自己收，而不是撑出屏幕', () => {
    const rect = defaultRect({ width: 320, height: 400 })

    expect(rect.width).toBeLessThanOrEqual(320)
    expect(rect.height).toBeGreaterThanOrEqual(PAD_MIN_HEIGHT)
  })

  it('clamp 允许探出左右边,但永远留得下能抓的一条', () => {
    const far = clampRect({ x: -5000, y: -5000, width: 380, height: 480 }, VIEWPORT)

    // 上边不许越过 0(标题栏被顶出去就再也抓不回来了)。
    expect(far.y).toBe(0)
    // 左边可以为负,但右沿至少还留 48px 在视口里。
    expect(far.x + far.width).toBeGreaterThanOrEqual(48)

    const past = clampRect({ x: 99999, y: 99999, width: 380, height: 480 }, VIEWPORT)
    expect(past.x).toBeLessThanOrEqual(VIEWPORT.width - 48)
    expect(past.y).toBeLessThanOrEqual(VIEWPORT.height - 48)
  })

  it('clamp 把尺寸夹进 [最小, 视口] 区间', () => {
    const tiny = clampRect({ x: 10, y: 10, width: 10, height: 10 }, VIEWPORT)
    expect(tiny.width).toBe(PAD_MIN_WIDTH)
    expect(tiny.height).toBe(PAD_MIN_HEIGHT)

    const huge = clampRect({ x: 0, y: 0, width: 99999, height: 99999 }, VIEWPORT)
    expect(huge.width).toBe(VIEWPORT.width)
    expect(huge.height).toBe(VIEWPORT.height)
  })

  it('小圆钮整枚都得在视口里', () => {
    const bubble = clampBubble({ x: 99999, y: -50 }, VIEWPORT)
    expect(bubble.x).toBe(VIEWPORT.width - BUBBLE_SIZE)
    expect(bubble.y).toBe(0)
    expect(defaultBubble(VIEWPORT).x).toBe(VIEWPORT.width - BUBBLE_SIZE - 24)
  })
})

describe('悬浮草稿垫 · 八向拉伸', () => {
  const start = { x: 400, y: 200, width: 380, height: 480 }

  it('抓东/南边:对边不动,尺寸跟着走', () => {
    const east = resizeRect(start, 'e', 60, 0, VIEWPORT)
    expect(east.x).toBe(start.x)
    expect(east.width).toBe(440)

    const south = resizeRect(start, 's', 0, 40, VIEWPORT)
    expect(south.y).toBe(start.y)
    expect(south.height).toBe(520)
  })

  it('抓西/北边:被抓的那条边跟着指针,对边钉死', () => {
    const west = resizeRect(start, 'w', -60, 0, VIEWPORT)
    expect(west.x).toBe(340)
    expect(west.width).toBe(440)
    // 右沿原地不动 —— 这是"在缩放"而不是"在平移"的判据。
    expect(west.x + west.width).toBe(start.x + start.width)

    const north = resizeRect(start, 'n', 0, -40, VIEWPORT)
    expect(north.y + north.height).toBe(start.y + start.height)
  })

  it('从左边拖过头时右沿仍然钉住,而不是整块跟着跑', () => {
    const over = resizeRect(start, 'w', 9999, 0, VIEWPORT)
    expect(over.width).toBe(PAD_MIN_WIDTH)
    expect(over.x + over.width).toBe(start.x + start.width)
  })

  it('角把手同时动两轴', () => {
    const corner = resizeRect(start, 'se', 50, 30, VIEWPORT)
    expect(corner.width).toBe(430)
    expect(corner.height).toBe(510)
    expect(corner.x).toBe(start.x)
    expect(corner.y).toBe(start.y)
  })
})

describe('悬浮草稿垫 · 账本读写', () => {
  it('读不到 / 读到坏数据都退回缺省,不抛', () => {
    expect(parsePadState(null, VIEWPORT).rect.width).toBe(380)
    expect(parsePadState('not json', VIEWPORT).rect.width).toBe(380)
    expect(parsePadState('[1,2,3]', VIEWPORT).collapsed).toBe(false)
  })

  it('逐字段回退:一个坏字段不带走整份账', () => {
    const state = parsePadState(JSON.stringify({
      rect: { x: 120, y: 60, width: 'wide', height: 500 },
      collapsed: true,
    }), VIEWPORT)

    expect(state.collapsed).toBe(true)
    expect(state.rect.x).toBe(120)
    expect(state.rect.height).toBe(500)
    // 坏掉的 width 退回缺省,而不是变成 NaN。
    expect(state.rect.width).toBe(380)
  })

  it('存进去的坐标在读出来时按当前视口重新夹一遍', () => {
    const state = parsePadState(JSON.stringify({
      rect: { x: 5000, y: 5000, width: 380, height: 480 },
    }), VIEWPORT)

    expect(state.rect.x).toBeLessThanOrEqual(VIEWPORT.width - 48)
    expect(state.rect.y).toBeLessThanOrEqual(VIEWPORT.height - 48)
  })
})
