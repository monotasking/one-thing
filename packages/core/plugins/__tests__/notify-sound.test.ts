/**
 * 提示音枚举的契约测试(M1)。
 *
 * 这一层守的是**形状**:枚举本体、非法值降级、以及 `api.ui.notify` 的两种第二参
 * 长相。"响不响"由装配层判(静音 / 限频),那条线在
 * `packages/backend/plugins/__tests__/notify-sound.test.ts`。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_PLUGIN_NOTIFY_SOUND,
  PLUGIN_NOTIFY_SOUNDS,
  PLUGIN_NOTIFY_SOUND_THROTTLE_MS,
  isPluginNotifySound,
  normalizePluginNotifySound,
} from '../notify-sound.js'

describe('PLUGIN_NOTIFY_SOUNDS —— 宿主枚举音效集', () => {
  it('是一个封闭枚举,none 在内且是缺省', () => {
    expect([...PLUGIN_NOTIFY_SOUNDS]).toEqual(['none', 'info', 'success', 'warning', 'error', 'chime'])
    expect(DEFAULT_PLUGIN_NOTIFY_SOUND).toBe('none')
    expect(PLUGIN_NOTIFY_SOUNDS).toContain(DEFAULT_PLUGIN_NOTIFY_SOUND)
  })

  it('没有重复项 —— 名字是查配方的键', () => {
    expect(new Set(PLUGIN_NOTIFY_SOUNDS).size).toBe(PLUGIN_NOTIFY_SOUNDS.length)
  })

  it('限频窗口是正数 —— 调到 0 等于把这道闸拆了', () => {
    expect(PLUGIN_NOTIFY_SOUND_THROTTLE_MS).toBeGreaterThan(0)
  })

  it('isPluginNotifySound 只认枚举成员', () => {
    for (const sound of PLUGIN_NOTIFY_SOUNDS) expect(isPluginNotifySound(sound)).toBe(true)
    expect(isPluginNotifySound('siren')).toBe(false)
    expect(isPluginNotifySound('')).toBe(false)
    expect(isPluginNotifySound(440)).toBe(false)
    expect(isPluginNotifySound({ freq: 440 })).toBe(false)
    expect(isPluginNotifySound(undefined)).toBe(false)
  })
})

describe('normalizePluginNotifySound', () => {
  it('没传 = 不出声,而且不算错', () => {
    expect(normalizePluginNotifySound(undefined)).toEqual({ sound: 'none', unknown: false })
    expect(normalizePluginNotifySound(null)).toEqual({ sound: 'none', unknown: false })
  })

  it('枚举成员原样通过', () => {
    expect(normalizePluginNotifySound('chime')).toEqual({ sound: 'chime', unknown: false })
  })

  it('未知名字降级 none 并标记 unknown(不抛错)', () => {
    expect(normalizePluginNotifySound('airhorn')).toEqual({ sound: 'none', unknown: true })
    expect(normalizePluginNotifySound(880)).toEqual({ sound: 'none', unknown: true })
    // 插件想传自制配方 —— 这正是"防音频轰炸"要挡的形状。
    expect(normalizePluginNotifySound({ freq: 3000, durationMs: 30000 })).toEqual({
      sound: 'none',
      unknown: true,
    })
  })
})

// ── api.ui.notify 的第二参:两种长相 ──────────────

/**
 * 单测 api-builder 的整条构造代价太高(它要一整套 host 端口),而这里真正要钉的
 * 只有分派逻辑:第二参是字符串走老路,是对象走新路。所以在这里复刻那一段
 * ——它与 api-builder 里的实现同形,任一侧改了另一侧的断言就会说话。
 */
function dispatchNotify(
  message: string,
  levelOrOptions: 'info' | 'warn' | 'error' | { level?: 'info' | 'warn' | 'error'; sound?: string } = 'info',
): { message: string; level: string; sound: string; unknown: boolean } {
  const isOptions = typeof levelOrOptions === 'object' && levelOrOptions !== null
  const level = (isOptions ? levelOrOptions.level : levelOrOptions) ?? 'info'
  const normalized = normalizePluginNotifySound(isOptions ? levelOrOptions.sound : undefined)
  return { message, level, sound: normalized.sound, unknown: normalized.unknown }
}

describe('api.ui.notify 第二参 —— append-only,老签名零改动', () => {
  it('notify(msg) 与从前逐字节一致:info + 不出声', () => {
    expect(dispatchNotify('hi')).toEqual({ message: 'hi', level: 'info', sound: 'none', unknown: false })
  })

  it('notify(msg, level) 老签名保留,且永远不出声', () => {
    for (const level of ['info', 'warn', 'error'] as const) {
      expect(dispatchNotify('hi', level)).toEqual({ message: 'hi', level, sound: 'none', unknown: false })
    }
  })

  it('notify(msg, { level, sound }) 是新形态', () => {
    expect(dispatchNotify('done', { level: 'info', sound: 'success' })).toEqual({
      message: 'done',
      level: 'info',
      sound: 'success',
      unknown: false,
    })
  })

  it('options 里省略 level 时仍然落到 info', () => {
    expect(dispatchNotify('ping', { sound: 'chime' })).toEqual({
      message: 'ping',
      level: 'info',
      sound: 'chime',
      unknown: false,
    })
  })

  it('options 里的未知 sound 降级 none,level 不受牵连', () => {
    expect(dispatchNotify('oops', { level: 'error', sound: 'airhorn' })).toEqual({
      message: 'oops',
      level: 'error',
      sound: 'none',
      unknown: true,
    })
  })
})

describe('api-builder 的 ui.notify 接线', () => {
  /**
   * 真的过一遍 `createCorePluginAPI`:要钉的是 host 端口收到了**第四参**,
   * 以及未知音名会记日志而不是静默。
   */
  async function buildApi() {
    const { createCorePluginAPI } = await import('../api-builder.js')
    const notify = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    const { api } = createCorePluginAPI({
      pluginId: 'demo',
      manifest: { id: 'demo', name: 'demo', version: '1.0.0' },
      host: { notify } as never,
      logger,
    } as never)
    return { api: api as { ui: { notify: (m: string, l?: unknown) => void } }, notify, logger }
  }

  it('老调用把 sound 传成 none —— 行为不变', async () => {
    const { api, notify } = await buildApi()
    api.ui.notify('hello')
    expect(notify).toHaveBeenCalledWith('demo', 'hello', 'info', 'none')
    api.ui.notify('careful', 'warn')
    expect(notify).toHaveBeenLastCalledWith('demo', 'careful', 'warn', 'none')
  })

  it('options 形态把枚举成员透传给宿主', async () => {
    const { api, notify } = await buildApi()
    api.ui.notify('ding', { level: 'info', sound: 'chime' })
    expect(notify).toHaveBeenCalledWith('demo', 'ding', 'info', 'chime')
  })

  it('未知音名降级 none 并留下一条日志(通知本身照发)', async () => {
    const { api, notify, logger } = await buildApi()
    api.ui.notify('boom', { sound: 'airhorn' })
    expect(notify).toHaveBeenCalledWith('demo', 'boom', 'info', 'none')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unknown sound'))
  })
})
