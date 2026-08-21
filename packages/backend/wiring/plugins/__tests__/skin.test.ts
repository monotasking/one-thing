/**
 * H3 验收:`contributes.theme.skin` 皮肤包(第一批旋钮)。
 *
 * 治理照抄 L2(`theme-overrides.test.ts`)一字不改,所以这里钉的是同一组性质:
 *  1. **枚举面** —— 插件递的是**档位名**不是 CSS 值;不认识的旋钮、枚举外的档位
 *     逐条丢弃。皮肤没有、也不需要 L2 那套颜色字面量白名单:插件的字符串永远
 *     不进 CSS(这一条本身要被钉住,否则哪天有人把它改成收 CSS 值也没人发现)。
 *  2. **降级不拒载** —— 非法档位只丢该键并在投影里标记;形状错(不是对象 /
 *     值不是字符串 / 条目超上限)才是加载期错误。
 *  3. **冲突顺序确定性** —— 多插件拧同一旋钮按全局规范顺序后者胜,输入顺序无关。
 *  4. **缺省档 == 现状(逐字节)** —— `standard` 的 CSS 值是 `null`(不写变量),
 *     所以"没插件"与"插件选了 standard"产出必须逐字节相同。这是整个 H3 最重要
 *     的一条:现状值只存在于组件 CSS 的兜底里那一份,这里禁止出现第二份。
 *  5. **拆除双面** —— 停用/卸载后皮肤变量从表里消失,整张表逐字回到无插件时。
 *  6. **合成点** —— 皮肤与主题变量名不相交(`--skin-*`),所以合并顺序无关;
 *     皮肤不得改动主题算出来的**任何一个**变量。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_SKIN_MAX_ENTRIES,
  validatePluginContributes,
} from '@onething/core/plugins'
import {
  isPluginSkinKnob,
  isPluginSkinTier,
  listPluginSkinKnobs,
  resolvePluginSkins,
} from '@onething/runtime/plugins/skin'
import { projectOnethingPluginsForRenderer } from '@onething/runtime/plugins/plugin-list'
import { SKIN_TIER_VALUES, SKIN_VAR_MAP, generateSkinVariables } from '@onething/runtime/themes/skin'
import { applyTheme, initializeThemes } from '@onething/runtime/themes'

/** 装配层只从插件管理器的**内存清单**读声明 —— 换成假的就能验完整条宿主链路。 */
const managedPlugins: Array<{ definition: { id: string; enabled: boolean; manifest: unknown } }> = []
vi.mock('../manager.js', () => ({
  getPluginManager: () => (managedPlugins.length ? { getPlugins: () => managedPlugins } : null),
}))
const { getPluginSkinTiers } = await import('../skin.js')

initializeThemes()

/** 宿主链路的一次完整走位:插件清单 → 裁决 → 作为参数进入主题计算。 */
function applyThemeWithPlugins(mode: 'dark' | 'light' = 'dark') {
  return applyTheme('flexoki', mode, undefined, undefined, getPluginSkinTiers())
}

function setPlugins(...entries: Array<{ id: string; enabled?: boolean; skin?: unknown }>) {
  managedPlugins.length = 0
  for (const entry of entries) {
    managedPlugins.push({
      definition: {
        id: entry.id,
        enabled: entry.enabled ?? true,
        manifest: { contributes: { theme: { skin: entry.skin } } },
      },
    })
  }
}

// ── 1. 枚举面(不是颜色白名单) ─────────────────

describe('skin enum surface', () => {
  it('旋钮白名单就是档位表本身,不另抄一份', () => {
    for (const knob of Object.keys(SKIN_TIER_VALUES)) {
      expect(isPluginSkinKnob(knob)).toBe(true)
    }
    expect(isPluginSkinKnob('bubbleColor')).toBe(false)
    expect(isPluginSkinKnob('__proto__')).toBe(false)
    expect(isPluginSkinKnob('')).toBe(false)
  })

  it('档位必须在该旋钮的枚举内', () => {
    for (const tier of Object.keys(SKIN_TIER_VALUES.bubbleRadius)) {
      expect(isPluginSkinTier('bubbleRadius', tier)).toBe(true)
    }
    for (const bogus of ['24px', 'ROUND', 'huge', '', 'toString', 0, null, undefined, {}]) {
      expect(isPluginSkinTier('bubbleRadius', bogus)).toBe(false)
    }
  })

  it('插件递进来的字符串永远不进 CSS —— 值只可能来自档位表', () => {
    // 这一条是皮肤的**安全模型**本身:哪怕档位名长得像 CSS,产出也只会是表里的值。
    const variables = generateSkinVariables({ bubbleRadius: 'round' })
    expect(variables[SKIN_VAR_MAP.bubbleRadius]).toBe(SKIN_TIER_VALUES.bubbleRadius.round)
    // 枚举外的"值"一律被丢掉,不会以任何形式出现在产出里。
    const injected = generateSkinVariables({ bubbleRadius: '0; background: url(http://evil)' })
    expect(injected).toEqual({})
  })

  it('设置页要念的档位表由宿主给出(作者指南与界面同一出处)', () => {
    const knobs = listPluginSkinKnobs()
    expect(knobs.map(item => item.knob)).toEqual(Object.keys(SKIN_TIER_VALUES))
    expect(knobs[0].tiers).toEqual(Object.keys(SKIN_TIER_VALUES.bubbleRadius))
    expect(knobs[0].cssVar).toBe(SKIN_VAR_MAP.bubbleRadius)
  })
})

// ── 2. manifest 形状(降级 vs 拒载) ─────────────────

describe('contributes.theme.skin manifest shape', () => {
  it('合法声明通过;档位内容问题不在这里判(降级归投影层)', () => {
    expect(validatePluginContributes({ theme: { skin: { bubbleRadius: 'round' } } })).toBeNull()
    // 不认识的旋钮 / 枚举外的档位**不是**加载错误 —— 它们是投影层的 invalid。
    expect(validatePluginContributes({ theme: { skin: { nope: 'whatever' } } })).toBeNull()
    expect(validatePluginContributes({ theme: { skin: { bubbleRadius: '24px' } } })).toBeNull()
    expect(validatePluginContributes({ theme: { skin: {} } })).toBeNull()
    // skin 可缺省(theme 也可以只带 overrides / background)。
    expect(validatePluginContributes({ theme: { overrides: { primary: '#fff' } } })).toBeNull()
  })

  it('形状错才拒载:不是对象 / 值不是字符串 / 条目超上限', () => {
    expect(validatePluginContributes({ theme: { skin: 'round' } })).toMatch(/skin must be an object/)
    expect(validatePluginContributes({ theme: { skin: [] } })).toMatch(/skin must be an object/)
    expect(validatePluginContributes({ theme: { skin: { bubbleRadius: 4 } } }))
      .toMatch(/skin\.bubbleRadius must be a string/)
    expect(validatePluginContributes({ theme: { skin: { ' ': 'round' } } }))
      .toMatch(/skin keys must be non-empty strings/)
    const tooMany: Record<string, string> = {}
    for (let i = 0; i <= PLUGIN_SKIN_MAX_ENTRIES; i++) tooMany[`knob${i}`] = 'round'
    expect(validatePluginContributes({ theme: { skin: tooMany } }))
      .toMatch(/must not exceed .* entries/)
  })
})

// ── 3. 裁决:后者胜 / 顺序确定 / 非法丢弃 ─────────────────

describe('skin resolution', () => {
  it('多插件拧同一旋钮:全局规范顺序后者胜,被压的标 shadowed', () => {
    const resolution = resolvePluginSkins([
      { pluginId: 'aaa', enabled: true, skin: { bubbleRadius: 'sharp' } },
      { pluginId: 'zzz', enabled: true, skin: { bubbleRadius: 'round' } },
    ])
    expect(resolution.tiers).toEqual({ bubbleRadius: 'round' })
    expect(resolution.byPlugin.get('aaa')).toEqual([
      { knob: 'bubbleRadius', tier: 'sharp', status: 'shadowed', shadowedBy: 'zzz' },
    ])
    expect(resolution.byPlugin.get('zzz')).toEqual([
      { knob: 'bubbleRadius', tier: 'round', status: 'active' },
    ])
  })

  it('顺序确定性:输入顺序不影响结果(目录发现序不得泄漏到语义里)', () => {
    const inputs = [
      { pluginId: 'aaa', enabled: true, skin: { bubbleRadius: 'sharp' } },
      { pluginId: 'zzz', enabled: true, skin: { bubbleRadius: 'round' } },
    ]
    expect(resolvePluginSkins(inputs).tiers)
      .toEqual(resolvePluginSkins([...inputs].reverse()).tiers)
  })

  it('非法条目丢弃并标记原因,合法的同插件条目照常生效', () => {
    const resolution = resolvePluginSkins([{
      pluginId: 'p',
      enabled: true,
      skin: { bubbleRadius: 'soft', nope: 'round', alsoNope: 'x' },
    }])
    expect(resolution.tiers).toEqual({ bubbleRadius: 'soft' })
    expect(resolution.byPlugin.get('p')).toEqual([
      { knob: 'bubbleRadius', tier: 'soft', status: 'active' },
      { knob: 'nope', tier: 'round', status: 'invalid', reason: 'unknown-knob' },
      { knob: 'alsoNope', tier: 'x', status: 'invalid', reason: 'unknown-knob' },
    ])
  })

  it('枚举外的档位标 unknown-tier(与 unknown-knob 分开报,用户要知道错在哪一半)', () => {
    const resolution = resolvePluginSkins([
      { pluginId: 'p', enabled: true, skin: { bubbleRadius: '24px' } },
    ])
    expect(resolution.tiers).toEqual({})
    expect(resolution.byPlugin.get('p')).toEqual([
      { knob: 'bubbleRadius', tier: '24px', status: 'invalid', reason: 'unknown-tier' },
    ])
  })
})

// ── 4. 缺省档 == 现状(整个 H3 的地基) ─────────────────

describe('standard tier is the app baseline', () => {
  it('缺省档的 CSS 值是 null —— 表里不许出现现状值的第二份副本', () => {
    // 现状值(`var(--radius-xs, 4px)`)只存在于组件 CSS 的兜底里那一份。
    expect(SKIN_TIER_VALUES.bubbleRadius.standard).toBeNull()
    for (const [tier, value] of Object.entries(SKIN_TIER_VALUES.bubbleRadius)) {
      if (tier === 'standard') continue
      expect(typeof value).toBe('string')
      // 任何一档都不许写成 `var(--radius-xs…)` —— 那就是把现状抄了第二遍。
      expect(String(value)).not.toContain('--radius-xs')
    }
  })

  it('"没插件"与"插件选了 standard"产出逐字节相同', () => {
    managedPlugins.length = 0
    const pristine = applyThemeWithPlugins()

    setPlugins({ id: 'skin-plugin', skin: { bubbleRadius: 'standard' } })
    expect(applyThemeWithPlugins()).toEqual(pristine)
    // 缺省档确实被裁决成 active(声明是生效的),只是它不写任何变量。
    expect(getPluginSkinTiers()).toEqual({ bubbleRadius: 'standard' })
    expect(generateSkinVariables(getPluginSkinTiers())).toEqual({})

    managedPlugins.length = 0
  })
})

// ── 5. 合成点与拆除 ─────────────────

describe('host composition', () => {
  it('插件系统没起来 = 空皮肤表(不抛),主题产出与没有插件时逐字相同', () => {
    managedPlugins.length = 0
    expect(getPluginSkinTiers()).toEqual({})
    expect(applyThemeWithPlugins()).toEqual(applyTheme('flexoki', 'dark'))
  })

  it('皮肤只添不改:主题算出来的每一个变量逐字不变,新增的只有 --skin-*', () => {
    managedPlugins.length = 0
    const pristine = applyThemeWithPlugins()

    setPlugins({ id: 'skin-plugin', skin: { bubbleRadius: 'round' } })
    const applied = applyThemeWithPlugins()

    for (const [name, value] of Object.entries(pristine)) {
      expect(applied[name]).toBe(value)
    }
    const added = Object.keys(applied).filter(name => !(name in pristine))
    expect(added).toEqual([SKIN_VAR_MAP.bubbleRadius])
    expect(applied[SKIN_VAR_MAP.bubbleRadius]).toBe(SKIN_TIER_VALUES.bubbleRadius.round)

    managedPlugins.length = 0
  })

  it('皮肤是每次算主题都递进去的参数 —— 换模式照样生效,不需要记住任何状态', () => {
    setPlugins({ id: 'skin-plugin', skin: { bubbleRadius: 'sharp' } })
    for (const mode of ['dark', 'light'] as const) {
      expect(applyThemeWithPlugins(mode)[SKIN_VAR_MAP.bubbleRadius])
        .toBe(SKIN_TIER_VALUES.bubbleRadius.sharp)
    }
    managedPlugins.length = 0
  })

  it('拆除快照:停用 → 不参与合成;卸载 → 整张表逐字回到无插件时', () => {
    managedPlugins.length = 0
    const pristine = applyThemeWithPlugins()

    setPlugins({ id: 'skin-plugin', enabled: false, skin: { bubbleRadius: 'round' } })
    expect(getPluginSkinTiers()).toEqual({})
    expect(applyThemeWithPlugins()).toEqual(pristine)
    // 声明仍可见(卡片要能说"它会改什么"),只是标 inactive。
    expect(resolvePluginSkins([
      { pluginId: 'skin-plugin', enabled: false, skin: { bubbleRadius: 'round' } },
    ]).byPlugin.get('skin-plugin')).toEqual([
      { knob: 'bubbleRadius', tier: 'round', status: 'inactive' },
    ])

    managedPlugins.length = 0
    expect(applyThemeWithPlugins()).toEqual(pristine)
  })
})

// ── 6. 目录投影 ─────────────────

describe('renderer projection', () => {
  it('投影带逐条裁决,非法条目标记可见(与 uiSlots unsupported 同规)', () => {
    const projected = projectOnethingPluginsForRenderer([
      {
        definition: {
          id: 'aaa',
          enabled: true,
          manifest: {
            name: 'A',
            version: '1.0.0',
            contributes: { theme: { skin: { bubbleRadius: 'sharp', nope: 'round' } } },
          },
        },
        loaded: true,
        commands: [],
      },
      {
        definition: {
          id: 'zzz',
          enabled: true,
          manifest: {
            name: 'Z',
            version: '1.0.0',
            contributes: { theme: { skin: { bubbleRadius: 'round' } } },
          },
        },
        loaded: true,
        commands: [],
      },
    ] as never)

    expect(projected[0].contributes.skin).toEqual([
      { knob: 'bubbleRadius', tier: 'sharp', status: 'shadowed', shadowedBy: 'zzz' },
      { knob: 'nope', tier: 'round', status: 'invalid', reason: 'unknown-knob' },
    ])
    expect(projected[1].contributes.skin).toEqual([
      { knob: 'bubbleRadius', tier: 'round', status: 'active' },
    ])
  })

  it('没有声明 skin 的插件投影出空数组(不是 undefined —— 消费端不必判两种空)', () => {
    const projected = projectOnethingPluginsForRenderer([{
      definition: { id: 'p', enabled: true, manifest: { name: 'P', version: '1.0.0' } },
      loaded: true,
      commands: [],
    }] as never)
    expect(projected[0].contributes.skin).toEqual([])
  })
})
