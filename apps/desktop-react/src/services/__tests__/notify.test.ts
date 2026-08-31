import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_FATE, notify } from '../notify'
import {
  NOTIFY_PERSIST_LIMIT,
  NOTIFY_RING_CAPACITY,
  unreadOf,
  useNotifyStore,
} from '../notify-store'
import { useToastHub } from '../../ui/Toast'
import { TOAST_LIFE_MS } from '../../components/motion'

/**
 * 三件事各测各的:
 *  · **命运表** —— 哪一档弹、弹多久、哪一档不弹。这是 notify 唯一的判断,
 *    所以它是唯一值得盯死的一格;
 *  · **存档** —— 无论弹不弹全都进中心。silent 那一条是这句话的检验点:
 *    它一个字都不弹,却必须在存档里;
 *  · **去重节流** —— 同 source 同 title 在窗口内合并成一条,且**不再弹一遍**。
 */
beforeEach(() => {
  useNotifyStore.setState({ items: [] })
  useToastHub.setState({ toasts: [], folded: 0 })
})

const items = () => useNotifyStore.getState().items
const toasts = () => useToastHub.getState().toasts

describe('命运表', () => {
  it('五档的弹与不弹、活多久,一张表说了算', () => {
    expect(NOTIFY_FATE).toEqual({
      success: { toast: true, lifeMs: TOAST_LIFE_MS.success },
      info: { toast: true, lifeMs: TOAST_LIFE_MS.info },
      warn: { toast: true, lifeMs: TOAST_LIFE_MS.warn },
      error: { toast: true, lifeMs: null },
      silent: { toast: false, lifeMs: null },
    })
  })

  it('四档弹起来,寿命按级别取;error 那条的 lifeMs 是 null(不自动消失)', () => {
    notify({ level: 'success', title: '成了', source: 'x' })
    notify({ level: 'info', title: '说一声', source: 'x' })
    notify({ level: 'warn', title: '注意', source: 'x' })
    notify({ level: 'error', title: '坏了', source: 'x' })
    // 同屏最多三条:最早那条被折走,所以这里看到的是后三条
    expect(toasts().map((x) => [x.level, x.lifeMs])).toEqual([
      ['info', TOAST_LIFE_MS.info],
      ['warn', TOAST_LIFE_MS.warn],
      ['error', null],
    ])
  })

  it('silent 一个字都不弹', () => {
    notify({ level: 'silent', title: '长帧 120ms', source: 'perf.longFrame' })
    expect(toasts()).toEqual([])
  })

  it('**无论弹不弹全部进存档** —— silent 也在里面', () => {
    notify({ level: 'silent', title: '长帧 120ms', source: 'perf.longFrame' })
    notify({ level: 'error', title: '坏了', source: 'crash.boundary' })
    expect(items().map((x) => x.level)).toEqual(['error', 'silent'])
  })

  it('存档的字段就是产地给的那些,加上未读与次数两件由中心自己说的事', () => {
    notify({
      level: 'warn',
      title: '没连上 core',
      body: 'ECONNREFUSED',
      source: 'platform.connection',
      detail: 'stack line 1\nstack line 2',
    })
    const [record] = items()
    expect(record).toMatchObject({
      level: 'warn',
      title: '没连上 core',
      body: 'ECONNREFUSED',
      source: 'platform.connection',
      detail: 'stack line 1\nstack line 2',
      read: false,
      count: 1,
    })
    expect(typeof record.id).toBe('string')
    expect(typeof record.time).toBe('number')
  })
})

describe('去重节流', () => {
  const storm = (n: number, at: (i: number) => number) => {
    for (let i = 0; i < n; i += 1) {
      useNotifyStore.getState().push(
        { level: 'error', title: '聊天区 出错了', source: 'crash.boundary', dedupeMs: 60_000 },
        at(i),
      )
    }
  }

  it('窗口内的同一条合并成一条,次数记在 count 上(不是丢掉)', () => {
    storm(30, (i) => 1_000 + i * 100)
    expect(items().length).toBe(1)
    expect(items()[0].count).toBe(30)
  })

  it('合并后时间跟到最新那一次,并重新翻回未读', () => {
    useNotifyStore.getState().push({ level: 'error', title: 'a', source: 's', dedupeMs: 60_000 }, 1_000)
    useNotifyStore.getState().markAllRead()
    useNotifyStore.getState().push({ level: 'error', title: 'a', source: 's', dedupeMs: 60_000 }, 5_000)
    expect(items()[0]).toMatchObject({ time: 5_000, read: false, count: 2 })
  })

  it('出了窗口就是新的一条 —— 合的是重复,不是「所有的同名错」', () => {
    useNotifyStore.getState().push({ level: 'error', title: 'a', source: 's', dedupeMs: 60_000 }, 1_000)
    useNotifyStore.getState().push({ level: 'error', title: 'a', source: 's', dedupeMs: 60_000 }, 1_000 + 60_001)
    expect(items().length).toBe(2)
  })

  it('产地不同 / 标题不同都不合 —— 两块面板同时炸掉仍然是两条', () => {
    const at = 1_000
    useNotifyStore.getState().push({ level: 'error', title: '聊天区 出错了', source: 'crash.boundary', dedupeMs: 60_000 }, at)
    useNotifyStore.getState().push({ level: 'error', title: '检索 出错了', source: 'crash.boundary', dedupeMs: 60_000 }, at)
    useNotifyStore.getState().push({ level: 'error', title: '聊天区 出错了', source: 'crash.window.onerror', dedupeMs: 60_000 }, at)
    expect(items().length).toBe(3)
  })

  it('不给窗口就不去重 —— 静默合并要有人显式要它', () => {
    useNotifyStore.getState().push({ level: 'info', title: 'a', source: 's' }, 1_000)
    useNotifyStore.getState().push({ level: 'info', title: 'a', source: 's' }, 1_000)
    expect(items().length).toBe(2)
  })

  it('被合并的那次**不再弹一遍**(挡住的正是刷屏),但存档照样跟上', () => {
    const first = notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    const again = notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    expect(again).toBe(first)
    expect(toasts().length).toBe(1)
    expect(items().length).toBe(1)
    expect(items()[0].count).toBe(2)
  })
})

describe('未读与清空', () => {
  it('未读数是派生的:进来即未读,markAllRead 一把清干净', () => {
    notify({ level: 'info', title: 'a', source: 's' })
    notify({ level: 'info', title: 'b', source: 's' })
    expect(unreadOf(items())).toBe(2)

    useNotifyStore.getState().markAllRead()
    expect(unreadOf(items())).toBe(0)
    expect(items().length).toBe(2)
  })

  it('act 与 markAllRead 是同一件事(名字不同只是调用点的理由不同)', () => {
    notify({ level: 'info', title: 'a', source: 's' })
    useNotifyStore.getState().act()
    expect(unreadOf(items())).toBe(0)
  })

  it('全读过了就原样返回旧 state —— 「面板可见即已读」那个副作用才不会自激', () => {
    notify({ level: 'info', title: 'a', source: 's' })
    useNotifyStore.getState().markAllRead()
    const settled = useNotifyStore.getState().items
    useNotifyStore.getState().markAllRead()
    expect(useNotifyStore.getState().items).toBe(settled)
  })

  it('clear 把存档倒空;空了再 clear 不产生新状态', () => {
    notify({ level: 'info', title: 'a', source: 's' })
    useNotifyStore.getState().clear()
    expect(items()).toEqual([])
    const empty = useNotifyStore.getState().items
    useNotifyStore.getState().clear()
    expect(useNotifyStore.getState().items).toBe(empty)
  })
})

describe('环形上限', () => {
  it('满 200 条之后最旧的挤出去,最新的永远在队首', () => {
    for (let i = 0; i < NOTIFY_RING_CAPACITY + 20; i += 1) {
      notify({ level: 'silent', title: `#${i}`, source: 's' })
    }
    expect(items().length).toBe(NOTIFY_RING_CAPACITY)
    expect(items()[0].title).toBe(`#${NOTIFY_RING_CAPACITY + 19}`)
    expect(items()[NOTIFY_RING_CAPACITY - 1].title).toBe(`#${20}`)
  })

  it('落盘只留最近 100 条(裁量记档),写盘炸了也不许连累通知本身', () => {
    expect(NOTIFY_PERSIST_LIMIT).toBeLessThan(NOTIFY_RING_CAPACITY)
    // 钉在 Storage.prototype 上而不是 localStorage 实例上:jsdom 的 Storage 是个
    // Proxy,往实例上装 own property 装不进去(实测 spy 一次都不被调到),
    // 而方法本来就住在原型上。
    const boom = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => notify({ level: 'info', title: 'a', source: 's' })).not.toThrow()
    expect(boom).toHaveBeenCalled()
    expect(items().length).toBe(1)
    boom.mockRestore()
  })
})

describe('serializeNotifications:整份存档 → 可粘贴纯文本', () => {
  it('首行带级别/时间/合并次数/source/标题,body 与多行 detail 逐行缩进', async () => {
    const { serializeNotifications } = await import('../notify-store')
    const text = serializeNotifications([
      {
        id: '1', time: new Date(2026, 7, 31, 14, 21, 7).getTime(), level: 'error',
        title: '出错了', body: '一行补充', source: 'chat.copy', detail: '第一行\n第二行',
        read: false, count: 3,
      },
      { id: '2', time: new Date(2026, 7, 31, 9, 0, 0).getTime(), level: 'info', title: '一条', source: 'x', read: true, count: 1 },
    ])
    expect(text).toBe(
      '[error] 2026-08-31 14:21:07 \u00d73 \u00b7 chat.copy \u2014 出错了\n  一行补充\n  第一行\n  第二行\n\n[info] 2026-08-31 09:00:00 \u00b7 x \u2014 一条',
    )
  })
})

/**
 * 详情那道门与风暴计数(09-01 崩溃弹框整改)。
 *
 * 两件事的判据都在这一层,而不在产地:**弹框上铺不铺开那一段** 是通知的事,
 * 崩溃捕获只负责把 detail 交出来。
 */
describe('详情那道门与合并计数', () => {
  it('有 detail 才画「查看详情」—— 没详情的那条不画一道点过去无话可说的门', () => {
    notify({ level: 'error', title: '有栈', source: 's', detail: 'at foo\nat bar' })
    notify({ level: 'error', title: '没栈', source: 's' })
    const [withDetail, without] = toasts()
    expect(withDetail.action).toBeTruthy()
    expect(without.action).toBeUndefined()
  })

  it('同一条又响了:屏上那条改成「×N」,不再弹第二个框', () => {
    notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    expect(toasts()[0].note).toBeUndefined()

    notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    expect(toasts().length).toBe(1)
    expect(toasts()[0].note).toBe('×3')
    expect(items()[0].count).toBe(3)
  })

  it('屏上那条已经走了,合并就只进存档 —— 不为一次合并复活一个框', () => {
    notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    useToastHub.getState().dismiss(toasts()[0].id)
    notify({ level: 'error', title: 'boom', source: 'crash.boundary', dedupeMs: 60_000 })
    expect(toasts()).toEqual([])
    expect(items()[0].count).toBe(2)
  })
})

/**
 * 未读数与命运表同口径(09-01 审计 A2)。
 *
 * 铃铛上那颗点和 toast 是同一件事的两种强度:一档说了「不打扰」,就不许从
 * 另一个口打扰回来。判例:全新 store 零操作开机,几条 perf 读数(silent)
 * 进环即把铃铛点亮。
 */
describe('未读数不数 silent', () => {
  it('silent 进存档但不进未读 —— 「不打扰,但记下」两半都要兑现', () => {
    notify({ level: 'silent', title: 'keypress took 80ms', source: 'perf.interaction' })
    notify({ level: 'silent', title: 'Long frame 218ms', source: 'perf.longFrame' })
    expect(items().length).toBe(2)
    expect(unreadOf(items())).toBe(0)
  })

  it('会打扰的那四档照数不误 —— 不数 silent 不是「不数」', () => {
    notify({ level: 'error', title: '坏了', source: 's' })
    notify({ level: 'silent', title: '长帧', source: 'perf.longFrame' })
    notify({ level: 'info', title: '说一声', source: 's' })
    expect(unreadOf(items())).toBe(2)
  })
})
