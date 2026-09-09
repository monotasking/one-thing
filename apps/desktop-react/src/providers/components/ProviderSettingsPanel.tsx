import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../ui/Button'
import { useT } from '../../i18n'
import type { CustomProviderConfig, ProviderConfig } from '@shared/ipc/providers'
import { useProviderSettings, authFlowOf, settingsKey, settingsMutation } from '../store'
import type { CustomProviderForm } from '../store'
import { buildFamilies, findFamily, resolveMode } from '../families'
import {
  buildCatalogRows,
  buildRailRows,
  connectedCountOf,
  credentialFactsOf,
  filterRailRows,
  isModeConfigured,
  modeTabsOf,
  poolViewOf,
} from '../projection'
import { ProviderRail } from './ProviderRail'
import { ProviderRowMenu } from './ProviderRowMenu'
import { ProviderDetail } from './ProviderDetail'
import { ModeCard } from './ModeCard'
import { ModelCatalog } from './ModelCatalog'
import { catalogQuery } from '../catalog-query'
import { useAsyncPending, useMutation, useQuery } from '../../data/kernel'
import { CustomProviderDialog } from './CustomProviderDialog'
import { isProviderEnabledIn } from '@onething/client/model/provider-model'
import s from './ProviderSettingsPanel.module.css'

/**
 * 「模型服务」= 一块**普通的 Dock 内容**(id 'providers'),所以它能上舞台 /
 * 变浮窗 / 钉到边,三种形态里长得一模一样 —— 这正是 `content/index.tsx` 那张表
 * 存在的理由。它一点特权都没有:不自己 portal、不自己管 z 层、不知道自己被摆在哪。
 *
 * ── 这块组件的全部职责 ────────────────────────────────────────────────────
 * 把 store 里的原始事实**接到判据上**,再把判据的结果交给几块哑组件。它自己不推导
 * 任何一件事:哪一家算一家在 families.ts,副行说什么、目录怎么折叠、池怎么读
 * 在 projection.ts,写怎么合并在 store.ts,计费档位那张表在 dials.ts。
 * 所以这里的每一个 useMemo 都只是「把参数摆好」。
 *
 * ── 批二之后还缺席的 ──────────────────────────────────────────────────────
 * 本机坑(ACP / Claude Code Agent)的探测与启动配置、单模型覆盖页(容量 / 能力
 * 三态 / 参数档位)。两处仍然一个假流程都没有:该说「下一批」的地方就那么说。
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
  const poolBusy = useProviderSettings((st) => st.poolBusy)
  const poolError = useProviderSettings((st) => st.poolError)
  const authStatus = useProviderSettings((st) => st.authStatus)
  // `authFlow` 那张表不在这里订 —— 只有当下这一坑的那一条要画,读法在下面的
  // `authFlowOf` 选择器里(订整张表会让别家的登录流也把这块面重渲一遍)。
  const usage = useProviderSettings((st) => st.usage)
  const usageStatus = useProviderSettings((st) => st.usageStatus)
  const usageError = useProviderSettings((st) => st.usageError)

  const start = useProviderSettings((st) => st.start)
  const refresh = useProviderSettings((st) => st.refresh)
  const selectFamily = useProviderSettings((st) => st.selectFamily)
  const selectMode = useProviderSettings((st) => st.selectMode)
  const setQuery = useProviderSettings((st) => st.setQuery)
  const setModelQuery = useProviderSettings((st) => st.setModelQuery)
  const setFamilyEnabled = useProviderSettings((st) => st.setFamilyEnabled)
  const toggleModel = useProviderSettings((st) => st.toggleModel)
  const setCurrentModel = useProviderSettings((st) => st.setCurrentModel)
  const addManualModel = useProviderSettings((st) => st.addManualModel)
  const removeManualModel = useProviderSettings((st) => st.removeManualModel)
  const setModelOverride = useProviderSettings((st) => st.setModelOverride)
  const addCredential = useProviderSettings((st) => st.addCredential)
  const replaceCredential = useProviderSettings((st) => st.replaceCredential)
  const relabelCredential = useProviderSettings((st) => st.relabelCredential)
  const removeCredential = useProviderSettings((st) => st.removeCredential)
  const moveCredential = useProviderSettings((st) => st.moveCredential)
  const setRotation = useProviderSettings((st) => st.setRotation)
  const setDials = useProviderSettings((st) => st.setDials)
  const setBaseUrl = useProviderSettings((st) => st.setBaseUrl)
  const checkAuth = useProviderSettings((st) => st.checkAuth)
  const startAuth = useProviderSettings((st) => st.startAuth)
  const setAuthCode = useProviderSettings((st) => st.setAuthCode)
  const submitAuthCode = useProviderSettings((st) => st.submitAuthCode)
  const cancelAuth = useProviderSettings((st) => st.cancelAuth)
  const signOut = useProviderSettings((st) => st.signOut)
  const loadUsage = useProviderSettings((st) => st.loadUsage)
  const saveCustomProvider = useProviderSettings((st) => st.saveCustomProvider)
  const deleteCustomProvider = useProviderSettings((st) => st.deleteCustomProvider)

  /** 自定义家的编辑弹窗。`editingId: null` = 新建。 */
  /**
   * 右键菜单开在哪一行、哪个坐标。**只存坐标与 id** —— 那一行的事实(名字、
   * 是不是自定义、启没启用)现算,不在这里存第二份:存了它就会在改名 / 开关
   * 之后说旧话(与 `views` 那一族「投影只发生一次」同理)。
   */
  const [rowMenu, setRowMenu] = useState<{ familyId: string; x: number; y: number } | null>(null)
  const [customDialog, setCustomDialog] = useState<{ open: boolean; editingId?: string }>({
    open: false,
  })

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
  const visibleRows = useMemo(() => filterRailRows(rows, families, query), [rows, families, query])
  const connected = useMemo(() => connectedCountOf(families, credsOf), [families, credsOf])

  // 开面落在第一家上。这不是「拿第一家去顶」—— 右面画的是那一家的真事实,
  // 只是替用户省掉必然要点的第一下。families 到齐之前不选,免得选中一个空 id。
  useEffect(() => {
    if (!selectedFamilyId && families.length > 0) selectFamily(families[0].id)
  }, [selectedFamilyId, families, selectFamily])

  const family = findFamily(families, selectedFamilyId)

  /**
   * 右键菜单此刻说的是哪一家。**现算** —— 那一行被改名 / 被删掉之后,
   * 这里自然就没有了(菜单跟着消失),不会留着一份说旧话的快照。
   */
  const rowMenuTarget = useMemo(() => {
    if (!rowMenu) return null
    const view = findFamily(families, rowMenu.familyId)
    if (!view) return null
    return { id: view.id, label: view.label, custom: view.custom === true, view }
  }, [rowMenu, families])
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
  const subscription = mode?.kind === 'subscription'

  /*
   * ── 忙态是**逐格**的,不是一颗 ────────────────────────────────────────────
   * 设置写路整只是一发 mutation(`settingsMutation`),它按 `settingsKey` 那张
   * 词表分格记账。这块面在这里做的只有一件事:把「此刻在飞的那些格」翻译成
   * 各个控件要的读数 —— 谁也不必知道别人在不在写。
   *
   * 从前这里读的是 store 上一颗 `saving`,于是勾一个模型 = 整张目录 + 家头开关
   * + 编辑钮 + 档位一起禁灰(09-01 报障「勾选闪烁」,病型 B)。
   *
   * `pendingModelIds` **必须在选择器外面** useMemo:zustand / useSyncExternalStore
   * 都是拿引用比上一帧的快照,选择器里现算一个 `new Set` 每帧都是新引用,
   * 表现为整面卡死(单测里是 "Maximum update depth exceeded")——
   * 与本文件下面那段 `poolViewOf` 是同一条判例。
   */
  const writes = useMutation(settingsMutation)
  const pendingModelIds = useMemo(() => {
    const prefix = settingsKey.modelPrefix(activeProviderId)
    const ids = new Set<string>()
    for (const key of writes.pendingKeys) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length))
    }
    return ids
  }, [writes.pendingKeys, activeProviderId])

  /*
   * 家头开关 / 自定义定义 / 计费档位各读自己那一格。`family` 缺席时给一个
   * **永远不会被占用的 key**,而不是不传 —— 不传 = 问整体 = 又变回一颗全局忙布尔。
   */
  const enabledPending = useAsyncPending(
    settingsMutation,
    family ? settingsKey.family(family) : 'family:',
  )
  const customPending = useAsyncPending(settingsMutation, settingsKey.custom(family?.id ?? ''))
  const dialsPending = useAsyncPending(settingsMutation, settingsKey.dials(activeProviderId))

  useEffect(() => {
    if (!activeProviderId || !catalogAvailable) return
    void catalogQuery.get(activeProviderId).ensure()
  }, [activeProviderId, catalogAvailable])

  // 订阅坑一露面就问一次登录态。**「登没登」是后端说了算**,凭证摘要里那一格
  // 只说得出「池子里有没有一条 oauth」,说不出令牌过没过期。
  useEffect(() => {
    if (!activeProviderId || !subscription) return
    void checkAuth(activeProviderId)
  }, [activeProviderId, subscription, checkAuth])

  // 登上了才问用量:没登录时那一口必然答不出东西,问它只是白等一轮。
  const signedIn = authStatus[activeProviderId]?.isLoggedIn === true
  useEffect(() => {
    if (!activeProviderId || !subscription || !signedIn) return
    void loadUsage(activeProviderId)
  }, [activeProviderId, subscription, signedIn, loadUsage])

  /*
   * 目录不再来自 store 的四张表(K1 样板迁移):它是一族 kernel query,
   * 一坑一格。`catalogQuery.get('')` 在还没选中任何一坑时也建得出来 ——
   * 那一格永远不会被 ensure,所以不会发出一次空请求;这么写只是为了让
   * hook 无条件地调(hooks 不许有条件)。
   */
  const catalog = useQuery(catalogQuery.get(activeProviderId))

  const catalogRows = useMemo(
    () =>
      activeProviderId
        ? buildCatalogRows(
            catalog.data ?? [],
            configs[activeProviderId],
            modelQuery[activeProviderId] ?? '',
          )
        : [],
    [activeProviderId, catalog.data, configs, modelQuery],
  )

  const tabs = useMemo(() => (family ? modeTabsOf(family, credsOf) : []), [family, credsOf])

  /*
   * 池视图**必须先选原料、再在外面算**,不能把 `poolViewOf` 写进选择器里:
   * 它每次调用都造一个新对象,而 zustand 是拿引用比上一帧的快照的 ——
   * 选择器里现算 = 每帧都「变了」= 无限重渲。真机上这一条表现为整面卡死,
   * 单测里是 React 的 "Maximum update depth exceeded"。
   *
   * `authFlowOf` 不吃这一条:它要么交出 store 里那个对象,要么交出模块级的
   * `IDLE_AUTH_FLOW` 常量 —— 两条路都是稳定引用。
   */
  const credentialSummary = useProviderSettings((st) => st.credentials[activeProviderId])
  const pool = useMemo(() => poolViewOf(credentialSummary), [credentialSummary])
  const flow = useProviderSettings((st) => authFlowOf(st, activeProviderId))

  /** 改一家自定义 provider 时的底本。找不到 = 新建。 */
  const editingCustom = useMemo(() => {
    const found = (customProviders ?? []).find(
      (item: CustomProviderConfig) => item.id === customDialog.editingId,
    )
    if (!found) return undefined
    return {
      name: found.name ?? '',
      description: found.description ?? '',
      apiType: found.apiType ?? 'openai',
      baseUrl: found.baseUrl ?? '',
      apiKey: '',
      model: found.model ?? '',
    } satisfies CustomProviderForm
  }, [customProviders, customDialog.editingId])

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
        onAddCustom={() => setCustomDialog({ open: true })}
        onRowMenu={(familyId, x, y) => setRowMenu({ familyId, x, y })}
      />
      {rowMenuTarget && (
        <ProviderRowMenu
          familyId={rowMenuTarget.id}
          label={rowMenuTarget.label}
          custom={rowMenuTarget.custom}
          enabled={isProviderEnabledIn(configs, rowMenuTarget.id)}
          x={rowMenu?.x ?? 0}
          y={rowMenu?.y ?? 0}
          onClose={() => setRowMenu(null)}
          onEdit={() => setCustomDialog({ open: true, editingId: rowMenuTarget.id })}
          onDelete={() => void deleteCustomProvider(rowMenuTarget.id)}
          onToggleEnabled={() =>
            void setFamilyEnabled(rowMenuTarget.view, !isProviderEnabledIn(configs, rowMenuTarget.id))
          }
        />
      )}
      {family && mode ? (
        <ProviderDetail
          family={family}
          mode={mode}
          tabs={tabs}
          enabled={isProviderEnabledIn(configs, family.id)}
          enabledPending={enabledPending}
          customPending={customPending}
          onToggleEnabled={(next) => void setFamilyEnabled(family, next)}
          onSelectMode={(providerId) => selectMode(family.id, providerId)}
          onEditCustom={() => setCustomDialog({ open: true, editingId: family.id })}
        >
          <ModeCard
            mode={mode}
            config={configs[mode.providerId]}
            dialsPending={dialsPending}
            pool={pool}
            poolBusy={poolBusy[mode.providerId] === true}
            poolError={poolError[mode.providerId] || undefined}
            onAddKey={(apiKey, label) => void addCredential(mode.providerId, apiKey, label)}
            onRelabelKey={(entryId, label) => void relabelCredential(mode.providerId, entryId, label)}
            onReplaceKey={(entryId, apiKey) =>
              void replaceCredential(mode.providerId, entryId, apiKey)
            }
            onRemoveKey={(entryId) => void removeCredential(mode.providerId, entryId)}
            onMoveKey={(entryId, delta) => void moveCredential(mode.providerId, entryId, delta)}
            onRotation={(policy) => void setRotation(mode.providerId, policy)}
            onDials={(apiMode, region) => void setDials(mode.providerId, apiMode, region)}
            onBaseUrl={(baseUrl) => void setBaseUrl(mode.providerId, baseUrl)}
            authStatus={authStatus[mode.providerId]}
            authFlow={flow}
            onSignIn={() => void startAuth(mode.providerId)}
            onAuthCode={(code) => setAuthCode(mode.providerId, code)}
            onSubmitAuthCode={() => void submitAuthCode(mode.providerId)}
            onCancelAuth={() => cancelAuth(mode.providerId)}
            onSignOut={() => void signOut(mode.providerId)}
            usage={usage[mode.providerId]}
            usageStatus={usageStatus[mode.providerId] ?? 'idle'}
            usageError={usageError[mode.providerId] || undefined}
            onRefreshUsage={() => void loadUsage(mode.providerId, true)}
          />
          {catalogAvailable ? (
            <ModelCatalog
              providerId={mode.providerId}
              rows={catalogRows}
              phase={catalog.phase}
              error={catalog.error}
              fetchedAt={catalog.updatedAt || undefined}
              dataRev={catalog.dataRev}
              refresh={catalogQuery.get(mode.providerId)}
              kind={mode.kind}
              query={modelQuery[mode.providerId] ?? ''}
              pendingModelIds={pendingModelIds}
              write={settingsMutation}
              chatMaxTokens={settings?.chat?.maxTokens}
              onQuery={(value) => setModelQuery(mode.providerId, value)}
              onRefresh={() => void catalogQuery.get(mode.providerId).refetch()}
              onToggle={(modelId, selected) => void toggleModel(mode.providerId, modelId, selected)}
              onSetCurrent={(modelId) => void setCurrentModel(mode.providerId, modelId)}
              onAddManual={(modelId) => addManualModel(mode.providerId, modelId)}
              onRemoveManual={(modelId) => void removeManualModel(mode.providerId, modelId)}
              onWriteOverride={(modelId, patch) =>
                void setModelOverride(mode.providerId, modelId, patch)
              }
            />
          ) : (
            <p className={s.locked}>{t('providers.subCatalogLocked')}</p>
          )}
        </ProviderDetail>
      ) : (
        <p className={s.detailState}>{t('providers.pickOne')}</p>
      )}

      <CustomProviderDialog
        open={customDialog.open}
        initial={editingCustom}
        editingId={customDialog.editingId}
        onClose={() => setCustomDialog({ open: false })}
        onSave={(form) => {
          void saveCustomProvider(form, customDialog.editingId)
          setCustomDialog({ open: false })
        }}
      />
    </div>
  )
}
