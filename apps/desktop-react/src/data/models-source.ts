import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { isProviderEnabledIn } from '@onething/client/model/provider-model'
import { resolveOnethingReasoningEffort } from '@onething/runtime/providers/model-capability'
import type {
  OpenRouterModel,
  ProviderInfo,
  SpaceProviderSettings,
  ThinkingEffort,
} from '@shared/ipc/providers'
import { priceOf } from '../providers/projection'
import { createMutation, createQuery, createQueryFamily, useQuery } from './kernel'
import type { Mutation } from './kernel'
import { modelsPort } from './models-port'
import { useSessionsSource } from './sessions-source'
import { catalogQuery } from '../providers/catalog-query'
import { findSession } from '../expose/projection'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { currentSpaceId, subscribeCurrentSpace } from '../workspace/current'
import { useWorkspaceStore } from '../workspace/store'
import { resolveSpaceProviderSettings } from '../providers/space-settings'

/**
 * 模型目录与当前模型的**真数据源**(D2)。全应用一个:模型抽屉从这里取目录,
 * 模型药丸从这里读「此刻跑的是谁」,读数环从这里问「这个模型的窗口多大」。
 *
 * 分工与 `data/agents-source.ts` 逐条同构 —— 那是这个文件的模板,不是巧合:
 * 「选一个人」与「选一个模型」在壳里是同一件事的两个实例(会话上的一格绑定,
 * 有会话就上行、没会话就记账,建会话时兑现)。
 *
 * ── 当前模型是**推导**出来的,不是存下来的 ──────────────────────────────
 * 没有「初始化 store」这一步。`resolveModelSelection` 每次从三层事实里现算:
 *   刚选完还没被 listMeta 追认的那块牌(optimistic)
 *   → 会话事实(SessionSummary.provider / .model = SessionMeta.lastProvider / lastModel)
 *   → 当前空间的默认(该空间 providers.json 的 provider + providers[那家].model)
 * 存一份副本就会有第三种事实,而它一定会与前两种漂开(换会话、后端改了、
 * 上行失败)。**同一条判据只算一次**,与 `resolveAgentId` 同款。
 *
 * 三层都答不上来 = **不知道**,药丸上写「选择模型」——不拿目录里第一家第一型去顶。
 * 那是 `SessionSummary.model` 早就写死的口径(expose/types.ts):
 * 「不拿一个默认模型名去顶」。全局默认不算顶:那正是引擎在用户没选时会用的那一个。
 *
 * ── 取数时机:设置热,名册与目录都冷 ────────────────────────────────────
 * `start()`(连通后一次)只拉**设置**:它是本地文件的一次读,没有网络,而
 * 药丸开机第一眼要写的那个默认模型就在里面。
 *
 * `providers.list` **不在启动期**。它看着像一次便宜的内存读,实际上后端那一侧
 * (`getAvailableProviders` → `configureAppProviderRegistry`)会顺手把 models.dev
 * 的整份目录(实测 212 家 / 7494 条)拉回来 —— 真机日志里看得见。为一个也许
 * 永远不会被点开的抽屉在每次开机拉一次外网,代价与收益完全不成比例;
 * 更要紧的是它把一次外网往返塞进了开机路径,而这套壳的开机路径此前**不碰网**。
 *
 * 所以名册与目录都是懒的:抽屉打开时拉名册 + 可见那几家的目录
 * (`ensureVisibleCatalogs`),读数环要窗口时只拉当前那一家(`ensureCatalog`)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 目录**只有一个产地**(批 7b 判定,证据在报告里)
 * ══════════════════════════════════════════════════════════════════════════
 * 这个文件从前有自己的一族目录缓存(`catalog` / `catalogStatus` 两张表 + 一个
 * `inflight: Map`),走 `models-port.listModels(pid)`;而设置面那一族
 * (`providers/catalog-query.ts`)走 `provider-settings-port.listModels(pid, force)`。
 * 两条线**落在同一口**:两个端口的真实现都是
 * `modelsApi.getModelsWithCapabilities`(`packages/renderer/platform/models-client.ts`),
 * 同一条 RPC 路由 `modelsRouter.getWithCapabilities`,同一个后端处理器,同一份
 * model registry;回的也是同一个 `ModelsListResponse`。差别只有一格:
 * 设置面那条把 `forceRefresh` 递下去(后端 `if (!request.forceRefresh)` 才吃缓存),
 * 这条从来不递 —— 那不是两个产地,那是同一个产地的两种用法。
 *
 * 而这个文件要的 `CatalogModel{id, contextLength}` 是 `OpenRouterModel` 的**真子集**
 * (`toCatalogModels`)。同一份答案缓存两遍,等于让「这一家的目录」在一个进程里有
 * 两个时刻、两个错误、两条在飞链 —— 那正是 kernel 手册里点名的「第二份真相」。
 *
 * 所以合并:**目录这一格就是 `providers/catalog-query.ts` 的那一族**,这个文件
 * 只在读的时候投影一次。`models-port` 上那一口 `listModels` 因此零消费者,已删。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 窗口有**两个**产地:用户覆盖优先、目录其次(09-10 改口)
 * ══════════════════════════════════════════════════════════════════════════
 * 这一段从前写的是「窗口的产地只有 provider 目录一个」。那句话在 09-09
 * 模型覆盖 UI 落地的那一天就不再成立,而壳里三处读数(读数环 / 抽屉分组列表 /
 * 右栏模型卡)一直照旧只查目录 —— 于是用户在浮层里给一个手填模型填了
 * context window,环上仍写「上下文用量未知」。那是 09-10 的报障。
 *
 * 今天的话:**窗口 = `contextLengthByModel[模型]` ?? 目录的 `contextLength`**,
 * 与引擎 `getOnethingModelContextLength` 同序(它从第一天就是覆盖优先,理由写在
 * 那儿:手填 / 自建的模型根本没有目录条目,128k 兜底会把压缩预算算错)。
 *
 * 两个产地不等于两份缓存:覆盖那一半住在**这个文件已经订着的那一格设置**里
 * (`prefsQuery`,键 = 空间 id),不多一发往返、不多一条订阅。而「哪一半优先」
 * 这条判据在壳里只折两处 —— `contextWindowOf`(一个数)与 `readingsOf`(一整份
 * 读数);`meter-source.ts` / `DrawerModelPicker.tsx` / `MeterCard.tsx` 一律只消费。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(09-01 用户令,施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个文件是**三读一写四条线**(设置 / 名册 / 目录 / 切模型),所以每一栏分着说。
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— import 只建两只 query + 一只 mutation,**零往返、零订阅**;
 *  · 首载    —— `start()`(main.tsx 在连通之后调一次):订上换空间 → 等传输面
 *                ready → `ensure()` 当前空间那一格设置。模块级 `started` 闸保证
 *                一个进程只跑一遍(这一格不是可渲染状态,所以不进 store);
 *  · 换宿主  —— 这条线的「宿主」是**当前工作区**:换空间 = 换一份「哪一家可见、
 *                这一家列哪些型、默认是哪一家」。键控之后换空间就是换一格:
 *                旧那一格的答案留在自己格里,回去时还在,**谁也串不到谁头上**。
 *                从前那句手写的「拉的过程中又切了空间就丢掉」因此退役 ——
 *                它与键控缓存是同一件事的两个说法。
 *                **名册与目录一个都不重拉**:它们是机器级的事实,不跟空间走;
 *  · 懒开    —— 名册与目录都不在开机路径上:抽屉打开时才 `ensureVisibleCatalogs`,
 *                环要窗口时才 `ensureCatalog(那一家)`;
 *  · 写      —— 一次切模型的寿命:立牌 → 写 → (成)重拉会话表、撤牌 /
 *                (败)撤牌 + notify(warn)。**牌绝不留过夜**;
 *  · 卸载    —— `reset()`:启动闸、换空间订阅、对账把手、设置 query、名册 query、
 *                mutation、pending 与乐观表一起归零。HMR dispose 复用的就是它。
 *                **目录那一族不在这份拆卸里** —— 它有自己的家
 *                (`providers/catalog-query.ts`),`providers/store.ts` 的 reset 收着它;
 *                两个 reset 收同一格就是两个主人。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · empty    —— 设置读不到 / 这个空间还没配过 → 空投影 → 抽屉**一家都不列**。
 *                那正是「不知道谁可见」诚实的样子,不是「列全部」;
 *  · loading  —— 只有首载算(`phase === 'initial'`)。今天屏幕上**不画**它:
 *                抽屉打开时目录还没到照样列全表(模型 id 来自设置,已经在手上),
 *                少的只有行尾那一格窗口 —— 为一个次要读数画骨架是更坏的谎;
 *  · ready    —— 有过一次答案就永远是它。**重拉保旧**(律②)—— 换空间、重拉目录
 *                期间旧内容留在屏上,由 kernel 的 keep-previous 保证;
 *  · error    —— 后端原话落在各自那一格的 `error` 上,与旧答案**并存**。
 *                **屏幕上今天一个都不画**,这是等价迁移的记档:
 *                  · 名册拉不到 → 从前是 `catch {}` 静默 return,抽屉里只剩自定义
 *                    那几家(或者空);现在 query 会把原话记进 `error`,而抽屉
 *                    **照旧不画** —— 人正在开抽屉,一条错误行只会挡住他要点的那一行;
 *                  · 目录拉不到 → 从前是 `catalogStatus='error'` 而**没有一处读它**
 *                    (那张表从第一天起就没有消费者);现在同样只记不画,窗口那一格空着。
 *                两处都从「记了不画」变成「记了不画」,只是记的地方从一张没人读的表
 *                换成了 query 自己的那一格 —— 要画的那天有真数可读,不必先补一个产地;
 *  · 超量     —— 名册是十几家、每家几十到上百条。抽屉自己封顶 + 滚入视野
 *                (`.pickScroll`),这一层不削量:削在数据层等于让搜索框搜不到。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * 控件在 `composer/components/{Composer,DrawerModelPicker}.tsx`,这里只说读数:
 *  · rest/hover/focus —— 药丸(ButtonBase + `.modelPill`)与抽屉行自己的配方;
 *  · **pending** —— `useAsyncPending(modelMutation, selectKey(sessionId))`:
 *                在飞时药丸上 `aria-busy`,并且**挡住同一条会话的第二发**
 *                (律③要的「反馈长在发起它的那个控件上」+ 逐格,不是整面禁灰);
 *  · disabled —— 药丸本身永不禁用(禁了就连抽屉都开不了),与 agent 徽同一条。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 一家 provider 在屏幕上的全部事实。产地 `providers.list` 的 `ProviderInfo`。 */
export interface ProviderOption {
  id: string
  /** 显示名。空串读作缺席 → 退回用 id 当名字(总比画一个空组头强)。 */
  name: string
}

/**
 * 目录里一条模型 —— 屏幕真正用得着的那几格(模态 / 分词器 / 更新日期不投)。
 *
 * 09-05(庚)之前只有 id + 窗口。抽屉长出右栏那张卡之后,**价格与思考档位也上屏了**,
 * 所以它们从「与屏幕无关」变成「这一层的事实」。两者都不再往返一次:
 * 价格早就在目录行里(`pricing`,`priceOf` 是它的唯一读法),思考档位由
 * `models.getWithCapabilities` 顺手带回(后端逐行投的那四格)。
 */
export interface CatalogModel {
  id: string
  /** context_length,缺席回落 top_provider.context_length;两处都没有 = **不知道**。 */
  contextLength: number | null
  /** 每百万 token 的美元数(目录给的就是每百万,`priceOf` 一次换算都不做);null = 不知道。 */
  pricing: { input: number; output: number } | null
  /** 能选的思考档;`null` = 这一型不思考(也含「后端没投过」);`[]` = 只能开关。 */
  thinkingLevels: ThinkingEffort[] | null
  /** 能不能关掉思考。 */
  thinkingToggleable: boolean
  /** 什么参数都不发时服务端思不思考。 */
  thinkingDefaultOn: boolean
  /** 什么档都没设时的有效档;null = 不知道 / 不思考。 */
  thinkingDefaultLevel: ThinkingEffort | null
  thinkingDisabledLevel?: ThinkingEffort | null
  thinkingLevelLabels?: Partial<Record<ThinkingEffort, string>>
}

/** 抽屉里的一行 = 目录那条的全部读数 + 它的 id。`contextLength` 为 null = 不画那一格。 */
export interface ModelOption extends Omit<CatalogModel, 'id'> {
  model: string
}

/** 抽屉里的一组。`id` 是 provider id(上行要它),`provider` 是显示名(组头写它)。 */
export interface ProviderGroup {
  id: string
  provider: string
  models: ModelOption[]
}

/** 一次选择 = 一对 (provider, model)。`provider` 空串 = 只知道模型名,不知道哪家。 */
export interface ModelSelection {
  provider: string
  model: string
}

/**
 * 一家 provider 里、与**这块屏幕**有关的那几格。整份 provider 设置不进这一层:
 * 存整份等于把一堆与屏幕无关的事实(密钥、端点、采样温度)拖进一个会被订阅的地方。
 *
 * 09-05(庚)加了两格思考档位。它们从前正是被这句话挡在外面的「档位」——
 * 挡的理由是「与屏幕无关」,而药丸从这一天起要写「GPT-5.5 · 高」,那句理由
 * 对这两格不再成立。判据没换,成员换了。
 */
export interface ProviderModelPrefs {
  enabled?: boolean
  selectedModels: string[]
  model: string
  /** 逐模型的思考开关(`thinkingByModel`)。缺席 = 没设过,读 profile 的 defaultOn。 */
  thinking: Record<string, boolean>
  /** 逐模型的思考档(`thinkingEffortByModel`)。缺席 = 没设过,读 profile 的 defaultEffort。 */
  thinkingEffort: Record<string, ThinkingEffort>
  /**
   * 逐模型的**上下文窗口覆盖**(`contextLengthByModel`)。缺席 = 没设过 → 读目录。
   * 09-10 报障「设了 context window 仍显示 unknown」的那一格:手填 / 自建的模型
   * 目录里根本没有,用户在设置里填的那个数**就是**它的窗口。
   */
  contextLength: Record<string, number>
  /**
   * 逐模型的**最大输出覆盖**(`maxOutputByModel`)。屏幕上今天**没有一处画它** ——
   * 一次投影带齐两张「按模型的数字表」是因为它们同源同尺、同一发设置里回来的,
   * 分两次投等于让第二张表将来再开一单。**不画的不消费**:今天零读者。
   */
  maxOutput: Record<string, number>
}

export interface ProviderPrefs {
  /** 这个空间的默认那一家(`SpaceProviderSettings.provider`)。空串 = 还没选过。 */
  defaultProvider: string
  /** providerId → 这一家的那几格。 */
  configs: Record<string, ProviderModelPrefs>
}

/**
 * 一次设置读回来的**两半**。一发往返,两个投影 —— 不是两个产地。
 *
 * 自定义 provider 只住在设置里(`providers.list` 不认识它们),所以「名册的
 * 自定义那一半」与「窄投影」出自同一份原件;分开存会让它们在换空间时
 * 各自到达一次,中间那一帧的抽屉是半份表。
 */
export interface ProviderPrefsFacts {
  prefs: ProviderPrefs
  custom: readonly ProviderOption[]
}

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/** 线上形状 → 屏幕形状。名字空了退回 id:组头总得有个字。 */
export function toProviderOption(info: ProviderInfo): ProviderOption {
  const name = (info.name ?? '').trim()
  return { id: info.id, name: name || info.id }
}

/**
 * 窗口大小的单一产地。`context_length` 优先,缺席回落 `top_provider.context_length`
 * (勘察记的口径),两处都没有(0 / 非有限数)= null = **不知道**。
 * 0 不是一个窗口大小,它是「这一格没填」。
 */
export function contextLengthOf(model: OpenRouterModel): number | null {
  const direct = model.context_length
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
  const fallback = model.top_provider?.context_length
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback
  return null
}

/**
 * 「后端投过思考档位没有」——`thinkingLevels` 缺席(旧缓存 / 测试夹具 / 别的产地)
 * 与「这一型不思考」在屏幕上是同一件事:**不写档**。所以两者都折成 null,
 * 而不是造一个「未知」第三态让每个消费者各判一次。
 */
function toThinking(model: OpenRouterModel): Omit<CatalogModel, 'id' | 'contextLength' | 'pricing'> {
  return {
    thinkingLevels: model.thinkingLevels ?? null,
    thinkingToggleable: model.thinkingToggleable ?? false,
    thinkingDefaultOn: model.thinkingDefaultOn ?? false,
    thinkingDefaultLevel: model.thinkingDefaultLevel ?? null,
    thinkingDisabledLevel: model.thinkingDisabledLevel,
    thinkingLevelLabels: model.thinkingLevelLabels,
  }
}

export function toCatalogModels(models: readonly OpenRouterModel[]): CatalogModel[] {
  return models.map((model) => ({
    id: model.id,
    contextLength: contextLengthOf(model),
    // 价格的唯一读法在 `providers/projection.priceOf`(它连单位判例一起带着) ——
    // 这一层不抄一份「Number(pricing.prompt)」出来。
    pricing: priceOf(model),
    ...toThinking(model),
  }))
}

/**
 * **当前空间那份 provider 设置** → 窄投影。缺席(还没连上 / 后端答不上话 /
 * 这个空间还没配过)= 空投影 —— 三种情况在屏幕上是同一件事:一家都列不出来。
 *
 * **自定义 provider 的默认模型也算一条可列的模型**:它没有 models.dev 目录,
 * 用户在设置里填的那个 `model` 就是它全部的模型表(Vue 壳
 * `buildProviderModelOptions` 的同一手)。不折进来的话,一台只配了自定义
 * provider 的机器打开抽屉会是空的 —— 而它明明能发消息。
 */
export function toProviderPrefs(ai: SpaceProviderSettings | undefined): ProviderPrefs {
  const configs: ProviderPrefs['configs'] = {}
  for (const [id, config] of Object.entries(ai?.providers ?? {})) {
    configs[id] = {
      enabled: config?.enabled,
      selectedModels: Array.isArray(config?.selectedModels) ? config.selectedModels : [],
      model: (config?.model ?? '').trim(),
      thinking: config?.thinkingByModel ?? {},
      thinkingEffort: config?.thinkingEffortByModel ?? {},
      contextLength: config?.contextLengthByModel ?? {},
      maxOutput: config?.maxOutputByModel ?? {},
    }
  }
  for (const custom of ai?.customProviders ?? []) {
    const model = (custom.model ?? '').trim()
    const existing = configs[custom.id]
    const selectedModels = existing?.selectedModels.length
      ? existing.selectedModels
      : model
        ? [model]
        : []
    configs[custom.id] = {
      enabled: existing?.enabled,
      selectedModels,
      model,
      thinking: custom.thinkingByModel ?? existing?.thinking ?? {},
      thinkingEffort: custom.thinkingEffortByModel ?? existing?.thinkingEffort ?? {},
      contextLength: custom.contextLengthByModel ?? existing?.contextLength ?? {},
      maxOutput: custom.maxOutputByModel ?? existing?.maxOutput ?? {},
    }
  }
  return { defaultProvider: (ai?.provider ?? '').trim(), configs }
}

/**
 * 自定义 provider 也要出现在名册上 —— `providers.list` 只回内置的那些
 * (Vue 壳 `updateAvailableProviders` 把两边并起来,这里同判据)。
 */
export function customProviderOptionsOf(ai: SpaceProviderSettings | undefined): ProviderOption[] {
  return (ai?.customProviders ?? []).map((custom) => ({
    id: custom.id,
    name: (custom.name ?? '').trim() || custom.id,
  }))
}

/**
 * 名册两半合流:内置的在前、自定义的在后,**id 撞了以内置为准**
 * (与从前 store 里那两句 set 逐字同效)。
 *
 * 没有自定义的那一家时**原样交回内置那张表** —— 身份不换,照它 memo 的下游
 * 不白重渲(律④)。
 */
export function mergeProviderOptions(
  builtin: readonly ProviderOption[],
  custom: readonly ProviderOption[],
): readonly ProviderOption[] {
  if (custom.length === 0) return builtin
  const extra = custom.filter((c) => !builtin.some((b) => b.id === c.id))
  if (extra.length === 0) return builtin
  return [...builtin, ...extra]
}

/**
 * 这一家在抽屉里列哪几个模型 —— 就是用户在设置里勾过的那些
 * (`selectedModels`,与 Vue 壳 `selectedModelsOf` 同一格)。
 *
 * 当前模型即使没被勾过也**排在最前**:它正在跑,抽屉里找不到它会让人以为
 * 自己看错了(Vue 壳 `buildProviderModelOptions` 的同一手)。
 */
export function modelIdsOf(
  prefs: ProviderPrefs,
  providerId: string,
  current: ModelSelection | null,
): string[] {
  const ids = [...(prefs.configs[providerId]?.selectedModels ?? [])]
  if (current && current.provider === providerId && current.model && !ids.includes(current.model)) {
    ids.unshift(current.model)
  }
  return ids
}

/**
 * 抽屉里的分组表 —— **两道闸**,第三道(凭证)的留账写在 models-port.ts 顶部。
 *  ① 开关:`isProviderEnabledIn`(契约层的家族派生,不在这里重写一遍);
 *  ② 有模型可列:一条都列不出来的家不出组头(空组头等于让人点了个寂寞)。
 *
 * 目录还没拉到的家**照样出组**:它的模型 id 来自设置(那一份已经在手上),
 * 少的只是窗口那一格。为了一个次要读数把整组藏起来是更坏的谎。
 */
export function buildProviderGroups(
  providers: readonly ProviderOption[],
  prefs: ProviderPrefs,
  catalog: Readonly<Record<string, CatalogModel[]>>,
  current: ModelSelection | null,
): ProviderGroup[] {
  const groups: ProviderGroup[] = []
  for (const provider of providers) {
    if (!isProviderEnabledIn(prefs.configs, provider.id)) continue
    const ids = modelIdsOf(prefs, provider.id, current)
    if (ids.length === 0) continue
    const models = catalog[provider.id] ?? []
    groups.push({
      id: provider.id,
      provider: provider.name,
      models: ids.map((id) => {
        // 目录还没到 / 这条不在目录里 = **一格读数都不知道**(窗口、价格、档位)。
        // 不知道就不画,不编 —— 与 `contextLength` 从第一天起的口径逐字相同。
        //
        // 唯一的例外是窗口:**用户自己说过的那个数不是「不知道」**。手填 / 自建的
        // 模型永远不在目录里,而它的窗口就写在这个空间的设置里 —— 所以覆盖优先,
        // 其余各格照旧空着(判据在 `overrideContextLengthOf` + `readingsOf` 两处折)。
        const entry = models.find((model) => model.id === id)
        return { model: id, ...readingsOf(entry, overrideContextLengthOf(prefs, provider.id, id)) }
      }),
    })
  }
  return groups
}

/** 「这条不在目录里」的那一份读数:全体不知道。恒等常量,`readingsOf` 的缺席档。 */
export const UNKNOWN_MODEL_READINGS: Omit<CatalogModel, 'id'> = {
  contextLength: null,
  pricing: null,
  thinkingLevels: null,
  thinkingToggleable: false,
  thinkingDefaultOn: false,
  thinkingDefaultLevel: null,
}

/**
 * 目录条目 → 屏幕上那几格读数。`id` 不在读数里(它是身份,不是读数)。
 *
 * `override` = 用户在设置里给这一型填过的窗口(`overrideContextLengthOf` 的答案)。
 * **在场就盖过目录**,与引擎 `getOnethingModelContextLength` 同序;其余格一格不动。
 * 目录条目缺席而覆盖在场(手填模型的常态)= 只有窗口有值,别的仍是不知道 ——
 * 「有人说过窗口」不等于「有人说过价格和思考档」。
 */
export function readingsOf(
  entry: CatalogModel | undefined,
  override: number | null = null,
): Omit<CatalogModel, 'id'> {
  if (!entry) {
    // 覆盖也没有 → 交回那个恒等常量(身份不换,照它 memo 的下游不白重渲,律④)。
    if (override === null) return UNKNOWN_MODEL_READINGS
    return { ...UNKNOWN_MODEL_READINGS, contextLength: override }
  }
  return {
    contextLength: override ?? entry.contextLength,
    pricing: entry.pricing,
    thinkingLevels: entry.thinkingLevels,
    thinkingToggleable: entry.thinkingToggleable,
    thinkingDefaultOn: entry.thinkingDefaultOn,
    thinkingDefaultLevel: entry.thinkingDefaultLevel,
    thinkingDisabledLevel: entry.thinkingDisabledLevel,
    thinkingLevelLabels: entry.thinkingLevelLabels,
  }
}

/**
 * 默认选择 = 引擎在用户没选过时会用的那一个(**当前空间**那份设置的 `provider` +
 * 那一家的 `model`)。两格缺一 = 没有默认,不编。
 */
export function defaultSelectionOf(prefs: ProviderPrefs): ModelSelection | null {
  const provider = prefs.defaultProvider
  if (!provider) return null
  const model = prefs.configs[provider]?.model ?? ''
  return model ? { provider, model } : null
}

/**
 * 此刻跑的是哪个模型 —— **屏幕唯一的判据**(三层,顺序即事实的新鲜度)。
 *
 * 会话事实那一层要求 `model` 有值;`provider` 允许缺席(老会话可能只有
 * `lastModel`)—— 那时候药丸照样写得出模型名,只是查不到窗口。
 */
export function resolveModelSelection(
  optimistic: Readonly<Record<string, ModelSelection>>,
  sessionId: string | null,
  session: { provider: string | null; model: string | null } | undefined,
  pending: ModelSelection | null,
  prefs: ProviderPrefs,
): ModelSelection | null {
  if (sessionId && optimistic[sessionId]) return optimistic[sessionId]
  if (session?.model) return { provider: session.provider ?? '', model: session.model }
  // 没有会话时,药丸上写的是「下一条新会话会用谁」——与 agent 徽同一条口径。
  if (!sessionId && pending) return pending
  return defaultSelectionOf(prefs)
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 思考档位:**屏幕上写什么** 的唯一判据(09-05 庚)
 * ══════════════════════════════════════════════════════════════════════════
 * 它照抄的是**发送链**(`agent-loop/providers/thinking-options.ts` 的
 * `getGenericThinkingOptions`)那三句,不是另立一套:
 *   `thinkingByModel[m] === false` → 明确关掉,请求带 `thinking:'disabled'`;
 *   `=== true`                     → 明确开着,档由 `thinkingEffortByModel[m]` 说,
 *                                    没设就是**一个参数都不发**,服务端用它的缺省档;
 *   缺席                            → 一个参数都不发,开不开与用哪一档全由服务端缺省
 *                                    决定 —— 那正是 profile 的 `defaultOn` / `defaultEffort`。
 * 所以「没设过」这一档屏幕上写的是 profile 的缺省,不是空白,也不是编的:
 * 它是这一发真的会发生的事。
 *
 * 判据只有这一处 —— 药丸(写字)与右栏阶梯(哪一颗按下)读同一个它,
 * 两处各判一次就是两处会漂。
 */
export interface ThinkingState {
  levelLabels?: Partial<Record<ThinkingEffort, string>>
  /** 这一型思不思考。假 = 药丸不写档、右栏不画控件。 */
  supported: boolean
  /** 此刻(以及下一发)到底想不想。 */
  on: boolean
  /** 此刻的有效档;null = 这一型没有档可挑(只有开 / 关)。 */
  level: ThinkingEffort | null
  /** 能选的档。空 = 只有开 / 关。 */
  levels: readonly ThinkingEffort[]
  /** 允不允许「关」。 */
  toggleable: boolean
  /** 用户明确设过没有(阶梯要它区分「按下的是缺省」还是「按下的是我选的」)。 */
  explicit: boolean
}

const NO_THINKING: ThinkingState = {
  supported: false,
  on: false,
  level: null,
  levels: [],
  toggleable: false,
  explicit: false,
}

export function thinkingStateOf(
  readings: Pick<
    CatalogModel,
    'thinkingLevels' | 'thinkingToggleable' | 'thinkingDefaultOn' | 'thinkingDefaultLevel' |
    'thinkingDisabledLevel' | 'thinkingLevelLabels'
  >,
  config: Pick<ProviderModelPrefs, 'thinking' | 'thinkingEffort'> | undefined,
  modelId: string,
): ThinkingState {
  const levels = readings.thinkingLevels
  if (!levels) return NO_THINKING
  const chosen = config?.thinking?.[modelId]
  const on = !readings.thinkingToggleable || (chosen ?? readings.thinkingDefaultOn)
  const effort = chosen === true ? config?.thinkingEffort?.[modelId] : undefined
  // 一档都没有的型(qwen3.5 / 智谱)只有开 / 关 —— 那时 `level` 恒为 null,
  // 哪怕盘上莫名其妙存着一个档:屏幕不写一个这一型根本不接受的字。
  const requestedLevel = chosen === false && !readings.thinkingToggleable
    ? readings.thinkingDisabledLevel ?? readings.thinkingDefaultLevel
    : effort
  const level = levels.length === 0 ? null : resolveOnethingReasoningEffort(
    requestedLevel ?? undefined, levels, readings.thinkingDefaultLevel ?? levels[levels.length - 1],
  )
  return {
    ...(readings.thinkingLevelLabels ? { levelLabels: readings.thinkingLevelLabels } : {}),
    supported: true,
    on,
    level: on ? level : null,
    levels,
    toggleable: readings.thinkingToggleable,
    explicit: chosen !== undefined,
  }
}

/**
 * **用户在这个空间给这一型填过的窗口**(`contextLengthByModel[model]`)。
 * 没填过 / 填的不是一个正有限数 = null = 没覆盖。
 *
 * 那把尺与 `providers/projection.ts` 的 `positive()` **同义**(0 / 负数 / 非有限数
 * = 这一格没填),就地写两行而不跨目录 import 它:那只是设置面自己的私有小工具,
 * 为一句同义判据把两块面拴在一起不划算。引擎那头的判据是
 * `getOnethingModelContextLength` 的 `typeof override === 'number' && override > 0`,
 * 三处同尺。
 */
export function overrideContextLengthOf(
  prefs: ProviderPrefs,
  provider: string,
  model: string,
): number | null {
  if (!provider || !model) return null
  const value = prefs.configs[provider]?.contextLength?.[model]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 这个选择的上下文窗口 —— **两个产地,用户覆盖优先、目录其次**(09-10;引擎
 * `getOnethingModelContextLength` 从第一天起就是这个序,壳的三处读数到这一天才跟上)。
 * 两处都没有(目录没拉到 / 这条不在目录里 / 目录没填 / 没覆盖)= null = 不知道。
 */
export function contextWindowOf(
  catalog: Readonly<Record<string, CatalogModel[]>>,
  selection: ModelSelection | null,
  prefs: ProviderPrefs,
): number | null {
  if (!selection?.provider || !selection.model) return null
  const override = overrideContextLengthOf(prefs, selection.provider, selection.model)
  if (override !== null) return override
  return catalog[selection.provider]?.find((m) => m.id === selection.model)?.contextLength ?? null
}

/* ── 读:两只 query,外加合并过来的那一族目录 ──────────────────────────── */

/**
 * 「一格设置都没有」的那一份。恒等常量:缺席时交同一个引用(律④)。
 * **导出是给用例用的** —— `contextWindowOf` 自 09-10 起要一份 prefs,而多数用例
 * 验的是目录那一半,手写一个 `{defaultProvider:'',configs:{}}` 就是第二份口径。
 */
export const EMPTY_PREFS: ProviderPrefs = { defaultProvider: '', configs: {} }
/** 恒等的空表 —— 缺席时交同一个引用,照它 memo 的下游不白重渲(律④)。 */
const NO_PROVIDERS: readonly ProviderOption[] = []
const EMPTY_FACTS: ProviderPrefsFacts = { prefs: EMPTY_PREFS, custom: NO_PROVIDERS }
const EMPTY_CATALOG: Readonly<Record<string, CatalogModel[]>> = {}

/**
 * 当前空间那份 provider 设置。**键就是空间 id** —— 从前那句手写的
 * 「拉的过程中又切了空间就丢掉」因此退役:一发回得再晚,它也只落进自己那一格。
 *
 * 一条判据留在这里,因为它是**这一口的事实**,不是 kernel 的:
 * **`success:false` 不是失败,是空投影**。「这个空间还没配过 provider」是一个
 * 真答案,画出来就是抽屉一家都不列;抛出去会让它进 error 档、并把上一个空间
 * 那份留在屏上(keep-previous),那才是说谎。真正的失败(传输面死了)照旧抛,
 * 由 kernel 记进 `error` 并留住上一份。
 *
 * 两发一起走:空间那份 + 全局那份。**全局那份不是回落用的**,它是拿来回答
 * 「这台机器迁移过没有」的(`storage.spaceProviderSettingsMigratedAt`)——
 * 判据与取舍全在 `resolveSpaceProviderSettings` 一处,09-01 报障 ① 的病历也在那儿。
 * 各自失败各自认:全局那发拿不到就当没迁移过的证据不足,照旧以空间那份为准。
 */
export const prefsQuery = createQueryFamily<ProviderPrefsFacts>('models.prefs', async (ctx) => {
  const port = await modelsPort()
  const [settings, global] = await Promise.all([
    port.readProviderSettings(ctx.key),
    port.readSettings().catch(() => undefined),
  ])
  const ai = settings.success
    ? resolveSpaceProviderSettings(settings.ai, global?.success ? global.settings : undefined)
    : undefined
  if (!ai) return EMPTY_FACTS
  return { prefs: toProviderPrefs(ai), custom: customProviderOptionsOf(ai) }
})

/**
 * provider 名册(内置那一半)。全应用一格,所以是 `createQuery` 而不是一族 ——
 * 它是**机器级**的事实,不跟空间走。
 *
 * **它会碰网**(文件头那条:后端顺手拉 models.dev 的 7494 条),所以它是懒的:
 * 只有抽屉打开时 `ensureVisibleCatalogs` 才 `ensure()` 它,开机路径一发都不发。
 *
 * `success:false` 与抛出在这里是**同一件事**:两者都不是「这台机器一家都没有」。
 * 抛出去之后 kernel 记进 `error`、**留住上一份名册**,而且因为 `dataRev` 还是 0,
 * 下一次 `ensure()` 会真的重试 —— 与从前「`providersLoaded` 没置上,下次再拉」
 * 逐字同效。屏幕上照旧**不画**这条错误(理由见文件头 ② 的 error 栏)。
 */
export const providersQuery = createQuery<readonly ProviderOption[]>(
  'models.providers',
  async () => {
    const port = await modelsPort()
    const response = await port.listProviders()
    if (!response.success) throw new Error(response.error || 'providers.list 未成功')
    return (response.providers ?? []).map(toProviderOption)
  },
)

/** 当前空间那一格设置的读法 —— 取数与组件侧共用这一句,不各拼一次。 */
function prefsFacts(): ProviderPrefsFacts {
  return prefsQuery.get(currentSpaceId()).get().data ?? EMPTY_FACTS
}

/**
 * 名册**合流之后**的那张表(取数侧的读法;组件侧走 `useProviderOptions`)。
 * 内置来自 query,自定义来自设置那一发 —— 两半各有产地,合流只有这一处。
 */
function providerOptions(): readonly ProviderOption[] {
  return mergeProviderOptions(providersQuery.get().data ?? NO_PROVIDERS, prefsFacts().custom)
}

/**
 * 拉一家的目录。
 *
 * 这**不是**那套四件套的转发壳(kernel 手册禁的是那个):它是这块面对目录格的
 * **编排** —— 「此刻哪一格该有答案」。判据(拉过就不再拉、并发折叠、保旧)
 * 一条都不在这里,全在 `catalogQuery` 那一族里。
 */
export async function ensureCatalog(providerId: string): Promise<void> {
  if (!providerId) return
  await catalogQuery.get(providerId).ensure()
}

/**
 * 抽屉打开时:名册先到位(它也是懒的),再按两道闸挑出**可见**的那几家去拉目录。
 * 关掉的家、一条模型都没勾的家一发都不发。
 */
export async function ensureVisibleCatalogs(current: ModelSelection | null): Promise<void> {
  await providersQuery.ensure()
  const groups = buildProviderGroups(providerOptions(), prefsFacts().prefs, EMPTY_CATALOG, current)
  await Promise.all(groups.map((group) => catalogQuery.get(group.id).ensure()))
}

/* ── 写:一只 mutation,一个格 ──────────────────────────────────────────── */

/** 忙态格子的**唯一词表**。store 记账与组件读账共用它 —— 两头各拼一次就是两处会漂。 */
export function selectKey(sessionId: string): string {
  return `select:${sessionId}`
}

/**
 * 一次写要带的全部东西。两口一个联合,`kind` 同时是分派与「立不立牌」的产地:
 *  · `select` —— 用户在抽屉里点了一个模型。立乐观牌,写完重拉会话表再撤牌;
 *  · `apply`  —— 新会话建出来之后兑现 `pending`。**不立牌、不重拉**
 *                (语义逐字保留:那条路刚刚才 create + refresh 过一遍,
 *                 再补一发对账是白跑一趟往返)。
 *
 * 两口共一只 mutation 的理由:失败那句话只该有一处产地。从前它在两个 action
 * 里各抄了一遍 try/catch + notify,那正是「同一句话在两处会漂」的形状。
 * 与 `agents-source.AgentWrite` 逐字同形。
 */
export type ModelWrite =
  | { kind: 'select'; sessionId: string; provider: string; model: string }
  | { kind: 'apply'; sessionId: string; provider: string; model: string }

/**
 * 最近一次**对账**(settle 里那发重拉 + 撤牌)的把手。
 *
 * 为什么需要它:`createMutation` 的 settle 是**不被 await 的** —— 对账是后台的事,
 * 不该把控件多按住一拍(理由写在 kernel 的 `mutation.ts` 里)。但撤牌这一步
 * **必须排在重拉之后**:中间那一段仍由牌顶着,药丸才不会闪回旧模型。而
 * `selectModel` 对调用方(以及用例)是有承诺的 —— 所以两件事各归各位:
 * **控件**的忙态在 settle 之前解除(律③要的那一拍),**action 自己**多等这一口。
 * 与 `agents-source.ts` / `workspace/store.ts` 的 `reconcile` 逐字同形。
 */
let reconcile: Promise<void> | undefined

/** 撤牌。成功走对账那一路,失败走 optimistic 交出来的回滚 —— 两条路不共用一份代码。 */
function dropOptimistic(sessionId: string): void {
  useModelsSource.setState((prev) => {
    if (!(sessionId in prev.optimistic)) return prev
    const next = { ...prev.optimistic }
    delete next[sessionId]
    return { optimistic: next }
  })
}

/*
 * 类型**显式写出来**,不靠推断:这只 mutation 与下面那只 store 互相引用
 * (它 setState 立牌撤牌;store 的两个 action 又调它的 run)。运行期没问题
 * (两边都是**调用时**才碰对方),但 TS 的推断会绕成一个环 —— 一句注解就把环
 * 剪断,与 `agents-source.ts` / `workspace/store.ts` 同一处判例。
 */
export const modelMutation: Mutation<ModelWrite, void> = createMutation<ModelWrite, void>(
  'models.select',
  {
    key: (input) => selectKey(input.sessionId),

    optimistic: (input) => {
      // 兑现那一路不立牌:会话刚建出来,屏幕上还没有一块要顶的牌。
      if (input.kind !== 'select') return
      const before = useModelsSource.getState().optimistic
      const card: ModelSelection = { provider: input.provider, model: input.model }
      useModelsSource.setState({ optimistic: { ...before, [input.sessionId]: card } })
      // 交出去的这个函数**就是**回滚 —— 补丁与它的撤销出自同一处,不会漂开。
      return () => {
        useModelsSource.setState((prev) => {
          const next = { ...prev.optimistic }
          if (input.sessionId in before) next[input.sessionId] = before[input.sessionId]
          else delete next[input.sessionId]
          return { optimistic: next }
        })
      }
    },

    run: async (input) => {
      const port = await modelsPort()
      const response = await port.updateSessionModel(input.sessionId, input.provider, input.model)
      // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得走 onError。
      // 兜底话原样保留:后端没给原话时,那句人话本身就是能说的全部。
      if (!response.success) throw new Error(response.error || t('model.switchFailed'))
    },

    settle: (_result, input) => {
      if (input.kind !== 'select') return
      reconcile = (async () => {
        // 对齐:后端认了这件事之后,牌就该撤掉 —— 屏幕从此读 listMeta 的事实。
        // 撤牌**在重拉之后**,中间那一段仍由牌顶着,所以药丸不会闪回旧模型。
        await useSessionsSource.getState().refresh()
        dropOptimistic(input.sessionId)
      })()
    },

    // 回滚已经由 kernel 在这之前跑过了(「屏幕上不许留一张后端没认下的牌,
    // 哪怕只留一帧」)。这里只剩说出来那一半 —— 后端原话原样进 body 与 detail。
    onError: (error) => {
      notify({
        level: 'warn',
        source: 'model.switch',
        title: t('model.switchFailed'),
        body: error.message,
        detail: error.message,
      })
    },
  },
)

/* ── store:只剩两格状态与四个 action ───────────────────────────────────── */

export interface ModelsSourceState {
  /**
   * 「还没进会话时选的那个模型」= 下一条新会话的模型。
   * 建会话的编排点(`expose/store.newSession`)建完就 `applyPendingModel` 兑现,
   * 与 `agents-source.pendingAgentId` 逐条同构。
   */
  pending: ModelSelection | null
  /**
   * 刚选完、还没被 `listMeta` 追认的那些。键 = 会话 id。
   *
   * 乐观更新的**唯一**存放处 —— 它是写路的东西,所以留在这只薄 store 里,
   * 不打在任何一格 query 上(与 `agents-source.optimistic` 同一条)。
   * 写成功立牌、重拉之后撤牌;写失败当场撤牌 + notify(warn),**绝不留说谎的牌**。
   */
  optimistic: Record<string, ModelSelection>

  /** 连通后启动:订上换空间,并**只**拉设置(不碰网)。幂等。 */
  start: () => Promise<void>
  /** 重新拉一次当前空间的设置(设置在别处被改过之后要它)。 */
  refresh: () => Promise<void>
  /**
   * 选一个模型。
   *  - 有会话:`sessions.updateModel` —— **从下一轮起生效,历史照留**;
   *  - 没有会话:只记 `pending`(建会话时兑现)。
   */
  selectModel: (sessionId: string | null, provider: string, model: string) => Promise<void>
  /** 把 `pending` 兑现到刚建出来的那条会话上,然后**无论成败都清空**。 */
  applyPendingModel: (sessionId: string) => Promise<void>
  /** 测试用:回到未启动的干净态。 */
  reset: () => void
}

/** 模块级的启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false
/** 换空间那条订阅的句柄 —— 这一个进程的事实,不是可渲染状态。 */
let unsubscribeSpace: (() => void) | undefined

export const useModelsSource = create<ModelsSourceState>()((set, get) => ({
  pending: null,
  optimistic: {},

  start: async () => {
    if (started) return
    started = true
    /*
     * 换工作区 = 换一格设置。订在首发之前,理由与 sessions-source 那条逐字相同:
     * 工作区列表是异步读的,首次读到时当前空间可能解析成别的。
     *
     * 换键之后是 `refetch()` 而不是 `ensure()`:**换空间照旧必重读**,与迁移前
     * 逐字同一条往返时机 —— 键控只改「答案落进哪一格」,不改「什么时候去问」。
     * `refetch` 不清屏(kernel 的 keep-previous),所以律②不受影响:回到一个
     * 问过的空间时,旧答案先在屏上,新答案到了才换。
     *
     * 这一格还有**第二个作废源**(09-02 结清,起因是用户报「设置里 disable 掉一家
     * provider,输入框的模型选择器仍列出它的模型」):设置面写完盘之后,
     * `providers/store.ts` 的 `settingsMutation.settle` 会 `prefsQuery.invalidate(空间 id)`。
     * 换空间与写设置是「这一格旧了」的**两个产地、同一口作废**,都走 kernel 的
     * 保旧后台补拉 —— 抽屉开着不闪、没人看则只记脏标记等下一次 `ensure`。
     */
    unsubscribeSpace?.()
    unsubscribeSpace = subscribeCurrentSpace(() => {
      void prefsQuery.get(currentSpaceId()).refetch()
    })
    const port = await modelsPort()
    await port.ready()
    await prefsQuery.get(currentSpaceId()).ensure()
  },

  refresh: async () => {
    await prefsQuery.get(currentSpaceId()).refetch()
  },

  selectModel: async (sessionId, provider, model) => {
    if (!provider || !model) return
    // 还没进会话:这次选择是「下一条新会话用谁」,不写盘也不发请求。
    if (!sessionId) {
      set({ pending: { provider, model } })
      return
    }
    // 同一条会话上已经有一发在飞:这一下不发第二发(律③的另一半 —— 反馈是
    // 「不可再点」,判据与药丸上那个 aria-busy 读的是同一格)。
    if (modelMutation.isPending(selectKey(sessionId))) return
    await modelMutation.run({ kind: 'select', sessionId, provider, model })
    // 成败都等这一口:失败时 reconcile 还是上一次那个(或 undefined),等它无害。
    await reconcile
  },

  applyPendingModel: async (sessionId) => {
    const selection = get().pending
    if (!sessionId || !selection) return
    // 清空是**无条件**的,而且在写之前:这一格说的是「下一条新会话用谁」,
    // 下一条已经建出来了,这句话就用掉了(理由与 `applyPendingAgent` 逐字相同)。
    set({ pending: null })
    // run 不抛 —— 失败已经在原语里处理完了(这一路没有牌可回滚,只剩 notify)。
    await modelMutation.run({
      kind: 'apply',
      sessionId,
      provider: selection.provider,
      model: selection.model,
    })
  },

  reset: () => {
    started = false
    unsubscribeSpace?.()
    unsubscribeSpace = undefined
    reconcile = undefined
    prefsQuery.reset()
    providersQuery.reset()
    modelMutation.reset()
    set({ pending: null, optimistic: {} })
  },
}))

/**
 * **HMR 退役**(09-01 立法,起因是 chat-source 那一案:热更之后旧模块的模块级
 * 副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用有六样:启动闸 `started`、换空间订阅 `unsubscribeSpace`、
 * 对账把手 `reconcile`、设置 query 与名册 query(各自带监听表)、写路 mutation
 * (监听表 + 逐格计数)。六样的寿命都是「这个模块实例」—— 不退役,旧实例那条
 * 换空间订阅会继续往没人看的格子里灌数。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useModelsSource.getState().reset()
  })
}

/* ── 组件侧 ────────────────────────────────────────────────────────────── */

/**
 * 「当前是哪个空间」的订阅读法。判据仍然只有 `currentSpaceId()` 一处产地,
 * 这里只是把它接到 store 的订阅上 —— 换空间时组件要跟着换那一格 query。
 */
function useSpaceId(): string {
  return useWorkspaceStore(() => currentSpaceId())
}

/** 当前空间的窄投影。缺席(还没拉 / 这个空间没配过)= 恒等的空投影。 */
export function useProviderPrefs(): ProviderPrefs {
  return useQuery(prefsQuery.get(useSpaceId())).data?.prefs ?? EMPTY_PREFS
}

/**
 * 抽屉里列哪几家 —— 内置名册(query)+ 自定义那几家(设置里)。
 * 合流判据只有 `mergeProviderOptions` 一处;两半都缺席时交回同一个空表(律④)。
 */
export function useProviderOptions(): readonly ProviderOption[] {
  const builtin = useQuery(providersQuery).data ?? NO_PROVIDERS
  const custom = useQuery(prefsQuery.get(useSpaceId())).data?.custom ?? NO_PROVIDERS
  return useMemo(() => mergeProviderOptions(builtin, custom), [builtin, custom])
}

/**
 * 把「这几家的目录」拼成 `buildProviderGroups` / `contextWindowOf` 吃的那张表。
 *
 * 为什么要手写一层订阅而不是 `useQuery` 一发:目录是**一族**,要几格由屏幕上
 * 此刻有几家决定,而 hook 不能有条件地、变数量地调。所以这里自己接
 * `useSyncExternalStore`:订阅面是那几格的并集,快照按 `dataRev` 记账 ——
 * **没有一格的答案真的变过就交回上一次那个对象**(律④:身份稳定;
 * 不这么做 getSnapshot 每次新对象,React 会无限重渲,理由写在 kernel/query.ts)。
 *
 * `dataRev` 够用是因为它正是 kernel 的「答案真的变了几次」:目录那一族的
 * `equals` 逐条比 id / name / context_length,「刷新了但内容没变」不推进它。
 *
 * 没拉过的格**不进表**(`data` 是 undefined)—— 那正是 `buildProviderGroups`
 * 里「目录还没到照样出组,只是窗口那一格是 null」要的形状。
 */
export function useCatalogRecord(
  providerIds: readonly string[],
): Readonly<Record<string, CatalogModel[]>> {
  /** 订阅面与快照都按这一串认身份 —— 数组每次渲染都是新的,字符串不是。 */
  const key = providerIds.join('\n')
  const ids = useMemo(() => (key ? key.split('\n') : []), [key])
  /*
   * 「从来没算过」用 `key: null` 表达,不用一个「不可能的字符串」当哨兵:
   * `join` 出来的键**可以是空串**(一家都不列的那一屏),所以任何字符串哨兵
   * 都得先证明自己撞不上;`null` 不在 `join` 的值域里,一眼看得出来。
   */
  const cache = useRef<{
    key: string | null
    revs: string
    value: Readonly<Record<string, CatalogModel[]>>
  }>({ key: null, revs: '', value: EMPTY_CATALOG })

  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = ids.map((id) => catalogQuery.get(id).subscribe(listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [ids],
  )

  const snapshot = useCallback(() => {
    const revs = ids.map((id) => `${id}:${catalogQuery.get(id).get().dataRev}`).join('\n')
    const held = cache.current
    if (held.key === key && held.revs === revs) return held.value
    const value: Record<string, CatalogModel[]> = {}
    for (const id of ids) {
      const models = catalogQuery.get(id).get().data
      if (models) value[id] = toCatalogModels(models)
    }
    cache.current = { key, revs, value }
    return value
  }, [ids, key])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * 这个选择的上下文窗口 —— 读数环与明细卡的那一格。
 *
 * 只订**当前这一家**那一格,不订整族:环要的是一个数,拿整张表来算等于让它
 * 跟着别人家的目录一起重渲。判据仍是 `contextWindowOf` 一处产地。
 *
 * 09-10 起多订**一格**设置(`useProviderPrefs` = 当前空间那一格,不是整份 settings):
 * 窗口有两个产地,覆盖那一半住在设置里。作废不用另接事件 —— 设置面写完盘
 * (`providers/store.ts` 的 `settingsMutation.settle`)会 `prefsQuery.invalidate(空间 id)`,
 * 这一格有人在看,kernel 自己后台补拉,环与抽屉跟着换数。
 */
export function useModelWindow(selection: ModelSelection | null): number | null {
  const providerId = selection?.provider ?? ''
  const ids = useMemo(() => (providerId ? [providerId] : []), [providerId])
  const catalog = useCatalogRecord(ids)
  const prefs = useProviderPrefs()
  return useMemo(() => contextWindowOf(catalog, selection, prefs), [catalog, selection, prefs])
}

/**
 * 这个选择的**读数一份**(窗口 / 价格 / 思考四格)。药丸与右栏那张卡共用。
 *
 * 与 `useModelWindow` 逐条同构:只订当前这一家那一格 + 当前空间那一格设置,
 * 不订整族、不订整份 settings。两只并存不是重复 —— 环只要一个数,而卡要一整份;
 * 让环跟着卡的对象身份重渲是白重渲。
 */
export function useModelReadings(selection: ModelSelection | null): Omit<CatalogModel, 'id'> {
  const providerId = selection?.provider ?? ''
  const ids = useMemo(() => (providerId ? [providerId] : []), [providerId])
  const catalog = useCatalogRecord(ids)
  const prefs = useProviderPrefs()
  return useMemo(() => {
    if (!selection?.provider || !selection.model) return UNKNOWN_MODEL_READINGS
    return readingsOf(
      catalog[selection.provider]?.find((m) => m.id === selection.model),
      overrideContextLengthOf(prefs, selection.provider, selection.model),
    )
  }, [catalog, selection, prefs])
}

/**
 * 此刻这个模型的思考态 —— 药丸与右栏阶梯的**唯一读法**。
 * 判据仍然只有 `thinkingStateOf` 一处产地,这里只是把它接到两条订阅上
 * (目录那一格 + 当前空间的设置那一格)。
 */
export function useThinkingState(selection: ModelSelection | null): ThinkingState {
  const readings = useModelReadings(selection)
  const prefs = useProviderPrefs()
  return useMemo(
    () =>
      selection?.model
        ? thinkingStateOf(readings, prefs.configs[selection.provider], selection.model)
        : NO_THINKING,
    [readings, prefs, selection],
  )
}

/**
 * 此刻跑的是哪个模型 —— 组件侧唯一的读法(药丸、抽屉、读数环共用)。
 * 判据仍然只有 `resolveModelSelection` 一个产地,这里只是把它接到订阅上,
 * 与 `files-source.useSessionCwd` 逐条同构。
 *
 * `sessionId` 是**入参**而不是就地读总览 store:那会让这个模块 import
 * `expose/store`,而 `expose/store` 为了兑现草稿态的预选又要 import 这里 ——
 * 一个可以不长出来的环。调用现场本来就知道自己在哪条会话上。
 */
export function useCurrentModelSelection(sessionId: string): ModelSelection | null {
  const sessions = useSessionsSource((st) => st.sessions)
  const optimistic = useModelsSource((st) => st.optimistic)
  const pending = useModelsSource((st) => st.pending)
  const prefs = useProviderPrefs()
  return useMemo(
    () =>
      resolveModelSelection(
        optimistic,
        sessionId || null,
        findSession(sessions, sessionId),
        pending,
        prefs,
      ),
    [optimistic, sessionId, sessions, pending, prefs],
  )
}
