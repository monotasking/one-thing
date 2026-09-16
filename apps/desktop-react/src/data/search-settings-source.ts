import { createMutation, createQuery, type Mutation } from './kernel'
import { searchSettingsPort } from './search-settings-port'
import { searchStatusQuery } from './search-catalog-source'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { DEFAULT_SEMANTIC_MODEL_ID, type AppSettings } from '@shared/ipc/settings'
import type { SearchStatusResponse } from '@shared/ipc/search'

/**
 * 设置页「搜索 → 按含义找」那一节的取数与一条写路。
 *
 * 设计:`docs/design/search-index-2026-09.md` §15(语义召回)。这一节结清了那份
 * 文档 §13 留账的最后一条 **「S7:设置页没有 UI」** —— 在此之前打开语义召回的唯一
 * 办法是手改 `~/.onething/settings.json`。
 *
 * ── 屏幕上那一节要的形状 ──────────────────────────────────────────────────
 * 整份 `AppSettings` 不是这一节的形状:它只问两件事(开着没有、用哪个嵌入器),
 * 外加一样**不住设置里**的事实 —— 索引此刻拿向量路在干什么。所以这里有两个产地:
 *
 *  | 要什么 | 产地 | 为什么不合并 |
 *  | --- | --- | --- |
 *  | 开关 / 模型 | `semanticSearchQuery`(这个文件) | 它是**设置**,写得动 |
 *  | 向量路在干什么 | `searchStatusQuery`(`search-catalog-source.ts`) | 它是**索引的状态**,只读,而且检索面已经在订它了 |
 *
 * 两者在屏幕上合成一句话,那一步是纯函数 `semanticPhaseOf` —— 投影不是画画。
 */

/** 屏幕上那一节的设置形状(两格)。 */
export interface SemanticSearchView {
  enabled: boolean
  /**
   * 嵌入器注册表里的 id(§15.3:**模型是数据**)。今天全仓只注册了一档,所以设置页
   * 把它画成一行**只读**的读数而不是一个选择器 ——「设置极简」那条:一个只有一项
   * 可选的选择器是纯噪音。注册表长出第二档时这一行换成 `ui/Segmented` 即可,形状
   * 这一层一个字不用改。
   */
  modelId: string
}

/**
 * 整份设置 → 这一节要的两格。纯函数。
 *
 * 回落在这里再做一次**不是与 defaults 重复**:`mergeWithDefaults` 归一的是后端那
 * 一份,而这只函数还要吃「后端答的那份压根没有 search 这一段」(老 store、被手改过
 * 的 `settings.json`、被裁过的响应)。
 */
export function toSemanticSearchView(settings: Pick<AppSettings, 'search'>): SemanticSearchView {
  return {
    enabled: settings.search?.semantic?.enabled === true,
    modelId: settings.search?.semantic?.modelId || DEFAULT_SEMANTIC_MODEL_ID,
  }
}

export const semanticSearchQuery = createQuery<SemanticSearchView>(
  'search.semanticSettings',
  async () => {
    const port = await searchSettingsPort()
    await port.ready()
    const response = await port.readSettings()
    // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并**留住上一份**
    // (律②)。回一个「关着」会把「拉不到」画成「你没开过」,那是编。
    if (!response.success || !response.settings) {
      throw new Error(response.error || 'settings.getSettings 未成功')
    }
    return toSemanticSearchView(response.settings)
  },
)

/**
 * 这一节此刻在说哪句话。**八个态,判据全在参数里**(没有计时器、没有「刚才点过」
 * 这种记忆),所以它可以被逐态单测。
 *
 * ── 为什么 `starting` 判的是「`vector` 缺席」而不是一段宽限时间 ──────────────
 * 契约上 `SearchStatusResponse.vector` 缺席的意思就是**不知道**。翻开关那一下,
 * 写路的 `optimistic` 顺手把这一格抹成 undefined —— 上一条 Worker 答的 `'off'`
 * 说的是上一份配置,拿它画「没跑起来」是拿旧答案回答新问题。真答案由那一发对账
 * 带回来(几十到几百毫秒),中间这一段屏幕上写的是「正在启动」,不是一次闪红。
 *
 * ── 为什么 `failed` 不猜原因 ──────────────────────────────────────────────
 * 打包版的桌面 app 里 `vectorExtension` 是 `loadable`(`vec0.dylib` 有
 * `asarUnpack`),缺的是嵌入运行时(`electron-builder.yml` 排掉了
 * `@huggingface/transformers`,§13 拍点癸');而开发机上同一个 `'off'` 也可能是模型
 * 没下下来。**两件事在这一格上长得一模一样**,所以文案只说「没跑起来 + 去哪儿看
 * 原因」,不替用户猜是哪一种。
 */
export type SemanticPhase =
  | 'unknown'
  | 'unsupported'
  | 'disabled'
  | 'starting'
  | 'downloading'
  | 'embedding'
  | 'ready'
  | 'failed'

export function semanticPhaseOf(
  view: SemanticSearchView | undefined,
  status: SearchStatusResponse | undefined,
): SemanticPhase {
  // 「还没问到」与「关着」是两件事:前者屏幕上不许写「未启用」。
  if (view === undefined || status === undefined) return 'unknown'
  // 装不上扩展 = 这份产物**结构上**做不了,与开关开没开无关 —— 所以排在最前面。
  if (status.vectorExtension === 'missing') return 'unsupported'
  if (!view.enabled) return 'disabled'
  switch (status.vector) {
    case 'downloading':
      return 'downloading'
    case 'embedding':
      return 'embedding'
    case 'ready':
      return 'ready'
    case 'off':
      return 'failed'
    default:
      // 缺席 = 不知道。开关刚翻过去的那一段就落在这里(见上面那段)。
      return 'starting'
  }
}

/** 这一节要不要一直问索引状态。关着 / 装不上的时候什么都不会动,问了也是白问。 */
export function semanticStatusWorthPolling(phase: SemanticPhase): boolean {
  return phase !== 'disabled' && phase !== 'unsupported'
}

/**
 * 开 / 关语义召回。
 *
 * **就地更新**(律①):`optimistic` 当场把开关翻过去,**并且把索引状态那一格的
 * `vector` 抹成「不知道」** —— 上一条 Worker 答的那个值说的是上一份配置。两格补丁
 * 交出来的回滚函数都要还,所以这里把它们串成一只。
 *
 * **后端是热生效的**(2026-09-17):`settings` 域保存成功后广播 `settings:changed`,
 * `backend/wiring/search/index.ts` 订着它,当场换一条索引 Worker。所以这一行的副文案
 * 说的是「马上开始」,**不是**「重启后生效」—— 那是内置浏览器 CDP 那一格的话。
 */
export const setSemanticSearchEnabledMutation: Mutation<boolean, void> = createMutation<boolean, void>(
  'search.setSemanticEnabled',
  {
    optimistic: (enabled) => {
      const undoSettings = semanticSearchQuery.patch((prev) =>
        prev ? { ...prev, enabled } : prev,
      )
      const undoStatus = searchStatusQuery.patch((prev) =>
        prev === undefined ? prev : withoutVectorState(prev),
      )
      return () => {
        undoStatus()
        undoSettings()
      }
    },
    run: async (enabled) => {
      const port = await searchSettingsPort()
      // 当场读一份新的当底本 —— 缓存里那份可能已经旧了(别的面刚改过主题、
      // 刚存过一把 key),拿它写回去等于把别人那一格抹掉。
      const current = await port.readSettings()
      if (!current.success || !current.settings) {
        throw new Error(current.error || 'settings.getSettings 未成功')
      }
      const view = toSemanticSearchView(current.settings)
      const response = await port.saveSettings({
        ...current.settings,
        // `modelId` 跟着一起写回去:契约上这两格都是必填的,只交一格会被归一那一层
        // 补成缺省 —— 用户手改过 `settings.json` 的那一份就这么被抹掉了。
        search: { ...current.settings.search, semantic: { enabled, modelId: view.modelId } },
      })
      if (!response.success) throw new Error(response.error || 'settings.saveSettings 未成功')
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.search',
        title: t('search.semanticSaveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    // 两格都要对账:设置那格确认后端收下了,状态那格去问新起来的那条 Worker。
    settle: () => {
      semanticSearchQuery.invalidate()
      searchStatusQuery.invalidate()
    },
  },
)

/**
 * 把 `vector` 那一格抹成**缺席**(= 不知道)。
 *
 * 写成一只函数而不是 `{ ...prev, vector: undefined }`:契约上那一格是可选的,而
 * `exactOptionalPropertyTypes` 下「显式的 undefined」与「没有这一格」是两回事 ——
 * 前者过不了类型,后者才是我们要说的话。
 */
function withoutVectorState(status: SearchStatusResponse): SearchStatusResponse {
  const { vector: _vector, ...rest } = status
  return rest
}

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 *
 * 这个文件的模块级副作用有两样:那只 query 与那只 mutation(各自带监听表)。
 * 退役**复用它们各自已有的那一口拆卸**,不写第二套。`searchStatusQuery` 不在这里
 * 退役 —— 它的产地是 `search-catalog-source.ts`,那个文件自己管自己。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    semanticSearchQuery.reset()
    setSemanticSearchEnabledMutation.reset()
  })
}
