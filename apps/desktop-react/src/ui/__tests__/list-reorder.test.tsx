import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GripVertical } from '../../components/icons'
import { focusTree } from '../../focus/registry'
import { resetWindowFocus } from '../../focus/window-focus'
import { IconButton } from '../IconButton'
import { useListReorder } from '../list-reorder'

/**
 * **`ui/list-reorder` 的守卫**(09-18 立件)。
 *
 * 判的是这一件存在的全部理由:**把手起拖才算数、阈值以下什么都不发、三条取消
 * 路径一个字不落定、松手只发一次、键盘四个键各发一次而且焦点跟着那一行走**。
 * 纯算术那一半不在这里 —— 它住在 `reorder-math.test.ts`(脱离 DOM,一条一条钉)。
 *
 * **四发事件一律手搓 `MouseEvent`**:jsdom 没有 `PointerEvent` 构造器,
 * testing-library 那一路会退回裸 `Event`,于是 `e.button` 是 `undefined`、件里
 * 那句「只认主键」当场把整场挡掉。`MouseEvent` 带得出 `button` / `clientY`,
 * 而件读的就是这两格;React 按**事件名**派合成事件,`onPointerDown` 照样收得到
 * (判据与 `drag-session.test.tsx` 文件头逐字同源)。
 *
 * **几何要自己摆**:jsdom 里 `getBoundingClientRect` 恒为全 0,而这一件的落点
 * 判据全靠它。下面那只桩按「第 i 行在 y = i × 40」摆,列表的上下缘跟着行数走 ——
 * 于是「把第 0 行拖到第 2 行的位置」在用例里是一句能算出来的话。
 */

const ROW_H = 40

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

/** 这一列此刻画着的那几行(按 DOM 次序)。 */
const rowsOf = (list: Element): HTMLElement[] =>
  Array.from(list.querySelectorAll<HTMLElement>('[data-list-reorder-item]'))

function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-list-reorder')) return rect(0, ROW_H * rowsOf(this).length)
    if (this.hasAttribute('data-list-reorder-item')) {
      const list = this.closest('[data-list-reorder]')
      const at = list ? rowsOf(list).indexOf(this) : -1
      return rect(at < 0 ? 0 : at * ROW_H, ROW_H)
    }
    return rect(0, 0)
  })
}

/** 一条受控的三行列表。`onMove` 真的改次序 —— 「焦点跟着那一行走」要的就是这个。 */
function Harness({ onMove, disabled }: { onMove?: (id: string, to: number) => void; disabled?: boolean }) {
  const [ids, setIds] = useState(['a', 'b', 'c'])
  const reorder = useListReorder({
    ids,
    disabled,
    onMove: (id, to) => {
      onMove?.(id, to)
      setIds((prev) => {
        const next = prev.filter((one) => one !== id)
        next.splice(to, 0, id)
        return next
      })
    },
    labels: { handle: (index) => `handle ${index}`, moved: (from, to) => `moved ${from} to ${to}` },
  })
  return (
    <ol {...reorder.listProps} data-testid="list">
      {ids.map((id, index) => (
        <li key={id} {...reorder.itemProps(id)} data-testid={`row-${id}`}>
          <span>{id}</span>
          <IconButton icon={GripVertical} testId={`handle-${id}`} {...reorder.handleProps(id, index)} />
        </li>
      ))}
    </ol>
  )
}

const down = (el: Element, y: number) =>
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: y }))
const move = (el: Element, y: number) =>
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: y }))
const up = (el: Element, y: number) =>
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: y }))

/** 这一场登记的那格 Esc 口(瞬态表末位)—— 与 `pointer-track.test.ts` 同一手。 */
const lastTransient = (): (() => boolean) | null => {
  const all = focusTree.transientEscapeHandlers()
  return all.length > 0 ? all[all.length - 1] : null
}

/** 屏上此刻的次序。 */
const order = () => rowsOf(screen.getByTestId('list')).map((el) => el.getAttribute('data-list-reorder-item'))

beforeEach(() => {
  stubGeometry()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetWindowFocus()
})

describe('指针:起拖的门槛', () => {
  it('阈值以下 = 一次普通按下,`onMove` 一个字都不发,也没有一行被抬起', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      // DRAG_START_PX = 8,走 5 不算。
      move(handle, 15)
      up(handle, 15)
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(screen.getByTestId('row-a').dataset.lift).toBeUndefined()
    expect(screen.getByTestId('list').dataset.reordering).toBeUndefined()
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  it('只从把手起拖:按在行身上一路拖过去,什么都不发生', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const row = screen.getByTestId('row-a')
    act(() => {
      down(row, 10)
      move(row, 90)
      up(row, 90)
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(screen.getByTestId('list').dataset.reordering).toBeUndefined()
  })

  it('过阈值 = 抬起:那一行挂 data-lift、整条挂 data-reordering、邻居让位', () => {
    render(<Harness />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      move(handle, 60)
    })
    expect(screen.getByTestId('row-a').dataset.lift).toBe('')
    expect(screen.getByTestId('list').dataset.reordering).toBe('')
    // 第 0 行下探到 y=50:后缘 90 越过了第 1 行中心 60,它让开一格行高。
    expect(screen.getByTestId('row-b').dataset.shift).toBe('')
    expect(screen.getByTestId('row-b').style.transform).toBe(`translateY(-${ROW_H}px)`)
    act(() => up(handle, 60))
  })
})

describe('指针:松手落定', () => {
  it('松手发一次、只发一次,落点就是屏上那一格', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      // 第 0 行走到 y≈90:后缘越过第 1 行与第 2 行的中心 → 排到第 2 位。
      move(handle, 100)
      up(handle, 100)
    })
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith('a', 2)
    expect(order()).toEqual(['b', 'c', 'a'])
    // 落定 = 回到什么都没发生过:抬起与让位的痕迹一格不剩。
    expect(screen.getByTestId('row-a').dataset.lift).toBeUndefined()
    expect(screen.getByTestId('list').dataset.reordering).toBeUndefined()
  })

  it('原地松手不发:落点与出发点同一格 = 什么都没改', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      // 走过阈值但没越过第 1 行的中心 —— 还是第 0 位。
      move(handle, 20)
      up(handle, 20)
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(order()).toEqual(['a', 'b', 'c'])
  })
})

describe('指针:三条取消路径', () => {
  /**
   * 三条是同一句话「这一下不算数」,所以逐条判的都是:`onMove` 零次、次序不变、
   * 抬起与让位的痕迹清干净。
   */
  const cases: Array<[string, (handle: Element) => void]> = [
    ['Esc', () => void lastTransient()?.()],
    ['pointercancel', (handle) => handle.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))],
    /*
     * 这条走的是 DOM 那条源(`focus/window-focus` 的缺省档 —— 没有宿主源时 DOM
     * `blur` 就是窗口 blur)。**别在这里 `installWindowFocusSource()`**:那一句
     * 把事实交给主进程,DOM blur 从此不算,这条用例会绿得莫名其妙。
     */
    ['窗口失焦', () => window.dispatchEvent(new Event('blur'))],
  ]

  for (const [name, fire] of cases) {
    it(`${name} 作废:一个字不落定,那串 id 一格不变`, () => {
      const onMove = vi.fn()
      render(<Harness onMove={onMove} />)
      const handle = screen.getByTestId('handle-a')
      act(() => {
        down(handle, 10)
        move(handle, 100)
      })
      expect(screen.getByTestId('row-a').dataset.lift).toBe('')
      act(() => fire(handle))
      expect(onMove).not.toHaveBeenCalled()
      expect(order()).toEqual(['a', 'b', 'c'])
      expect(screen.getByTestId('row-a').dataset.lift).toBeUndefined()
      expect(screen.getByTestId('row-b').dataset.shift).toBeUndefined()
      expect(screen.getByTestId('list').dataset.reordering).toBeUndefined()
    })
  }

  /*
   * **第四条结束路径:宿主没了**(抽屉在拖到一半时被关掉)。判的是那格 Esc 瞬态
   * 登记真的销了号 —— 不销的话「关掉之后按 Esc 还有人吃掉它」会一直挂着。
   * 反证:把 `useListReorder` 里那只卸载 effect 挖掉 → 这一条红。
   */
  it('拖到一半宿主卸载:监听与那格 Esc 瞬态一起收干净', () => {
    const before = focusTree.transientEscapeHandlers().length
    const view = render(<Harness />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      move(handle, 100)
    })
    expect(focusTree.transientEscapeHandlers().length).toBe(before + 1)
    act(() => view.unmount())
    expect(focusTree.transientEscapeHandlers().length).toBe(before)
  })

  it('取消之后再松手:这一场已经死了,补一发 pointerup 也不会落定', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      move(handle, 100)
      lastTransient()?.()
      up(handle, 100)
    })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('键盘:把手上的四个键', () => {
  it('↑ ↓ Home End 各发一次,参数是最终位置', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    fireEvent.keyDown(screen.getByTestId('handle-b'), { key: 'ArrowUp' })
    expect(onMove).toHaveBeenLastCalledWith('b', 0)
    expect(order()).toEqual(['b', 'a', 'c'])

    fireEvent.keyDown(screen.getByTestId('handle-b'), { key: 'ArrowDown' })
    expect(onMove).toHaveBeenLastCalledWith('b', 1)
    expect(order()).toEqual(['a', 'b', 'c'])

    fireEvent.keyDown(screen.getByTestId('handle-b'), { key: 'End' })
    expect(onMove).toHaveBeenLastCalledWith('b', 2)
    expect(order()).toEqual(['a', 'c', 'b'])

    fireEvent.keyDown(screen.getByTestId('handle-b'), { key: 'Home' })
    expect(onMove).toHaveBeenLastCalledWith('b', 0)
    expect(order()).toEqual(['b', 'a', 'c'])

    expect(onMove).toHaveBeenCalledTimes(4)
  })

  /*
   * 到头了不发,但**照样 preventDefault** —— 否则「已经在第一位了还按 ↑」会变成
   * 把整页滚一下,人看到的是「换序把页面弄跑了」。
   */
  it('到头不发,但仍然吃掉那一下(不让它去滚页面)', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    const eaten = !fireEvent.keyDown(screen.getByTestId('handle-a'), { key: 'ArrowUp' })
    expect(eaten).toBe(true)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('带修饰键的一律放行 —— 那是快捷键那张表的事', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      fireEvent.keyDown(screen.getByTestId('handle-b'), { key: 'ArrowUp', ...mods })
    }
    expect(onMove).not.toHaveBeenCalled()
  })

  /*
   * **焦点跟着那一行走是结构性的**:把手是那一行的孩子,消费方用稳定 key 渲染,
   * React 换序时 `insertBefore` 挪的是同一个 DOM 节点。所以这一件里一句
   * `.focus()` 都没有(不变量 I3)。反证:把 `key={id}` 换成 `key={index}` →
   * 节点被换掉,这一条当场红。
   */
  it('换完序焦点还在同一颗把手上(同一个 DOM 节点,不是同一个位置)', () => {
    render(<Harness />)
    const handle = screen.getByTestId('handle-b')
    act(() => handle.focus())
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(order()).toEqual(['b', 'a', 'c'])
    expect(screen.getByTestId('handle-b')).toBe(handle)
    expect(document.activeElement).toBe(handle)
  })
})

describe('播报与 disabled', () => {
  it('落定播一句,走全应用唯一那口 live region', async () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId('handle-a'), { key: 'End' })
    // `announce` 是先清空、下一个宏任务再写(重复文案要能重播),所以这里等一拍。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-live="polite"]')?.textContent).toBe('moved 0 to 2')
  })

  it('disabled:指针与键盘两条路一起停', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} disabled />)
    const handle = screen.getByTestId('handle-a')
    act(() => {
      down(handle, 10)
      move(handle, 100)
      up(handle, 100)
    })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onMove).not.toHaveBeenCalled()
    expect(screen.getByTestId('list').dataset.reordering).toBeUndefined()
  })
})

/**
 * 样式那一半的守卫。jsdom 不排版,所以判的是**文件里写没写那两条** —— 与
 * `ui/__tests__/Dots.test.tsx` 那条降级用例同一手(读样式表的门先剥注释,
 * 既有法条:病历文本里会引这些写法当例子)。
 */
describe('动效两档,一个结论', () => {
  const css = () =>
    readFileSync(path.resolve(__dirname, '../list-reorder.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ')

  it('时长只读 token —— 动效档「无」把 --dur-neighbor / --dur-settle 归 0,于是 JS 里一句档位分支都不必写', () => {
    const text = css()
    expect(text).toMatch(/\[data-shift\]\s*\{\s*transition:\s*transform var\(--dur-neighbor\)/)
    expect(text).toMatch(/\[data-settle\]\s*\{[^}]*transition:\s*transform var\(--dur-settle\)/)
    // 组件文件零字面时长(验收轴一,`motion-gate` 的静态那一半判的也是这条)。
    expect(text).not.toMatch(/transition:[^;}]*\d+m?s/)
  })

  it('系统 prefers-reduced-motion 是第二条来源:让位与收笔两条过渡都关掉,直接落位', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}/.exec(css())?.[1]
    expect(block, '降级块必须在').toBeTruthy()
    expect(block).toMatch(/data-shift/)
    expect(block).toMatch(/data-settle/)
    expect(block).toMatch(/transition:\s*none/)
  })
})
