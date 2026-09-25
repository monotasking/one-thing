import {
  modelsRouter,
  providersRouter,
  type GetProvidersResponse,
  type ListDialectsResponse,
  type ModelManualEditRequest,
  type ModelManualEditResponse,
  type ModelsListResponse,
  type ProviderQuotaRequest,
  type ProviderQuotaResponse,
} from '@shared/ipc/providers'
import type { ProviderQuota, ProviderQuotaPushPayload } from '@shared/contracts/quota'
import { oauthRouter } from '@shared/ipc/oauth'
import type {
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthCancelRequest,
  OAuthCancelResponse,
  OAuthFlowEventPayload,
  OAuthFlowPhase,
  OAuthLogoutRequest,
  OAuthLogoutResponse,
  OAuthStartRequest,
  OAuthStartResponse,
  OAuthStatusRequest,
  OAuthStatusResponse,
} from '@shared/ipc/oauth'
import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'
import { spacesRouter } from '@shared/ipc/spaces'
import type {
  SpacesClearCredentialRequest,
  SpacesClearCredentialResponse,
  SpacesGetCredentialsResponse,
  SpacesGetProviderSettingsResponse,
  SpacesSetCredentialPoolRequest,
  SpacesSetCredentialPoolResponse,
  SpacesSetCredentialRequest,
  SpacesSetCredentialResponse,
  SpacesSetProviderSettingsRequest,
  SpacesSetProviderSettingsResponse,
} from '@shared/ipc/spaces'

/**
 * 「模型服务」设置面与 core 的客户端(`@onething/client`)之间的那一层**端口** ——
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
 * ② **API 密钥** → `spaces.setCredential`,**不是** saveSettings。
 *    后端 `prepareSave` 走的 `splitEffectiveAISettings` 会把 `apiKey` /
 *    `oauthToken` / `authType` 三个键剥掉(`SPACE_PROVIDER_STRIPPED_FIELDS`,
 *    `packages/onething-runtime/src/spaces/provider-settings.ts:74-81`),而全局那一半
 *    (`AISettings`)只剩 `temperature` 与 `modelCatalog`。**把密钥塞进
 *    saveSettings 会被静默丢掉** —— 那是「看起来存上了、其实没有」,比报错更坏。
 *
 * ── ③′ 空间:两条写口都打在**当前工作区**上(09-01「真切换」批)──────────
 * 08-31 那版写着「这块壳今天没有『当前空间』这个事实,所以两条写口都打在
 * `DEFAULT_SPACE_ID` 上」。壳有了当前工作区之后,那句话就从「诚实的降级」变成了
 * **一颗静默的雷**,而且是双向的:
 *
 *  - 写偏了:用户站在工作区 B 里填的 key 与勾的模型,落进了 `default` 的文件;
 *  - 读不着:引擎起流时读的是**会话归属那个空间**的设置
 *    (`backend/wiring/engine/stream/provider-helpers.ts:110` 的
 *     `getSessionSettings(sessionId).ai` = `getSpaceSettings(会话的 workspaceId)`,
 *     凭证同理走 `resolveSessionProviderCredential(sessionId, providerId)`)。
 *    于是 B 里配得再全,B 的会话照样起不了流 —— 而设置页显示一切正常。
 *
 * 所以 **①(启用开关 / 模型勾选 / 默认模型)从 `settings.saveSettings` 改走
 * `spaces.setProviderSettings({ id: 当前空间, ai })`**,与 Vue 壳
 * (`stores/spaceProviders.ts:160-227` 的 `writeProviderSettings` / `patchProviders`)
 * 逐字同一条路 —— 不是本批发明的新语义,是把新壳漏掉的那一条接回来。
 *
 * **default 不是特例**(与凭证 C1 同一条):`settings.getSettings()` 本身就是
 * `getSpaceSettings('default')`,而 `prepareSave` 的注释白纸黑字写着「`ai.providers`
 * 不在 = 调用方自己已经把 per-space 那一半写进 providers.json 了」—— 所以对
 * default 空间,新旧两条写口落的是**同一个文件**。一条路走到底,不分岔。
 *
 * 留在 `settings` 那一口上的只剩两件**本来就是全局**的事实:`ai.modelCatalog`
 * (models.dev 目录快照)与 ai 段之外的所有设置。
 */
export interface ProviderSettingsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 有哪些 provider。这一发**会碰网**(后端顺手拉 models.dev),所以它是懒的。 */
  listProviders(): Promise<GetProvidersResponse>
  /**
   * 自定义服务商对话框的「接口类型」下拉(批 3 §6.1):方言自述了人话名的那几份。
   * 只读、不碰网;壳按 `providers.dialect.<id>` 查自己的字典。
   */
  listDialects(): Promise<ListDialectsResponse>
  /**
   * 一家的模型明细。`forceRefresh` 才是「刷新目录」那颗钮 ——
   * 不传就吃后端缓存,开一次面不该把 models.dev 问一遍。
   */
  listModels(providerId: string, forceRefresh?: boolean, spaceId?: string): Promise<ModelsListResponse>
  /**
   * 手填模型(批 2):手填 = 目录里的一条 `source:'manual'` 条目 + 这个空间里勾上。
   * 目录全空间共享、勾选是这个空间的,两半由后端一发写完 —— 所以这两口不走
   * `writeProviderSettings`。回的 `ai` 与那一口同形,用来对账。
   */
  addManualModel(request: ModelManualEditRequest): Promise<ModelManualEditResponse>
  removeManualModel(request: ModelManualEditRequest): Promise<ModelManualEditResponse>
  /**
   * 整份应用设置。**provider 那一半不再从这里读**(见 ③′)—— 留着它是因为这块面
   * 还要 `ai.modelCatalog`(models.dev 目录快照,全空间共享)与非 ai 的那些段,
   * 而且它仍然是**非 provider 那一半**写回的底本。
   */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见上面 ①。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  /**
   * 这个空间那份 provider 设置(`workspaces/<id>/providers.json`)。**无回落** ——
   * 读不到就是这个空间还没配过,不是「去看全局那一份」。见 ③′。
   */
  readProviderSettings(spaceId: string): Promise<SpacesGetProviderSettingsResponse>
  /**
   * 整层写回这个空间的 provider 设置。**传什么就是什么**(缺字段 = 清空),
   * 所以调用方一律「先读整份 → 合并一格 → 整份写回」,与 Vue 壳
   * `stores/spaceProviders.ts` 的 `patchProviders` 是同一条纪律。
   */
  writeProviderSettings(
    request: SpacesSetProviderSettingsRequest,
  ): Promise<SpacesSetProviderSettingsResponse>
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
   * ⑤ **OAuth 登录**→ `oauth` 域(`packages/shared/ipc/oauth.ts`)。**流住在后端**
   *    (批 1):设备码轮询 / 回调等待 / 超时都在 `OnethingAuthService`,相位经全局事件
   *    `oauth:flow` 推过来(`onOAuthPush`),取消是 `oauth.cancel`。这边不再轮询,
   *    所以 `devicePoll` 这条动词不在这张表上(它留给别的宿主)。
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
  oauthCallback(request: OAuthCallbackRequest): Promise<OAuthCallbackResponse>
  oauthLogout(request: OAuthLogoutRequest): Promise<OAuthLogoutResponse>
  oauthCancel(request: OAuthCancelRequest): Promise<OAuthCancelResponse>
  /** `oauth:flow` / `oauth:token-expired` 两种全局事件的推送面。返回退订函数。 */
  onOAuthPush(callback: (push: OAuthPush) => void): () => void

  /**
   * 配额与余额(批 5)。`spaceId` 缺席 = 默认空间;`credentialId` 缺席 = 「下一发会用哪条」;
   * `force` = 刷新钮(绕过后端 60 秒缓存,429 静默期不绕)。
   */
  getProviderQuota(request: ProviderQuotaRequest): Promise<ProviderQuotaResponse>
  /** `provider:quota` 全局事件的推送面。返回退订函数。 */
  onQuotaPush(callback: (push: ProviderQuotaPushPayload) => void): () => void
}

const QUOTA_KINDS: ReadonlySet<ProviderQuota['kind']> = new Set(['balance', 'windows', 'unsupported', 'error'])

/** 一帧 `provider:quota` 认不认。形不对就丢(推送面是不可信输入)。 */
export function quotaPushOfFrame(name: string, data: unknown): ProviderQuotaPushPayload | null {
  if (name !== 'provider:quota' || !data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (typeof record.providerId !== 'string') return null
  const quota = record.quota as ProviderQuota | undefined
  if (!quota || typeof quota !== 'object' || !QUOTA_KINDS.has(quota.kind)) return null
  if (quota.kind === 'windows' && !Array.isArray(quota.windows)) return null
  if (quota.kind === 'balance' && typeof quota.available !== 'number') return null
  return {
    providerId: record.providerId,
    ...(typeof record.credentialId === 'string' ? { credentialId: record.credentialId } : {}),
    quota,
  }
}

/** 登录相关的两种推送,认过形之后的样子。 */
export type OAuthPush =
  | { type: 'flow'; event: OAuthFlowEventPayload }
  | { type: 'token-expired'; providerId: string; error?: string }

const FLOW_PHASES: ReadonlySet<OAuthFlowPhase> = new Set(['pending', 'completed', 'failed', 'expired', 'cancelled'])

/** 一帧推送认不认。形不对就丢(推送面是不可信输入)。 */
export function oauthPushOfFrame(name: string, data: unknown): OAuthPush | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (typeof record.providerId !== 'string') return null
  const error = typeof record.error === 'string' ? record.error : undefined
  if (name === 'oauth:flow') {
    if (typeof record.flowId !== 'string') return null
    if (!FLOW_PHASES.has(record.phase as OAuthFlowPhase)) return null
    return {
      type: 'flow',
      event: {
        providerId: record.providerId,
        flowId: record.flowId,
        phase: record.phase as OAuthFlowPhase,
        ...(error ? { error } : {}),
      },
    }
  }
  if (name === 'oauth:token-expired') {
    return { type: 'token-expired', providerId: record.providerId, ...(error ? { error } : {}) }
  }
  return null
}

let port: ProviderSettingsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureProviderSettingsPort(next: ProviderSettingsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 models-port 逐字相同:它要的是那个连通之后
 * 才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<ProviderSettingsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const providersApi = client.api(providersRouter)
  const modelsApi = client.api(modelsRouter)
  const settingsApi = client.api(settingsRouter)
  const spacesApi = client.api(spacesRouter)
  const oauthApi = client.api(oauthRouter)
  return {
    ready: () => whenConnected(),
    listProviders: () => providersApi.list({}),
    listDialects: () => providersApi.listDialects({}),
    listModels: (providerId, forceRefresh, spaceId) =>
      modelsApi.getWithCapabilities({
        providerId,
        ...(forceRefresh ? { forceRefresh } : {}),
        ...(spaceId ? { spaceId } : {}),
      }),
    addManualModel: (request) => modelsApi.addManual(request),
    removeManualModel: (request) => modelsApi.removeManual(request),
    readSettings: () => settingsApi.getSettings({}),
    saveSettings: (settings) => settingsApi.saveSettings(settings),
    readProviderSettings: (spaceId) => spacesApi.getProviderSettings({ id: spaceId }),
    writeProviderSettings: (request) => spacesApi.setProviderSettings(request),
    readCredentials: (spaceId) => spacesApi.getCredentials({ id: spaceId }),
    setCredential: (request) => spacesApi.setCredential(request),
    setCredentialPool: (request) => spacesApi.setCredentialPool(request),
    clearCredential: (request) => spacesApi.clearCredential(request),
    oauthStatus: (request) => oauthApi.status(request),
    oauthStart: (request) => oauthApi.start(request),
    oauthCallback: (request) => oauthApi.callback(request),
    oauthLogout: (request) => oauthApi.logout(request),
    oauthCancel: (request) => oauthApi.cancel(request),
    onOAuthPush: (callback) =>
      client.events.onAny((frame) => {
        const push = oauthPushOfFrame(frame.name, frame.data)
        if (push) callback(push)
      }),
    getProviderQuota: (request) => providersApi.quota(request),
    onQuotaPush: (callback) =>
      client.events.onAny((frame) => {
        const push = quotaPushOfFrame(frame.name, frame.data)
        if (push) callback(push)
      }),
  }
}

let pending: Promise<ProviderSettingsPort> | undefined

export function providerSettingsPort(): Promise<ProviderSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
