import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALU_RIG } from '@onething/runtime/pets/builtin/alu.rig'
import type { AppSettings } from '@shared/ipc/settings'
import { configurePetPort, resetPetSource } from '../../../data/pet-source'
import type { ResourcePort } from '../../../data/resource-port'
import {
  configurePetSettingsPort,
  resetPetSettingsSource,
  type PetSettingsPort,
} from '../../../data/pet-settings-source'
import { zh } from '../../../i18n/zh'
import { useStageStore } from '../../../stage/store'
import { en } from '../../../i18n/en'
import { SETTINGS_PAGES } from '../pages'
import { PET_PREVIEW_BUSY_MS, PetSettings } from '../PetSettings'

/**
 * 设置「宠物」页(宠物 P5,§12.6 第四条):
 *  ① 读到:当前那只选中、频率按设置选中、说明句跟着档位走;
 *  ② 换宠物乐观选中,成功落定;失败回到原选中 + 目标卡片下一行错话,下一次操作清掉;
 *     在飞时再点另一张,以最后一次为准;
 *  ③ 换频率整份写回、只动 `pets.chattiness`;
 *  ④ 试听说的是那一只的 sample;被挡 → 一行「它正在说话。」,3s 后消失;
 *  ⑤ 无宠物(名册读不到)→ 整页一句;
 *  ⑥ 文案逐字(§12.4 那张表);页在「通用」之后。
 */

const ROSTER = {
  pets: [
    { id: 'heidou', name: '黑豆', rig: 'heidou-svg', sample: '我是黑豆。今晚想听点什么？' },
    { id: 'alu', name: '阿绿', rig: ALU_RIG, sample: '我是阿绿！我是阿绿！' },
  ],
}

interface Deferred {
  resolve: (outcome: Awaited<ReturnType<ResourcePort['do']>>) => void
}

function petPort(options: { current?: string; rosterFails?: boolean } = {}) {
  let current = options.current ?? 'heidou'
  const doCalls: Array<{ op: string; params: unknown }> = []
  const pending: Deferred[] = []
  const port: ResourcePort = {
    ready: async () => undefined,
    read: async (_ref, name) => {
      if (name === 'roster') {
        return options.rosterFails ? { kind: 'invalid', message: 'No resource named pet:' } : { kind: 'ok', value: ROSTER }
      }
      const pet = ROSTER.pets.find((p) => p.id === current)!
      return { kind: 'ok', value: { pet: { id: pet.id, name: pet.name, rig: pet.rig }, speaking: false, utterances: [] } }
    },
    do: (_ref, op, params) => {
      doCalls.push({ op, params })
      return new Promise((resolve) => {
        pending.push({
          resolve: (outcome) => {
            if (op === 'adopt' && outcome.kind === 'ok') current = (params as { id: string }).id
            resolve(outcome)
          },
        })
      })
    },
    onResourceEvent: () => () => undefined,
  }
  return { port, doCalls, pending }
}

function settingsPort(chattiness: 'quiet' | 'balanced' | 'chatty' = 'balanced') {
  const saves: AppSettings[] = []
  let settings = { theme: 'dark', pets: { chattiness }, search: { semantic: { enabled: true, modelId: 'm' } } } as unknown as AppSettings
  const port: PetSettingsPort = {
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings }),
    saveSettings: async (next) => {
      saves.push(next)
      settings = next
      return { success: true, settings: next }
    },
  }
  return { port, saves }
}

async function mount() {
  render(<PetSettings />)
  await waitFor(() => expect(screen.getByTestId('pet-tile-alu')).toBeTruthy())
}

const checked = (id: string) => screen.getByTestId(`pet-tile-${id}`).getAttribute('aria-checked')

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetPetSource()
  resetPetSettingsSource()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  configurePetPort(undefined)
  configurePetSettingsPort(undefined)
  resetPetSource()
  resetPetSettingsSource()
})

describe('PetSettings', () => {
  it('reads: the current pet is checked, the level is selected, and its hint follows', async () => {
    configurePetPort(petPort({ current: 'alu' }).port)
    configurePetSettingsPort(settingsPort('quiet').port)
    await mount()
    await waitFor(() => expect(checked('alu')).toBe('true'))
    expect(checked('heidou')).toBe('false')
    expect(screen.getByText('话不多，爱学你说话的绿鹦鹉。')).toBeTruthy()
    expect(screen.getByText('住在唱机上的黑猫，眼睛是两张小唱片。')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('pet-settings-level-hint').textContent).toBe('只在电台换歌时说话。'))
    expect(screen.getByRole('radio', { name: '安静' }).getAttribute('aria-checked')).toBe('true')
    // 两张卡的形象都画出来了:黑豆是手画的,阿绿是解释器画的。
    expect(screen.getByTestId('pet-tile-alu').querySelector('[data-part="skull"]')).not.toBeNull()
    expect(screen.getByTestId('pet-tile-heidou').querySelector('[data-testid="pet-rig"]')).not.toBeNull()
  })

  it('first load: tiles and levels hold their place but draw nothing', () => {
    const never: ResourcePort = { ready: () => new Promise(() => undefined), read: async () => ({ kind: 'ok', value: null }), do: async () => ({ kind: 'ok', text: '' }), onResourceEvent: () => () => undefined }
    configurePetPort(never)
    configurePetSettingsPort({ ready: () => new Promise(() => undefined), readSettings: async () => ({ success: false }), saveSettings: async () => ({ success: false }) })
    render(<PetSettings />)
    expect(screen.getByTestId('pet-settings-tiles').children).toHaveLength(0)
    expect(screen.getByTestId('pet-settings-tiles').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('pet-settings-levels').children).toHaveLength(0)
  })

  it('adopt is optimistic and settles on success', async () => {
    const pet = petPort()
    configurePetPort(pet.port)
    configurePetSettingsPort(settingsPort().port)
    await mount()
    await waitFor(() => expect(checked('heidou')).toBe('true'))
    fireEvent.click(screen.getByTestId('pet-tile-alu'))
    expect(checked('alu')).toBe('true')
    expect(checked('heidou')).toBe('false')
    await waitFor(() => expect(pet.doCalls).toEqual([{ op: 'adopt', params: { id: 'alu' } }]))
    await act(async () => pet.pending[0].resolve({ kind: 'ok', text: '{}' }))
    await waitFor(() => expect(checked('alu')).toBe('true'))
  })

  it('a failed adopt rolls back and says so under that tile; the next action clears it', async () => {
    const pet = petPort()
    configurePetPort(pet.port)
    configurePetSettingsPort(settingsPort().port)
    await mount()
    await waitFor(() => expect(checked('heidou')).toBe('true'))
    fireEvent.click(screen.getByTestId('pet-tile-alu'))
    await waitFor(() => expect(pet.pending).toHaveLength(1))
    await act(async () => pet.pending[0].resolve({ kind: 'failed', error: { name: 'Error', message: 'nope' } }))
    await waitFor(() => expect(checked('heidou')).toBe('true'))
    expect(screen.getByTestId('pet-tile-error-alu').textContent).toBe('没换成，再点一次试试。')
    fireEvent.click(screen.getByTestId('pet-tile-heidou'))
    expect(screen.queryByTestId('pet-tile-error-alu')).toBeNull()
  })

  it('while one adopt is in flight another click wins', async () => {
    const pet = petPort()
    configurePetPort(pet.port)
    configurePetSettingsPort(settingsPort().port)
    await mount()
    await waitFor(() => expect(checked('heidou')).toBe('true'))
    fireEvent.click(screen.getByTestId('pet-tile-alu'))
    fireEvent.click(screen.getByTestId('pet-tile-heidou'))
    expect(checked('heidou')).toBe('true')
    await waitFor(() => expect(pet.pending).toHaveLength(2))
    // 第一发晚到失败:不是最后一次,屏上不动、不出错话。
    await act(async () => pet.pending[0].resolve({ kind: 'failed', error: { name: 'Error', message: 'late' } }))
    expect(screen.queryByTestId('pet-tile-error-alu')).toBeNull()
    expect(checked('heidou')).toBe('true')
    await act(async () => pet.pending[1].resolve({ kind: 'ok', text: '{}' }))
    await waitFor(() => expect(checked('heidou')).toBe('true'))
  })

  it('changing the level writes the whole settings back with only pets.chattiness changed', async () => {
    configurePetPort(petPort().port)
    const settings = settingsPort()
    configurePetSettingsPort(settings.port)
    await mount()
    await waitFor(() => expect(screen.getByRole('radio', { name: '适中' }).getAttribute('aria-checked')).toBe('true'))
    await act(async () => void fireEvent.click(screen.getByRole('radio', { name: '话多' })))
    expect(screen.getByTestId('pet-settings-level-hint').textContent).toBe('有什么说什么。')
    await waitFor(() => expect(settings.saves).toHaveLength(1))
    expect(settings.saves[0].pets).toEqual({ chattiness: 'chatty' })
    expect(settings.saves[0].search).toEqual({ semantic: { enabled: true, modelId: 'm' } })
  })

  it('preview says the selected pet\'s sample; when blocked it shows a line for 3s', async () => {
    const pet = petPort({ current: 'alu' })
    configurePetPort(pet.port)
    configurePetSettingsPort(settingsPort().port)
    await mount()
    await waitFor(() => expect(checked('alu')).toBe('true'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(screen.getByTestId('pet-settings-preview'))
    await waitFor(() => expect(pet.doCalls).toEqual([{ op: 'say', params: { mode: 'speak', text: '我是阿绿！我是阿绿！' } }]))
    await act(async () => pet.pending[0].resolve({ kind: 'ok', text: '{"said":false,"reason":"busy"}' }))
    await waitFor(() => expect(screen.getByTestId('pet-settings-preview-busy').textContent).toBe('它正在说话。'))
    await act(async () => {
      vi.advanceTimersByTime(PET_PREVIEW_BUSY_MS)
    })
    expect(screen.queryByTestId('pet-settings-preview-busy')).toBeNull()
  })

  it('a preview that was said shows no line', async () => {
    const pet = petPort()
    configurePetPort(pet.port)
    configurePetSettingsPort(settingsPort().port)
    await mount()
    await waitFor(() => expect(checked('heidou')).toBe('true'))
    fireEvent.click(screen.getByTestId('pet-settings-preview'))
    await waitFor(() => expect(pet.pending).toHaveLength(1))
    await act(async () => pet.pending[0].resolve({ kind: 'ok', text: '{"said":true,"utterance":{}}' }))
    expect(screen.queryByTestId('pet-settings-preview-busy')).toBeNull()
  })

  it('no pet on this host: the whole page is one sentence', async () => {
    configurePetPort(petPort({ rosterFails: true }).port)
    configurePetSettingsPort(settingsPort().port)
    render(<PetSettings />)
    await waitFor(() => expect(screen.getByTestId('pet-settings-none').textContent).toBe('这台设备上没有宠物。'))
    expect(screen.queryByTestId('pet-settings-tiles')).toBeNull()
    expect(screen.queryByTestId('pet-settings-preview')).toBeNull()
  })
})

describe('PetSettings · copy and placement (§12.4)', () => {
  it('uses the fixed copy in both languages', () => {
    expect([zh['settings.pagePet'], en['settings.pagePet']]).toEqual(['宠物', 'Pet'])
    expect([zh['pet.settings.intro'], en['pet.settings.intro']]).toEqual(['住在应用里陪你的那只小家伙。', 'The little one that keeps you company in the app.'])
    expect([zh['pet.settings.who'], en['pet.settings.who']]).toEqual(['谁陪你', 'Who keeps you company'])
    expect([zh['pet.settings.chattiness'], en['pet.settings.chattiness']]).toEqual(['多久开口一次', 'How often it talks'])
    expect([zh['pet.settings.quiet'], zh['pet.settings.balanced'], zh['pet.settings.chatty']]).toEqual(['安静', '适中', '话多'])
    expect([en['pet.settings.quiet'], en['pet.settings.balanced'], en['pet.settings.chatty']]).toEqual(['Quiet', 'Balanced', 'Chatty'])
    expect([zh['pet.settings.quietHint'], zh['pet.settings.balancedHint'], zh['pet.settings.chattyHint']]).toEqual(['只在电台换歌时说话。', '偶尔聊两句。', '有什么说什么。'])
    expect([en['pet.settings.quietHint'], en['pet.settings.balancedHint'], en['pet.settings.chattyHint']]).toEqual([
      'Only speaks between songs on the radio.',
      'Chats now and then.',
      'Says what’s on its mind.',
    ])
    expect([zh['pet.settings.preview'], en['pet.settings.preview']]).toEqual(['让它说句话', 'Hear it talk'])
    expect([zh['pet.settings.previewBusy'], en['pet.settings.previewBusy']]).toEqual(['它正在说话。', 'It’s already talking.'])
    expect([zh['pet.settings.none'], en['pet.settings.none']]).toEqual(['这台设备上没有宠物。', 'No pet on this device.'])
    expect([zh['pet.heidou.blurb'], en['pet.heidou.blurb']]).toEqual(['住在唱机上的黑猫，眼睛是两张小唱片。', 'A black cat living on the turntable, with two tiny records for eyes.'])
    expect([zh['pet.alu.blurb'], en['pet.alu.blurb']]).toEqual(['话不多，爱学你说话的绿鹦鹉。', 'A quiet green parrot that likes to repeat what you say.'])
  })

  it('sits right after General (there is no Music page)', () => {
    const ids = SETTINGS_PAGES.map((page) => page.id)
    expect(ids.indexOf('pet')).toBe(ids.indexOf('general') + 1)
  })
})
