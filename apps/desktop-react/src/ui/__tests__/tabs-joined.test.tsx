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
  /*
   * **判据是「被拖那格朝运动方向的那条边越过邻居中心」**(W6-b 二修,§4.2)。
   * 抓 a 的中心(grabX=60,grabDx=60),所以 left = x - 60、**右缘 = x + 60**。
   * 往右拖看右缘:b 的中心是 180,所以 x > 120 那一刻 b 才让位 —— 不是中心对中心
   * 那一版的 x > 180。中心对中心时宽标签要整个越过窄邻居才换位,手感发黏。
   */
  it.each([
    [60, 0, '原地'],
    [120, 0, '右缘(180)恰好压在 b 的中心上 —— 还没越过'],
    [121, 2, '右缘越过 b 的中心 = 插到 c 之前'],
    [185, 2, '再往右一段答案不变(右缘 245 还没到 c 的中心 300)'],
    /*
     * **两端各一条,而且这里没有任何特例**(W6-b 二修)。条宽 360、这一格宽 120,
     * 所以 left 钳在 [0, 240]。顶到右端时右缘 = 360 > c 的中心 300 → 两个邻居全
     * 计入 → 末位;顶到左端时 left = 0 < a 右边所有邻居的中心 → 一个都不计入 →
     * 首位。上一版的两句钳位特例(`want <= min` 判 0、`want >= max` 判 last)是
     * 「中心对中心」那个错判据的症状 —— 判据换掉之后它们一起删了。
     */
    [310, 3, '往右出界被夹回条内,仍旧到得了末位'],
    [30, 0, '往左出界也还是第一格'],
  ])('抓 a 拖到 x=%i → at=%i(%s)', (x, expected) => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    expect(choreo.track(x)).toBe(expected)
  })

  /**
   * **刚抬起那一帧,邻居一个都不动**(设计 §11 第 3 条的字面)。
   *
   * 这一条是「不把邻居按『拿走被拖那格之后』的位置算」那条裁定的守门人:那一版
   * 把右边的邻居整体左移一格宽再比中心,于是**手还没动**(x 只走过 6px 的起拖阈值)
   * 右邻居就先跳一下。判据换成「边越过中心」之后,静止时 next === index,
   * 一格 transform 都不写。
   */
  it('抬起后横向只走 6px:邻居的 transform 一个都不非空', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    expect(choreo.track(66)).toBe(0)
    const [, b, c] = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    expect(b.style.transform).toBe('')
    expect(c.style.transform).toBe('')
    expect(b.dataset.shift).toBeUndefined()
    expect(c.dataset.shift).toBeUndefined()
  })

  /**
   * **宽标签够得到末位**(§4.2「中心对中心……永远够不到末位」)。
   *
   * a 加宽到 200、b / c 各 80(条宽 360)。中心对中心那一版:a 的中线钳位后最多
   * 到 260,而 c 的中心是 320 —— 越不过去,「拖到最后一位」在结构上到不了。
   * 边越过中心那一版:右缘钳位后到 360 > 320,到得了。
   */
  it('宽标签也拖得到末位(窄邻居不再拦路)', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    const geom = [
      { left: 0, width: 200 },
      { left: 200, width: 80 },
      { left: 280, width: 80 },
    ]
    tabs.forEach((el, i) => {
      const { left, width } = geom[i]
      el.getBoundingClientRect = () =>
        ({ left, top: 0, width, height: 34, right: left + width, bottom: 34 }) as DOMRect
    })
    list.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 360, height: 34, right: 360, bottom: 34 }) as DOMRect
    const choreo = tabStripChoreo(list)
    // 抓 a 的中心(100),grabDx = 100。
    choreo.lift('a', 100)
    expect(choreo.track(100)).toBe(0)
    expect(choreo.track(9999)).toBe(3)
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

  /**
   * **基准矩形:整场只量一次**(W6-b,设计 v3 §4.2「邻居中心用抬起那一刻量好的
   * 位置算,不读正在过渡中的活矩形,否则拖快了槽位会漂」)。
   *
   * 这一条是**反证一**咬得住的那一格:把 `track()` 改成读活矩形,它当场红。
   * 现场就是真机上那一形 —— 邻居正走在 120ms 的让位过渡里,`getBoundingClientRect()`
   * 答的是插值中的位置。用例直接把邻居的活矩形改掉(让位让了一半),再问同一个 x:
   * 答案必须与没让位时**逐字相同**,因为落点问的是「起手时那张表」。
   */
  it('track 只读抬起时的基准矩形 —— 邻居正在过渡中也不改答案', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    expect(choreo.track(185)).toBe(2)

    // 邻居 b / c 各往左「让」了 60px(过渡跑到一半)—— 活矩形因此全变了。
    const [, b, c] = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    b.getBoundingClientRect = () =>
      ({ left: 60, top: 0, width: 120, height: 34, right: 180, bottom: 34 }) as DOMRect
    c.getBoundingClientRect = () =>
      ({ left: 180, top: 0, width: 120, height: 34, right: 300, bottom: 34 }) as DOMRect

    // 同一个 x,答案一个字不变。读活矩形的话 b / c 的中心成了 120 / 240,
    // 185 那一帧的右缘 245 把两个都越过了 → 会答 3。
    expect(choreo.track(185)).toBe(2)
    // 120 那一帧右缘恰好 180:读基准是「还没越过 b」答 0,读活矩形(b 中心 120)
    // 就成了「已经越过」答 2。
    expect(choreo.track(120)).toBe(0)
  })

  /**
   * **两端对称,且靠判据本身而不是特例**(W6-b 二修):把中间那一格往两头各拖到底,
   * 首位与末位都到得了,而中间那一段照旧原地不动。
   */
  it('两端都到得了:中间那一格拖到最左 = 第一位,拖到最右 = 末位', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    // 抓 b(中间那一格)的中心 = 180。
    choreo.lift('b', 180)
    expect(choreo.track(-100)).toBe(0)
    expect(choreo.track(999)).toBe(3)
    // 原地:左缘 120 还在 a 的中心(60)右侧、右缘 240 还没到 c 的中心(300)。
    expect(choreo.track(180)).toBe(1)
  })

  /**
   * **`hover()`:「放到标签上」那一形答的是「指针 x 底下是哪一格」**(W6-b 二修,
   * §4.2 的 onto 带)。按标签**整宽**判,不是 `TAB_MIDDLE` 44% 的正中 —— 那一形手
   * 已经压到条的下面,再要求它对准 44% 是让人在空中描准头。44% 那一档留给
   * `workbench/drop.ts` 的 `tabMiddleAt`(外来来源落到标签上)。
   */
  it('hover 按整宽答「指针底下是谁」,自己与条外的空白都答 null', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    // b 占 [120,240):左缘、正中、右缘边上都算数(44% 那一档在这里不适用)。
    expect(choreo.hover(121)).toBe('b')
    expect(choreo.hover(180)).toBe('b')
    expect(choreo.hover(239)).toBe('b')
    expect(choreo.hover(250)).toBe('c')
    // 抬起那一格自己不算数(拖回自己身上不是一次并,§2.3 不变量 3)。
    expect(choreo.hover(60)).toBeNull()
    // 末格之后的空白:松手什么都不该发生。
    expect(choreo.hover(400)).toBeNull()
  })

  /**
   * **onto 态里邻居的让位全部清零,而被拖那格照旧跟手**(§4.2「邻居不再让位」)。
   * 这一条是「压下去之后条上还在让位」那个长相的守门人。
   */
  it('hover:邻居让位清零,被拖那一格照旧夹在两端之内跟手', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    choreo.lift('a', 60)
    choreo.track(310)
    const [a, b, c] = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    expect(b.style.transform).toBe('translateX(-120px)')

    choreo.hover(310)
    expect(b.style.transform).toBe('')
    expect(c.style.transform).toBe('')
    expect(b.dataset.shift).toBeUndefined()
    expect(c.dataset.shift).toBeUndefined()
    // 跟手照旧夹紧:left = clamp(310 - 60, 0, 360 - 120) = 240。
    expect(a.style.transform).toBe('translateX(240px)')
    expect(a.dataset.lift).toBe('')
  })

  /** 没抬起过就没有基准矩形 —— 两只都答 null,而不是拿零矩形算一个假答案。 */
  it('没 lift 过时 track / hover 都答 null', () => {
    const { container } = renderTabs('joined')
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!
    stubLayout(list)
    const choreo = tabStripChoreo(list)
    expect(choreo.track(180)).toBeNull()
    expect(choreo.hover(180)).toBeNull()
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
