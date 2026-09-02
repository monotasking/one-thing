import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDockLens } from '../useDockLens'
import type { DockLensInput } from '../useDockLens'

/**
 * `useDockLens` 的宿主半边 —— 纯几何那半边在 `dock-lens.test.ts`。
 *
 * 这里钉的是四件只有宿主才答得出的事:**写的次序**(先几何后开关)、**指针在不在
 * 条上**(含交叉轴那一维)、**收起时留不留几何**,以及**基准是不是每次现读**
 * (瓦数 / 分隔线 / 对齐档变了不需要任何作废机制)。
 *
 * 时间是自己造的:rAF 换成手推的,免得测试跟着真机帧率飘。
 */

/** 条的静止矩形:主轴 100→400,交叉轴 800→862(与 md 档条高 62 对得上)。 */
const STRIP_BOX = { left: 100, top: 800, right: 400, bottom: 862, width: 300, height: 62 }
/** 条内坐标的原点 = 边框前缘 + 边框宽 1。瓦壳的 offsetLeft 从内距前缘 10 起算。 */
const ORIGIN = STRIP_BOX.left + 1
const TILE = 44
const GAP = 9
const PAD = 10
/** 第 i 块瓦在**条内**坐标里的中心。 */
const localCenter = (i: number, sepAfter = -1) =>
  PAD + i * (TILE + GAP) + (sepAfter >= 0 && i > sepAfter ? 1 + GAP : 0) + TILE / 2
/** 同一块瓦在视口坐标里的中心 —— 指针要用这个。 */
const clientCenter = (i: number, sepAfter = -1) => ORIGIN + localCenter(i, sepAfter)

const INPUT: DockLensInput = { edge: 'bottom', align: 'center', enabled: true }

function harness(input: DockLensInput = INPUT) {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})

  const strip = document.createElement('div')
  strip.getBoundingClientRect = () =>
    ({ ...STRIP_BOX, x: STRIP_BOX.left, y: STRIP_BOX.top, toJSON: () => '' }) as DOMRect
  Object.defineProperty(strip, 'clientLeft', { value: 1, configurable: true })
  Object.defineProperty(strip, 'clientTop', { value: 1, configurable: true })

  const realComputed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    if (el !== strip) return realComputed(el)
    return {
      getPropertyValue: (name: string) =>
        name === '--dock-lens-max' ? '1.35' : name === '--dock-lens-reach' ? '2' : '',
    } as unknown as CSSStyleDeclaration
  })

  /** 摆 n 块瓦壳,offsetLeft/offsetWidth 是**布局值**(真机上 transform 改不动它们)。 */
  const layout = (count: number, sepAfter = -1) => {
    strip.replaceChildren()
    for (let i = 0; i < count; i += 1) {
      const wrap = document.createElement('div')
      wrap.setAttribute('data-dock-tile', '')
      Object.defineProperty(wrap, 'offsetLeft', {
        value: localCenter(i, sepAfter) - TILE / 2,
        configurable: true,
      })
      Object.defineProperty(wrap, 'offsetWidth', { value: TILE, configurable: true })
      Object.defineProperty(wrap, 'offsetTop', { value: 0, configurable: true })
      Object.defineProperty(wrap, 'offsetHeight', { value: TILE, configurable: true })
      strip.append(wrap)
    }
    // 分隔线是 <span> 且不带记号 —— 它不该进那张表。
    if (sepAfter >= 0) strip.append(document.createElement('span'))
  }
  layout(5)

  const view = renderHook((props: DockLensInput) => useDockLens(props), { initialProps: input })
  act(() => {
    view.result.current.stripRef.current = strip
  })

  const run = () => {
    const pending = frames.splice(0, frames.length)
    act(() => pending.forEach((cb) => cb(0)))
    return pending.length
  }
  const move = (main: number, cross = 830) =>
    act(() =>
      view.result.current.onMouseMove({
        clientX: main,
        clientY: cross,
      } as unknown as React.MouseEvent<HTMLDivElement>),
    )
  const leave = () => act(() => view.result.current.onMouseLeave())
  const tiles = () => [...strip.querySelectorAll<HTMLElement>('[data-dock-tile]')]
  const scales = () => tiles().map((t) => Number(t.style.getPropertyValue('--tile-scale')))
  const dxs = () => tiles().map((t) => Number(t.style.getPropertyValue('--tile-dx-x')))
  const on = () => strip.getAttribute('data-lens')

  return { view, run, move, leave, layout, tiles, scales, dxs, on, strip, frames }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useDockLens:指针在不在条上', () => {
  it('主轴压着一块瓦、交叉轴也在条里 —— 那块顶格,镜头开着', () => {
    const h = harness()
    h.move(clientCenter(0))
    h.run()
    expect(h.on()).toBe('on')
    expect(Math.max(...h.scales())).toBeCloseTo(1.35, 6)
    expect(h.scales().indexOf(Math.max(...h.scales()))).toBe(0)
  })

  it('交叉轴出了条(悬在放大后长出条外的那一截上)= 不在条上,镜头收着', () => {
    const h = harness()
    // 条的交叉轴是 800→862;790 在条上方 —— 正是瓦长出去那一截所在的位置。
    // 事件仍会从那一截冒泡到条上,所以只判主轴的话这里会照样放大。
    h.move(clientCenter(0), 790)
    h.run()
    expect(h.on()).toBe(null)
  })

  it('手离开:只摘开关,**几何留着最后一帧** —— 于是它原地缩回去,不会先跳一下', () => {
    const h = harness()
    h.move(clientCenter(2))
    h.run()
    const held = h.scales()
    h.leave()
    h.run()
    expect(h.on()).toBe(null)
    expect(h.scales()).toEqual(held)
  })
})

describe('useDockLens:写的次序与合帧', () => {
  it('几何先落地、开关后挂 —— 反过来第一帧会拿旧几何满格画一下', () => {
    const h = harness()
    const order: string[] = []
    const tile = h.tiles()[0]
    const realTileSet = tile.style.setProperty.bind(tile.style)
    vi.spyOn(tile.style, 'setProperty').mockImplementation((name: string, value: string | null) => {
      order.push(`geometry:${name}`)
      realTileSet(name, value)
    })
    vi.spyOn(h.strip, 'setAttribute').mockImplementation((name: string) => {
      order.push(`switch:${name}`)
    })
    h.move(clientCenter(1))
    h.run()
    expect(order.filter((s) => s.startsWith('geometry')).length).toBeGreaterThan(0)
    expect(order[order.length - 1]).toBe('switch:data-lens')
  })

  it('一帧之内来几发 pointermove 只算最后那一发(合帧,不是插值)', () => {
    const h = harness()
    h.move(clientCenter(0))
    h.move(clientCenter(1))
    h.move(clientCenter(2))
    expect(h.frames.length).toBe(1)
    h.run()
    // 画出来的就是最后那一发对应的几何,不是三发的平均,也不是第一发的。
    expect(h.scales().indexOf(Math.max(...h.scales()))).toBe(2)
    expect(Math.max(...h.scales())).toBeCloseTo(1.35, 6)
  })

  it('手停着就不该再有一帧 —— 算完那一发之后没有人再排 rAF', () => {
    const h = harness()
    h.move(clientCenter(2))
    h.run()
    expect(h.frames.length).toBe(0)
    const settled = h.scales()
    h.run()
    expect(h.scales()).toEqual(settled)
  })
})

describe('useDockLens:基准每次现读,没有作废机制', () => {
  it('瓦数变了当场算数 —— 没有「锚点」可以过期', () => {
    const h = harness()
    h.move(clientCenter(0))
    h.run()
    expect(h.scales()).toHaveLength(5)
    act(() => {
      h.layout(8)
      h.view.rerender(INPUT)
    })
    h.move(clientCenter(6))
    h.run()
    expect(h.scales()).toHaveLength(8)
    expect(h.scales().indexOf(Math.max(...h.scales()))).toBe(6)
    expect(Math.max(...h.scales())).toBeCloseTo(1.35, 6)
  })

  it('分隔线插进来:它右边的每一块都被推开,而分隔线自己不占格', () => {
    const h = harness()
    act(() => {
      h.layout(5, 1)
      h.view.rerender(INPUT)
    })
    // 分隔线那个 <span> 不带记号,取到的仍是 5 块。
    expect(h.tiles()).toHaveLength(5)
    h.move(clientCenter(2, 1))
    h.run()
    expect(h.scales().indexOf(Math.max(...h.scales()))).toBe(2)
    expect(Math.max(...h.scales())).toBeCloseTo(1.35, 6)
    // 反证:没算分隔线那 10px 的旧中心已经不是顶格了。
    h.move(clientCenter(2))
    h.run()
    expect(Math.max(...h.scales())).toBeLessThan(1.35)
  })

  it('半径按**瓦距的整数倍**算,不是一个绝对像素数', () => {
    const h = harness()
    /*
     * 瓦距 53、`--dock-lens-reach: 2` ⇒ 半径 106px。上一版写死 96px(= 1.81 倍瓦距),
     * 那个数不满足 COLA、条会呼吸(理由在 dock-lens.ts 文件头)。100px 这一点正好
     * 卡在两者之间:半径 106 时它还在钟形里,半径 96 时它已经出界 —— 所以这一条
     * 换回绝对像素当场就红。
     */
    h.move(clientCenter(2) - 100)
    h.run()
    expect(h.scales()[2]).toBeGreaterThan(1)
    // 正好落在半径上时钟形接 0:余弦核在边缘是平滑接 0,不是折角。
    h.move(clientCenter(2) - 106)
    h.run()
    expect(h.scales()[2]).toBe(1)
  })

  it('分隔线不进那张表:一个自定义属性都不许写在它身上', () => {
    const h = harness()
    act(() => {
      h.layout(5, 1)
      h.view.rerender(INPUT)
    })
    h.move(clientCenter(2, 1))
    h.run()
    const sep = h.strip.querySelector('span')
    // 写在分隔线上等于把它当成一块瓦,后面每一块的下标都会错一格。
    expect(sep?.getAttribute('style')).toBe(null)
  })

  it('对齐档换了,位移整体平移一个常数(退让是 CSS 定位的后果,不是这里的选择)', () => {
    const h = harness()
    h.move(clientCenter(2))
    h.run()
    const centered = h.dxs()
    act(() => h.view.rerender({ ...INPUT, align: 'start' }))
    h.move(clientCenter(2))
    h.run()
    const started = h.dxs()
    const delta = started.map((v, i) => v - centered[i])
    expect(Math.max(...delta) - Math.min(...delta)).toBeLessThan(1e-6)
    expect(delta[0]).toBeGreaterThan(0)
    expect(Math.min(...started)).toBeGreaterThanOrEqual(-1e-9)
  })

  it('条空着(还没画出瓦)时不炸,也不开镜头', () => {
    const h = harness()
    act(() => {
      h.layout(0)
      h.view.rerender(INPUT)
    })
    h.move(clientCenter(0))
    h.run()
    expect(h.on()).toBe(null)
  })
})

describe('useDockLens:配置态', () => {
  it('设置里关掉放大 = 这条链不跑:一格几何都不写,开关也不挂', () => {
    const h = harness({ ...INPUT, enabled: false })
    h.move(clientCenter(2))
    h.run()
    expect(h.on()).toBe(null)
    expect(h.tiles()[2].style.getPropertyValue('--tile-scale')).toBe('')
    expect(h.tiles()[2].style.getPropertyValue('--tile-dx-x')).toBe('')
  })

  it('手压在条上时当场关掉:开关当帧摘掉,几何留在最后一帧原地缩回', () => {
    const h = harness()
    h.move(clientCenter(2))
    h.run()
    expect(h.on()).toBe('on')
    const held = h.scales()
    act(() => h.view.rerender({ ...INPUT, enabled: false }))
    h.run()
    expect(h.on()).toBe(null)
    expect(h.scales()).toEqual(held)
  })

  it('再打开:下一发 pointermove 就照算', () => {
    const h = harness({ ...INPUT, enabled: false })
    h.move(clientCenter(2))
    h.run()
    act(() => h.view.rerender(INPUT))
    h.move(clientCenter(2))
    h.run()
    expect(h.on()).toBe('on')
    expect(Math.max(...h.scales())).toBeCloseTo(1.35, 6)
  })
})

describe('useDockLens:轴向', () => {
  it('停竖边时量另一条轴 —— 交叉轴判据也跟着转身', () => {
    const h = harness({ edge: 'left', align: 'center', enabled: true })
    // 竖排:主轴是 y(clientY),交叉轴是 x(clientX,条 100→400)。
    // offsetTop 在夹具里全是 0,所以主轴上各瓦中心重合;这里钉的是
    // 「交叉轴出界即不在条上」这一维,以及位移落到哪一格自定义属性。
    h.move(500, 830) // clientX=500 出了条的左右范围
    h.run()
    expect(h.on()).toBe(null)
    h.move(250, 830) // clientX=250 在条里,clientY=830 是主轴
    h.run()
    expect(h.on()).toBe('on')
    // 位移落在 y 那一格,x 那一格一个字都不写。
    expect(h.tiles()[0].style.getPropertyValue('--tile-dx-y')).not.toBe('')
    expect(h.tiles()[0].style.getPropertyValue('--tile-dx-x')).toBe('')
  })
})
