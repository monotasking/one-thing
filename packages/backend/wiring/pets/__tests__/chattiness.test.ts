/**
 * 开口频率热生效的接线(P5 §12.4,§12.6 第三条的「热生效」):设置一保存,档位交到子系统;
 * 串在宿主那条推送后面,不掐掉它;退订还原槽。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import {
  broadcastSettingsChanged,
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '../../settings/events.js'
import { petChattinessOf, watchPetChattiness } from '../chattiness.js'

function settingsWith(chattiness: unknown): AppSettings {
  return { ...createDefaultSettings(), pets: { chattiness } } as AppSettings
}

afterEach(() => configureSettingsEventBroadcaster(null))

describe('pet chattiness wiring', () => {
  it('reads the level from settings, defaulting to balanced', () => {
    expect(petChattinessOf(createDefaultSettings())).toBe('balanced')
    expect(petChattinessOf(settingsWith('quiet'))).toBe('quiet')
    expect(petChattinessOf(settingsWith('loud'))).toBe('balanced')
    expect(petChattinessOf(undefined)).toBe('balanced')
  })

  it('hands every settings save to the target, after the host broadcaster, and restores the slot', () => {
    const order: string[] = []
    const host = vi.fn(() => order.push('host'))
    configureSettingsEventBroadcaster(host)
    const target = { setChattiness: vi.fn((level: string) => order.push(level)) }
    const stop = watchPetChattiness(target)
    broadcastSettingsChanged(settingsWith('chatty'))
    expect(order).toEqual(['host', 'chatty'])
    stop()
    expect(getSettingsEventBroadcaster()).toBe(host)
    broadcastSettingsChanged(settingsWith('quiet'))
    expect(target.setChattiness).toHaveBeenCalledTimes(1)
  })
})
