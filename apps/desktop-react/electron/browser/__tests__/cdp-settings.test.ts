/**
 * B2′ 的主进程单元用例:设置里那一格 → 启动旗文件,以及发现文件补的那一格。
 *
 * **一条 `import … from 'electron'` 都没有**(与 `browser-host.test.ts` 同一条
 * 结构判据):`app.commandLine` 与那个单槽端口在被测模块那一侧都是注入的结构化
 * 端口,这里喂的是记调用的替身。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import type { SettingsEvent, SettingsEventBroadcaster } from '@onething/backend/wiring/settings/events.js'

import { getCdpFlagPath, readCdpLaunchFlag } from '../cdp-flag.js'
import {
  CDP_SWITCH_NAME,
  cdpDiscoveryExtras,
  cdpFlagFromSettings,
  installCdpSettingsWatcher,
} from '../cdp-settings.js'

/** 只带这一节要的两格 —— `AppSettings` 那 17 段与这件事无关。 */
function settingsWith(cdp: { enabled: boolean; port: number } | undefined): Pick<AppSettings, 'browser'> {
  return cdp ? { browser: { cdp } } : {}
}

/** 单槽端口的替身:一个格子 + 读写两口,与真端口逐格同形。 */
function fakeBroadcasterSlot() {
  let slot: SettingsEventBroadcaster | null = null
  return {
    get: () => slot,
    set: (next: SettingsEventBroadcaster | null) => { slot = next },
    emit: (settings: Pick<AppSettings, 'browser'>) => {
      slot?.({ type: 'settings:changed', settings: settings as AppSettings } satisfies SettingsEvent)
    },
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
    const slot = fakeBroadcasterSlot()
    const off = installCdpSettingsWatcher({
      storePath: store,
      readSettings: () => settingsWith({ enabled: true, port: 9444 }),
      getBroadcaster: slot.get,
      setBroadcaster: slot.set,
    })
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9444 })
    off()
  })

  it('**关 → 删旗**:一次 settings:changed 把开着的那份关掉,盘上那份就没了', () => {
    const slot = fakeBroadcasterSlot()
    const off = installCdpSettingsWatcher({
      storePath: store,
      readSettings: () => settingsWith({ enabled: true, port: 9333 }),
      getBroadcaster: slot.get,
      setBroadcaster: slot.set,
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

  it('单槽端口是**串联**不是覆盖:前一个照样收得到每一条', () => {
    const slot = fakeBroadcasterSlot()
    const seen: string[] = []
    const previous: SettingsEventBroadcaster = event => { seen.push(event.type) }
    slot.set(previous)

    const off = installCdpSettingsWatcher({
      storePath: store,
      readSettings: () => settingsWith({ enabled: false, port: 9333 }),
      getBroadcaster: slot.get,
      setBroadcaster: slot.set,
    })
    slot.emit(settingsWith({ enabled: true, port: 9333 }))
    expect(seen).toEqual(['settings:changed'])
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9333 })

    // 摘掉之后:那一格**原样装回前一个**,不是 null —— 内嵌 HTTP 面的扇出
    // 还在它上面挂着。
    off()
    expect(slot.get()).toBe(previous)
    off() // 幂等
    expect(slot.get()).toBe(previous)
  })

  it('摘掉之后不再跟着设置走', () => {
    const slot = fakeBroadcasterSlot()
    const off = installCdpSettingsWatcher({
      storePath: store,
      readSettings: () => settingsWith({ enabled: true, port: 9333 }),
      getBroadcaster: slot.get,
      setBroadcaster: slot.set,
    })
    off()
    slot.emit(settingsWith({ enabled: false, port: 9333 }))
    expect(readCdpLaunchFlag(store)).toEqual({ port: 9333 })
  })

  it('写砸了只报一声,不抛 —— 这一格的后果只是「下次启动没跟上」', () => {
    const slot = fakeBroadcasterSlot()
    const errors: unknown[] = []
    // 一条指向**文件**的「store 根」:`mkdirSync` 在它下面建 `run/` 必然 ENOTDIR。
    const blocked = path.join(store, 'not-a-dir')
    fs.writeFileSync(blocked, 'x')
    const off = installCdpSettingsWatcher({
      storePath: blocked,
      readSettings: () => settingsWith({ enabled: true, port: 9333 }),
      getBroadcaster: slot.get,
      setBroadcaster: slot.set,
      onError: error => { errors.push(error) },
    })
    expect(errors.length).toBe(1)
    // 订上去那一半照样成立:一次写失败不该把这条路整个摘掉。
    slot.emit(settingsWith({ enabled: true, port: 9333 }))
    expect(errors.length).toBe(2)
    off()
  })
})

describe('cdpDiscoveryExtras', () => {
  const commandLine = (value: string | undefined) => ({
    hasSwitch: (name: string) => name === CDP_SWITCH_NAME && value !== undefined,
    getSwitchValue: () => value ?? '',
  })

  it('命令行上开着 → 补 cdp 那一格', () => {
    expect(cdpDiscoveryExtras(commandLine('9333'))).toEqual({ cdp: { port: 9333 } })
  })

  it('没开 → undefined,于是 `cdp` 这个键根本不出现在发现文件里', () => {
    expect(cdpDiscoveryExtras(commandLine(undefined))).toBeUndefined()
  })

  it('值不是一个合法端口 → 当没开(空串 / 0 / 非数字)', () => {
    expect(cdpDiscoveryExtras(commandLine(''))).toBeUndefined()
    expect(cdpDiscoveryExtras(commandLine('0'))).toBeUndefined()
    expect(cdpDiscoveryExtras(commandLine('nope'))).toBeUndefined()
  })
})
