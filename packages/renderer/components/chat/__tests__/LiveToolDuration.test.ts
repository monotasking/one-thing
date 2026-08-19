// @vitest-environment happy-dom
/**
 * `LiveToolDuration` —— 正在跑的工具行上那个自己走秒的数字。
 *
 * 它存在的理由是**隔离时钟**:走秒发生在这片叶子里,StepsPanel 的 activity /
 * group / timeline 那几个 computed 不会因为时间过去而重算。所以这里测的是
 * 「它自己会走」和「没有起点就一个字都不吐」,不是格式化本身(那是
 * format-duration 的测试)。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LiveToolDuration from '../LiveToolDuration.vue'

const NOW = 1_700_000_000_000

/**
 * 时钟是**模块级共享**的(useDurationTicker 按引用计数起停),订阅者归零时才
 * 重新对表 —— 所以每条用例结束必须把挂载的都卸掉,否则上一条推进的时间会漏到
 * 下一条里。
 */
const mounted: ReturnType<typeof mount>[] = []

function mountDuration(props: { startTime?: number; separator?: string } = {}) {
  const wrapper = mount(LiveToolDuration, { props })
  mounted.push(wrapper)
  return wrapper
}

/** 推进假时钟(组件里的 ticker 是 100ms 一跳)并刷到 DOM。 */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  vi.useRealTimers()
})

describe('LiveToolDuration', () => {
  it('从 startTime 起算,自己走秒', async () => {
    const w = mountDuration({ startTime: NOW })
    // 亚 100ms 也显示 0.1s —— 归零的计时器读起来像坏了。
    expect(w.text()).toBe('0.1s')

    await advance(1_500)
    expect(w.text()).toBe('1.5s')

    await advance(1_000)
    expect(w.text()).toBe('2.5s')
  })

  it('过一分钟切成 m/s 口径', async () => {
    const w = mountDuration({ startTime: NOW })
    await advance(65_400)
    expect(w.text()).toBe('1m05.4s')
  })

  it('startTime 缺失时整个元素都不在场', async () => {
    const w = mountDuration()
    expect(w.find('.live-tool-duration').exists()).toBe(false)
    expect(w.text()).toBe('')

    // 时钟照走也依然什么都不画。
    await advance(3_000)
    expect(w.find('.live-tool-duration').exists()).toBe(false)
  })

  it('startTime 为 0 视作没有起点(不是 1970 年开始跑的工具)', () => {
    const w = mountDuration({ startTime: 0 })
    expect(w.find('.live-tool-duration').exists()).toBe(false)
  })

  it('separator 画在数字前面,默认没有', async () => {
    const bare = mountDuration({ startTime: NOW })
    const withSep = mountDuration({ startTime: NOW, separator: ' · ' })
    await advance(1_000)

    expect(bare.text()).toBe('1.0s')
    expect(withSep.text()).toBe('· 1.0s')
    expect(withSep.find('.live-tool-duration').element.textContent).toBe(' · 1.0s')
  })

  it('startTime 换成更晚的起点后,读数跟着回落', async () => {
    const w = mountDuration({ startTime: NOW })
    await advance(5_000)
    expect(w.text()).toBe('5.0s')

    await w.setProps({ startTime: NOW + 4_000 })
    expect(w.text()).toBe('1.0s')
  })

  it('卸载后不再有活着的定时器(共享时钟按引用计数收摊)', () => {
    mountDuration({ startTime: NOW })
    expect(vi.getTimerCount()).toBe(1)
    mounted.pop()?.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
