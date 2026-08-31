import { useCallback, useEffect, useMemo } from 'react'
import { Button } from '../../ui/Button'
import { useT } from '../../i18n'
import type { ProviderConfig } from '@shared/ipc/providers'
import { useProviderSettings } from '../store'
import { buildFamilies, findFamily, resolveMode } from '../families'
import {
  buildCatalogRows,
  buildRailRows,
  connectedCountOf,
  credentialFactsOf,
  filterRailRows,
  isModeConfigured,
  modeTabsOf,
} from '../projection'
import { ProviderRail } from './ProviderRail'
import { ProviderDetail } from './ProviderDetail'
import { ModelCatalog } from './ModelCatalog'
import { isProviderEnabledIn } from '@renderer/stores/helpers/provider-model'
import s from './ProviderSettingsPanel.module.css'

/**
 * 「模型服务」= 一块**普通的 Dock 内容**(id 'providers'),所以它能上舞台 /
 * 变浮窗 / 钉到边,三种形态里长得一模一样 —— 这正是 `content/index.tsx` 那张表
 * 存在的理由。它一点特权都没有:不自己 portal、不自己管 z 层、不知道自己被摆在哪。
 *
 * ── 这块组件的全部职责 ────────────────────────────────────────────────────
 * 把 store 里的原始事实**接到判据上**,再把判据的结果交给三块哑组件。它自己不推导
 * 任何一件事:哪一家算一家在 families.ts,副行说什么在 projection.ts,写怎么合并
 * 在 store.ts。所以这里的每一个 useMemo 都只是「把参数摆好」。
 *
 * ── 缺席态清单(批一)────────────────────────────────────────────────────
 * OAuth 登录流 / 多钥列表与轮换 / 订阅用量卡 / 单模型覆盖 / 新建自定义家 ——
 * 五件都不做,对应位置画禁用钮 + 一句「在下一批」。**一个假流程都没有。**
 */

const EMPTY_CONFIGS: Readonly<Record<string, ProviderConfig>> = {}

export function ProviderSettingsPanel() {
  const t = useT()

  const status = useProviderSettings((st) => st.status)
  const error = useProviderSettings((st) => st.error)
  const providers = useProviderSettings((st) => st.providers)
  const settings = useProviderSettings((st) => st.settings)
  const credentials = useProviderSettings((st) => st.credentials)
  const credentialsKnown = useProviderSettings((st) => st.credentialsKnown)
  const selectedFamilyId = useProviderSettings((st) => st.selectedFamilyId)
  const pickedMode = useProviderSettings((st) => st.pickedMode)
  const query = useProviderSettings((st) => st.query)
  const modelQuery = useProviderSettings((st) => st.modelQuery)
  const catalog = useProviderSettings((st) => st.catalog)
  const catalogStatus = useProviderSettings((st) => st.catalogStatus)
  const catalogError = useProviderSettings((st) => st.catalogError)
  const catalogFetchedAt = useProviderSettings((st) => st.catalogFetchedAt)
  const keyStatus = useProviderSettings((st) => st.keyStatus)
  const saving = useProviderSettings((st) => st.saving)

  const start = useProviderSettings((st) => st.start)
  const refresh = useProviderSettings((st) => st.refresh)
  const selectFamily = useProviderSettings((st) => st.selectFamily)
  const selectMode = useProviderSettings((st) => st.selectMode)
  const setQuery = useProviderSettings((st) => st.setQuery)
  const setModelQuery = useProviderSettings((st) => st.setModelQuery)
  const ensureCatalog = useProviderSettings((st) => st.ensureCatalog)
  const setFamilyEnabled = useProviderSettings((st) => st.setFamilyEnabled)
  const toggleModel = useProviderSettings((st) => st.toggleModel)
  const saveApiKey = useProviderSettings((st) => st.saveApiKey)

  useEffect(() => {
    void start()
  }, [start])

  const configs = settings?.ai?.providers ?? EMPTY_CONFIGS
  const customProviders = settings?.ai?.customProviders

  const families = useMemo(
    () => buildFamilies(providers, customProviders ?? []),
    [providers, customProviders],
  )

  const credsOf = useCallback(
    (providerId: string) => credentialFactsOf(credentials[providerId], credentialsKnown),
    [credentials, credentialsKnown],
  )

  const rows = useMemo(() => buildRailRows(families, configs, credsOf), [families, configs, credsOf])
  const visibleRows = useMemo(
    () => filterRailRows(rows, families, query),
    [rows, families, query],
  )
  const connected = useMemo(() => connectedCountOf(families, credsOf), [families, credsOf])

  // 开面落在第一家上。这不是「拿第一家去顶」—— 右面画的是那一家的真事实,
  // 只是替用户省掉必然要点的第一下。families 到齐之前不选,免得选中一个空 id。
  useEffect(() => {
    if (!selectedFamilyId && families.length > 0) selectFamily(families[0].id)
  }, [selectedFamilyId, families, selectFamily])

  const family = findFamily(families, selectedFamilyId)
  const mode = family
    ? resolveMode(family, pickedMode[family.id], (providerId) => {
        const candidate = family.modes.find((m) => m.providerId === providerId)
        return candidate ? isModeConfigured(candidate, credsOf(providerId)) : false
      })
    : null

  const modeCreds = mode ? credsOf(mode.providerId) : undefined
  // 未登录的订阅坑**没有目录可拉**(交接稿 §4b:不预渲猜测列表)。所以这里连
  // 请求都不发 —— 发一发再把空结果画成「这一坑还没有模型」就是编。
  const catalogAvailable = Boolean(
    mode && !(mode.kind === 'subscription' && !(modeCreds?.known && modeCreds.hasOAuth)),
  )
  const activeProviderId = mode?.providerId ?? ''

  useEffect(() => {
    if (!activeProviderId || !catalogAvailable) return
    void ensureCatalog(activeProviderId)
  }, [activeProviderId, catalogAvailable, ensureCatalog])

  const catalogRows = useMemo(
    () =>
      activeProviderId
        ? buildCatalogRows(
            catalog[activeProviderId] ?? [],
            configs[activeProviderId],
            modelQuery[activeProviderId] ?? '',
          )
        : [],
    [activeProviderId, catalog, configs, modelQuery],
  )

  const tabs = useMemo(() => (family ? modeTabsOf(family, credsOf) : []), [family, credsOf])

  if (status === 'loading' || status === 'idle') {
    return (
      <div className={s.panel}>
        <p className={s.state}>{t('providers.loading')}</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={s.panel}>
        <div className={s.state}>
          <span>
            {t('providers.loadFailed')}
            {error ? ` · ${error}` : ''}
          </span>
          <Button size="sm" onClick={() => void refresh()}>
            {t('providers.retry')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={s.panel} data-testid="providers-panel">
      <ProviderRail
        rows={visibleRows}
        connectedCount={connected}
        selectedId={selectedFamilyId}
        query={query}
        onQuery={setQuery}
        onSelect={selectFamily}
      />
      {family && mode ? (
        <ProviderDetail
          family={family}
          mode={mode}
          tabs={tabs}
          enabled={isProviderEnabledIn(configs, family.id)}
          saving={saving}
          credentials={credsOf(mode.providerId)}
          keyStatus={keyStatus[mode.providerId] ?? 'idle'}
          onToggleEnabled={(next) => void setFamilyEnabled(family, next)}
          onSelectMode={(providerId) => selectMode(family.id, providerId)}
          onSaveKey={(apiKey) => void saveApiKey(mode.providerId, apiKey)}
        >
          {catalogAvailable ? (
            <ModelCatalog
              rows={catalogRows}
              status={catalogStatus[mode.providerId] ?? 'idle'}
              error={catalogError[mode.providerId] || undefined}
              fetchedAt={catalogFetchedAt[mode.providerId]}
              kind={mode.kind}
              query={modelQuery[mode.providerId] ?? ''}
              saving={saving}
              onQuery={(value) => setModelQuery(mode.providerId, value)}
              onRefresh={() => void ensureCatalog(mode.providerId, true)}
              onToggle={(modelId, selected) => void toggleModel(mode.providerId, modelId, selected)}
            />
          ) : (
            <p className={s.locked}>{t('providers.subCatalogLocked')}</p>
          )}
        </ProviderDetail>
      ) : (
        <p className={s.detailState}>{t('providers.pickOne')}</p>
      )}
    </div>
  )
}
