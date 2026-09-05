import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tabs } from '../Tabs'
import { tabStripChoreo } from '../tab-reorder'
import type { TabSpec } from '../Tabs'

/**
 * **`joined` 档与条内换序的编舞**(W3-b 裁定 1/4/5)。
 *
 * jsdom 不排版,所以这里**不量像素** —— 量像素那一半是 `gate:squeeze` 与
 * `gate:drag` 的活(08-30 判例:交互时序类改动必须真机对照)。这只文件守的是
 * 三件在 jsdom 里就是事实的东西:
 *   ① 三态:`look` 缺省是 `line`、`joined` 只改一格 data 属性、两档的 DOM 一样;
 *   ② 编舞的**纯判据**:抬起 → 每一帧的落点下标,一张表逐行走;
 *   ③ Esc / 结束那一下的**复原**:属性、transform、空位全清干净。
 */

const ITEMS: TabSpec[] = [
  { id: 'a', label: 'alpha' },
  { id: 'b', label: 'beta' },
  { id: 'c', label: 'gamma' },
]

function renderTabs(look?: 'line' | 'joined') {
  return render(
    <Tabs items={ITEMS} activeId="b" look={look} onSelect={() => {}} label="tabs" />,
  )
}

describe('joined 档:三态', () => {
  it('缺省是 line —— 别处的分段条一个字都不变', () => {
    renderTabs()
    expect(screen.getByRole('tablist').getAttribute('data-look')).toBe('line')
  })

  it('joined 只换一格属性,DOM 形状与 line 逐字相同', () => {
    const line = renderTabs().container.querySelector('[role="tablist"]')!.innerHTML
    const joined = renderTabs('joined').container.querySelector('[role="tablist"]')!.innerHTML
    expect(joined).toBe(line)
  })

  it('每一格都带得出自己的 id(编舞与门的取件口)', () => {
    renderTabs('joined')
    expect(
      screen.getAllByRole('tab').map((el) => el.getAttribute('data-tab-id')),
    ).toEqual(['a', 'b', 'c'])
  })
})

/**
 * 编舞的判据部分。jsdom 里 `getBoundingClientRect` 恒答零,所以这里**自己喂几何**
 * —— 把三格 tab 的矩形打桩成 120 宽、依次排开,再逐行走「指针在这儿 → 落点是几」。
 */
function stubLayout(list: HTMLElement, width = 120): void {
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
  tabs.forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ left: i * width, top: 0, width, height: 34, right: (i + 1) * width, bottom: 34 }) as DOMRect
  })
  list.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: width * tabs.length, height: 34, right: width * tabs.length, bottom: 34 }) as DOMRect
}

describe('条内换序:纯判据(下标表驱动)', () => {
  /*
   * 三格各 120 宽依次排开(a[0,120) b[120,240) c[240,360)),中线 60 / 180 / 300。
   * 抓的是 a 的中心(grabX=60),所以抬起那格的中线 = 指针本身。
   */
  /*
   * 答的是**插到第几格之前**(与 `workbench/drop.ts` 的 `stripIndexAt` 同一个坐标系,
   * 对着**没摘掉任何东西**的那张原始表)。所以 a 越过 b 之后答的是 2 而不是 1:
   * 「插到 c 之前」= 摘掉 a 再插到 1 = [b, a, c]。这一格是真机门当场量出来的 ——
   * 两格 tab 里答 1 会撞上 `store.moveTab` 的「原地不动」闸,序一格不变。
   */
  it.each([
    [60, 0, '原地'],
    [179, 0, '还没越过 b 的中线(180)'],
    [185, 2, '越过 b 的中线 = 插到 c 之前'],
    [310, 3, '越过 c 的中线(300)= 插到末尾'],
    [30, 0, '往左出界也还是第一格'],
  ])('抓 a 拖到 x=%i → at=%i(%s)', (x, expected) => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    expect(choreo.track(x)).toBe(expected)
  })

  it('抬起那一格挂 data-lift,邻居让位挂 data-shift', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    choreo.track(310)
    const [a, b, c] = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    expect(a.dataset.lift).toBe('')
    // a 排到了末尾,所以 b / c 各往左挪一格宽。
    expect(b.dataset.shift).toBe('')
    expect(b.style.transform).toBe('translateX(-120px)')
    expect(c.style.transform).toBe('translateX(-120px)')

    // 手往回收:a 排回第 1 位,两个邻居当场归零(让位必须是可逆的)。
    choreo.track(60)
    expect(b.style.transform).toBe('')
    expect(c.style.transform).toBe('')
    expect(b.dataset.shift).toBeUndefined()
  })

  /** 让位落定后必须**清零** —— 留着的话下一次渲染那几格会长在错位上。 */
  it('reset:抬起 / 让位 / 折起 / 空位全部清干净(Esc 那条路)', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    choreo.track(310)
    choreo.tear('a')
    choreo.gapAt(1, 120)
    expect(list.querySelector('[data-tab-placeholder]')).not.toBeNull()
    expect(list.querySelector<HTMLElement>('[data-tab-id="a"]')!.dataset.torn).toBe('')

    choreo.reset()
    for (const el of Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))) {
      expect(el.style.transform).toBe('')
      expect(el.dataset.lift).toBeUndefined()
      expect(el.dataset.shift).toBeUndefined()
      expect(el.dataset.torn).toBeUndefined()
    }
    expect(list.querySelector('[data-tab-placeholder]')).toBeNull()
  })

  /** 撕下:那一格**不卸载**,只是折起来(零重挂断言的那一格)。 */
  it('tear 之后那一格还是同一个 DOM 节点', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const before = list.querySelector('[data-tab-id="a"]')
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    choreo.track(60)
    choreo.tear('a')
    expect(list.querySelector('[data-tab-id="a"]')).toBe(before)
    choreo.reset()
    expect(list.querySelector('[data-tab-id="a"]')).toBe(before)
  })
})

describe('跨条落点:空位插在第几格', () => {
  it.each([
    [0, 'a'],
    [1, 'b'],
    [2, 'c'],
    [3, null],
  ])('gapAt(%i) 插在 %s 之前', (index, nextId) => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.gapAt(index as number, 120)
    const ph = list.querySelector<HTMLElement>('[data-tab-placeholder]')!
    expect(ph.nextElementSibling?.getAttribute('data-tab-id') ?? null).toBe(nextId)
    expect(ph.getAttribute('aria-hidden')).toBe('true')
  })

  it('同一个下标重复叫不会重插(过渡不会从头再放一遍)', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.gapAt(1, 120)
    const first = list.querySelector('[data-tab-placeholder]')
    choreo.gapAt(1, 120)
    expect(list.querySelector('[data-tab-placeholder]')).toBe(first)
  })
})
