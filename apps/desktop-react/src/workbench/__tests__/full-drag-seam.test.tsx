import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveRegionText } from '../../ui/a11y/live-region'
import { act, render, screen } from '@testing-library/react'
import { DragLayer, DropOverlay, resetDragSession } from '../../ui/drag'
import { useContentDrag } from '../useContentDrag'
import { dropRef } from '../drop-commit'
import { CENTER_REGION, edgeRegion } from '../regions'
import { refId, registerContentKind, resetContentKinds } from '../kinds'
import { useWorkbenchStore } from '../store'
import { useStageStore } from '../../stage/store'
import { makeLeaf, refIdsOf } from '../tree'
import { ButtonBase } from '../../ui/ButtonBase'
import type { ContentRef } from '../kinds'

/**
 * **W2(真全屏)× W3(拖拽)那道接缝的守卫**(合树裁定 a / b)。
 *
 * 两件事各一条,它们是同一句话的两半 —— 「全屏层盖着整棵树的时候,拖拽这台机器
 * 说的话与用户看见的东西不许分家」:
 *
 *   a. **全屏期间一下都不许起拖**。落点几何量的是底下那棵树(被 `inert` 盖着、
 *      屏幕上根本看不见),真让它起拖,高亮就画在一块看不见的矩形上。
 *   b. **落定之前先把全屏收掉**。落定会改树,而改完之后用户看见的还是那块铺满
 *      的面 —— 那是「按了没反应」;`land()` 的焦点还会送进一片 `inert` 的叶里。
 *
 * 断言的是**结果**(拖没拖起来 / 全屏还在不在 + 树变没变),不是「某只函数被调了」:
 * 哪天有人在别处再写一条捷径,spy 照样绿,而这两条会红。
 */

const A: ContentRef = { kind: 'seam-a', key: 'a' }
const B: ContentRef = { kind: 'seam-b', key: 'b' }

function seedKinds(): void {
  resetContentKinds()
  for (const kind of ['seam-a', 'seam-b']) {
    registerContentKind({
      id: kind,
      singleton: false,
      title: (ref) => ({ text: ref.key }),
      icon: () => 'File',
      render: () => null,
    })
  }
}

/** 中央区一片叶,装着 A 与 B 两格。 */
function seedTree(): void {
  useWorkbenchStore.setState({
    regions: { [CENTER_REGION]: makeLeaf('leaf-seam', [A, B], 0) },
    hidden: [],
    focusLeafId: 'leaf-seam',
    dragging: false,
    full: null,
  })
}

beforeEach(() => {
  seedKinds()
  useWorkbenchStore.getState().reset()
  useStageStore.setState({ floats: {}, floatOrder: [] })
  seedTree()
})

afterEach(() => {
  act(() => resetDragSession())
})

/**
 * 一颗「能拖 A」的按钮,走的正是五种来源共用的那只 hook。
 *
 * 事件一律用 `MouseEvent` 派(jsdom 没有 `PointerEvent` 构造器,理由与
 * `ui/__tests__/drag-session.test.tsx` 文件头那一段逐字相同)。
 */
function Source({ onDrop }: { onDrop?: () => boolean }) {
  const start = useContentDrag({ ref: () => A, onDrop: onDrop ? () => onDrop() : undefined })
  return (
    <>
      {/* 夹具里的拖拽把手是**结构件**(③),所以走 `ui/ButtonBase` 而不是裸钮。 */}
      <ButtonBase data-testid="src" onPointerDown={start}>
        源
      </ButtonBase>
      <DropOverlay />
      <DragLayer />
    </>
  )
}

function down(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
}
function move(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
}
function up(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }))
}

describe('接缝 a:全屏期间不许起拖', () => {
  it('全屏开着 —— 走过阈值也不起拖:没有浮影、树没被闸住、松手不落定', async () => {
    useWorkbenchStore.getState().enterFull(B)
    expect(useWorkbenchStore.getState().full).not.toBeNull()

    const onDrop = vi.fn(() => true)
    render(<Source onDrop={onDrop} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 300, 300)
      up(src, 300, 300)
    })

    expect(screen.queryByTestId('drag-ghost')).toBeNull()
    // 整场没成立 → 那道树形闸压根没合上(合了没开才是漏)。
    expect(useWorkbenchStore.getState().dragging).toBe(false)
    expect(onDrop).not.toHaveBeenCalled()
    // 这一下不是「取消全屏」,是「什么都没发生」。
    expect(refId(useWorkbenchStore.getState().full!.ref)).toBe(refId(B))
    // ……但不是静默的(09-25):读屏那一侧念出为什么。播报排在下一拍。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(liveRegionText('polite')).toMatch(/全屏|full screen/i)
  })

  it('全屏关着 —— 同一串手势照旧起得来(闸只在全屏那一形上合)', () => {
    expect(useWorkbenchStore.getState().full).toBeNull()
    render(<Source onDrop={() => true} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 300, 300)
    })
    expect(screen.getByTestId('drag-ghost')).not.toBeNull()
    expect(useWorkbenchStore.getState().dragging).toBe(true)
    act(() => up(src, 300, 300))
  })
})

describe('接缝 b:落定之前先收全屏', () => {
  it('全屏铺着的时候落定 —— 全屏收回去,而且树真的改了', () => {
    useWorkbenchStore.getState().enterFull(B)
    expect(useWorkbenchStore.getState().full).not.toBeNull()

    dropRef(A, { kind: 'edge', side: 'right' })

    expect(useWorkbenchStore.getState().full).toBeNull()
    const regions = useWorkbenchStore.getState().regions
    expect(refIdsOf(regions[CENTER_REGION])).toEqual([refId(B)])
    expect(refIdsOf(regions[edgeRegion('right')])).toEqual([refId(A)])
  })

  it('被拒绝的那一下什么都不改 —— 全屏照旧铺着', () => {
    useWorkbenchStore.getState().enterFull(B)
    dropRef(A, { kind: 'refuse', reasonKey: 'drag.regionRefused' })
    expect(useWorkbenchStore.getState().full).not.toBeNull()
    expect(refIdsOf(useWorkbenchStore.getState().regions[CENTER_REGION])).toEqual([
      refId(A),
      refId(B),
    ])
  })
})
