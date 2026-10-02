/**
 * G2 验收(判据 + 裁决层):氛围层声明校验、全窗单层裁决、四态投影。
 *
 * 与背景层 `background.test.ts` 同构 —— 氛围也是"全局唯一一格 + 全局规范顺序
 * 后者胜",区别只在:入口判据分叉到 `.html`,且没有运行期调参。
 */
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_AMBIENT_MESSAGE_TYPES,
  describePluginAmbientProblem,
  pluginAmbientEntryUrl,
  resolvePluginAmbients,
} from '../ambient.js'

describe('describePluginAmbientProblem — 声明校验', () => {
  it('合法声明(.html 入口)过', () => {
    expect(describePluginAmbientProblem({ entry: 'ambient.html' })).toBeNull()
    expect(describePluginAmbientProblem({ entry: 'fx/snow.html' })).toBeNull()
  })

  it('非对象一律拒', () => {
    expect(describePluginAmbientProblem(null)).toMatch(/must be an object/)
    expect(describePluginAmbientProblem('ambient.html')).toMatch(/must be an object/)
  })

  it('入口必须是非空字符串', () => {
    expect(describePluginAmbientProblem({})).toMatch(/non-empty string/)
    expect(describePluginAmbientProblem({ entry: '' })).toMatch(/non-empty string/)
  })

  it('入口必须指向 .html —— 图片/脚本当氛围是写错了', () => {
    expect(describePluginAmbientProblem({ entry: 'ambient.js' })).toMatch(/\.html/)
    expect(describePluginAmbientProblem({ entry: 'bg.png' })).toMatch(/\.html/)
  })

  it('穿越 / scheme / 编码变体走 webview entry 那一份判据(不重复实现)', () => {
    expect(describePluginAmbientProblem({ entry: '../escape.html' })).toBeTruthy()
    expect(describePluginAmbientProblem({ entry: '/abs.html' })).toBeTruthy()
    expect(describePluginAmbientProblem({ entry: 'javascript:x.html' })).toBeTruthy()
    expect(describePluginAmbientProblem({ entry: '%2e%2e/x.html' })).toBeTruthy()
  })
})

describe('resolvePluginAmbients — 全窗单层裁决', () => {
  it('单个已启用插件 = 它胜出,URL 是它自己的 origin', () => {
    const { winner, byPlugin } = resolvePluginAmbients([
      { pluginId: 'snow-scene', enabled: true, ambient: { entry: 'ambient.html' } },
    ])
    expect(winner).toEqual({
      pluginId: 'snow-scene',
      entryUrl: 'onething-plugin://snow-scene/ambient.html',
    })
    expect(byPlugin.get('snow-scene')?.status).toBe('active')
  })

  it('多个已启用 → 只一个 active,其余 shadowed;后者(规范顺序更后)胜', () => {
    const { winner, byPlugin } = resolvePluginAmbients([
      { pluginId: 'aaa', enabled: true, ambient: { entry: 'a.html' } },
      { pluginId: 'zzz', enabled: true, ambient: { entry: 'z.html' } },
    ])
    // canonical order 是 id 升序,后写(zzz)赢。
    expect(winner?.pluginId).toBe('zzz')
    const actives = [...byPlugin.values()].filter(e => e.status === 'active')
    expect(actives).toHaveLength(1)
    expect(byPlugin.get('aaa')?.status).toBe('shadowed')
    expect(byPlugin.get('aaa')?.shadowedBy).toBe('zzz')
  })

  it('停用的插件不参与裁决 —— 标 inactive,不夺 winner', () => {
    const { winner, byPlugin } = resolvePluginAmbients([
      { pluginId: 'aaa', enabled: true, ambient: { entry: 'a.html' } },
      { pluginId: 'zzz', enabled: false, ambient: { entry: 'z.html' } },
    ])
    expect(winner?.pluginId).toBe('aaa')
    expect(byPlugin.get('zzz')?.status).toBe('inactive')
  })

  it('非法声明丢弃并标 invalid + reason,不拒载、不夺 winner', () => {
    const { winner, byPlugin } = resolvePluginAmbients([
      { pluginId: 'aaa', enabled: true, ambient: { entry: 'a.html' } },
      { pluginId: 'zzz', enabled: true, ambient: { entry: 'bad.js' } },
    ])
    // zzz 规范顺序更后,但它非法 —— winner 回落到 aaa。
    expect(winner?.pluginId).toBe('aaa')
    expect(byPlugin.get('zzz')?.status).toBe('invalid')
    expect(byPlugin.get('zzz')?.reason).toBeTruthy()
  })

  it('没有任何 active → winner 为 null', () => {
    expect(resolvePluginAmbients([]).winner).toBeNull()
    expect(resolvePluginAmbients([
      { pluginId: 'x', enabled: false, ambient: { entry: 'a.html' } },
    ]).winner).toBeNull()
  })

  it('没声明氛围的插件不进 byPlugin 表', () => {
    const { byPlugin } = resolvePluginAmbients([
      { pluginId: 'x', enabled: true },
    ])
    expect(byPlugin.has('x')).toBe(false)
  })
})

describe('协议常量与出处', () => {
  it('氛围入口 URL 与 webview entry 同一个出处', () => {
    expect(pluginAmbientEntryUrl('p', 'ambient.html')).toBe('onething-plugin://p/ambient.html')
  })

  it('消息集:host→iframe 有 init/geometry/pause/resume;iframe→host 有 ready', () => {
    expect(PLUGIN_AMBIENT_MESSAGE_TYPES).toMatchObject({
      init: 'ambient-init',
      geometry: 'ambient-geometry',
      pause: 'ambient-pause',
      resume: 'ambient-resume',
      ready: 'ambient-ready',
    })
    // 没有 invoke/result —— 氛围层永远不回调宿主。
    expect(Object.values(PLUGIN_AMBIENT_MESSAGE_TYPES)).not.toContain('invoke')
    expect(Object.values(PLUGIN_AMBIENT_MESSAGE_TYPES)).not.toContain('result')
  })
})
