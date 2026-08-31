import type {
  GetProvidersResponse,
  ModelsListResponse,
  ProviderUsageResponse,
} from '@shared/ipc/providers'
import type {
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthDevicePollRequest,
  OAuthDevicePollResponse,
  OAuthLogoutRequest,
  OAuthLogoutResponse,
  OAuthStartRequest,
  OAuthStartResponse,
  OAuthStatusRequest,
  OAuthStatusResponse,
} from '@shared/ipc/oauth'
import type { AppSettings, GetSettingsResponse, SaveSettingsResponse } from '@shared/ipc/settings'
import type {
  SpacesClearCredentialRequest,
  SpacesClearCredentialResponse,
  SpacesGetCredentialsResponse,
  SpacesSetCredentialPoolRequest,
  SpacesSetCredentialPoolResponse,
  SpacesSetCredentialRequest,
  SpacesSetCredentialResponse,
} from '@shared/ipc/spaces'

/**
 * 「模型服务」设置面与 `@renderer/platform` 之间的那一层**端口** ——
 * 与 `files-port` / `sessions-port` / `models-port` 同一形状、同一理由:这块面的
 * 全部判据(哪一家算一家、模式怎么分、副行说什么、写回怎么合并)都是纯逻辑,
 * 不该为了测它去起一台 core。真实现是下面那一个,测试用
 * `configureProviderSettingsPort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:六条各自对应
 * `providersApi.getProviders` / `modelsApi.getModelsWithCapabilities` /
 * `settingsApi.getSettings` / `settingsApi.saveSettings` /
 * `spacesApi.getCredentials` / `spacesApi.setCredential`,一个字段都没有多。
 *
 * ── 为什么不是往 models-port 上加两口 ────────────────────────────────────
 * `models-port.ts` 顶部自己写着:settings 那一口留在那里,是因为当时只有一个
 * settings 消费者,「真长出第二个再拆」。第二个就是这块面 —— 而且它要的三口
 * (整份写回、凭证摘要、写一条凭证)与「模型目录与模型切换」毫无关系,挂上去
 * 只会让那条端口变成一个什么都摸的杂物袋。两条端口各有一口读设置,是**同一个
 * 平台调用面被两个数据源各用了一次**,不是两份契约。
 *
 * ── 写口勘察结论(2026-08-31,file:line 在报告里)──────────────────────────
 * ① **启用开关 / 模型勾选** → `settings.saveSettings(整份 AppSettings)`。
 *    看着像「整份写回太粗」,但它恰恰是唯一正确的那一口:后端
 *    `packages/backend/stores/settings.ts:116-131` 的 `prepareSave` 会把
 *    `ai.providers` 拆出来写进 `workspaces/default/providers.json`,再把剩下的
 *    落 `settings.json` —— 与 `getSettings()`(:96,读的正是 default 空间的生效
 *    settings)严丝合缝。所以读什么形状就写什么形状,**先读整份 → 合并一格 →
 *    整份写回**;漏传一格 = 清空那一格,这条纪律与 Vue 壳的 `patchProviders`
 *    (`packages/renderer/stores/spaceProviders.ts:181-194`)逐字相同。
 * ② **API 密钥** → `spaces.setCredential`,**不是** saveSettings。
 *    同一个 `prepareSave` 走的 `splitEffectiveAISettings` 会把 `apiKey` /
 *    `oauthToken` / `authType` 三个键剥掉(`SPACE_PROVIDER_STRIPPED_FIELDS`,
 *    `packages/onething-runtime/src/spaces/provider-settings.ts:74-81`),而全局那一半
 *    (`AISettings`)只剩 `temperature` 与 `modelCatalog`。**把密钥塞进
 *    saveSettings 会被静默丢掉** —— 那是「看起来存上了、其实没有」,比报错更坏。
 * ③ **空间**:这块壳今天没有「当前空间」这个事实,所以两条写口都打在
 *    `DEFAULT_SPACE_ID`('default')上。它不是兜底,是这台壳读的那一份:
 *    `getSettings()` 自己就是 `getSpaceSettings(DEFAULT_SPACE_ID)`。
 *    per-space 的模型服务设置归批二(它要先有空间视图)。
 */
export interface ProviderSettingsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 有哪些 provider。这一发**会碰网**(后端顺手拉 models.dev),所以它是懒的。 */
  listProviders(): Promise<GetProvidersResponse>
  /**
   * 一家的模型明细。`forceRefresh` 才是「刷新目录」那颗钮 ——
   * 不传就吃后端缓存,开一次面不该把 models.dev 问一遍。
   */
  listModels(providerId: string, forceRefresh?: boolean): Promise<ModelsListResponse>
  /** 整份应用设置。它同时是**写回的底本** —— 不留着它就没法「合并一格」。 */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见上面 ①。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  /** 凭证**摘要**:有没有 key、尾号、有没有 OAuth、哪个账号。原文永远不出后端。 */
  readCredentials(spaceId: string): Promise<SpacesGetCredentialsResponse>
  /** 写一条凭证。见上面 ②。 */
  setCredential(request: SpacesSetCredentialRequest): Promise<SpacesSetCredentialResponse>

  /* ── 批二新增的三族口 ──────────────────────────────────────────────────
   * 都是**平台调用面的子集**,和上面六条同一条纪律:一个字段都没有多。
   *
   * ④ **凭证池**(多钥 / 顺序 / 策略)→ `spaces.setCredentialPool`。
   *    它的 `entryIds` 是**期望的最终顺序**,而且**不在列表里的条目会被删掉** ——
   *    所以调序、删除、换策略是同一口的三种用法,不是三口。
   *    (契约 `packages/shared/ipc/spaces.ts:280-285`,语义注释在 :274-279。)
   *    「换一把 key 不换条目」走的是 `setCredential` 带 `entryId` 那一支
   *    (:241-249:带 entryId = 改这一条;不带 = 追加一条)—— 用量账按条目归因,
   *    换 key 新建条目就等于把这一条的历史账断了。
   *
   * ⑤ **OAuth 登录**→ `oauth` 域(`packages/shared/ipc/oauth.ts:144-160`)。
   *    **没有 cancel 这一口** —— 取消是渲染层自己停掉轮询,后端那边没有可撤的东西
   *    (Vue 壳的 `useProviderAuth.ts` 也是这么做的,它连这口都没找)。
   *
   * ⑥ **订阅用量**→ `providers.usage`。今天只有 codex 真有数,其余家后端直接回
   *    `unsupported: true`(`onething-runtime/src/providers/provider-usage.ts:69-73`)——
   *    所以「这家没有用量卡」是**后端说的**,不是这块面猜的。
   *
   * 有一件事这里**没有**:测连通。全仓没有这口(testConnection / validateApiKey
   * 一个都不存在),所以这块面不画那颗钮 —— 画一颗点了只能假装的钮,比不画更坏。
   */
  setCredentialPool(
    request: SpacesSetCredentialPoolRequest,
  ): Promise<SpacesSetCredentialPoolResponse>
  clearCredential(request: SpacesClearCredentialRequest): Promise<SpacesClearCredentialResponse>

  oauthStatus(request: OAuthStatusRequest): Promise<OAuthStatusResponse>
  oauthStart(request: OAuthStartRequest): Promise<OAuthStartResponse>
  oauthDevicePoll(request: OAuthDevicePollRequest): Promise<OAuthDevicePollResponse>
  oauthCallback(request: OAuthCallbackRequest): Promise<OAuthCallbackResponse>
  oauthLogout(request: OAuthLogoutRequest): Promise<OAuthLogoutResponse>

  /** 订阅用量。`spaceId` 缺席 = 默认空间。 */
  getProviderUsage(providerId: string, spaceId?: string): Promise<ProviderUsageResponse>
}

let port: ProviderSettingsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureProviderSettingsPort(next: ProviderSettingsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 models-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<ProviderSettingsPort> {
  const [
    { providersApi },
    { modelsApi },
    { settingsApi },
    { spacesApi },
    { oauthApi },
    { whenConnected },
  ] = await Promise.all([
    import('@renderer/platform/providers-client'),
    import('@renderer/platform/models-client'),
    import('@renderer/platform/settings-client'),
    import('@renderer/platform/spaces-client'),
    import('@renderer/platform/oauth-client'),
    import('../platform/connection'),
  ])
  return {
    ready: () => whenConnected(),
    listProviders: () => providersApi.getProviders(),
    listModels: (providerId, forceRefresh) =>
      modelsApi.getModelsWithCapabilities(providerId, forceRefresh ? { forceRefresh } : undefined),
    readSettings: () => settingsApi.getSettings(),
    saveSettings: (settings) => settingsApi.saveSettings(settings),
    readCredentials: (spaceId) => spacesApi.getCredentials({ id: spaceId }),
    setCredential: (request) => spacesApi.setCredential(request),
    setCredentialPool: (request) => spacesApi.setCredentialPool(request),
    clearCredential: (request) => spacesApi.clearCredential(request),
    oauthStatus: (request) => oauthApi.status(request),
    oauthStart: (request) => oauthApi.start(request),
    oauthDevicePoll: (request) => oauthApi.devicePoll(request),
    oauthCallback: (request) => oauthApi.callback(request),
    oauthLogout: (request) => oauthApi.logout(request),
    getProviderUsage: (providerId, spaceId) => providersApi.getProviderUsage(providerId, spaceId),
  }
}

let pending: Promise<ProviderSettingsPort> | undefined

export function providerSettingsPort(): Promise<ProviderSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
