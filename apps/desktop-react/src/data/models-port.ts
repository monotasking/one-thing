import type { GetProvidersResponse, ModelsListResponse } from '@shared/ipc/providers'
import type { SpacesGetProviderSettingsResponse } from '@shared/ipc/spaces'
import type { SessionMutationResponse } from '@shared/ipc/sessions'

/**
 * 模型目录与模型切换,和 `@renderer/platform` 之间的那一层**端口** ——
 * 与 `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * models-source 的全部判据(哪一家可见、目录怎么懒加载、当前模型怎么解析)
 * 都是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,测试用
 * `configureModelsPort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:四条各自对应
 * `providersApi.getProviders` / `modelsApi.getModelsWithCapabilities` /
 * `spacesApi.getProviderSettings` / `sessionsApi.updateModel`,一个字段都没有多。
 *
 * ── 为什么空间的 provider 设置也在这条端口上 ─────────────────────────────
 * 「哪一家可见」的两道闸(开关、选过哪些模型)读的是那个空间的
 * `providers[pid].enabled`(经 `isProviderEnabledIn` 的家族派生)与
 * `providers[pid].selectedModels`。它不是模型域的口,但它是 models-source
 * 唯一多出来的取数面 —— 为它单开一个端口只会多一份要在 `src/test/setup.ts` 里
 * 维护的假端口,而这一层端口的存在理由本来就是「这个数据源要摸的那几口」。
 *
 * ── 留账:第三道闸仍然不做 ───────────────────────────────────────────────
 * Vue 壳的模型选择器筛三道(`ModelSelector.vue:293-315`):
 *  1. `isProviderEnabledIn`(开关,含家族派生)—— 做了;
 *  2. 有模型可列(`selectedModels` 非空)—— 做了;
 *  3. `isConfigured`(这个空间配了凭证没有)—— **仍然不做**。它要的是凭证摘要
 *     那一口(`spaces.getCredentials`),而那一口今天只有设置面在读;抽屉再开一份
 *     就是第二份凭证快照,两份一定会在某个时刻说两句话。诚实的降级照旧是:
 *     配错了家的模型选出来能选中,发消息时才失败 —— 屏幕不假装它知道凭证在不在。
 *
 * 前两道闸从 09-01 起读的是**当前空间**那一份(见 `readProviderSettings`),
 * 所以「per-space 覆盖不传 = 回落全局」那条旧留账已经结清:根本不需要覆盖参数,
 * 数据源读的本来就是那个空间的原件。
 */
export interface ModelsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 有哪些 provider(名字与 id)。目录里的 `models` 不吃 —— 见 listModels。 */
  listProviders(): Promise<GetProvidersResponse>
  /**
   * 一家的模型明细。**吃缓存语义**:不传 `forceRefresh`,后端有缓存就给缓存
   * (`models.getWithCapabilities`)—— 抽屉是随手开合的东西,不该每开一次
   * 就去问一遍 models.dev。
   */
  listModels(providerId: string): Promise<ModelsListResponse>
  /**
   * **当前空间那一份 provider 设置**(`workspaces/<id>/providers.json`)——
   * 「哪一家可见」「这一家列哪些型」「默认是哪一家」三格的真产地。
   *
   * 09-01「真切换」批之前这里是 `settings.getSettings()`(整份应用设置)。那一口
   * 读的永远是 **default 空间**的生效设置(后端 `getSettings()` 就是
   * `getSpaceSettings('default')`),于是站在别的工作区里,抽屉列的是 default 的
   * 模型表 —— 而引擎起流时读的是**会话归属那个空间**的设置。屏幕与引擎说两句话。
   *
   * **无回落**:读不到就是这个空间还没配过,不去看全局那一份。
   */
  readProviderSettings(spaceId: string): Promise<SpacesGetProviderSettingsResponse>
  /**
   * 把一条会话绑到某个模型上。**从下一轮起生效,历史照留** ——
   * 与 Vue 壳 `sessionsStore.updateSessionModel` 同一条写面。
   */
  updateSessionModel(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<SessionMutationResponse>
}

let port: ModelsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureModelsPort(next: ModelsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<ModelsPort> {
  const [{ providersApi }, { modelsApi }, { spacesApi }, { sessionsApi }, { whenConnected }] =
    await Promise.all([
      import('@renderer/platform/providers-client'),
      import('@renderer/platform/models-client'),
      import('@renderer/platform/spaces-client'),
      import('@renderer/platform/sessions-client'),
      import('../platform/connection'),
    ])
  return {
    ready: () => whenConnected(),
    listProviders: () => providersApi.getProviders(),
    listModels: (providerId) => modelsApi.getModelsWithCapabilities(providerId),
    readProviderSettings: (spaceId) => spacesApi.getProviderSettings({ id: spaceId }),
    updateSessionModel: (sessionId, provider, model) =>
      sessionsApi.updateModel({ sessionId, provider, model }),
  }
}

let pending: Promise<ModelsPort> | undefined

export function modelsPort(): Promise<ModelsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
