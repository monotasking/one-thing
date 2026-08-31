import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStageStore } from '../../../stage/store'
import { ModelCatalog } from '../ModelCatalog'
import { createQuery } from '../../../data/kernel'
import { GROUP_MIN_ROWS, SEARCH_ROW_CAP } from '../../projection'
import type { CatalogRow } from '../../types'

/**
 * ── K1 第四轴:**状态完备性** ────────────────────────────────────────────
 * 这一组守的是「一次刷新从头到尾,屏幕上都发生了什么」——不是某一格画对没有,
 * 而是**四个读数各管一处、互不冒充**:
 *   phase 首载 / 在飞(只喂刷新钮)/ error 并陈 / updatedAt·dataRev 收尾。
 * 每条断言配一个反证(把那条性质拆掉必红),形式是同一段剧情换一份 props 再跑。
 *
 * ── 超量形 ───────────────────────────────────────────────────────────────
 * 1000 型的后果分两半:**削量**(已选置顶 + 前缀分组默认收起 + 检索截断,判据在
 * `groupCatalog` 里)与**回顶**(滚过一屏才出现的那颗钮)。这里守的是它们
 * 在 DOM 上兑现了没有 —— 收起的组**一行都不许渲染**。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id,
    name: id,
    selected: false,
    current: false,
    contextLength: 200_000,
    maxOutput: 32_768,
    caps: [],
    price: { input: 3, output: 15 },
    manual: false,
    ...over,
  }
}

/** 一份「一千型」的假目录:25 个厂牌 × 40 型。 */
function bigCatalog(vendors = 25, per = 40): CatalogRow[] {
  const rows: CatalogRow[] = []
  for (let v = 0; v < vendors; v += 1) {
    for (let i = 0; i < per; i += 1) rows.push(row(`vendor${v}/model-${i}`))
  }
  return rows
}

const IDLE_QUERY = createQuery<never>('t.idle', () => new Promise(() => undefined))

function catalog(props: Partial<Parameters<typeof ModelCatalog>[0]> = {}) {
  return (
    <ModelCatalog
      providerId="openrouter"
      rows={[row('a')]}
      phase="ready"
      dataRev={1}
      refresh={IDLE_QUERY}
      kind="api"
      query=""
      saving={false}
      onQuery={vi.fn()}
      onRefresh={vi.fn()}
      onToggle={vi.fn()}
      onSetCurrent={vi.fn()}
      onAddManual={vi.fn()}
      onRemoveManual={vi.fn()}
      {...props}
    />
  )
}

describe('状态戏份 · 重拉不清屏(律②)', () => {
  it('phase 已 ready(此刻还有一发在飞):旧行仍在 DOM,没有骨架/空态那句话', () => {
    // 「在飞」在这块组件里**没有 prop** —— 它只被刷新钮读(AsyncButton 直接吃
    // query),所以这条断言证的正是:重拉这件事对表格一个字都改不了。
    render(catalog({ rows: [row('a'), row('b')] }))
    expect(screen.getByTestId('model-row-a')).toBeTruthy()
    expect(screen.getByTestId('model-row-b')).toBeTruthy()
    expect(screen.queryByText('正在拉目录…')).toBeNull()
  })

  it('反证:同一发在飞,但 phase 还是 initial(真·首载)—— 那时才画那句话', () => {
    render(catalog({ phase: 'initial', rows: [], dataRev: 0 }))
    expect(screen.getByText('正在拉目录…')).toBeTruthy()
  })

  it('失败与旧行**并存**:错误行画出来了,行一条没少', () => {
    render(catalog({ rows: [row('a'), row('b')], error: '402 Insufficient Balance' }))
    expect(screen.getByText(/402 Insufficient Balance/)).toBeTruthy()
    expect(screen.getByTestId('model-row-a')).toBeTruthy()
    expect(screen.getByTestId('model-row-b')).toBeTruthy()
  })

  it('重拉不换行的身份:同一份 rows 再渲染一次,行元素还是原来那一个', () => {
    const rows = [row('a'), row('b')]
    const { rerender } = render(catalog({ rows }))
    const before = screen.getByTestId('model-row-a')
    rerender(catalog({ rows }))
    expect(screen.getByTestId('model-row-a')).toBe(before)
  })
})

describe('状态戏份 · 收尾的两种可感知', () => {
  it('时刻前进 → 时刻那一格播一次淡入;内容没变 → 行区不播', () => {
    const rows = [row('a')]
    const { rerender } = render(catalog({ rows, fetchedAt: 1000, dataRev: 1 }))
    const stampClass = screen.getByTestId('catalog-stamp').className
    const rowsClass = screen.getByTestId('catalog-rows').className

    rerender(catalog({ rows, fetchedAt: 2000, dataRev: 1 }))
    expect(screen.getByTestId('catalog-stamp').className).not.toBe(stampClass)
    // 内容一个字节没变:行区**不闪** —— 无中生有的动静比没有动静更糟。
    expect(screen.getByTestId('catalog-rows').className).toBe(rowsClass)
  })

  it('内容真的变了 → 行区播一次淡入,并在 animationend 之后收掉', () => {
    const { rerender } = render(catalog({ rows: [row('a')], fetchedAt: 1000, dataRev: 1 }))
    const before = screen.getByTestId('catalog-rows').className

    rerender(catalog({ rows: [row('a'), row('b')], fetchedAt: 2000, dataRev: 2 }))
    const during = screen.getByTestId('catalog-rows')
    expect(during.className).not.toBe(before)

    // 收尾不看计时器,看 animationend —— 于是动效档调到 0ms 时它立刻回来。
    act(() => {
      during.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(screen.getByTestId('catalog-rows').className).toBe(before)
  })

  it('挂载那一次不播:屏幕上本来就在长内容,再淡一次是噪音', () => {
    render(catalog({ rows: [row('a')], fetchedAt: 1000, dataRev: 1 }))
    const cls = screen.getByTestId('catalog-rows').className
    expect(cls.includes('settled')).toBe(false)
  })
})

describe('能力列 · 图标 + 悬停全名', () => {
  it('五种能力各画一枚图标,名字同时给读屏的人(aria-label)', () => {
    render(
      catalog({
        rows: [row('a', { caps: ['vision', 'tools', 'reasoning', 'imageOut', 'audioIn'] })],
      }),
    )
    for (const label of ['图像输入', '工具调用', '推理', '图像输出', '音频输入']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
  })

  it('反证:字母缩写已经退役 —— 表里再也找不到孤零零的一个 V', () => {
    render(catalog({ rows: [row('a', { caps: ['vision'] })] }))
    expect(screen.queryByText('V')).toBeNull()
  })

  it('一项能力都没有的行画破折号,不画五个灰图标(不知道 ≠ 都不支持)', () => {
    render(catalog({ rows: [row('a', { caps: [] })] }))
    expect(screen.queryByLabelText('图像输入')).toBeNull()
  })
})

describe('超量形 · 削量三层', () => {
  it('一千型:默认只渲染已选那几行 + 组头,收起的组一行 DOM 都不留', () => {
    const rows = bigCatalog()
    rows[0] = { ...rows[0], selected: true }
    rows[1] = { ...rows[1], selected: true }
    render(catalog({ rows }))

    const drawn = document.querySelectorAll('[data-testid^="model-row-"]')
    // 削量之后首屏的行数 = 已选那两条。1000 行只画 2 行,这就是「不平铺」。
    expect(drawn.length).toBe(2)
    expect(rows.length).toBeGreaterThan(GROUP_MIN_ROWS)
    // 组头一个不少:每个厂牌一条,人知道后面还有什么。
    expect(document.querySelectorAll('[data-testid^="model-group-"]').length).toBe(25)
  })

  it('展开一个组才渲染它那 40 行;别的组照旧不渲染', async () => {
    const rows = bigCatalog()
    render(catalog({ rows }))
    const toggle = screen.getByTestId('model-group-vendor0/')
    await act(async () => {
      toggle.click()
    })
    expect(document.querySelectorAll('[data-testid^="model-row-"]').length).toBe(40)
  })

  it('检索时截断并**如实说**剩下多少 —— 不默默少画几百行', () => {
    render(catalog({ rows: bigCatalog(), query: 'model' }))
    const drawn = document.querySelectorAll('[data-testid^="model-row-"]')
    expect(drawn.length).toBe(SEARCH_ROW_CAP)
    expect(screen.getByText(/还有 950 型没画/)).toBeTruthy()
  })

  it('反证:同一份 1000 行,若判据说「不分组」就是平铺 —— 那正是卡顿的产地', () => {
    // 不足 GROUP_MIN_ROWS 的目录本来就不分组;拿它当对照组,证明上面那 2 行
    // 不是因为组件画不出行,而是因为削量判据真的在起作用。
    const rows = Array.from({ length: GROUP_MIN_ROWS - 1 }, (_, i) => row(`v/m-${i}`))
    render(catalog({ rows }))
    expect(document.querySelectorAll('[data-testid^="model-row-"]').length).toBe(rows.length)
  })
})

describe('超量形 · 回顶', () => {
  /**
   * jsdom 没有 IntersectionObserver。装一个可手动喂的桩 —— 喂的是**带几何的**
   * entry,因为判据要问方向(哨兵在视口上面才算滚过去)。
   */
  type Entry = {
    isIntersecting: boolean
    boundingClientRect: { top: number }
    rootBounds: { top: number } | null
  }
  function stubObserver() {
    const callbacks: ((entries: Entry[]) => void)[] = []
    class Stub {
      constructor(cb: (entries: Entry[]) => void) {
        callbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', Stub)
    const feed = (entry: Entry) => act(() => callbacks.forEach((cb) => cb([entry])))
    return {
      /** 哨兵跑到视口**上面**去了 = 真的滚过头了。 */
      scrollPast: () =>
        feed({ isIntersecting: false, boundingClientRect: { top: -400 }, rootBounds: { top: 0 } }),
      /** 哨兵还在视口**下面** = 只是还没滚到(开面时的常态)。 */
      notYetReached: () =>
        feed({ isIntersecting: false, boundingClientRect: { top: 900 }, rootBounds: { top: 0 } }),
      backToTop: () =>
        feed({ isIntersecting: true, boundingClientRect: { top: 100 }, rootBounds: { top: 0 } }),
    }
  }

  it('反证:哨兵在视口**下方**(还没滚到)不算滚过头 —— 钮不出来', () => {
    const observer = stubObserver()
    render(catalog({ rows: bigCatalog() }))
    observer.notYetReached()
    expect(screen.queryByTestId('catalog-to-top')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('没滚过目录头时没有这颗钮;滚过去才出现,点它回到头', () => {
    const observer = stubObserver()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(catalog({ rows: bigCatalog() }))

    expect(screen.queryByTestId('catalog-to-top')).toBeNull()
    observer.scrollPast()
    const button = screen.getByTestId('catalog-to-top')

    act(() => {
      button.click()
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })

    // 回到头之后它自己走 —— 常驻一颗浮钮只是多一件要绕开的东西。
    observer.backToTop()
    expect(screen.queryByTestId('catalog-to-top')).toBeNull()
    vi.unstubAllGlobals()
  })
})
