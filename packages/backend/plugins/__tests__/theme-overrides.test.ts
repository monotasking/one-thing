/**
 * B 期验收(L2):`contributes.theme` 主题 token 覆盖。
 *
 * 钉住的东西:
 *  1. **安全面** —— 覆盖值只放行颜色字面量;`url(` / `var(` / `;` / `}` /
 *     `expression(` / 空串 / 超长串逐条反例,以及非字符串值。
 *  2. **降级不拒载** —— 键不在主题 token 表、值不过白名单,只丢该条目并在
 *     清单投影里标记(与未知锚点同规);形状错(不是对象/条目超上限)才是
 *     加载期错误。
 *  3. **冲突顺序确定性** —— 多插件覆盖同一 token 按全局规范顺序后者胜,
 *     输入顺序不影响结果。
 *  4. **拆除双面** —— 停用/卸载后覆盖从表里消失,整张 `:root` 逐字回到主题原值
 *     (派生层也要一起退,不能留下半新半旧的一张表)。
 *  5. **主题切换保留覆盖** —— 覆盖是每次算主题都递进去的**参数**,不是记住的状态。
 *  6. **合成点在主题计算之内** —— 覆盖当参数进 `applyTheme`,在 `resolveThemeUI` /
 *     `generateCSSVariables` 之前落位;三层(原始 / ui 语义 / -rgb)一起变色。
 *     曾经是拿到响应再往 cssVariables 上 spread,只盖得住原始变量。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_THEME_COLOR_MAX_LENGTH,
  PLUGIN_THEME_OVERRIDE_MAX_ENTRIES,
  comparePluginCanonicalOrder,
  isPluginThemeColorValue,
  sortByPluginCanonicalOrder,
  validatePluginContributes,
} from '@onething/core/plugins'
import {
  isPluginThemeOverrideToken,
  resolvePluginThemeOverrides,
} from '@onething/runtime/plugins/theme-overrides'
import { projectOnethingPluginsForRenderer } from '@onething/runtime/plugins/plugin-list'
import { CSS_VAR_MAP } from '@onething/runtime/themes/css-mapper'
import { applyTheme, initializeThemes } from '@onething/runtime/themes/index'

/**
 * 装配层只从插件管理器的**内存清单**读声明,所以这里把管理器换成一个假的
 * 就能验完整条宿主链路(收集 → 裁决 → 叠在主题产出上)。
 */
const managedPlugins: Array<{ definition: { id: string; enabled: boolean; manifest: unknown } }> = []
vi.mock('../manager.js', () => ({
  getPluginManager: () => (managedPlugins.length ? { getPlugins: () => managedPlugins } : null),
}))
const { getPluginThemeOverrideTokenValues } = await import('../theme-overrides.js')

initializeThemes()

/** 宿主链路的一次完整走位:插件清单 → 裁决 → 作为参数进入主题计算。 */
function applyThemeWithPlugins(mode: 'dark' | 'light' = 'dark') {
  return applyTheme('flexoki', mode, undefined, getPluginThemeOverrideTokenValues())
}

// ── 1. 颜色字面量白名单(安全面) ─────────────────

describe('plugin theme override color whitelist', () => {
  it('放行颜色字面量的全部合法写法', () => {
    for (const value of [
      '#fff', '#FFFF', '#0a0a0a', '#0A0A0AFF',
      'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(1 2 3 / 50%)',
      'hsl(210, 40%, 50%)', 'hsla(210 40% 50% / 0.4)',
      'oklch(0.7 0.1 250)', 'oklab(0.7 -0.1 0.05)',
      'rebeccapurple', 'Transparent', 'red',
    ]) {
      expect(isPluginThemeColorValue(value), value).toBe(true)
    }
  })

  it('逐条反例:url( / var( / ; / } / expression( / 空串 / 超长 / 非字符串', () => {
    const rejected: unknown[] = [
      'url(https://tracker.example/pixel.png)',
      'rgb(1,2,3) url(https://tracker.example/p.png)',
      'var(--bg-app)',
      'rgb(var(--x))',
      '#fff; background: url(https://x)',
      '#fff}',
      'expression(alert(1))',
      'calc(1px)',
      '',
      '   ',
      '\n',
      'notacolorname',
      'javascript:alert(1)',
      '#ff',
      '#fffff',
      '"#fff"',
      'a'.repeat(PLUGIN_THEME_COLOR_MAX_LENGTH + 1),
      `rgb(${'1'.repeat(PLUGIN_THEME_COLOR_MAX_LENGTH)})`,
      null,
      undefined,
      42,
      { toString: () => '#fff' },
      ['#fff'],
    ]
    for (const value of rejected) {
      expect(isPluginThemeColorValue(value), String(value)).toBe(false)
    }
  })

  it('括号内不许再出现括号 —— 这一条就挡住了所有函数注入,不靠黑名单', () => {
    expect(isPluginThemeColorValue('rgb(1,2,3)')).toBe(true)
    expect(isPluginThemeColorValue('rgb(calc(1),2,3)')).toBe(false)
  })
})

// ── 2. manifest 形状校验:什么才算拒载 ───────────

describe('contributes.theme manifest shape', () => {
  it('合法声明通过;键/值的内容问题不在这里判(降级归投影层)', () => {
    expect(validatePluginContributes({ theme: { overrides: { primary: '#ff0000' } } })).toBeNull()
    // 未知 token / 非法颜色都**不是**加载期错误。
    expect(validatePluginContributes({ theme: { overrides: { nope: '#ff0000' } } })).toBeNull()
    expect(validatePluginContributes({ theme: { overrides: { primary: 'url(https://x)' } } })).toBeNull()
  })

  it('形状错才拒载:不是对象 / overrides 不是对象 / 值不是字符串 / 条目超上限', () => {
    expect(validatePluginContributes({ theme: 'red' })).toContain('theme must be an object')
    // G 期起 overrides 可缺省:`contributes.theme` 也可能只带 background,
    // 逼作者写一个空的 overrides 才算合法是没有道理的。
    expect(validatePluginContributes({ theme: {} })).toBeNull()
    expect(validatePluginContributes({ theme: { overrides: [] } })).toContain('theme.overrides must be an object')
    expect(validatePluginContributes({ theme: { overrides: { primary: 1 } } }))
      .toContain('theme.overrides.primary must be a string')
    const tooMany = Object.fromEntries(
      Array.from({ length: PLUGIN_THEME_OVERRIDE_MAX_ENTRIES + 1 }, (_, i) => [`t${i}`, '#fff']),
    )
    expect(validatePluginContributes({ theme: { overrides: tooMany } }))
      .toContain(`must not exceed ${PLUGIN_THEME_OVERRIDE_MAX_ENTRIES} entries`)
    // 恰好卡在上限上是合法的。
    const exactly = Object.fromEntries(
      Array.from({ length: PLUGIN_THEME_OVERRIDE_MAX_ENTRIES }, (_, i) => [`t${i}`, '#fff']),
    )
    expect(validatePluginContributes({ theme: { overrides: exactly } })).toBeNull()
  })
})

// ── 3. 键白名单 = CSS_VAR_MAP,不另抄一份 ────────

describe('token whitelist', () => {
  it('白名单就是主题 token 表本身', () => {
    expect(isPluginThemeOverrideToken('primary')).toBe(true)
    expect(isPluginThemeOverrideToken('bg.app')).toBe(true)
    expect(isPluginThemeOverrideToken('definitely.not.a.token')).toBe(false)
    // 原型链上的东西不算 token(`toString` 之类)。
    expect(isPluginThemeOverrideToken('toString')).toBe(false)
    // 表里每一个键都必须被放行 —— 抄第二份表就会在这里崩。
    for (const token of Object.keys(CSS_VAR_MAP)) {
      expect(isPluginThemeOverrideToken(token), token).toBe(true)
    }
  })

  it('token 展开成 CSS 变量名用的是同一张表(别名要一起覆盖)', () => {
    const { cssVariables } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { primary: '#123456' } },
    ])
    for (const cssVar of CSS_VAR_MAP.primary) {
      expect(cssVariables[cssVar]).toBe('#123456')
    }
  })
})

// ── 4. 冲突裁决与顺序确定性 ──────────────────────

describe('override resolution', () => {
  it('多插件覆盖同一 token:全局规范顺序后者胜,被压的标 shadowed', () => {
    const resolution = resolvePluginThemeOverrides([
      { pluginId: 'zed', enabled: true, overrides: { primary: '#222222' } },
      { pluginId: 'alpha', enabled: true, overrides: { primary: '#111111' } },
    ])
    expect(resolution.cssVariables['--color-primary']).toBe('#222222')
    expect(resolution.byPlugin.get('alpha')).toEqual([
      { token: 'primary', value: '#111111', status: 'shadowed', shadowedBy: 'zed' },
    ])
    expect(resolution.byPlugin.get('zed')).toEqual([
      { token: 'primary', value: '#222222', status: 'active' },
    ])
  })

  it('顺序确定性:输入顺序不影响结果(目录发现序不得泄漏到语义里)', () => {
    const inputs = [
      { pluginId: 'b', enabled: true, overrides: { primary: '#bbbbbb' } },
      { pluginId: 'a', enabled: true, overrides: { primary: '#aaaaaa' } },
      { pluginId: 'c', enabled: true, overrides: { primary: '#cccccc' } },
    ]
    const forward = resolvePluginThemeOverrides(inputs).cssVariables
    const reversed = resolvePluginThemeOverrides([...inputs].reverse()).cssVariables
    expect(forward).toEqual(reversed)
    expect(forward['--color-primary']).toBe('#cccccc')
  })

  it('规范顺序的出处只有一个:pluginId 字典序,稳定排序保留声明顺序', () => {
    expect(comparePluginCanonicalOrder('a', 'b')).toBeLessThan(0)
    expect(comparePluginCanonicalOrder('b', 'a')).toBeGreaterThan(0)
    expect(comparePluginCanonicalOrder('a', 'a')).toBe(0)
    const sorted = sortByPluginCanonicalOrder(
      [{ id: 'b', n: 1 }, { id: 'a', n: 1 }, { id: 'a', n: 2 }],
      item => item.id,
    )
    expect(sorted.map(item => `${item.id}${item.n}`)).toEqual(['a1', 'a2', 'b1'])
  })

  it('非法条目丢弃并标记原因,合法的同插件条目照常生效', () => {
    const resolution = resolvePluginThemeOverrides([{
      pluginId: 'a',
      enabled: true,
      overrides: { primary: '#111111', 'not.a.token': '#222222', accent: 'url(https://x)' },
    }])
    expect(resolution.byPlugin.get('a')).toEqual([
      { token: 'primary', value: '#111111', status: 'active' },
      { token: 'not.a.token', value: '#222222', status: 'invalid', reason: 'unknown-token' },
      { token: 'accent', value: 'url(https://x)', status: 'invalid', reason: 'invalid-color' },
    ])
    expect(resolution.cssVariables['--color-primary']).toBe('#111111')
    expect(resolution.cssVariables['--accent']).toBeUndefined()
  })

  it('值前后空白被归一;声明照样可见', () => {
    const resolution = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { primary: '  #abcdef  ' } },
    ])
    expect(resolution.cssVariables['--color-primary']).toBe('#abcdef')
  })
})

// ── 5. 拆除双面:停用即撤除 ──────────────────────

describe('teardown', () => {
  it('停用的插件不参与合成(声明仍可见,标 inactive)', () => {
    const resolution = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: false, overrides: { primary: '#111111' } },
    ])
    expect(resolution.cssVariables).toEqual({})
    expect(resolution.byPlugin.get('a')).toEqual([
      { token: 'primary', value: '#111111', status: 'inactive' },
    ])
  })

  it('停用不会改变别人的裁决:唯一覆盖者被关掉后,另一个插件从 shadowed 回到 active', () => {
    const enabled = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { primary: '#aaaaaa' } },
      { pluginId: 'z', enabled: true, overrides: { primary: '#ffffff' } },
    ])
    expect(enabled.byPlugin.get('a')?.[0].status).toBe('shadowed')

    const zDisabled = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { primary: '#aaaaaa' } },
      { pluginId: 'z', enabled: false, overrides: { primary: '#ffffff' } },
    ])
    expect(zDisabled.byPlugin.get('a')?.[0].status).toBe('active')
    expect(zDisabled.cssVariables['--color-primary']).toBe('#aaaaaa')
  })

  it('拆除快照:卸载(清单里没有了)后整张表逐字回到主题原值', () => {
    const pristine = applyTheme('flexoki', 'dark')

    const withPlugin = applyTheme('flexoki', 'dark', undefined, resolvePluginThemeOverrides([
      { pluginId: 'brand', enabled: true, overrides: { primary: '#ff4d00' } },
    ]).tokenValues)
    expect(withPlugin['--color-primary']).toBe('#ff4d00')

    // 派生层也必须一起退回 —— 只退原始变量就会留下一张半新半旧的表。
    const afterUninstall = applyTheme('flexoki', 'dark', undefined,
      resolvePluginThemeOverrides([]).tokenValues)
    expect(afterUninstall).toEqual(pristine)
  })
})

// ── 6. 主题切换保留覆盖 ──────────────────────────

describe('theme switching', () => {
  it('覆盖是每次算主题都递进去的参数 —— 换模式照样生效,不需要记住任何状态', () => {
    const { tokenValues } = resolvePluginThemeOverrides([
      { pluginId: 'brand', enabled: true, overrides: { primary: '#ff4d00' } },
    ])
    const dark = applyTheme('flexoki', 'dark', undefined, tokenValues)
    const light = applyTheme('flexoki', 'light', undefined, tokenValues)
    expect(dark['--color-primary']).toBe('#ff4d00')
    expect(light['--color-primary']).toBe('#ff4d00')
    // 没被覆盖的 token 仍跟随主题(明暗两套背景不会因为覆盖而合流)。
    expect(dark['--bg-app']).not.toBe(light['--bg-app'])
    // 派生层跟着模式各自重算 —— 覆盖不是一张贴上去的静态表。
    expect(dark['--color-primary-bg']).not.toBe(light['--color-primary-bg'])
  })
})

// ── 7. 清单投影:非法条目可见 ────────────────────

describe('renderer projection', () => {
  it('投影带逐条裁决,非法条目标记可见(与 uiSlots unsupported 同规)', () => {
    const projected = projectOnethingPluginsForRenderer([
      makeListItem('alpha', true, { primary: '#111111', bogus: '#222222' }),
      makeListItem('zed', true, { primary: '#333333', accent: 'var(--x)' }),
    ])
    expect(projected.find(p => p.id === 'alpha')?.contributes.theme).toEqual([
      { token: 'primary', value: '#111111', status: 'shadowed', shadowedBy: 'zed' },
      { token: 'bogus', value: '#222222', status: 'invalid', reason: 'unknown-token' },
    ])
    expect(projected.find(p => p.id === 'zed')?.contributes.theme).toEqual([
      { token: 'primary', value: '#333333', status: 'active' },
      { token: 'accent', value: 'var(--x)', status: 'invalid', reason: 'invalid-color' },
    ])
  })

  it('没有声明 theme 的插件投影出空数组(不是 undefined —— 消费端不必判两种空)', () => {
    const [plugin] = projectOnethingPluginsForRenderer([makeListItem('plain', true, undefined)])
    expect(plugin.contributes.theme).toEqual([])
  })
})

// ── 8. 装配层:宿主合成链路 ──────────────────────

describe('host composition', () => {
  it('插件系统没起来 = 空覆盖表(不抛),主题产出与没有插件时逐字相同', () => {
    managedPlugins.length = 0
    expect(getPluginThemeOverrideTokenValues()).toEqual({})
    expect(applyThemeWithPlugins()).toEqual(applyTheme('flexoki', 'dark'))
  })

  it('宿主递的是 token 表(不是变量表):派生层因此吃得到覆盖色', () => {
    const pristine = applyTheme('flexoki', 'dark')

    managedPlugins.length = 0
    managedPlugins.push(makeListItem('brand', true, { primary: '#ff4d00', accent: '#ff8800' }))
    expect(getPluginThemeOverrideTokenValues()).toEqual({ primary: '#ff4d00', accent: '#ff8800' })

    const applied = applyThemeWithPlugins()
    // 原始变量。
    expect(applied['--color-primary']).toBe('#ff4d00')
    // ui 语义层 —— renderer 上可见的 UI 绝大多数消费这一族。
    expect(applied['--ui-action-primary-bg']).toBe('#ff4d00')
    expect(applied['--ui-action-primary-bg']).not.toBe(pristine['--ui-action-primary-bg'])
    // -rgb 变体。
    expect(applied['--color-primary-rgb']).toBe('255, 77, 0')
    // 没被覆盖的 token 仍跟随主题。
    expect(applied['--bg-app']).toBe(pristine['--bg-app'])

    // 停用后下一次下发整张表回到主题原值(拆除快照)。
    managedPlugins[0].definition.enabled = false
    expect(getPluginThemeOverrideTokenValues()).toEqual({})
    expect(applyThemeWithPlugins()).toEqual(pristine)
  })
})

// ── 9. 代码色:两族键归一到权威族 ────────────────

/**
 * 代码色曾经是**死键**(H3 §6.6 实证):`syntax.*` 进不了白名单、`text.code.*`
 * 进得来却被高亮层原样盖回去。修完之后这里钉住裁决层这一半:
 *  - 权威族是 `syntax.*`(它就是 `SemanticHighlightToken`,与高亮解析 1:1);
 *  - `text.code.*` 是**合法别名**,裁决期归一到权威键,投影里带 `canonicalToken`;
 *  - 冲突按权威键比,不按字面键 —— 两个插件各写一族不能双双"生效";
 *  - 同一插件两族撞车:**权威族胜**,被吞的标 `shadowed` + `shadowedByToken`。
 */
describe('code colour token normalization', () => {
  it('权威族与别名族都放行,归一表两边一致', () => {
    expect(isPluginThemeOverrideToken('syntax.keyword')).toBe(true)
    expect(isPluginThemeOverrideToken('text.code.keyword')).toBe(true)
    // 权威族全 21 条都是真 token(每条都有 --hg-*-fg 出口)。
    expect(isPluginThemeOverrideToken('syntax.atom')).toBe(true)
    expect(isPluginThemeOverrideToken('syntax.nope')).toBe(false)
  })

  it('别名声明归一成权威键,投影带 canonicalToken', () => {
    const { tokenValues, byPlugin, cssVariables } = resolvePluginThemeOverrides([
      { pluginId: 'a', enabled: true, overrides: { 'text.code.keyword': '#123456' } },
    ])
    expect(tokenValues).toEqual({ 'syntax.keyword': '#123456' })

    const entry = byPlugin.get('a')![0]
    expect(entry.token).toBe('text.code.keyword')
    expect(entry.canonicalToken).toBe('syntax.keyword')
    expect(entry.status).toBe('active')

    // 投影走高亮层的出口(--hg-*-fg + legacy 别名),不是 CSS_VAR_MAP。
    expect(cssVariables['--hg-syntax-keyword-fg']).toBe('#123456')
    expect(cssVariables['--text-code-keyword']).toBe('#123456')
    expect(cssVariables['--syntax-keyword']).toBe('#123456')
  })

  it('跨插件冲突按权威键比:各写一族也只有一个赢家', () => {
    const { tokenValues, byPlugin } = resolvePluginThemeOverrides([
      { pluginId: 'zzz', enabled: true, overrides: { 'text.code.keyword': '#222222' } },
      { pluginId: 'aaa', enabled: true, overrides: { 'syntax.keyword': '#111111' } },
    ])
    // 规范顺序后者(zzz)胜。
    expect(tokenValues).toEqual({ 'syntax.keyword': '#222222' })

    const loser = byPlugin.get('aaa')![0]
    expect(loser.status).toBe('shadowed')
    expect(loser.shadowedBy).toBe('zzz')
    expect(loser.shadowedByToken).toBe('text.code.keyword')
  })

  it('同一插件两族撞车:权威族胜,与书写顺序无关', () => {
    for (const overrides of [
      { 'text.code.keyword': '#222222', 'syntax.keyword': '#111111' },
      { 'syntax.keyword': '#111111', 'text.code.keyword': '#222222' },
    ]) {
      const { tokenValues, byPlugin } = resolvePluginThemeOverrides([
        { pluginId: 'a', enabled: true, overrides },
      ])
      expect(tokenValues).toEqual({ 'syntax.keyword': '#111111' })

      const swallowed = byPlugin.get('a')!.find(e => e.token === 'text.code.keyword')!
      expect(swallowed.status).toBe('shadowed')
      expect(swallowed.shadowedByToken).toBe('syntax.keyword')
    }
  })

  it('宿主链路走通:插件声明代码色,:root 上的代码色变量真的换了', () => {
    const pristine = applyTheme('flexoki', 'dark')
    managedPlugins.length = 0
    managedPlugins.push(makeListItem('a', true, { 'text.code.keyword': '#ff00ff' }))

    const themed = applyThemeWithPlugins()
    expect(themed['--hg-syntax-keyword-fg']).not.toBe(pristine['--hg-syntax-keyword-fg'])
    expect(themed['--text-code-keyword']).toBe(themed['--hg-syntax-keyword-fg'])
    expect(themed['--hljs-keyword']).toBe(themed['--hg-syntax-keyword-fg'])
    expect(themed['--syntax-keyword']).toBe(themed['--hg-syntax-keyword-fg'])

    // 拆除:停用后整张表逐字回到主题原值。
    managedPlugins[0].definition.enabled = false
    expect(applyThemeWithPlugins()).toEqual(pristine)
    managedPlugins.length = 0
  })
})

function makeListItem(id: string, enabled: boolean, overrides: Record<string, string> | undefined) {
  return {
    definition: {
      id,
      source: 'user',
      enabled,
      dirPath: `/plugins/${id}`,
      manifest: {
        name: id,
        version: '1.0.0',
        contributes: overrides ? { theme: { overrides } } : {},
      },
    },
    loaded: true,
    commands: [],
  }
}
