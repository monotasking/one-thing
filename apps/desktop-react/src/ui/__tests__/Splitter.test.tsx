import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Splitter, SPLITTER_STEP } from '../Splitter'
import { focusTree } from '../../focus/registry'

/**
 * **Splitter(第 19 件)的规格测试** —— 09-01 报障「file open 之后,没办法调整宽度」。
 *
 * 照「组件收敛战役纪律」把三类状态测全:
 *  · **生命状态**:挂载即报得出当下比例;拖拽期间容器挂 `data-splitting`,松手摘掉;
 *  · **交互状态**:←/→(竖杆)· Home / End · ↵ 回默认 · 双击回默认 · 拖拽;
 *  · **页面与数据状态**:值超出上下界一律钳住(盘上读回一个 -3 不该把分栏压成一条缝)。
 *
 * APG 那一套(role / valuenow / orientation / 进 Tab 序)也在这里逐条钉。
 */
function setup(overrides: Partial<Parameters<typeof Splitter>[0]> = {}) {
  const onCommit = vi.fn()
  const containerRef = createRef<HTMLDivElement>()
  const view = render(
    <div ref={containerRef} style={{ width: 200 }}>
      <div id="pane-a" />
      <Splitter
        containerRef={containerRef}
        value={overrides.value ?? 45}
        defaultValue={45}
        label="分隔杆"
        controls="pane-a"
        liveVar="--x"
        testId="splitter"
        onCommit={onCommit}
        {...overrides}
      />
    </div>,
  )
  return { onCommit, containerRef, view }
}

describe('Splitter:APG 的 window splitter 语义', () => {
  it('role=separator、可聚焦、报得出 valuenow / min / max / orientation / controls', () => {
    setup()
    const bar = screen.getByTestId('splitter')
    expect(bar.getAttribute('role')).toBe('separator')
    expect(bar.tabIndex).toBe(0)
    expect(bar.getAttribute('aria-valuenow')).toBe('45')
    expect(bar.getAttribute('aria-valuemin')).toBe('15')
    expect(bar.getAttribute('aria-valuemax')).toBe('85')
    expect(bar.getAttribute('aria-orientation')).toBe('vertical')
    expect(bar.getAttribute('aria-controls')).toBe('pane-a')
  })

  it('横杆报 horizontal —— 方向是它自己的事实,不是调用方的措辞', () => {
    setup({ orientation: 'horizontal' })
    expect(screen.getByTestId('splitter').getAttribute('aria-orientation')).toBe('horizontal')
  })
})

describe('Splitter:键盘那一套', () => {
  /*
   * **缺省步长是 5,而 5 只有一个产地**(W7-t / B8)。设计
   * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §6 的原话是「键盘 ←/→
   * 5% 一步」,而代码里曾经写着 2 —— 一条写在正本里、屏幕上从来没兑现过的规格。
   *
   * 断言读的是 `SPLITTER_STEP` 而不是字面 5:把 5 抄进用例里,哪天常量改了
   * 用例会替一份过期的规格说话(与 `gate:squeeze` 读 `--pair-head-h` 同一条)。
   * **反证**:把 `SPLITTER_STEP` 改回 2 → 下面第二条(它对着设计里那个 5)当场红。
   */
  it('←/→ 各走一格 step,缺省就是 SPLITTER_STEP', () => {
    const { onCommit } = setup()
    const bar = screen.getByTestId('splitter')
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(45 - SPLITTER_STEP)
    fireEvent.keyDown(bar, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(45 + SPLITTER_STEP)
  })

  it('设计 §6 那个数就是这一格常量:5%', () => {
    expect(SPLITTER_STEP).toBe(5)
  })

  it('竖杆不接 ↑↓(那是别人的键)', () => {
    const { onCommit } = setup()
    fireEvent.keyDown(screen.getByTestId('splitter'), { key: 'ArrowUp' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Home / End 到两头,↵ 与双击都回默认', () => {
    const { onCommit } = setup({ value: 60 })
    const bar = screen.getByTestId('splitter')
    fireEvent.keyDown(bar, { key: 'Home' })
    expect(onCommit).toHaveBeenLastCalledWith(15)
    fireEvent.keyDown(bar, { key: 'End' })
    expect(onCommit).toHaveBeenLastCalledWith(85)
    fireEvent.keyDown(bar, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(45)
    fireEvent.doubleClick(bar)
    expect(onCommit).toHaveBeenLastCalledWith(45)
  })

  it('没有默认值时 ↵ 与双击都不做事(不许凭空造一个「默认」)', () => {
    const { onCommit } = setup({ defaultValue: undefined })
    const bar = screen.getByTestId('splitter')
    fireEvent.keyDown(bar, { key: 'Enter' })
    fireEvent.doubleClick(bar)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('Splitter:钳制与跟手', () => {
  it('走到头就停住,不越界', () => {
    const { onCommit } = setup({ value: 16 })
    const bar = screen.getByTestId('splitter')
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(15)
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(15)
  })

  it('键盘走一格也把实时值写进容器那个变量(拖与按走同一条输出口)', () => {
    const { containerRef } = setup()
    fireEvent.keyDown(screen.getByTestId('splitter'), { key: 'ArrowRight' })
    expect(containerRef.current?.style.getPropertyValue('--x')).toBe(String(45 + SPLITTER_STEP))
  })

  /*
   * 拖拽那一段在 jsdom 里没有真实布局(getBoundingClientRect 全是 0),所以这里
   * 只验**生命周期那一半**:按下去容器挂上 `data-splitting`(分栏的过渡要在这段
   * 时间里关掉,不然列宽会追着指针走),松手摘掉并落一次 commit。
   * 「拖着看到的与存下来的逐像素相同」由真机门 gate:files 验(它有真实布局)。
   */
  /*
   * jsdom 里 `fireEvent.pointerDown(el, { button: 0 })` **派的不是 MouseEvent**
   * (它没有 PointerEvent 实现),`event.button` 会是 undefined,于是「只认主键」
   * 那条闸把它挡了。所以这里手搓一个带 button 的 MouseEvent —— 类型名仍是
   * `pointerdown`,React 照样接得到。这不是给测试开后门:被测的判据(button===0)
   * 一个字没放松,只是把事件造得像真的。
   */
  const pointer = (type: string, button = 0) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button })

  it('按下去挂 data-splitting,松手摘掉并落一次 commit', () => {
    const { onCommit, containerRef } = setup()
    const bar = screen.getByTestId('splitter')
    fireEvent(bar, pointer('pointerdown'))
    expect(containerRef.current?.getAttribute('data-splitting')).toBe('true')
    bar.dispatchEvent(pointer('pointerup'))
    expect(containerRef.current?.getAttribute('data-splitting')).toBeNull()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('右键 / 中键按下去不开始拖(只认主键)', () => {
    const { containerRef } = setup()
    fireEvent(screen.getByTestId('splitter'), pointer('pointerdown', 2))
    expect(containerRef.current?.getAttribute('data-splitting')).toBeNull()
  })

  /*
   * **取消不落定**(U5,2026-09-08)。三条取消路(Esc / pointercancel / 窗口失焦)
   * 由 `ui/drag` 的 `PointerTrack` 统一收,消费方这一头只做一件事:**还原到按下
   * 那一刻**,`onCommit` 一个字都不落。
   *
   * 从前这条杆压根没有 Esc、也收不到失焦(监听挂在杆自己身上,capture 一丢就聋),
   * 所以拖到一半切走应用会把 `data-splitting` 永远挂在容器上。
   * 反证:把 `onPointerDown` 里那只 `cancel` 回调挖掉 → 三条全红(属性还挂着)。
   */
  const cancelPaths: Array<[string, () => void]> = [
    ['窗口失焦', () => window.dispatchEvent(new Event('blur'))],
    ['pointercancel', () => screen.getByTestId('splitter').dispatchEvent(pointer('pointercancel'))],
    [
      'Esc(经 focus 树的瞬态口)',
      () => {
        const all = focusTree.transientEscapeHandlers()
        all[all.length - 1]?.()
      },
    ],
  ]
  /** 取消那一下会 setState(出拖拽态),所以进 act —— 否则读到的是上一帧。 */
  const fireIn = (run: () => void) => act(() => { run() })
  for (const [name, fire] of cancelPaths) {
    it(`拖到一半${name}:摘掉 data-splitting、比例画回按下那一刻、不落 commit`, () => {
      const { onCommit, containerRef } = setup({ value: 45 })
      const bar = screen.getByTestId('splitter')
      act(() => { fireEvent(bar, pointer('pointerdown')) })
      bar.dispatchEvent(pointer('pointermove'))
      expect(containerRef.current?.getAttribute('data-splitting')).toBe('true')
      fireIn(fire)
      expect(containerRef.current?.getAttribute('data-splitting')).toBeNull()
      expect(containerRef.current?.style.getPropertyValue('--x')).toBe('45')
      expect(onCommit).not.toHaveBeenCalled()
    })
  }

  it('取消之后再来一发 pointerup,仍旧不落 commit(这一场真的死了)', () => {
    const { onCommit } = setup()
    const bar = screen.getByTestId('splitter')
    act(() => { fireEvent(bar, pointer('pointerdown')) })
    fireIn(() => window.dispatchEvent(new Event('blur')))
    fireIn(() => bar.dispatchEvent(pointer('pointerup')))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
