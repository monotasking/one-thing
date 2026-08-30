import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useReadingStore, effectiveMotionTier, readingAxes } from '../store'
import { applyReadingAxes, startReadingAxes, stopReadingAxesForTest } from '../apply'
import {
  DEFAULT_READING_AXES,
  MOTION_TIERS,
  READING_COLUMNS,
  READING_DENSITIES,
  READING_FONT_SIZES,
  clampReadingAxes,
  motionTier,
} from '../types'

/**
 * 阅读轴的三条门:**档表 → 属性 → CSS 里真有那一档**、**存盘活得过重开**、
 * **动效档的「用户选过没有」那条判据**。
 *
 * 屏幕上到底排成什么样是真机门的事(jsdom 不排版)。这里证的是链路:
 * 存盘里那四个字符串会原样变成 documentElement 上的四个属性,而 tokens.css /
 * motion.css 里对着每一个档值都真的有一条规则 —— 少一条就是「选了没反应」。
 */

const stylesDir = path.resolve(__dirname, '../../styles')
const tokensCss = readFileSync(path.join(stylesDir, 'tokens.css'), 'utf-8')
const motionCss = readFileSync(path.join(stylesDir, 'motion.css'), 'utf-8')

/** 每个用例都从"没人调过"重新开始 —— store 是模块级单例,存盘是共享的。 */
beforeEach(() => {
  localStorage.clear()
  useReadingStore.setState({ ...DEFAULT_READING_AXES })
  stopReadingAxesForTest()
})

afterEach(() => {
  stopReadingAxesForTest()
  vi.restoreAllMocks()
})

describe('档表:每一个档值在 CSS 里都真有一条规则', () => {
  it.each(READING_FONT_SIZES)('字号档 %s', (value) => {
    expect(tokensCss).toContain(`:root[data-reading-fs='${value}']`)
  })

  it.each(READING_DENSITIES)('密度档 %s', (value) => {
    expect(tokensCss).toContain(`:root[data-reading-density='${value}']`)
  })

  it.each(READING_COLUMNS)('列宽档 %s', (value) => {
    expect(tokensCss).toContain(`:root[data-reading-col='${value}']`)
  })

  it('动效档:calm 与 none 各有一块;standard 刻意没有(它就是原值)', () => {
    expect(motionCss).toContain(":root[data-motion-tier='calm']")
    expect(motionCss).toContain(":root[data-motion-tier='none']")
    expect(MOTION_TIERS).toEqual(['standard', 'calm', 'none'])
  })

  it('密度档是**九个量一起**换的 —— 少写一个就会串档', () => {
    const names = [
      '--pr-lh',
      '--pr-gap',
      '--pr-h2-top',
      '--pr-h2-btm',
      '--pr-h3-top',
      '--pr-h3-btm',
      '--pr-li',
      '--pr-obj',
      '--pr-hr',
    ]
    for (const density of READING_DENSITIES) {
      const at = tokensCss.indexOf(`:root[data-reading-density='${density}']`)
      const block = tokensCss.slice(at, tokensCss.indexOf('}', at))
      for (const name of names) expect(block, `${density} 缺 ${name}`).toContain(`${name}:`)
    }
  })
})

describe('贴到 documentElement:存的那四个字符串原样变成四个属性', () => {
  it('默认档', () => {
    applyReadingAxes(DEFAULT_READING_AXES, false)
    const root = document.documentElement
    expect(root.getAttribute('data-reading-fs')).toBe('14')
    expect(root.getAttribute('data-reading-density')).toBe('comfortable')
    expect(root.getAttribute('data-reading-col')).toBe('standard')
    expect(root.getAttribute('data-motion-tier')).toBe('standard')
  })

  it('换档就换属性,一次一趟', () => {
    applyReadingAxes({ ...DEFAULT_READING_AXES, fontSize: '16', density: 'compact', column: 'full' }, false)
    const root = document.documentElement
    expect(root.getAttribute('data-reading-fs')).toBe('16')
    expect(root.getAttribute('data-reading-density')).toBe('compact')
    expect(root.getAttribute('data-reading-col')).toBe('full')
  })

  it('探针把生效档说出来(真机门读的就是它)', () => {
    const probe = applyReadingAxes({ ...DEFAULT_READING_AXES, motion: 'calm', motionChosen: true }, true)
    expect(probe.applied).toBe(true)
    expect(probe.motion).toBe('calm')
    expect(window.__reading?.motion).toBe('calm')
  })
})

describe('动效档:用户选过就听用户的,没选过就听系统的', () => {
  it('没选过 + 系统没要求 = 存着的那一档', () => {
    expect(motionTier({ ...DEFAULT_READING_AXES, motion: 'standard' }, false)).toBe('standard')
  })

  it('没选过 + 系统要求减弱 = 无', () => {
    expect(motionTier({ ...DEFAULT_READING_AXES, motion: 'standard' }, true)).toBe('none')
  })

  it('**选过**就压过系统 —— 明说要标准时,系统的减弱开关不再改写它', () => {
    expect(motionTier({ ...DEFAULT_READING_AXES, motion: 'standard', motionChosen: true }, true)).toBe(
      'standard',
    )
  })

  it('setMotion 同时记下「亲手选过」', () => {
    expect(useReadingStore.getState().motionChosen).toBe(false)
    useReadingStore.getState().setMotion('calm')
    expect(useReadingStore.getState().motionChosen).toBe(true)
    // 系统此刻要求减弱,但用户已经表过态 —— 面上仍该显示 calm。
    expect(effectiveMotionTier(useReadingStore.getState(), true)).toBe('calm')
  })
})

describe('存盘:活得过重开,读不懂的值退回默认', () => {
  it('改一档就落盘', () => {
    useReadingStore.getState().setFontSize('16')
    useReadingStore.getState().setColumn('wide')
    const raw = localStorage.getItem('onething.reading')
    expect(raw, '换档之后应当落盘').toBeTruthy()
    const saved = JSON.parse(raw!)
    expect(saved.state.fontSize).toBe('16')
    expect(saved.state.column).toBe('wide')
  })

  it('存盘里的野值被钳回默认,不炸也不留', () => {
    const clamped = clampReadingAxes({
      fontSize: '99' as never,
      density: 'cozy' as never,
      column: undefined,
      motion: 'wild' as never,
      motionChosen: 'yes' as never,
    })
    expect(clamped).toEqual(DEFAULT_READING_AXES)
  })

  it('存盘缺席 = 全默认', () => {
    expect(clampReadingAxes(undefined)).toEqual(DEFAULT_READING_AXES)
  })
})

describe('开工:贴一次 + 订两条来源', () => {
  it('startReadingAxes 当场把当下的档贴上', () => {
    useReadingStore.setState({ ...DEFAULT_READING_AXES, fontSize: '13', density: 'relaxed' })
    const probe = startReadingAxes()
    expect(probe.applied).toBe(true)
    expect(document.documentElement.getAttribute('data-reading-fs')).toBe('13')
    expect(document.documentElement.getAttribute('data-reading-density')).toBe('relaxed')
  })

  it('订上之后,设置面改一档屏幕跟着换 —— 不必再手动贴一次', () => {
    startReadingAxes()
    useReadingStore.getState().setDensity('compact')
    expect(document.documentElement.getAttribute('data-reading-density')).toBe('compact')
    useReadingStore.getState().setMotion('none')
    expect(document.documentElement.getAttribute('data-motion-tier')).toBe('none')
  })

  it('幂等:开两次不会订两份(第二次的订阅换掉第一次)', () => {
    startReadingAxes()
    startReadingAxes()
    useReadingStore.getState().setColumn('full')
    expect(document.documentElement.getAttribute('data-reading-col')).toBe('full')
  })

  it('readingAxes 只交出四轴,不夹带 action', () => {
    expect(Object.keys(readingAxes(useReadingStore.getState())).sort()).toEqual(
      ['column', 'density', 'fontSize', 'motion', 'motionChosen'].sort(),
    )
  })
})
