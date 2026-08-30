import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PERF_HUD_KEY, PerfHud, perfHudEnabled, phaseLine, rowLabel, rowSummary } from './PerfHud'
import { __pushPerfForTests, __resetPerfForTests, type PerfEntry } from '../services/perf'
import { t } from '../i18n'
import { useStageStore } from '../stage/store'

/**
 * HUD 开关契约(08-30 二次拍板:缺省一律关)。曾短暂 dev 缺省开——那时探针没有
 * 别的出口;通知系统上线后超预算走 notify(silent) 进中心,HUD 回归显式打开的仪表。
 */
describe('perfHudEnabled', () => {
  afterEach(() => localStorage.removeItem(PERF_HUD_KEY))

  it('没表态:缺省关 —— 不再自动出面(超预算的去处是通知中心)', () => {
    localStorage.removeItem(PERF_HUD_KEY)
    expect(perfHudEnabled()).toBe(false)
  })

  it("'1':强制开", () => {
    localStorage.setItem(PERF_HUD_KEY, '1')
    expect(perfHudEnabled()).toBe(true)
  })

  it("'0'(历史显式关的值):同样是关", () => {
    localStorage.setItem(PERF_HUD_KEY, '0')
    expect(perfHudEnabled()).toBe(false)
  })
})

const longFrame: PerfEntry = {
  ts: 1,
  kind: 'longFrame',
  ms: 128,
  name: 'frame',
  blockingMs: 78,
  renderMs: 40,
  styleAndLayoutMs: 22,
  scripts: [
    { invoker: 'BUTTON#tab.onclick', ms: 57, fn: 'activate', at: 'EdgeShelf.tsx:4210' },
    { invoker: 'TimerHandler:setTimeout', ms: 31, at: 'App.tsx:88' },
  ],
}

describe('行的三句话', () => {
  // 句式钉在中文那一份上,所以先把 locale 固定住 —— 缺省 'system' 在 jsdom 里解到 en。
  beforeEach(() => useStageStore.setState({ locale: 'zh' }))

  it('三种 kind 各有各的句式,句式住在字典里', () => {
    expect(rowLabel(t, longFrame)).toBe('长帧 128ms')
    expect(rowLabel(t, { ts: 1, kind: 'span', ms: 12, name: 'assemble' })).toBe('assemble 12ms')
    expect(rowLabel(t, { ts: 1, kind: 'interaction', ms: 96, name: 'click' })).toBe(
      'click 延迟 96ms',
    )
  })

  it('折叠态只给最重的一段 + 还有几段 —— 全量留给展开', () => {
    expect(rowSummary(longFrame)).toBe('BUTTON#tab.onclick 57ms +1')
  })

  it('交互折叠态给的是目标元素(「点的是什么」比「什么事件」有用)', () => {
    expect(rowSummary({ ts: 1, kind: 'interaction', ms: 96, name: 'click', target: 'button#x' }))
      .toBe('button#x')
  })

  it('没有归因就不画那一行', () => {
    expect(rowSummary({ ts: 1, kind: 'span', ms: 12, name: 'assemble' })).toBeUndefined()
  })

  it('阶段拆分一行说完,缺席的不出现', () => {
    expect(phaseLine(longFrame)).toBe('blocking 78ms · render 40ms · style+layout 22ms')
    expect(phaseLine({ ts: 1, kind: 'span', ms: 12, name: 'x' })).toBeUndefined()
  })
})

describe('HUD 展开与聚合', () => {
  afterEach(() => __resetPerfForTests())

  it('点一行铺开完整脚本列表与源位置 —— 折叠态看不到的第二段在这里', () => {
    __resetPerfForTests()
    __pushPerfForTests(longFrame)
    render(<PerfHud />)
    expect(screen.queryByText('EdgeShelf.tsx:4210')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('perf.rowDetail') }))
    expect(screen.getByText('EdgeShelf.tsx:4210')).toBeTruthy()
    expect(screen.getByText('App.tsx:88')).toBeTruthy()
    expect(screen.getByText('blocking 78ms · render 40ms · style+layout 22ms')).toBeTruthy()
  })

  it('「聚合」把整个环按名字打成一张控制台表', () => {
    __resetPerfForTests()
    __pushPerfForTests({ ts: 1, kind: 'span', ms: 12, name: 'assemble' })
    const spy = vi.spyOn(console, 'table').mockImplementation(() => undefined)
    render(<PerfHud />)
    fireEvent.click(screen.getByTestId('perf-hud-report'))
    expect(spy).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'span', name: 'assemble', count: 1, max: 12 }),
    ])
    spy.mockRestore()
  })

  it('环空时给一句「暂无读数」,不给一张空表', () => {
    __resetPerfForTests()
    render(<PerfHud />)
    expect(screen.getByText(t('perf.empty'))).toBeTruthy()
  })
})
