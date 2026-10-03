/**
 * 凭证功能的入口(D25,2026-10-04 新建)。
 *
 * 这个功能回答「凭证在哪、这一发用哪把」:每个空间的凭证池(`workspaces/<id>/credentials.json`,整份落盘加密)、
 * 凭证解析规则、这条会话该用哪把钥匙、失败了换哪把、插件凭证策略怎么选、订阅额度用完走哪条路、
 * 每把钥匙最近用了多少、OAuth 登录拿到的令牌写回池里,以及老版本的凭证怎么迁进默认空间。
 * 这些从前散在 `providers/`(解析、轮换、插件策略、迁移、订阅路由)、`spaces/`(池与规则)、
 * `auth/`(令牌写回)三处;放进其中任何一处都会让那个功能既是别人的叶子、又是要用全世界的枢纽,所以单独成功能。
 *
 * 它依赖的功能:spaces(空间身份与每空间的服务商设置)、providers(各家清单与名册)、settings(读设置)、
 * sessions(这条会话属于哪个空间)、auth(刷新令牌、令牌目标)、plugins(插件凭证策略的契约与健康表)、
 * agent-loop(报错分类)、usage(只引类型),以及 logging / events / lifecycle 这些基础件。
 * 反过来,auth 与设置的模型目录服务**不 import 这里**:令牌存放面与「取这个空间这一家的密钥」由装配
 * (`backend.ts` 的 `configureAppRuntimeAdapters`)交给它们(D24 断边)。
 *
 * 下面按类列出外面真在用的名字。`credentials-candidate-route.ts`(候选序列的纯函数)只在功能内部用,不交出去。
 */

// ── 凭证池:每个空间一份,条目、冷却与游标 ──────────────────────────────────────────
export {
  getSpaceCredentialEntry,
  markSpaceCredentialCooldown,
} from './credentials-pool.js'

// ── 解析规则:池里的条目怎么盖到一家的 provider 配置上 ──────────────────────────────
export {
  applySpaceProviderCredential,
  toSpaceCredentialMarker,
} from './credentials-provider-rules.js'
export type {
  SpaceProviderCredentialResolution,
} from './credentials-provider-rules.js'

// ── 这条会话 / 这个空间该用哪把钥匙(发送路与设置页共用的那一处判据)────────────────
export {
  applySessionProviderGates,
  applySessionSpaceCredentials,
  credentialTargetFromMarker,
  decideSpaceProviderCredential,
  resolveSessionCredentialId,
  resolveSessionSpaceOAuthAuth,
  resolveSpaceProviderCredentialForSpace,
} from './credentials-resolution.js'

// ── 设置页对凭证的读写,以及落盘加密端口的装配 ──────────────────────────────────────
export {
  clearSpaceProviderCredential,
  configureAppSpaceCredentialsCrypto,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  setSpaceProviderCredential,
  setSpaceProviderCredentialPoolForRequest,
} from './credentials-resolution.js'

// ── 失败了换哪把 ────────────────────────────────────────────────────────────────────
export {
  createSessionCredentialRotator,
} from './credentials-rotation.js'

// ── 插件凭证策略:登记、宿主端口与随 backend 的生命周期 ───────────────────────────────
export {
  configureAppPluginCredentialStrategyHost,
  disposeCredentialStrategyState,
  registerPluginCredentialStrategy,
} from './credentials-strategy.js'
export {
  captureCredentialStrategyScope,
  CredentialStrategyScope,
  CredentialStrategyService,
} from './credentials-strategy-lifetime.js'
export type {
  CredentialUsageLedgerReader,
} from './credentials-strategy-lifetime.js'

// ── 每把钥匙最近用了多少(读用量账本记录,纯函数)────────────────────────────────────
export {
  computeOnethingCredentialUsage,
} from './credentials-usage.js'
export type {
  OnethingCredentialUsageQuery,
  OnethingCredentialUsageTotals,
} from './credentials-usage.js'

// ── OAuth 登录拿到的令牌写回凭证池(交给 auth 当令牌存放面)──────────────────────────
export {
  createOnethingSpaceTokenStore,
  parseSpaceOAuthToken,
} from './credentials-token-store.js'
export type {
  OnethingSpaceAuthTokenStore,
} from './credentials-token-store.js'

// ── 老版本的凭证迁进默认空间(装配序列里的一次性步骤)─────────────────────────────────
export {
  migrateOAuthSlotToDefaultSpace,
  migrateProviderConfigToDefaultSpace,
  upgradeSpaceCredentialsEncryptionAtRest,
} from './credentials-default-space-migration.js'
