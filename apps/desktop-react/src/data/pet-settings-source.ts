import {
  settingsRouter,
  DEFAULT_PET_CHATTINESS,
  type AppSettings,
  type GetSettingsResponse,
  type PetChattinessSetting,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'
import { t } from '../i18n'
import { notify } from '../services/notify'
import { createMutation, createQuery, type Mutation } from './kernel'

/**
 * 设置「宠物」页的**开口频率**那一格(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.4)。
 *
 * 只有这一格走设置(`pets.chattiness`):换哪一只宠物、试听,是 `pet:` 资源自己的做法,在
 * `pet-source.ts`。写法与 `search-settings-source.ts` 同形 —— 当场读一份新的当底本,只改自己
 * 那一格再整份写回;乐观补丁在前,失败回滚 + 一条通知。后端订 `settings:changed` 热换档,
 * 这里不必知道后端怎么换。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期(这条线不是组件,②③ 在 `content/settings/PetSettings.tsx` 头上)
 * ══════════════════════════════════════════════════════════════════════════
 *  · import:建一格空 query、一只空 mutation,零往返;
 *  · 首载:页挂载时 `ensure()` 一次;
 *  · 写:乐观补丁 → 读新底本 → 写回;失败回滚 + 通知;
 *  · HMR:`resetPetSettingsSource()`。
 */

export interface PetSettingsPort {
  ready(): Promise<unknown>
  readSettings(): Promise<GetSettingsResponse>
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
}

let port: PetSettingsPort | undefined
let pending: Promise<PetSettingsPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configurePetSettingsPort(next: PetSettingsPort | undefined): void {
  port = next
  pending = undefined
}

/** 真实现是**惰性**建的,理由与 `search-settings-port` 逐字相同。 */
async function realPort(): Promise<PetSettingsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(settingsRouter)
  return {
    ready: () => whenConnected(),
    readSettings: () => api.getSettings({}),
    saveSettings: (settings) => api.saveSettings(settings),
  }
}

function petSettingsPort(): Promise<PetSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

export const PET_CHATTINESS_LEVELS: readonly PetChattinessSetting[] = ['quiet', 'balanced', 'chatty']

/** 设置里读出来的档。不认识 = 缺省档(与后端归一同一条)。 */
export function chattinessOf(settings: Pick<AppSettings, 'pets'> | undefined): PetChattinessSetting {
  const value = settings?.pets?.chattiness
  return value !== undefined && PET_CHATTINESS_LEVELS.includes(value) ? value : DEFAULT_PET_CHATTINESS
}

async function readFresh(): Promise<AppSettings> {
  const p = await petSettingsPort()
  await p.ready()
  const response = await p.readSettings()
  if (!response.success || !response.settings) throw new Error(response.error || 'settings.getSettings 未成功')
  return response.settings
}

export const petChattinessQuery = createQuery<PetChattinessSetting>('pet.chattiness', async () =>
  chattinessOf(await readFresh()),
)

export const setPetChattinessMutation: Mutation<PetChattinessSetting, void> = createMutation<PetChattinessSetting, void>(
  'pet.setChattiness',
  {
    optimistic: (level) => petChattinessQuery.patch(level),
    run: async (level) => {
      const current = await readFresh()
      const p = await petSettingsPort()
      const response = await p.saveSettings({ ...current, pets: { ...current.pets, chattiness: level } })
      if (!response.success) throw new Error(response.error || 'settings.saveSettings 未成功')
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.pets',
        title: t('pet.settings.chattinessSaveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
  },
)

export function resetPetSettingsSource(): void {
  petChattinessQuery.reset()
  setPetChattinessMutation.reset()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetPetSettingsSource)
}
