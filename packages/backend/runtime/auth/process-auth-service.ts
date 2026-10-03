/**
 * 装配层那一台 `OnethingAuthService`(进程单例)。令牌只有一个家:空间凭证池
 * (`credentials` 的 `createOnethingSpaceTokenStore`,由装配经 `configureProcessAuthTokenStore` 交进来)。
 * 批 8 之前这里还注入一把「一家一个位置」的单槽给默认空间用 —— 退役了,旧文件只由
 * 装配序列里的一次性归位读(`../credentials/credentials-default-space-migration.ts`);
 * `scripts/headless-boundary-check.ts` 的 `checkRuntimeOwnsAuthTokenStorage` 钉着它别回来。
 */
import { OnethingAuthService, type OnethingAuthCallbackServerAdapter, type OnethingAuthServiceOptions } from './auth-service.js'
import { createOnethingAuthServiceOptions } from './service-factory.js'
import type { OAuthToken } from '@shared/ipc.js'
import { createRequiredAppFetch } from '@onething/backend/runtime/settings'
import { getAuthHostPorts } from '@onething/backend/runtime/auth/host-ports'

export interface MainAuthServiceOptions extends Partial<OnethingAuthServiceOptions<OAuthToken>> {
  tokenStore: OnethingAuthServiceOptions<OAuthToken>['tokenStore']
  callbackServer?: OnethingAuthCallbackServerAdapter
}

/**
 * 宿主没注入 `authFetch` 时用的那只受管 fetch,**第一次真要发请求时才建**(2026-10-04)。
 * 从前在加载时建:加载本模块就要去调设置入口里的工厂,本模块一旦和设置入口落在同一个 import 环上,
 * 工厂读到的适配器是不是已初始化完,要看谁先被 import。等价理由:工厂只把策略名与那份适配器
 * (每次请求现取代理设置)包成一个函数,不读设置、不发请求;建一次以后同一只一直用,和从前加载时建的那一只行为相同。
 */
const fallbackAuthFetch: { current?: typeof fetch } = {}

const mainAuthFetch: typeof fetch = (input, init) =>
  (getAuthHostPorts().authFetch ?? (fallbackAuthFetch.current ??= createRequiredAppFetch({ policy: 'auth' })))(input, init)

export class AuthService extends OnethingAuthService<OAuthToken> {
  constructor(options: MainAuthServiceOptions) {
    super(createOnethingAuthServiceOptions<OAuthToken>({
      fetch: mainAuthFetch,
      ...options,
    }))
  }
}

/**
 * 进程那一台登录服务的持有器(D12 口径:首次用到时才建,2026-10-04)。
 *
 * 从前是模块加载时 `export const authService = new AuthService()`,令牌存放面由 auth 自己缺省装上凭证池那一台。
 * 凭证池搬进 `credentials` 以后,auth 不再认识它(否则两个功能互相引用成环,D24 断边 ③):存放面由装配
 * (`backend.ts` 的 `configureAppRuntimeAdapters`)建好,经 `configureProcessAuthTokenStore` 交进来。
 *
 * 这台服务拿到的存放面是一层**转交**:每次读写令牌时才去取装配交进来的那一台。所以「建服务」与「交存放面」
 * 谁先谁后都行 —— 没装配 backend 的宿主(例如只起 HTTP 面的测试)照样能建这台服务、挂事件监听,
 * 只有真去读写令牌时才要求存放面已经交进来(那时还没交 = 用法错了,直接抛)。
 *
 * 等价理由:`AuthService` 的构造函数只把选项存进字段、挂一个 EventEmitter,不读盘、不发请求、不起计时器;
 * 全仓没有在 import 期就调用它的顶层语句。建一次以后同一台一直用,和从前加载时建的那一台一样是进程单例 ——
 * 同一进程先后装配两只 backend 时仍是同一台(与从前相同)。存放面以第一次交进来的为准:凭证池那一台是
 * 无状态的薄壳(每次调用现读当前 store),后来交的与它没有差别。
 */
type ProcessAuthTokenStore = OnethingAuthServiceOptions<OAuthToken>['tokenStore']

const processAuth: { tokenStore?: ProcessAuthTokenStore; service?: AuthService } = {}

function configuredTokenStore(): ProcessAuthTokenStore {
  const tokenStore = processAuth.tokenStore
  if (!tokenStore) throw new Error('auth token store is not configured; assemble the backend first')
  return tokenStore
}

/** 转交给「装配交进来的那一台」的存放面。 */
const forwardingTokenStore: ProcessAuthTokenStore = {
  getToken: (providerId, target) => configuredTokenStore().getToken(providerId, target),
  saveToken: (providerId, token, target) => configuredTokenStore().saveToken(providerId, token, target),
  deleteToken: (providerId, target) => configuredTokenStore().deleteToken(providerId, target),
  resolveEntryId: (providerId, target) => configuredTokenStore().resolveEntryId(providerId, target),
  listEntries: (providerId, spaceId) => configuredTokenStore().listEntries(providerId, spaceId),
}

/** 装配时交令牌存放面。幂等:第一次交的为准(见上面持有器的说明)。 */
export function configureProcessAuthTokenStore(tokenStore: ProcessAuthTokenStore): void {
  processAuth.tokenStore ??= tokenStore
}

/** 进程那一台登录服务,第一次问到时才建。 */
export function getAuthService(): AuthService {
  return (processAuth.service ??= new AuthService({ tokenStore: forwardingTokenStore }))
}
