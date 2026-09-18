import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import { configureMusicEnabledPort, runWithMusicEnabled } from '../music-enabled'

/**
 * 总开关(用户 09-18:点「开台」被告知去「设置 → 音乐」,而壳里没有这一页)。
 * 判据是**发在前、开关在后**:点击当帧就发得出去,只有被拒了才去看那一格。
 */
function portWith(enabled: boolean | undefined) {
  const saved: AppSettings[] = []
  const settings = { music: enabled === undefined ? undefined : { enabled } } as unknown as AppSettings
  configureMusicEnabledPort({
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings }),
    saveSettings: async (next) => {
      saved.push(next)
      return { success: true }
    },
  })
  return saved
}

afterEach(() => configureMusicEnabledPort(undefined))

describe('runWithMusicEnabled', () => {
  it('发成功:一个字都不读设置', async () => {
    const saved = portWith(false)
    let runs = 0
    await runWithMusicEnabled(
      async () => {
        runs += 1
      },
      () => false,
    )
    expect(runs).toBe(1)
    expect(saved).toHaveLength(0)
  })

  it('被拒且开关关着:打开它,再发一次', async () => {
    const saved = portWith(false)
    let runs = 0
    await runWithMusicEnabled(
      async () => {
        runs += 1
      },
      () => runs === 1,
    )
    expect(saved).toHaveLength(1)
    expect(saved[0]?.music?.enabled).toBe(true)
    expect(runs).toBe(2)
  })

  it('被拒但开关本来就开着:不重发(那是别的毛病)', async () => {
    const saved = portWith(true)
    let runs = 0
    await runWithMusicEnabled(
      async () => {
        runs += 1
      },
      () => true,
    )
    expect(saved).toHaveLength(0)
    expect(runs).toBe(1)
  })

  it('读不到设置:不抛,也不重发', async () => {
    configureMusicEnabledPort({
      ready: async () => undefined,
      readSettings: async () => {
        throw new Error('nope')
      },
      saveSettings: async () => ({ success: true }),
    })
    let runs = 0
    await expect(
      runWithMusicEnabled(
        async () => {
          runs += 1
        },
        () => true,
      ),
    ).resolves.toBeUndefined()
    expect(runs).toBe(1)
  })
})
