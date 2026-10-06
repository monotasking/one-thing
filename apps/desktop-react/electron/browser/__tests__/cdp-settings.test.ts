/**
 * B2′ 的主进程单元用例:设置里那一格 → 启动旗文件。
 *
 * **一条 `import … from 'electron'` 都没有**(与 `browser-host.test.ts` 同一条
 * 结构判据):设置订阅源在被测模块那一侧是注入的结构化端口(第④步批 2b 起是
 * `core-client.ts` 的设置 feed),这里喂的是一只替身。发现文件里补 `cdp` 那一格随批 2b 退役。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'

import { getCdpFlagPath, readCdpLaunchFlag } from '../cdp-flag.js'
import { cdpFlagFromSettings, installCdpSettingsWatcher } from '../cdp-settings.js'

/** 只带这一节要的两格 —— `AppSettings` 那 17 段与这件事无关。 */
function settingsWith(cdp: { enabled: boolean; port: number } | undefined): Pick<AppSettings, 'browser'> {
  // 名册那三格与这一节无关,但契约上它们是必填的 —— 补一份最小的(B3-b)。
  return cdp
    ? { browser: { cdp, profiles: [{ id: 'default', name: '' }], defaultProfile: 'default', searchEngine: 'google' } }
    : {}
}

/** 设置 feed 的替身:订上去先交当下那一份,`emit` 再交一份(与 `core-client.ts` 的 feed 同形)。 */
function fakeFeed(initial: Pick<AppSettings, 'browser'>) {
  const listeners = new Set<(settings: Pick<AppSettings, 'browser'>) => void>()
  return {
    subscribe: (listener: (settings: Pick<AppSettings, 'browser'>) => void) => {
      listeners.add(listener)
      listener(initial)
      return () => { listeners.delete(listener) }
    },
    emit: (settings: Pick<AppSettings, 'browser'>) => {
      for (const listener of [...listeners]) listener(settings)
    },
    get size() { return listeners.size },
  }
}

describe('cdpFlagFromSettings', () => {
  it('关着 = null;开着 = 那个端口', () => {
    expect(cdpFlagFromSettings(settingsWith({ enabled: false, port: 9333 }))).toBeNull()
    expect(cdpFlagFromSettings(settingsWith({ enabled: true, port: 9333 }))).toEqual({ port: 9333 })
  })

  it('这一段压根不在 = 关着(老 store / 手改过的 settings.json)', () => {
    expect(cdpFlagFromSettings(settingsWith(undefined))).toBeNull()
  })

  it('端口不合法就当关着,**不回落到缺省口** —— 替他挑一个口是自作主张', () => {
    expect(cdpFlagFromSettings(settingsWith({ enabled: true, port: 0 }))).toBeNull()
    expect(cdpFlagFromSettings(settingsWith({ enabled: true, port: 70000 }))).toBeNull()
  })
})

describe('installCdpSettingsWatcher', () => {
  let store: string
  beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-settings-')) })
  afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

  it('开场按当下设置对齐一次:开着 → 旗文件在且端口对', () => {
    const slot = fakeFeed(settingsWith({ enabled: true, port: 9444 }))
    const off = installCdpSettingsWatcher({
      storePath: store,
      subscribe: slot.subscribe,
    })
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9444 })
    off()
  })

  it('**关 → 删旗**:一次 settings:changed 把开着的那份关掉,盘上那份就没了', () => {
    const slot = fakeFeed(settingsWith({ enabled: true, port: 9333 }))
    const off = installCdpSettingsWatcher({
      storePath: store,
      subscribe: slot.subscribe,
    })
    expect(fs.existsSync(getCdpFlagPath(store))).toBe(true)

    slot.emit(settingsWith({ enabled: false, port: 9333 }))
    expect(fs.existsSync(getCdpFlagPath(store))).toBe(false)
    expect(readCdpLaunchFlag(store)).toBeUndefined()

    // 再开回来:同一条路反着走一遍。
    slot.emit(settingsWith({ enabled: true, port: 9555 }))
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9555 })
    off()
  })

  it('退订幂等:摘两次只退一次,摘掉之后 feed 上一个订阅者都不剩', () => {
    const slot = fakeFeed(settingsWith({ enabled: false, port: 9333 }))
    const off = installCdpSettingsWatcher({ storePath: store, subscribe: slot.subscribe })
    expect(slot.size).toBe(1)
    off()
    off()
    expect(slot.size).toBe(0)
  })

  it('摘掉之后不再跟着设置走', () => {
    const slot = fakeFeed(settingsWith({ enabled: true, port: 9333 }))
    const off = installCdpSettingsWatcher({
      storePath: store,
      subscribe: slot.subscribe,
    })
    off()
    slot.emit(settingsWith({ enabled: false, port: 9333 }))
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9333 })
  })

  it('写砸了只报一声,不抛 —— 这一格的后果只是「下次启动没跟上」', () => {
    const slot = fakeFeed(settingsWith({ enabled: true, port: 9333 }))
    const errors: unknown[] = []
    // 一条指向**文件**的「store 根」:`mkdirSync` 在它下面建 `run/` 必然 ENOTDIR。
    const blocked = path.join(store, 'not-a-dir')
    fs.writeFileSync(blocked, 'x')
    const off = installCdpSettingsWatcher({
      storePath: blocked,
      subscribe: slot.subscribe,
      onError: error => { errors.push(error) },
    })
    expect(errors.length).toBe(1)
    // 订上去那一半照样成立:一次写失败不该把这条路整个摘掉。
    slot.emit(settingsWith({ enabled: true, port: 9333 }))
    expect(errors.length).toBe(2)
    off()
  })
})
