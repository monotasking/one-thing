import type { AppSettings } from '@shared/ipc/settings'
import type { SpaceProviderSettings } from '@shared/ipc/providers'

/**
 * 「这个工作区的模型服务设置」与「整份应用设置」之间的**两条纯换算** ——
 * 合(读的时候)与拆(写的时候)。没有 React、没有端口、没有 store。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────────
 * 后端把同一份事实存在两处,分界是「它是不是跟着空间走」:
 *
 *   `settings.json` 的 `ai`         → 只剩 `temperature`(机器级缺省)与
 *                                     `modelCatalog`(models.dev 目录快照,全空间共享);
 *   `workspaces/<id>/providers.json` → `provider` / `providers` / `customProviders`,
 *                                     **每个空间一份,互不回落**。
 *
 * 而 `settings.getSettings()` 交给渲染层的是**合过的**那一份(契约
 * `@shared/ipc/providers.ts:277` 的 `EffectiveAISettings`:「某个空间的
 * SpaceProviderSettings + 全局目录缓存」)—— 只不过它合的永远是 **default** 那个空间。
 *
 * 所以壳有了当前工作区之后,只要在这里照同一条规则合一次,`settings` 这一格的
 * **形状一个字都不变**,下游(家族表、模式判定、模型目录、能力徽)一行都不用改:
 * 它们读的仍然是「当前生效的那份 ai」,只是「当前」终于指对了空间。
 *
 * ── 拆的时候为什么不是「把合过的原样交回去」 ──────────────────────────────
 * 因为 `temperature` 在两边的语义不同:全局那格是**缺省值**,空间那格是
 * **这个空间表达过的覆盖**(契约 `@shared/ipc/providers.ts:249`「缺席 = 用全局缺省」)。
 * 合过的那份里这一格永远有值(合的时候拿全局顶上了),原样写回去等于**替用户
 * 在这个空间按下了一次「就用这个温度」** —— 此后用户改全局温度,这个空间不再跟随,
 * 而界面上没有任何地方显示过这件事。所以拆的时候把空间原本那一格**原样带回**,
 * 没表达过就还是没表达过。
 */

/** 空间那份 provider 设置的空壳 —— 「后端答了,这个空间就是空的」。 */
export const EMPTY_SPACE_PROVIDER_SETTINGS: SpaceProviderSettings = {
  provider: '',
  providers: {},
  customProviders: [],
}

/**
 * 合:全局设置 + 这个空间的 provider 设置 → 当前生效的整份设置。
 *
 * `global` 缺席(还没连上 / 后端答不上话)= 整份缺席:这块面本来就要在那种时候
 * 说「读不到」,凭空造一份只装着空间那一半的设置会让它假装读到了。
 */
export function composeSpaceSettings(
  global: AppSettings | undefined,
  space: SpaceProviderSettings | undefined,
): AppSettings | undefined {
  if (!global) return undefined
  const ai = global.ai
  return {
    ...global,
    ai: {
      ...ai,
      // 全空间共享的两格照旧从全局来;空间没表达温度就用全局那个缺省。
      temperature: space?.temperature ?? ai?.temperature,
      provider: space?.provider ?? '',
      providers: space?.providers ?? {},
      customProviders: space?.customProviders ?? [],
    },
  } as AppSettings
}

/**
 * 拆:合过的整份设置 + 空间原本那一份 → 要写回空间的那一份。
 *
 * `previous` 只用来取一格 —— `temperature`(见文件头)。别的三格一律以
 * `settings.ai` 为准:那才是屏幕上刚被改过的那一份。
 *
 * **整层写语义**:回来的这个对象就是落盘的全部内容(缺字段 = 清空),
 * 所以三格都给全,不做「只传改过的」。
 */
export function splitSpaceProviderSettings(
  settings: AppSettings,
  previous: SpaceProviderSettings | undefined,
): SpaceProviderSettings {
  const ai = settings.ai
  const next: SpaceProviderSettings = {
    provider: ai?.provider ?? '',
    providers: ai?.providers ?? {},
    customProviders: ai?.customProviders ?? [],
  }
  if (previous?.temperature !== undefined) next.temperature = previous.temperature
  return next
}

/**
 * 这台机器跑过 C2 那次「provider 设置整体搬进空间」没有。
 *
 * **判据与后端逐字同一条**(`packages/backend/provider-binding/ai-settings-compose.ts`
 * 的 `hasSpaceProviderSettingsMigrated`):看 `storage.spaceProviderSettingsMigratedAt`
 * 这一格在不在。它随 `settings.getSettings()` 一起下来,所以渲染层问得到 ——
 * 不必猜、也不必按「providers 是不是空的」去推(那会把「用户真的把默认空间清空了」
 * 误判成未迁移)。
 */
export function hasSpaceProviderSettingsMigrated(settings: AppSettings | undefined): boolean {
  return typeof settings?.storage?.spaceProviderSettingsMigratedAt === 'number'
}

/**
 * 「此刻这个空间的 provider 设置是哪一份」—— **全仓唯一一条判据**
 * (模型抽屉与模型服务面共用;09-01 报障 ① 的修法)。
 *
 * ── 病历:为什么需要这一条 ───────────────────────────────────────────────
 * e389473b 把两块面从 `settings.getSettings()` 改读 `spaces.getProviderSettings(空间)`,
 * 理由是「引擎起流读的是会话所属空间那一份」——那条理由到今天仍然成立。
 * 漏掉的是**未迁移态**:一台还没跑过 C2 搬迁的机器,
 * `workspaces/default/providers.json` 根本不存在,而
 *  · `settings.getSettings().ai` → 原样给出旧形状(15 家 provider,provider='deepseek');
 *  · `spaces.getProviderSettings('default')` → **空**(它只读文件,不认迁移标记)。
 * 于是模型药丸写「Pick a model」、抽屉一家都列不出来,而这台机器明明配好了。
 * 09-01 自查的真机读数就是这一对(探针记在报告里)。
 *
 * ── 规则:**两个条件同时成立才回落**(照抄后端 `resolveEffectiveAppSettings`)──
 * 后端那一句是 `if (space === null && !hasMigrated) return raw` —— 注意它是**两条**:
 * 空间那份**不存在**,**并且**这台机器没迁移过。少判一条都会错:
 *
 *  · 只看迁移标记(本条修法的第一版,gate 第 10 步当场抓到):一个「没迁移过、
 *    但已经写过 per-space 文件」的 store(比如门里用 `spaces.setProviderSettings`
 *    种出来的那种)会被判成「用全局那份」,**把这个空间自己配好的设置盖掉**;
 *  · 只看空不空:一个被用户真清空的默认空间会被悄悄灌回全局那份 —— 那是
 *    「我明明删干净了,它又回来了」。
 *
 * 渲染层看不到「文件在不在」(`getProviderSettings` 对缺席文件回的是一份空设置),
 * 所以用**「空」当「不存在」的代理**,而且只在**没迁移**时这么代理 ——
 * 迁移过的机器上,空就是真的空,一格都不回落。
 */
export function resolveSpaceProviderSettings(
  spaceAi: SpaceProviderSettings | undefined,
  global: AppSettings | undefined,
): SpaceProviderSettings | undefined {
  if (hasSpaceProviderSettingsMigrated(global)) return spaceAi
  // 没迁移过,但这个空间已经有东西了 = 那份文件真的在,以它为准(条件一)。
  if (spaceAi && (spaceAi.provider || Object.keys(spaceAi.providers ?? {}).length > 0)) {
    return spaceAi
  }
  const ai = global?.ai
  if (!ai) return spaceAi
  /*
   * **温度那一格刻意不带过来。** 这条回落要回答的只有一句话:「这个空间此刻有
   * 哪些 provider、哪些型可列、默认是谁」。温度在全局那一份里是**缺省值**,
   * 在空间那一份里是**这个空间表达过的覆盖** —— 把它抄进来,第一次写回就会
   * 把当下的全局温度钉死在这个空间上(写回的底本正是这里回的东西),
   * 此后用户改全局温度,这个空间不再跟随,而界面上没有任何地方说过这件事。
   * 与 `splitSpaceProviderSettings` 的那条注释是同一个理由的两半。
   */
  return {
    provider: ai.provider ?? '',
    providers: ai.providers ?? {},
    customProviders: ai.customProviders ?? [],
  }
}
