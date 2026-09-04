import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { NotificationsPanel, dayBucket, groupByDay } from '../NotificationsPanel'
import { PanelVisibilityContext } from '../visibility'
import { useNotifyStore, unreadOf } from '../../services/notify-store'
import type { NotifyRecord } from '../../services/notify-store'
import { useStageStore } from '../../stage/store'

/**
 * 面板的四件事各测各的:过滤 / 分组 / 点开详情 / 到场即已读。
 *
 * 分组的两个纯函数单独测:它们与 React 无关,而「凌晨一点看昨晚十一点那条」
 * 这类边界靠渲染断言是量不准的。
 */

const DAY = 24 * 60 * 60 * 1000

function seed(records: Array<Partial<NotifyRecord> & { title: string }>): void {
  useNotifyStore.setState({
    items: records.map((x, i) => ({
      id: `r${i}`,
      time: Date.now(),
      level: 'info' as const,
      source: 'test',
      read: false,
      count: 1,
      ...x,
    })),
  })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useNotifyStore.setState({ items: [] })
})

/** 面板在**看不见 / 不算数**的那一份里挂着时不该清未读,所以默认渲染成「算数的那一份」。 */
const mount = (visibility = { visible: true, interactive: true }) =>
  render(
    <PanelVisibilityContext.Provider value={visibility}>
      <NotificationsPanel />
    </PanelVisibilityContext.Provider>,
  )

describe('分组:按本地自然日切段', () => {
  const now = new Date(2026, 7, 30, 1, 0, 0).getTime() // 8/30 凌晨一点

  it('凌晨一点看昨晚十一点那条,它在「昨天」而不是「距今两小时」', () => {
    expect(dayBucket(new Date(2026, 7, 29, 23, 0, 0).getTime(), now)).toBe('yesterday')
    expect(dayBucket(new Date(2026, 7, 30, 0, 30, 0).getTime(), now)).toBe('today')
    expect(dayBucket(new Date(2026, 7, 28, 23, 0, 0).getTime(), now)).toBe('earlier')
  })

  it('连续切段,不排序也不去重 —— 组的次序就是记录的次序', () => {
    const items = [
      { time: now, title: 'a' },
      { time: now - 30 * 60 * 1000, title: 'b' },
      { time: now - DAY, title: 'c' },
      { time: now - 5 * DAY, title: 'd' },
    ].map((x, i) => ({ id: `${i}`, level: 'info' as const, source: 's', read: false, count: 1, ...x }))
    expect(groupByDay(items, now).map((g) => [g.bucket, g.items.length])).toEqual([
      ['today', 2],
      ['yesterday', 1],
      ['earlier', 1],
    ])
  })

  it('空组不产出 —— 一个没有行的组头是「这里本该有东西」的错觉', () => {
    expect(groupByDay([], now)).toEqual([])
  })
})

describe('面板', () => {
  it('空态一句灰字', () => {
    mount()
    expect(screen.getByText('还没有通知')).toBeTruthy()
  })

  it('级别过滤是减法:全部 / 警告 / 错误', () => {
    seed([
      { title: '成了', level: 'success' },
      { title: '注意', level: 'warn' },
      { title: '坏了', level: 'error' },
      { title: '长帧', level: 'silent' },
    ])
    mount()
    expect(screen.getAllByRole('button', { expanded: undefined }).length).toBeGreaterThan(0)
    expect(screen.getByText('成了')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '警告' }))
    expect(screen.queryByText('成了')).toBe(null)
    expect(screen.getByText('注意')).toBeTruthy()
    expect(screen.queryByText('坏了')).toBe(null)

    fireEvent.click(screen.getByRole('radio', { name: '错误' }))
    expect(screen.getByText('坏了')).toBeTruthy()
    expect(screen.queryByText('注意')).toBe(null)

    fireEvent.click(screen.getByRole('radio', { name: '全部' }))
    expect(screen.getByText('长帧')).toBeTruthy()
  })

  it('行按天分组,组头出现在行之前', () => {
    const now = Date.now()
    seed([
      { title: '今天这条', time: now },
      { title: '昨天那条', time: now - DAY },
    ])
    mount()
    // 组头查 heading 而不是查文字:行尾那个相对时间也会写「昨天」,
    // 按文字找会同时命中两处 —— 层级由 <h3> 给,正好拿它当判据。
    expect(screen.getByRole('heading', { name: '今天' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '昨天' })).toBeTruthy()
  })

  it('点行在**行下方**展开 detail,再点收起;没有 detail 的行不声称自己能展开', () => {
    seed([
      { title: '坏了', level: 'error', detail: 'TypeError: x\n  at y' },
      { title: '成了', level: 'success' },
    ])
    mount()
    expect(screen.queryByText(/TypeError/)).toBe(null)

    const row = screen.getByRole('button', { name: /坏了/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(screen.getByText(/TypeError/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /坏了/ }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /坏了/ }))
    expect(screen.queryByText(/TypeError/)).toBe(null)

    // 没有详情的那行不该谎称能展开
    expect(screen.getByRole('button', { name: /成了/ }).getAttribute('aria-expanded')).toBe(null)
  })

  it('产地与相对时间同行显示', () => {
    seed([{ title: '长帧 120ms', source: 'perf.longFrame', level: 'silent' }])
    mount()
    expect(screen.getByText('perf.longFrame')).toBeTruthy()
  })

  it('合并过的行把次数写在标题旁(不是行尾一枚计数徽)', () => {
    seed([{ title: '聊天区 出错了', level: 'error', count: 7 }])
    mount()
    expect(screen.getByText('×7')).toBeTruthy()
  })
})

describe('已读', () => {
  it('面板到场即清未读', () => {
    seed([{ title: 'a' }, { title: 'b' }])
    expect(unreadOf(useNotifyStore.getState().items)).toBe(2)
    mount()
    expect(unreadOf(useNotifyStore.getState().items)).toBe(0)
  })

  it('Dock 预览泡里那一份(看得见但不算数)**不清**未读 —— 悬停一眼不该动状态', () => {
    seed([{ title: 'a' }])
    mount({ visible: true, interactive: false })
    expect(unreadOf(useNotifyStore.getState().items)).toBe(1)
  })

  it('面板开着时新来的通知同样当场算已读(而不是自激成死循环)', () => {
    mount()
    act(() => void useNotifyStore.getState().push({ level: 'info', title: '新来的', source: 's' }))
    expect(unreadOf(useNotifyStore.getState().items)).toBe(0)
  })

  it('「清空」把存档倒空;两枚钮在空存档时都是禁用的', () => {
    seed([{ title: 'a' }])
    mount()
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(useNotifyStore.getState().items).toEqual([])
    expect(screen.getByRole('button', { name: '清空' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '全部已读' }).hasAttribute('disabled')).toBe(true)
  })

  it('完整日志那道门今天是禁用的(诚实缺口,不是占位装饰)', () => {
    mount()
    const link = screen.getByRole('button', { name: /app\.jsonl/ })
    expect(link.hasAttribute('disabled')).toBe(true)
  })
})

/**
 * **一行 = 一个 memo 组件**(09-03,`probe-notify` 的读数)。
 *
 * 病历:行从前内联在 `groups.map` 里,于是 `items` 一动(每条 perf 读数都会进档)
 * 或 `openId` 一动(点开一行),200 行**全部**重渲。真机读数:点开一行的
 * 「处理器 + 同步 flush」头几次 40–51ms(用户报的 46–65ms 就是这个形),
 * 面板开着时连推 16 条超预算 longFrame 中位 22.7ms。
 *
 * 渲染次数怎么数:`ui/StatusDot` 每行恰好画一枚,拿它当计数探针 ——
 * 数「行画了几次」不必去猜 React 内部,只要数那一枚点被调了几次。
 */
vi.mock('../../ui/StatusDot', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ui/StatusDot')>()
  return {
    ...real,
    StatusDot: (props: Parameters<typeof real.StatusDot>[0]) => {
      dotRenders.n += 1
      return real.StatusDot(props)
    },
  }
})

const dotRenders = { n: 0 }

describe('行是 memo 的:点开一行只重渲翻面的那两行', () => {
  // 种成**已读**:面板到场会 `act()` 一次(那是它的本分),未读的话那一下会把
  // 每条记录都换一份新对象 —— 那是真该重渲的,不是这一条要抓的东西。
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ title: `第 ${i} 条`, detail: `细节 ${i}`, read: true }))

  it('200 条记录下点开一行,只有翻面的那一两行重画', () => {
    seed(bulk(200))
    mount()
    const rows = screen.getAllByTestId('notify-row')
    expect(rows).toHaveLength(200)

    dotRenders.n = 0
    fireEvent.click(rows[3])
    // 翻面的只有它自己(收起 → 展开)。此前 openId 是 null,所以没有第二行要收。
    expect(dotRenders.n).toBe(1)

    dotRenders.n = 0
    fireEvent.click(rows[7])
    // 这一下有两行翻面:第 3 行收起、第 7 行展开。
    expect(dotRenders.n).toBe(2)
  })

  it('连推 16 条(探针那一形):重画的只有新来的那几行,存量 200 行一次没动', () => {
    seed(bulk(200))
    mount()
    dotRenders.n = 0
    act(() => {
      for (let i = 0; i < 16; i += 1) {
        useNotifyStore.getState().push({ level: 'silent', title: `读数 ${i}`, source: 'perf' })
      }
    })
    /*
     * 16 条新行 × 最多两遍(到场 + 被标已读)= 32 是上界;存量那 200 行是零。
     * 真机上这一形的**墙钟**读数在 dev 构建里反而略高(200 条 memo fiber 在
     * `runWithFiberInDEV` 下各要走一趟),那是 dev 的插桩常数;**该抓的事实是
     * 重画次数**,它在这里是机器守得住的。
     */
    expect(dotRenders.n).toBeLessThanOrEqual(32)
  })

  it('新来一条:重画的只有新那一行(存档环是 COW,没变的那几条引用不变)', () => {
    seed(bulk(150))
    mount()
    dotRenders.n = 0
    act(() => {
      useNotifyStore.getState().push({ level: 'info', title: '新来的', source: 'test' })
    })
    expect(screen.getAllByTestId('notify-row')).toHaveLength(151)
    /*
     * 新那一行画两次是**如实的**:一次是它到场,一次是面板到场那条 effect 把它
     * 标成已读(记录换了新对象)。要抓的是「另外 150 行一次都没动」——
     * 没有 memo 的话这个数是 300 上下。
     */
    expect(dotRenders.n).toBeLessThanOrEqual(2)
  })
})
