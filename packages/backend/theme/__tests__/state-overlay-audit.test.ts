/**
 * 16 主题 × 明暗双向的交互态审计(UI 系统收敛 P4)。
 *
 * 代替"逐个主题人肉走查 hover/selected/focus"的大头:对每个 builtin 主题在
 * dark 与 light 两种模式下跑 resolver + css-mapper,断言
 *   1. 所有 --ui-state-* / --ui-sidebar-item-* / --ui-sidebar-rail-* / 焦点 token 有值;
 *   2. 状态底与它所依附的**区域底色**之间的差值可感知(ΔRGB ≥ 5);
 *   3. 状态阶梯单调:hover < active/selected(离底色越来越远);
 *   4. 区域状态底是**实色**(gallery 回归与对比度计算都要求可解析,
 *      所以主题层不许把 color-mix 表达式当值发出来)。
 *
 * 这里只管"看得见 / 分得开",配色好不好看仍然靠人眼抽查。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { Theme } from '../types.js'
import { generateCSSVariables } from '../css-mapper.js'
import { resolveTheme, resolveThemeUI } from '../resolver.js'
import type { ThemeColorScheme } from '../role-mapping.js'
import { REGION_OVERLAY_STEPS, parseCssColor } from '../role-mapping.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const builtinThemeDir = path.resolve(dirname, '../builtin')
const builtinThemeFiles = fs
  .readdirSync(builtinThemeDir)
  .filter(fileName => fileName.endsWith('.json'))
  .sort()

const BOTH_MODES: ThemeColorScheme[] = ['dark', 'light']
/** 肉眼在实机上分得开的最小通道差 —— 低于这个数状态就是"画了等于没画"。 */
const MIN_PERCEPTIBLE_DELTA = 5

function loadTheme(fileName: string): Theme {
  return JSON.parse(fs.readFileSync(path.join(builtinThemeDir, fileName), 'utf8')) as Theme
}

/**
 * 每个主题**两种模式都审**,包括"浅色主题按 dark 模式解析"这种产品里不会发生的
 * 反模式 —— P4a 时它是红的(亮度偏移撞端点被裁,hover 与底只差 ΔRGB 1、
 * hover 与 selected 同色),P4b 给 `deriveStateOverlays` 加了端点反向保护之后
 * 它必须是绿的。这条覆盖就是那个保护的回归网。
 */
function modesFor(_theme: Theme): ThemeColorScheme[] {
  return BOTH_MODES
}

function cssVariablesFor(theme: Theme, mode: ThemeColorScheme): Record<string, string> {
  const resolvedTheme = resolveTheme(theme, mode)
  return generateCSSVariables(resolvedTheme, undefined, resolveThemeUI(theme, mode, resolvedTheme))
}

function requireSolid(vars: Record<string, string>, name: string, label: string): {
  red: number
  green: number
  blue: number
} {
  const raw = vars[name]
  expect(raw, `${label}: ${name} should be emitted`).toBeTruthy()
  const parsed = parseCssColor(raw)
  if (!parsed) {
    throw new Error(`${label}: ${name} should be a parseable solid color, got "${raw}"`)
  }
  return parsed
}

function channelDelta(
  a: { red: number; green: number; blue: number },
  b: { red: number; green: number; blue: number }
): number {
  return Math.max(Math.abs(a.red - b.red), Math.abs(a.green - b.green), Math.abs(a.blue - b.blue))
}

interface StatePair {
  /** 状态底 token */
  state: string
  /** 它画在哪个区域底色上 */
  surface: string
}

const STATE_PAIRS: StatePair[] = [
  { state: '--ui-state-hover-bg', surface: '--ui-surface-panel-bg' },
  { state: '--ui-state-active-bg', surface: '--ui-surface-panel-bg' },
  { state: '--ui-state-selected-bg', surface: '--ui-surface-panel-bg' },
  { state: '--ui-sidebar-item-hover-bg', surface: '--ui-sidebar-surface-bg' },
  { state: '--ui-sidebar-item-active-bg', surface: '--ui-sidebar-surface-bg' },
  { state: '--ui-sidebar-rail-hover-bg', surface: '--ui-sidebar-surface-bg' },
  { state: '--ui-sidebar-rail-active-bg', surface: '--ui-sidebar-surface-bg' },
  { state: '--ui-tab-bar-item-active-bg', surface: '--ui-tab-bar-surface-bg' },
  { state: '--ui-settings-row-hover-bg', surface: '--ui-surface-panel-bg' },
  { state: '--ui-settings-row-active-bg', surface: '--ui-surface-panel-bg' },
  // G6:通用「叠 accent 淡底」两档,与设置行同一张基面(panel)。
  { state: '--ui-state-hover-accent-bg', surface: '--ui-surface-panel-bg' },
  { state: '--ui-state-hover-accent-strong-bg', surface: '--ui-surface-panel-bg' },
  // G8:「hover 底上再进一档」。它依附的底**就是 hover 底**(不是区域面)——
  // 这一档专给"静息已经是 hover 底"的控件,对照面写别的都没有意义。
  { state: '--ui-state-hover-raised-bg', surface: '--ui-state-hover-bg' },
]

/** 同一区域内 hover → 选中 必须越走越远,否则两态读起来是一个。 */
const STATE_LADDERS: Array<{ surface: string; steps: string[] }> = [
  { surface: '--ui-surface-panel-bg', steps: ['--ui-state-hover-bg', '--ui-state-selected-bg'] },
  { surface: '--ui-sidebar-surface-bg', steps: ['--ui-sidebar-item-hover-bg', '--ui-sidebar-item-active-bg'] },
  {
    surface: '--ui-sidebar-surface-bg',
    steps: ['--ui-sidebar-rail-bg', '--ui-sidebar-rail-hover-bg', '--ui-sidebar-rail-active-bg'],
  },
  { surface: '--ui-surface-panel-bg', steps: ['--ui-settings-row-hover-bg', '--ui-settings-row-active-bg'] },
  {
    surface: '--ui-surface-panel-bg',
    steps: ['--ui-state-hover-accent-bg', '--ui-state-hover-accent-strong-bg'],
  },
]

const FOCUS_TOKENS = ['--ui-state-focus-ring', '--ui-state-focus-border', '--ui-surface-input-focus-ring']

describe('builtin theme state overlays', () => {
  it('covers every builtin theme', () => {
    expect(builtinThemeFiles.length).toBeGreaterThanOrEqual(16)
  })

  // P4b 端点保护的定点回归:浅色主题强按 dark 解析(亮度已贴着上界,
  // 正向偏移会被裁),状态叠加必须整组反向、而不是挤成一个颜色。
  for (const [fileName, wrongMode] of [
    ['paper-ink.json', 'dark'],
    ['github-light.json', 'dark'],
  ] as const) {
    it(`${fileName} forced to ${wrongMode}: overlays reflect instead of clipping`, () => {
      const vars = cssVariablesFor(loadTheme(fileName), wrongMode)
      const panel = requireSolid(vars, '--ui-surface-panel-bg', fileName)
      const hover = requireSolid(vars, '--ui-state-hover-bg', fileName)
      const selected = requireSolid(vars, '--ui-state-selected-bg', fileName)

      expect(channelDelta(hover, panel)).toBeGreaterThanOrEqual(MIN_PERCEPTIBLE_DELTA)
      expect(channelDelta(selected, hover)).toBeGreaterThan(0)
    })
  }

  it('keeps the region overlay ladder monotonic by construction', () => {
    expect(REGION_OVERLAY_STEPS.sidebarRailBg).toBeLessThan(REGION_OVERLAY_STEPS.sidebarRailHover)
    expect(REGION_OVERLAY_STEPS.sidebarRailHover).toBeLessThan(REGION_OVERLAY_STEPS.sidebarRailActive)
    expect(REGION_OVERLAY_STEPS.sidebarRowHover).toBeLessThan(REGION_OVERLAY_STEPS.sidebarRowActive)
    expect(REGION_OVERLAY_STEPS.settingsRowHover).toBeLessThan(REGION_OVERLAY_STEPS.settingsRowActive)
    expect(REGION_OVERLAY_STEPS.stateHoverAccent).toBeLessThan(REGION_OVERLAY_STEPS.stateHoverAccentStrong)
    // 淡档要真的"淡":比设置行的选中底重不了,否则它就成了另一个选中态。
    expect(REGION_OVERLAY_STEPS.stateHoverAccent).toBeLessThanOrEqual(REGION_OVERLAY_STEPS.settingsRowActive)
    // 「再进一档」是 hover 族的续档,不是新的选中态:压在 hover 底上的这一层墨
    // 不许重过侧栏行的选中档(14%),否则它读起来就是"选中"而不是"手指着"。
    expect(REGION_OVERLAY_STEPS.stateHoverRaised).toBeLessThan(REGION_OVERLAY_STEPS.sidebarRowActive)
  })

  for (const fileName of builtinThemeFiles) {
    for (const mode of modesFor(loadTheme(fileName))) {
      const label = `${fileName} (${mode})`

      it(`${label}: state overlays are emitted, solid and perceptible`, () => {
        const vars = cssVariablesFor(loadTheme(fileName), mode)

        for (const { state, surface } of STATE_PAIRS) {
          const stateColor = requireSolid(vars, state, label)
          const surfaceColor = requireSolid(vars, surface, label)
          const delta = channelDelta(stateColor, surfaceColor)
          expect(
            delta,
            `${label}: ${state} is invisible on ${surface} (ΔRGB ${delta.toFixed(1)}, need ≥ ${MIN_PERCEPTIBLE_DELTA})`
          ).toBeGreaterThanOrEqual(MIN_PERCEPTIBLE_DELTA)
        }
      })

      it(`${label}: hover → selected keeps walking away from the surface`, () => {
        const vars = cssVariablesFor(loadTheme(fileName), mode)

        for (const { surface, steps } of STATE_LADDERS) {
          const surfaceColor = requireSolid(vars, surface, label)
          let previous = 0
          for (const step of steps) {
            const delta = channelDelta(requireSolid(vars, step, label), surfaceColor)
            expect(
              delta,
              `${label}: ${step} (Δ${delta.toFixed(1)}) must sit further from ${surface} than the step before it (Δ${previous.toFixed(1)})`
            ).toBeGreaterThan(previous)
            previous = delta
          }
        }
      })

      it(`${label}: focus tokens resolve and stand off the app surface`, () => {
        const vars = cssVariablesFor(loadTheme(fileName), mode)
        const appBg = requireSolid(vars, '--ui-surface-app-bg', label)

        for (const token of FOCUS_TOKENS) {
          const ring = requireSolid(vars, token, label)
          const delta = channelDelta(ring, appBg)
          expect(
            delta,
            `${label}: ${token} disappears into --ui-surface-app-bg (ΔRGB ${delta.toFixed(1)})`
          ).toBeGreaterThanOrEqual(MIN_PERCEPTIBLE_DELTA * 3)
        }
      })
    }
  }
})
