/**
 * 提示音裁决的行为测试(M1)——「响不响」的三道闸。
 *
 * 枚举本身的形状测试在 `packages/core/plugins/__tests__/notify-sound.test.ts`;
 * 这里只测要读宿主状态的部分:全局总开关、每插件静音、每插件限频。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PLUGIN_NOTIFY_SOUND_THROTTLE_MS } from '@onething/core/plugins'

const settings: { plugins?: { notifySoundsEnabled: boolean; notifySoundMutedPluginIds: string[] } } = {}

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => settings,
}))

const {
  forgetPluginNotifySoundThrottle,
  isPluginNotifySoundAllowed,
  resetPluginNotifySoundThrottle,
  resolvePluginNotifySound,
} = await import('../notify-sound.js')

beforeEach(() => {
  resetPluginNotifySoundThrottle()
  settings.plugins = { notifySoundsEnabled: true, notifySoundMutedPluginIds: [] }
})

describe('resolvePluginNotifySound —— 基础归一', () => {
  it('没点名就不出声', () => {
    expect(resolvePluginNotifySound('demo', undefined)).toBe('none')
    expect(resolvePluginNotifySound('demo', 'none')).toBe('none')
  })

  it('点名了、没被拦,就原样返回', () => {
    expect(resolvePluginNotifySound('demo', 'chime')).toBe('chime')
  })

  it('兜底再挡一次枚举 —— 宿主内部调用点不经过 core 的归一', () => {
    expect(resolvePluginNotifySound('demo', 'airhorn' as never)).toBe('none')
  })
})

describe('限频 —— 连发只响第一声', () => {
  it('窗口内的第二声被吃掉', () => {
    let now = 1_000_000
    const clock = { now: () => now }
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
    now += 100
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('none')
    now += PLUGIN_NOTIFY_SOUND_THROTTLE_MS - 200
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('none')
  })

  it('窗口过了以后又能响', () => {
    let now = 1_000_000
    const clock = { now: () => now }
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
    now += PLUGIN_NOTIFY_SOUND_THROTTLE_MS
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
  })

  it('限频是**每插件**的 —— 一个插件刷屏不该让别人哑掉', () => {
    let now = 1_000_000
    const clock = { now: () => now }
    expect(resolvePluginNotifySound('noisy', 'warning', clock)).toBe('warning')
    now += 10
    expect(resolvePluginNotifySound('noisy', 'warning', clock)).toBe('none')
    expect(resolvePluginNotifySound('quiet', 'info', clock)).toBe('info')
  })

  it('被拦下的那一声不记账 —— 静音期间不该悄悄推走限频窗口', () => {
    const now = 1_000_000
    const clock = { now: () => now }
    settings.plugins = { notifySoundsEnabled: true, notifySoundMutedPluginIds: ['demo'] }
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('none')
    // 取消静音后立刻就该有声音,而不是"还要再等 3 秒"。
    settings.plugins = { notifySoundsEnabled: true, notifySoundMutedPluginIds: [] }
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
  })

  it('拆除插件会清掉它的限频账', () => {
    const now = 1_000_000
    const clock = { now: () => now }
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('none')
    forgetPluginNotifySoundThrottle('demo')
    expect(resolvePluginNotifySound('demo', 'chime', clock)).toBe('chime')
  })
})

describe('用户主权 —— 静音只掐声音', () => {
  it('每插件静音:被点名的那个哑,别人照响', () => {
    settings.plugins = { notifySoundsEnabled: true, notifySoundMutedPluginIds: ['muted-one'] }
    expect(resolvePluginNotifySound('muted-one', 'chime')).toBe('none')
    expect(resolvePluginNotifySound('other', 'chime')).toBe('chime')
  })

  it('全局总开关:一键全静', () => {
    settings.plugins = { notifySoundsEnabled: false, notifySoundMutedPluginIds: [] }
    expect(resolvePluginNotifySound('a', 'chime')).toBe('none')
    expect(resolvePluginNotifySound('b', 'error')).toBe('none')
  })

  it('isPluginNotifySoundAllowed 是那两道闸的读法', () => {
    settings.plugins = { notifySoundsEnabled: true, notifySoundMutedPluginIds: ['muted-one'] }
    expect(isPluginNotifySoundAllowed('muted-one')).toBe(false)
    expect(isPluginNotifySoundAllowed('other')).toBe(true)
    settings.plugins = { notifySoundsEnabled: false, notifySoundMutedPluginIds: [] }
    expect(isPluginNotifySoundAllowed('other')).toBe(false)
  })

  it('设置还没加载时缺省能响 —— 装配早期不该把声音永久掐掉', () => {
    settings.plugins = undefined
    expect(resolvePluginNotifySound('demo', 'chime')).toBe('chime')
  })
})
