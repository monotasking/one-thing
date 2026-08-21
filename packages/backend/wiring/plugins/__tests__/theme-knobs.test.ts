/**
 * 批 3b 验收:`contributes.theme.overrides` 里的**表面旋钮**地址(`--ot-*`)。
 *
 * 钉住的东西:
 *  1. **寻址靠前缀,不靠宿主手编清单** —— 名字空间里没登记过的旋钮名照样能拨,
 *     只要后缀落在类型表里(用户裁决:「让插件自己需要什么注入什么」)。
 *  2. **越界是钳制不是丢弃** —— 意图清楚就别静默无事发生;钳过要如实标 `clampedFrom`。
 *  3. **不成形的值才丢弃** —— 丢弃 + 目录页投影可见,**不拒载**(与颜色白名单同规)。
 *  4. **两个地址空间互不干扰** —— 前缀外的键仍走 `CSS_VAR_MAP` 那道旧门,
 *     旋钮不进 `tokenValues`(它不是主题 token,主题计算里没有东西从它派生)。
 *  5. **合流不回归** —— 与 token 覆盖共用同一套规范顺序后者胜,输入顺序无关。
 *  6. **宿主链路 + 拆除** —— 旋钮叠在主题产出之上下发;停用后从表里消失。
 */
import { describe, expect, it, vi } from 'vitest'
import { resolvePluginThemeOverrides } from '@onething/runtime/plugins/theme-overrides'
import { projectOnethingPluginsForRenderer } from '@onething/runtime/plugins/plugin-list'
import {
  THEME_KNOB_ALPHA_FLOOR_PERCENT,
  THEME_KNOB_BLUR_CEILING_PX,
  themeKnobType,
} from '@onething/runtime/themes/knobs'

const managedPlugins: Array<{ definition: { id: string; enabled: boolean; manifest: unknown } }> = []
vi.mock('../manager.js', () => ({
  getPluginManager: () => (managedPlugins.length ? { getPlugins: () => managedPlugins } : null),
}))
const { getPluginThemeKnobVariables } = await import('../theme-overrides.js')

function makeListItem(id: string, enabled: boolean, overrides: Record<string, string>) {
  return {
    definition: {
      id,
      enabled,
      source: 'user',
      dirPath: `/tmp/plugins/${id}`,
      manifest: { name: id, version: '1.0.0', contributes: { theme: { overrides } } },
    },
    loaded: true,
    commands: [],
  }
}

// ── 1. 前缀寻址 + 类型表 ─────────────────────────────────────────────────

describe('旋钮寻址', () => {
  it('前缀内、后缀在类型表里的合法值直接生效', () => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      {
        pluginId: 'a',
        enabled: true,
        overrides: { '--ot-frost-alpha': '40%', '--ot-frost-blur': '10px' },
      },
    ])
    expect(knobVariables).toEqual({ '--ot-frost-alpha': '40%', '--ot-frost-blur': '10px' })
    expect(byPlugin.get('a')!.every(e => e.status === 'active')).toBe(true)
  })

  it('宿主没有旋钮清单:类型表认后缀,没见过的旋钮名一样拨得动', () => {
    // 这枚旋钮今天不存在于 wallpaper.css。能拨,正是"名字空间即 API"的意思 ——
    // 组件哪天加一档同类型旋钮,校验器一个字都不用改。
    expect(themeKnobType('--ot-brand-new-alpha')).toBe('alpha')
    const { knobVariables } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-brand-new-alpha': '55%' } },
    ])
    expect(knobVariables).toEqual({ '--ot-brand-new-alpha': '55%' })
  })

  it('前缀内但后缀不在类型表:丢弃 + 说得出原因(宿主无从校验一个不知类型的串)', () => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-frost-filter': 'blur(2px)' } },
    ])
    expect(knobVariables).toEqual({})
    const entry = byPlugin.get('a')![0]
    expect(entry.status).toBe('invalid')
    expect(entry.reason).toBe('unknown-knob')
  })
})

// ── 2. 按类型钳制 ────────────────────────────────────────────────────────

describe('旋钮钳制', () => {
  it('alpha 越地板被钳到地板,不是丢弃', () => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-surface-alpha': '2%' } },
    ])
    expect(knobVariables).toEqual({ '--ot-surface-alpha': `${THEME_KNOB_ALPHA_FLOOR_PERCENT}%` })
    const entry = byPlugin.get('a')![0]
    expect(entry.status).toBe('active')
    expect(entry.clampedFrom).toBe('2%')
  })

  it('alpha 越天花板被钳到 100%', () => {
    const { knobVariables } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-state-alpha': '250%' } },
    ])
    expect(knobVariables).toEqual({ '--ot-state-alpha': '100%' })
  })

  it('blur 超上限被钳到上限', () => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-frost-blur': '48px' } },
    ])
    expect(knobVariables).toEqual({ '--ot-frost-blur': `${THEME_KNOB_BLUR_CEILING_PX}px` })
    expect(byPlugin.get('a')![0].clampedFrom).toBe('48px')
  })

  it('区间内的值原样通过,不标 clampedFrom', () => {
    const { byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-frost-blur': '0px' } },
    ])
    expect(byPlugin.get('a')![0].clampedFrom).toBeUndefined()
  })
})

// ── 3. 不成形的值:丢弃 + 投影可见,不拒载 ───────────────────────────────

describe('旋钮值的安全面', () => {
  it.each([
    ['单位缺席', '40'],
    ['单位不匹配', '6%'],
    ['注入串', 'var(--ot-state-alpha)'],
    ['计算串', 'calc(10px + 2px)'],
    ['分号逃逸', '10px; color: red'],
    ['负数', '-4px'],
    ['颜色', 'red'],
    ['空串', ''],
  ])('%s 被丢弃并标 invalid-knob-value', (_label, value) => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { '--ot-frost-blur': value } },
    ])
    expect(knobVariables).toEqual({})
    const entry = byPlugin.get('a')![0]
    expect(entry.status).toBe('invalid')
    expect(entry.reason).toBe('invalid-knob-value')
  })

  it('非法条目进得了设置页投影(说得出为什么没生效)', () => {
    const projected = projectOnethingPluginsForRenderer([
      makeListItem('a', true, { '--ot-frost-blur': 'var(--x)' }),
    ])
    const themeEntries = projected[0].contributes.theme
    expect(themeEntries).toHaveLength(1)
    expect(themeEntries[0]).toMatchObject({
      token: '--ot-frost-blur',
      status: 'invalid',
      reason: 'invalid-knob-value',
    })
  })
})

// ── 4. 两个地址空间互不干扰 ──────────────────────────────────────────────

describe('旋钮与主题 token 同表共存', () => {
  it('前缀外的键仍按旧判据走 tokenValues,旋钮不掺进去', () => {
    const { tokenValues, knobVariables, cssVariables } = resolvePluginThemeOverrides([
      {
        pluginId: 'a',
        enabled: true,
        overrides: { primary: '#ff4d00', '--ot-frost-alpha': '30%' },
      },
    ])
    expect(tokenValues).toEqual({ primary: '#ff4d00' })
    expect(knobVariables).toEqual({ '--ot-frost-alpha': '30%' })
    // 说明性投影只展开 token,不含旋钮。
    expect(Object.keys(cssVariables).some(k => k.startsWith('--ot-'))).toBe(false)
  })

  it('前缀外的未知键仍是 unknown-token(旧判据没被旋钮分流改坏)', () => {
    const { byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { 'definitely.not.a.token': '#fff' } },
    ])
    expect(byPlugin.get('a')![0].reason).toBe('unknown-token')
  })
})

// ── 5. 合流:同一套规范顺序后者胜 ────────────────────────────────────────

describe('旋钮合流', () => {
  it('两插件拨同一枚旋钮:规范顺序后者胜,输入顺序无关', () => {
    const inputs = [
      { pluginId: 'a-plugin', enabled: true, overrides: { '--ot-frost-alpha': '30%' } },
      { pluginId: 'z-plugin', enabled: true, overrides: { '--ot-frost-alpha': '70%' } },
    ]
    const forward = resolvePluginThemeOverrides(inputs)
    const reversed = resolvePluginThemeOverrides([...inputs].reverse())
    expect(forward.knobVariables).toEqual({ '--ot-frost-alpha': '70%' })
    expect(reversed.knobVariables).toEqual(forward.knobVariables)

    const loser = forward.byPlugin.get('a-plugin')![0]
    expect(loser.status).toBe('shadowed')
    expect(loser.shadowedBy).toBe('z-plugin')
  })

  it('停用的插件:声明照样可见,但不参与合成', () => {
    const { knobVariables, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: false, overrides: { '--ot-frost-alpha': '30%' } },
    ])
    expect(knobVariables).toEqual({})
    expect(byPlugin.get('a')![0].status).toBe('inactive')
  })
})

// ── 6. 宿主链路 + 拆除 ───────────────────────────────────────────────────

describe('宿主链路', () => {
  it('装配层把裁决后的旋钮表交出来;停用即消失', () => {
    managedPlugins.length = 0
    expect(getPluginThemeKnobVariables()).toEqual({})

    managedPlugins.push(makeListItem('a', true, { '--ot-frost-alpha': '35%' }))
    expect(getPluginThemeKnobVariables()).toEqual({ '--ot-frost-alpha': '35%' })

    managedPlugins[0].definition.enabled = false
    expect(getPluginThemeKnobVariables()).toEqual({})

    managedPlugins.length = 0
    expect(getPluginThemeKnobVariables()).toEqual({})
  })
})
