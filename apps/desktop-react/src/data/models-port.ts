import { providersRouter, type GetProvidersResponse } from '@shared/ipc/providers'
import { spacesRouter, type SpacesGetProviderSettingsResponse } from '@shared/ipc/spaces'
import { settingsRouter, type GetSettingsResponse } from '@shared/ipc/settings'
import { sessionsRouter, type SessionMutationResponse } from '@shared/ipc/sessions'

/**
 * 模型目录与模型切换,和 core 的客户端(`@onething/client`)之间的那一层**端口** ——
 * 与 `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * models-source 的全部判据(哪一家可见、目录怎么懒加载、当前模型怎么解析)
 * 都是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,测试用
 * `configureModelsPort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:四条各自对应
 * `providersApi.getProviders` / `spacesApi.getProviderSettings` /
 * `settingsApi.getSettings` / `sessionsApi.updateModel`,一个字段都没有多。
 *
 * ── 目录那一口已经删了(批 7b)────────────────────────────────────────────
 * 这里从前还有第五条 `listModels(providerId)` → `modelsApi.getModelsWithCapabilities`。
 * 它与 `provider-settings-port.listModels(pid, force)` **是同一口**:同一个平台
 * 调用面、同一条 RPC 路由(`modelsRouter.getWithCapabilities`)、同一份 model
 * registry、同一个 `ModelsListResponse`;唯一差别是这一条从不递 `forceRefresh`。
 * 同一份答案在一个进程里缓存两遍就是两个时刻、两条在飞链 —— 所以目录收敛到
 * `providers/catalog-query.ts` 那一族,这一口零消费者,连同它的类型一起删掉。
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
  /**
   * 有哪些 provider(名字与 id)。目录里的 `models` 不吃 —— 见文件头的合并记档。
   */
  listProviders(): Promise<GetProvidersResponse>
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
   * 整份应用设置。**只读一格**:`storage.spaceProviderSettingsMigratedAt` ——
   * 「这台机器跑过 C2 搬迁没有」。09-01 报障 ① 之后它回到这条端口上:
   * 未迁移的机器盘上根本没有 per-space 文件,那时全局那份就是所有空间的真相
   * (判据与病历在 `providers/space-settings.ts` 的 `resolveSpaceProviderSettings`)。
   */
  readSettings(): Promise<GetSettingsResponse>
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
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:它要的是那个连通之后
 * 才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<ModelsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const providersApi = client.api(providersRouter)
  const spacesApi = client.api(spacesRouter)
  const settingsApi = client.api(settingsRouter)
  const sessionsApi = client.api(sessionsRouter)
  return {
    ready: () => whenConnected(),
    listProviders: () => providersApi.list({}),
    readProviderSettings: (spaceId) => spacesApi.getProviderSettings({ id: spaceId }),
    readSettings: () => settingsApi.getSettings({}),
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
