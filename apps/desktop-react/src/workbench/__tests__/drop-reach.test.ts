import { describe, expect, it } from 'vitest'
import { dropTargetAt, sameDropTarget, stickyDropTargetAt, DROP_HYSTERESIS_PX } from '../drop'
import type { DropGeometry, DropTarget, LeafBox } from '../drop'
import type { ShelfSide } from '../../stage/types'

/**
 * **可达表**(09-25,外窄内宽):任何布局下,每片叶的四向分屏都够得着,每条空边都拖得出
 * 一条新架子。
 *
 * 起因是用户报「只有右架子,chat 区没办法分屏到右侧」。扫点(窗口每 5px 一点)量出来的
 * 09-24 那一版:无架子时中央叶左 / 右 / 下三向分屏 0%,左右都有架子时三片叶都分不出下,
 * 中央已左右分屏时两片各丢一侧 —— 30% 的新架子带排在叶之前,贴着空边的那一侧分屏带整块
 * 落在它里面。这张表钉的是结果不是参数:以后谁再调带宽或调次序,只要让某个落点够不着,
 * 这里就红。
 */

const W = 1400
const H = 900
/** 顶栏那一截:叶从它下面开始。 */
const TOP = 40
const WIN = { left: 0, top: 0, width: W, height: H }
const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height })

const leaf = (region: string, leafId: string, rect: ReturnType<typeof r>): LeafBox => ({
  region: region as LeafBox['region'],
  leafId,
  rect,
})

const LAYOUTS: Record<string, DropGeometry> = {
  '无架子': { window: WIN, shelves: [], leaves: [leaf('center', 'C', r(0, TOP, W, H - TOP))] },
  '只有左架子': {
    window: WIN,
    shelves: ['left'],
    leaves: [leaf('edge:left', 'L', r(0, TOP, 420, H - TOP)), leaf('center', 'C', r(420, TOP, W - 420, H - TOP))],
  },
  '只有右架子': {
    window: WIN,
    shelves: ['right'],
    leaves: [leaf('center', 'C', r(0, TOP, W - 420, H - TOP)), leaf('edge:right', 'R', r(W - 420, TOP, 420, H - TOP))],
  },
  '只有底架子': {
    window: WIN,
    shelves: ['bottom'],
    leaves: [leaf('center', 'C', r(0, TOP, W, H - TOP - 270)), leaf('edge:bottom', 'B', r(0, H - 270, W, 270))],
  },
  '左右都有架子': {
    window: WIN,
    shelves: ['left', 'right'],
    leaves: [
      leaf('edge:left', 'L', r(0, TOP, 300, H - TOP)),
      leaf('center', 'C', r(300, TOP, W - 600, H - TOP)),
      leaf('edge:right', 'R', r(W - 300, TOP, 300, H - TOP)),
    ],
  },
  '中央已左右分屏': {
    window: WIN,
    shelves: [],
    leaves: [leaf('center', 'C1', r(0, TOP, W / 2, H - TOP)), leaf('center', 'C2', r(W / 2, TOP, W / 2, H - TOP))],
  },
  '右架子收起': {
    window: WIN,
    shelves: ['right'],
    collapsed: [{ side: 'right', thickness: 420 }],
    leaves: [leaf('center', 'C', r(0, TOP, W - 6, H - TOP))],
  },
}

const OUTSIDER = { dragged: { id: 'x', slots: 1 } }

/** 扫一遍:每片叶上出现过哪些落点,以及出现过哪些边带。 */
function sweep(geo: DropGeometry) {
  const splits = new Map<string, Set<string>>()
  const edges = new Set<ShelfSide>()
  for (let x = 1; x < W; x += 5) {
    for (let y = TOP + 1; y < H; y += 5) {
      const t = dropTargetAt({ x, y }, geo, OUTSIDER)
      if (t.kind === 'split') {
        const seen = splits.get(t.leafId) ?? new Set<string>()
        seen.add(t.side)
        splits.set(t.leafId, seen)
      }
      if (t.kind === 'edge') edges.add(t.side)
    }
  }
  return { splits, edges }
}

describe('可达表:每片叶四向分屏、每条空边的边带,一个都不许够不着', () => {
  for (const [name, geo] of Object.entries(LAYOUTS)) {
    it(name, () => {
      const { splits, edges } = sweep(geo)
      for (const box of geo.leaves) {
        expect([...(splits.get(box.leafId) ?? [])].sort(), `${name} · 叶 ${box.leafId}`).toEqual([
          'bottom',
          'left',
          'right',
          'top',
        ])
      }
      const open = (['left', 'right', 'bottom'] as const).filter(
        (side) => !geo.shelves.includes(side) || geo.collapsed?.some((c) => c.side === side),
      )
      expect([...edges].sort(), `${name} · 边带`).toEqual([...open].sort())
    })
  }
})

describe('迟滞:分界线上的抖动不换预示', () => {
  const geo = LAYOUTS['无架子']
  // 左边带宽 min(64, 1400 × 6%) = 64。
  const edgeLeft: DropTarget = { kind: 'edge', side: 'left' }

  it('刚跨过分界线不到迟滞宽度:留着上一个', () => {
    const justOut = { x: 64 + DROP_HYSTERESIS_PX - 2, y: 400 }
    expect(dropTargetAt(justOut, geo, OUTSIDER).kind).toBe('split')
    expect(stickyDropTargetAt(justOut, edgeLeft, geo, OUTSIDER)).toEqual(edgeLeft)
  })

  it('跨过迟滞宽度:换人', () => {
    const out = { x: 64 + DROP_HYSTERESIS_PX + 2, y: 400 }
    expect(stickyDropTargetAt(out, edgeLeft, geo, OUTSIDER).kind).toBe('split')
  })

  it('没有上一个(第一帧)= 照判据交', () => {
    const p = { x: 66, y: 400 }
    expect(stickyDropTargetAt(p, null, geo, OUTSIDER)).toEqual(dropTargetAt(p, geo, OUTSIDER))
  })

  it('同一条条上只是下标变了,不算换人,照新值交', () => {
    const a: DropTarget = { kind: 'strip', leafId: 'x', at: 1 }
    const b: DropTarget = { kind: 'strip', leafId: 'x', at: 2 }
    expect(sameDropTarget(a, b)).toBe(true)
    expect(sameDropTarget(a, { kind: 'strip', leafId: 'y', at: 1 })).toBe(false)
    expect(sameDropTarget({ kind: 'edge', side: 'left' }, { kind: 'edge', side: 'right' })).toBe(false)
  })
})
