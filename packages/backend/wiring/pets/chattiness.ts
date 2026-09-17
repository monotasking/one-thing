/**
 * **开口频率热生效**(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.4)。
 *
 * 设置 `pets.chattiness` 一保存,宠物子系统当场换档:读初值交给构造,之后订「设置刚保存过」
 * 调 `setChattiness`。档位的含义(冷却几秒、哪些 `low` 也开口)住产品层那张表
 * (`@onething/runtime/pets` 的 `PET_CHATTINESS`),这里只搬一个档名。
 *
 * **串联,不是占槽** —— 与 `wiring/search/index.ts` 的 `watchSettingsChanged` 同一条判例:
 * 设置推送是单槽端口,直接写进去会把宿主那条推送(SSE)掐掉。先让上一位走,再干自己的;
 * 还原带身份守卫,后来又有人串了一层时不抹掉它。**settings 域一个字都不知道有宠物。**
 */

import { normalizePetChattiness, type PetChattiness } from '@onething/runtime/pets'
import type { AppSettings } from '@shared/ipc/settings.js'
import { getLogger } from '../logging/index.js'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
  type SettingsEventBroadcaster,
} from '../settings/events.js'

const log = getLogger('pets')

/** 设置里的档。缺席 / 不认识 = 缺省档。 */
export function petChattinessOf(settings: Pick<AppSettings, 'pets'> | undefined): PetChattiness {
  return normalizePetChattiness(settings?.pets?.chattiness)
}

/** 谁要换档。只要这一口 —— 测试不必起一整只子系统。 */
export interface PetChattinessTarget {
  setChattiness(level: PetChattiness): void
}

/** 订设置保存,换档。返回幂等退订。 */
export function watchPetChattiness(target: PetChattinessTarget): () => void {
  const previous = getSettingsEventBroadcaster()
  const ours: SettingsEventBroadcaster = event => {
    previous?.(event)
    try {
      target.setChattiness(petChattinessOf(event.settings))
    } catch (error) {
      log.warn('applying pet chattiness failed', {}, error)
    }
  }
  configureSettingsEventBroadcaster(ours)
  return () => {
    if (getSettingsEventBroadcaster() !== ours) return
    configureSettingsEventBroadcaster(previous)
  }
}
