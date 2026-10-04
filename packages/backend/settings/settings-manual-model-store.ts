/**
 * 手填模型的装配半边(批 2,`docs/design/provider-settings-rework-2026-09.md` §4)。
 *
 * 判据全在产品层的纯函数里(`@onething/backend/provider/manual-models`);这里只做
 * 装配层才知道的事 —— 目录住在全局 `ai.modelCatalog`、勾选住在每个空间的
 * `providers.json`,两半怎么读、怎么一发写完。
 *
 * 三个出口:
 *  - `foldedCatalogFor`         —— 读:目录 + 所有空间里「勾了但目录没有」的 id 折成手填条目
 *                                 (内存里,不写盘)。目录是机器级的,所以孤儿也按全机器收。
 *  - `add/removeManualModel`    —— `models.addManual` / `models.removeManual` 的实现;
 *  - `persistManualOrphans`     —— 任何一次空间 provider 设置的写(`spaces.setProviderSettings`,
 *                                 壳的勾选 / 取消勾选走的就是它)随手把折出来的条目落盘。
 *                                 看的是**写前 ∪ 写后**:取消勾选一个老孤儿,写后那一份里已经
 *                                 没有它了,只看写后就等于替用户把它删了。
 */
import type {
  AppSettings,
  CatalogModelEntry,
  ModelManualEditFailure,
  ModelManualEditRequest,
  ModelManualEditResponse,
  ProviderConfig,
  SpaceProviderSettings,
} from '@shared/ipc.js'
import {
  applyAddManualModel,
  applyRemoveManualModel,
  foldOrphansIntoManual,
  type ManualModelEditResult,
  type OnethingCatalogModelEntry,
} from '@onething/backend/provider'
import {
  createEmptySpaceProviderSettings,
  readSpaceProviderSettings,
} from '@onething/backend/space/space-provider-settings'
import { getSpacesStore } from '@onething/backend/space/space-store'
import { DEFAULT_SPACE_ID } from '@onething/backend/space/space-types'
import { getSettings, getSpaceSettings, saveSettings } from './settings-store.js'

type ConfigLike = { selectedModels?: unknown; model?: unknown } | undefined

function idsOf(config: ConfigLike): string[] {
  const out: string[] = []
  if (!config) return out
  if (Array.isArray(config.selectedModels)) {
    for (const id of config.selectedModels) if (typeof id === 'string') out.push(id)
  }
  if (typeof config.model === 'string') out.push(config.model)
  return out
}

/** 一个空间 provider 设置里,这一家(含自定义家)勾过 / 当前的全部 id。 */
function idsInSpaceSettings(
  ai: { providers?: Record<string, unknown>; customProviders?: unknown[] } | null | undefined,
  providerId: string,
): string[] {
  if (!ai) return []
  const custom = (ai.customProviders ?? []).find(
    (entry) => (entry as { id?: unknown } | undefined)?.id === providerId,
  ) as ConfigLike
  return [...idsOf(custom), ...idsOf(ai.providers?.[providerId] as ConfigLike)]
}

function spaceIds(): string[] {
  const ids = new Set<string>([DEFAULT_SPACE_ID])
  for (const space of getSpacesStore().list()) ids.add(space.id)
  return [...ids]
}

/** 这一家在整台机器上被勾过 / 当前的 id(默认空间的生效设置 ∪ 每个空间的 providers.json)。 */
function configuredIdsAcrossSpaces(providerId: string): string[] {
  const ids = idsInSpaceSettings(
    getSettings()?.ai as { providers?: Record<string, unknown> } | undefined,
    providerId,
  )
  for (const spaceId of spaceIds()) {
    ids.push(
      ...idsInSpaceSettings(
        readSpaceProviderSettings(spaceId) as { providers?: Record<string, unknown> } | null,
        providerId,
      ),
    )
  }
  return ids
}

function storedCatalogOf(providerId: string): Record<string, CatalogModelEntry> | undefined {
  return getSettings()?.ai?.providers?.[providerId]?.models
}

/**
 * 这一家的目录,老孤儿折成手填条目(**内存里**)。没有可折的就是盘上那一份原样。
 */
export function foldedCatalogFor(providerId: string): Record<string, OnethingCatalogModelEntry> {
  return foldOrphansIntoManual(
    {
      models: storedCatalogOf(providerId) as Record<string, OnethingCatalogModelEntry> | undefined,
      selectedModels: configuredIdsAcrossSpaces(providerId),
    },
    providerId,
  ).models ?? {}
}

function isKnownSpace(spaceId: string): boolean {
  return spaceId === DEFAULT_SPACE_ID || getSpacesStore().list().some((space) => space.id === spaceId)
}

function failure(reason: ModelManualEditFailure, error: string): ModelManualEditResponse {
  return { success: false, reason, error }
}

const FAILURE_WORDS: Record<ModelManualEditFailure, string> = {
  empty: 'model id is empty',
  duplicate: 'model is already selected in this space',
  'not-manual': 'model is not a manually added catalog entry',
  'last-selected': 'cannot remove the last selected model',
  'unknown-space': 'unknown space',
}

type ManualEditConfig = {
  models?: Record<string, OnethingCatalogModelEntry>
  selectedModels: string[]
  model: string
}

/**
 * 加 / 删共用的那一手:读这个空间的生效设置 → 折好目录 → 交给纯函数 → 两半一发写完。
 * `saveSettings(settings, { spaceId })` 本来就是「per-space 那一半进 providers.json,
 * 目录进 settings.json」的唯一拆分点,所以这里不自己拆。
 */
function editManual(
  request: ModelManualEditRequest | undefined,
  apply: (
    config: ManualEditConfig,
    providerId: string,
    modelId: string,
  ) => ManualModelEditResult<ManualEditConfig>,
): ModelManualEditResponse {
  const providerId = request?.providerId?.trim() ?? ''
  const modelId = request?.modelId?.trim() ?? ''
  if (!providerId || !modelId) return failure('empty', FAILURE_WORDS.empty)
  const spaceId = request?.spaceId?.trim() || DEFAULT_SPACE_ID
  if (!isKnownSpace(spaceId)) return failure('unknown-space', FAILURE_WORDS['unknown-space'])

  const settings = getSpaceSettings(spaceId)
  const ai = settings.ai
  const existing = ai.providers?.[providerId] as ProviderConfig | undefined
  const custom = ai.customProviders?.find((entry) => entry.id === providerId)
  const result = apply(
    {
      models: foldedCatalogFor(providerId),
      selectedModels: [...(existing?.selectedModels ?? custom?.selectedModels ?? [])],
      model: existing?.model ?? custom?.model ?? '',
    },
    providerId,
    modelId,
  )
  if (!result.ok) return failure(result.reason, FAILURE_WORDS[result.reason])

  const nextConfig: ProviderConfig = {
    ...(existing ?? { model: '', selectedModels: [] }),
    models: result.config.models as Record<string, CatalogModelEntry> | undefined,
    selectedModels: result.config.selectedModels,
    model: result.config.model,
  }
  const next: AppSettings = {
    ...settings,
    ai: { ...ai, providers: { ...(ai.providers ?? {}), [providerId]: nextConfig } },
  }
  saveSettings(next, { spaceId })
  return {
    success: true,
    ai: (readSpaceProviderSettings(spaceId) ?? createEmptySpaceProviderSettings()) as unknown as SpaceProviderSettings,
  }
}

export function addManualModel(request: ModelManualEditRequest | undefined): ModelManualEditResponse {
  return editManual(request, applyAddManualModel)
}

export function removeManualModel(request: ModelManualEditRequest | undefined): ModelManualEditResponse {
  return editManual(request, applyRemoveManualModel)
}

/**
 * 空间 provider 设置写完之后调:写前 ∪ 写后里「勾了但目录没有」的 id 折成手填条目落盘。
 * 没有可折的就一发都不写(常态)。
 */
export function persistManualOrphans(
  previous: { providers?: Record<string, unknown>; customProviders?: unknown[] } | null | undefined,
  next: { providers?: Record<string, unknown>; customProviders?: unknown[] } | null | undefined,
): void {
  const providerIds = new Set<string>()
  for (const ai of [previous, next]) {
    for (const id of Object.keys(ai?.providers ?? {})) providerIds.add(id)
    for (const custom of ai?.customProviders ?? []) {
      const id = (custom as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') providerIds.add(id)
    }
  }
  if (providerIds.size === 0) return

  const settings = getSettings()
  const providers = { ...(settings.ai?.providers ?? {}) }
  let changed = false
  for (const providerId of providerIds) {
    const config = providers[providerId]
    const stored = config?.models as Record<string, OnethingCatalogModelEntry> | undefined
    const folded = foldOrphansIntoManual(
      {
        models: stored,
        selectedModels: [
          ...idsInSpaceSettings(previous, providerId),
          ...idsInSpaceSettings(next, providerId),
        ],
      },
      providerId,
    )
    if (folded.models === stored) continue
    providers[providerId] = {
      ...(config ?? { model: '', selectedModels: [] }),
      models: folded.models as Record<string, CatalogModelEntry> | undefined,
    }
    changed = true
  }
  if (!changed) return
  saveSettings({ ...settings, ai: { ...settings.ai, providers } })
}
