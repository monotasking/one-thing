import { createMutation, createQuery, type Mutation } from './kernel'
import { searchSettingsPort } from './search-settings-port'
import { searchStatusQuery } from './search-catalog-source'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { DEFAULT_SEMANTIC_MODEL_ID, type AppSettings } from '@shared/ipc/settings'
import type { SearchStatusResponse, SearchStorageResponse } from '@shared/ipc/search'

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
 *
 * ── 判词:后端那几个枚举名**不照字面读**(2026-09-17 报障)─────────────────
 * `status.vector` 的 `'downloading'` 是 `VectorWriter` 的**初始态名**,它诞生在
 * 「打开开关就顺带下模型」那一版;09-17 把下载拆成一件独立的东西之后,这一格的
 * 真实含义已经变成「**正在把模型装进内存**」。后端那个名字不改(契约不为文案动),
 * 但壳照字面画出来就是一句假话 —— 真机截图上模型行写着「已下载 · 129 MB」,
 * 底下同时写着「正在下载模型…」,用户的原话是「上面显示已下载,下面正在下载中,
 * 有毛病?」。所以这一侧把它并进 `starting`:**屏上「下载」二字只属于模型行**。
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

/* ── 占用空间(2026-09-18;用户 09-17「我要知道搜索占得空间」)──────────────
 *
 * **第三个产地**,理由与前两个各不相同:
 *
 * | 要什么 | 产地 | 为什么不合并 |
 * | --- | --- | --- |
 * | 开关 / 模型 | `semanticSearchQuery` | 它是**设置**,写得动 |
 * | 向量路在干什么 | `searchStatusQuery` | 它是**索引的状态**,每秒轮询,检索面也在订 |
 * | 占了多少地方 | `searchStorageQuery`(这里) | 它**贵**(要扫库),而且**不会自己动** |
 *
 * 所以它**不轮询**:进页问一次,然后只在「地方真的变了」的那几件事之后再问一次
 * (模型下载落定 / 删掉模型 / 翻开关 / 向量那一半刚嵌完)。一个每 5s 去扫一遍库的
 * 读数,换来的只是看着秒表跳字。
 */
export const searchStorageQuery = createQuery<SearchStorageResponse>(
  'search.storage',
  async () => {
    const port = await searchSettingsPort()
    await port.ready()
    // 后端答不出(这台宿主没有索引)会抛 —— kernel 记进 error,屏上写「没量出来」
    // 并**留住上一份**(律②)。答一堆零会把「没这个库」画成「它是空的」。
    return await port.storage()
  },
)

/**
 * 「占用空间」那一节此刻在说哪句话(2026-09-18)。**三态,判据全在参数里**。
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | loading | 一份都还没有,也没出错 | 「计算中…」 |
 * | ready | 拿到了(哪怕更早前红过 —— 有数就画数) | 三行 + 合计 |
 * | error | 这一发红了 | 旧值留着,底下补一行「没量出来」;一份都没有过就是那一句 |
 *
 * **有数就不算 loading,哪怕正在重量** —— 一个每次重量都翻回「计算中…」的读数会
 * 在屏上闪,而它上一秒说的话此刻并没有变假。
 */
export type SearchStoragePhase = 'loading' | 'ready' | 'error'

export function storagePhaseOf(
  data: SearchStorageResponse | undefined,
  error: string | undefined,
): SearchStoragePhase {
  if (error !== undefined) return 'error'
  return data === undefined ? 'loading' : 'ready'
}

/**
 * 向量那一半**刚嵌完**了吗 —— 嵌完那一刻库真的长大了,该重新量一次。
 *
 * 纯函数、导出,所以「首载就是 ready 不算变化」这条可以被单测。判据是**跃迁**而不是
 * 当前值:首载那一帧上一个值是 `undefined`,那时刚 `ensure()` 过一发,再量一遍是白量。
 */
export function shouldRemeasureStorage(
  previous: SearchStatusResponse['vector'],
  next: SearchStatusResponse['vector'],
): boolean {
  return previous !== undefined && previous !== next && next === 'ready'
}

/**
 * 这一节此刻在说哪句话。**八个态,判据全在参数里**(没有计时器、没有「刚才点过」
 * 这种记忆),所以它可以被逐态单测。
 *
 * ── 为什么没有 `downloading` 这一态(2026-09-17 报障)──────────────────────
 * 见文件头那条判词:后端 `vector === 'downloading'` 今天说的是「正在把模型装进
 * 内存」,而不是在下载。它并进 `starting` —— **开关那一行永远不说「下载」**,
 * 下载这件事整个归模型行。
 *
 * ── 为什么 `starting` 判的是「`vector` 缺席**或者 off 而说不出死因**」 ───────
 * 契约上 `SearchStatusResponse.vector` 缺席的意思就是**不知道**。翻开关那一下,
 * 写路的 `optimistic` 顺手把这一格抹成 undefined —— 上一条 Worker 答的 `'off'`
 * 说的是上一份配置,拿它画「没跑起来」是拿旧答案回答新问题。
 *
 * 光抹那一格还不够:对账那一发回来时,换 Worker 这件事在后端**还没走完**,答回来
 * 的仍然是上一条(没装向量写路,于是 `vector: 'off'`、一句死因都没有)。那一帧照
 * 字面画就是一次闪红。而**真的失败一定带着死因** —— `VectorWriter.markOff` 每一条
 * 路都 `failure ??= describeEmbedderFailure(error)`,所以「off 且没有死因」在这一侧
 * 的意思只能是「这条 Worker 压根没带向量写路」= 还没换过来。
 *
 * ── 为什么这一格只答 `failed`,不答「为什么 failed」 ───────────────────────
 * 打包版的桌面 app 里 `vectorExtension` 是 `loadable`(`vec0.dylib` 有
 * `asarUnpack`),缺的是嵌入运行时(`electron-builder.yml` 排掉了
 * `@huggingface/transformers`,§13 拍点癸');而开发机上同一个 `'off'` 也可能是模型
 * 没下下来。**两件事在这一格上长得一模一样** —— 这一格手上只有一个 `'off'`,
 * 它凭什么都猜不出来,所以它不猜。
 *
 * 原因是**后端答的**(2026-09-17 R12):`status.vectorErrorKind` 一个码 +
 * `status.vectorError` 一句原话,由 `SearchSettings.tsx` 的 `FAILED_REASON_KEY` 查成
 * 一句人话。后端答不出就只写「没跑起来」——**编一个原因比不说更糟**。
 */
export type SemanticPhase =
  | 'unknown'
  | 'unsupported'
  | 'needsModel'
  | 'disabled'
  | 'starting'
  | 'embedding'
  | 'ready'
  | 'failed'

/**
 * **模型那一行此刻在说哪句话**(2026-09-17;与开关那一行是两件事)。
 *
 * 用户裁定「把开关和下载模型拆开」之后,屏幕上是两行,于是判据也是两只纯函数:
 * 这一只只读 `status.model`,与开关开没开、与向量路在干什么都无关。
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | unknown | 状态还没问到,或者 `model` 缺席 | 「检查中…」,一颗钮都不画 |
 * | absent | `model.state === 'absent'` | 「未下载 · 约 113 MB」+ 下载 |
 * | downloading | `'downloading'` | 进度条 + 「43 MB / 113 MB · 38%」+ 取消 |
 * | ready | `'ready'` | 「已下载 · 113 MB」+ 删除(开关开着时禁) |
 * | failed | `'failed'` | 按 `errorKind` 一句人话 +(原话)+ 重试 |
 *
 * **「不知道」与「没下载」不是一回事**,所以后端那一格缺席时落在 `unknown`:画一颗
 * 按不动的下载钮是骗人。缺席有两种意思,屏幕上分不出,也不必分 —— 这台宿主管不了
 * 模型(独立 server 上没有索引、门跑的是假嵌入器),或者后端**正在试装**盘上那堆没有
 * 清单的文件(2026-09-17 认领,§15.8b)。后一种几秒后就会变,所以
 * `semanticStatusPollMs` 在这一格上照问不误。
 */
export type SemanticModelPhase = 'unknown' | 'absent' | 'downloading' | 'ready' | 'failed'

export function semanticModelPhaseOf(status: SearchStatusResponse | undefined): SemanticModelPhase {
  return status?.model?.state ?? 'unknown'
}

export function semanticPhaseOf(
  view: SemanticSearchView | undefined,
  status: SearchStatusResponse | undefined,
): SemanticPhase {
  // 「还没问到」与「关着」是两件事:前者屏幕上不许写「未启用」。
  if (view === undefined || status === undefined) return 'unknown'
  // 装不上扩展 = 这份产物**结构上**做不了,与开关开没开无关 —— 所以排在最前面。
  if (status.vectorExtension === 'missing') return 'unsupported'
  /*
   * **模型还没到位 = 「先下载模型」**(2026-09-17;09-17 报障后扩到开关开着那一形)。
   *
   * 这一支**不问开关开没开**,理由是两行不许互相打架:模型行此刻正一条一条地说
   * 「未下载 · 约 113 MB」/「40 MB / 113 MB · 35%」/「没下成:连不上」,那就是全部
   * 实情,而下一步动作在两种开关位置下是同一个 —— 去按那颗「下载」。开关开着时若
   * 照旧走 `failed`,屏上会在一条**正在走的进度条**底下写「模型文件不完整,重新下载」,
   * 那正是用户报的那一类自相矛盾。
   *
   * **它只说话,不锁开关**:禁不禁是 `SearchSettings.tsx` 里那句
   * `!enabled && phase === 'needsModel'` 的事 —— **开着的时候永远许人关掉**。老用户的
   * 设置里 `enabled: true` 是上一版留下的(那时打开开关就是下载),而模型一个字节都
   * 没下;那一形下要是把开关也禁了,他就被锁在一个开着却不工作的状态里。
   *
   * **「不知道」不拦路**:`model` 那一格缺席说的是「这台宿主管不了模型」(老后端、
   * 独立 server、门跑的假嵌入器),不是「没下载」。那时拿一件我们不知道的事去挡人,
   * 与上面「还没问到不许写未启用」是同一条。
   */
  const modelPhase = semanticModelPhaseOf(status)
  if (modelPhase !== 'ready' && modelPhase !== 'unknown') return 'needsModel'
  if (!view.enabled) return 'disabled'
  switch (status.vector) {
    case 'embedding':
      return 'embedding'
    case 'ready':
      return 'ready'
    case 'off':
      // 死因说得出才是真失败;说不出 = 答话的还是上一条 Worker(见上面那段)。
      return hasVectorFailure(status) ? 'failed' : 'starting'
    default:
      // 缺席 = 不知道;`'downloading'` = 正在把模型装进内存。两者都是「正在启动」。
      return 'starting'
  }
}

/** 后端说得出「为什么关回去了」吗 —— 说得出才算真的失败(空串 = 没说)。 */
function hasVectorFailure(status: SearchStatusResponse): boolean {
  return status.vectorError !== undefined && status.vectorError.length > 0
}

/**
 * 这一节要不要一直问索引状态,以及**多勤**。
 *
 * 三档,判据是「有没有东西在动、动得有多快」:
 *  - 正在下模型 → **1s**。那是一条会走的进度条,5s 一跳的读数比没有进度更糟。
 *  - 别的会动的态(启动 / 建索引 / 检查中 / 就绪)→ 5s(与 09-17 那一版同)。
 *  - 关着 / 装不上 / 只等人按「下载」→ **不问**。什么都不会动,问了是白问。
 *
 * **「不知道」要问**(2026-09-17 认领那一批补的):模型那一格缺席有两种意思 —— 这台
 * 宿主管不了模型(问一辈子也不会变),或者后端**正在试装**盘上那堆没有清单的文件
 * (几秒之后就会变成「已下载」)。屏幕上分不出这两种,而其中一种会动,所以问。
 * 少了这一句,开关关着 + 正在认领那一形会永远停在「检查中…」—— 页面没有第二个
 * 重新去问的由头。代价是前一种情形下每 5s 一发很便宜的 `search.status`,只在这一节
 * 在屏上时才发。
 *
 * 返回毫秒数或 `undefined`(= 别起计时器)—— 一个数比「要不要 + 多久」两格好:
 * 调用方那只 `useEffect` 的依赖就是它,档位一变计时器自己换。
 */
export function semanticStatusPollMs(
  phase: SemanticPhase,
  model: SemanticModelPhase,
): number | undefined {
  if (model === 'downloading') return 1000
  if (model === 'unknown') return 5000
  if (phase === 'disabled' || phase === 'unsupported' || phase === 'needsModel') return undefined
  return 5000
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
    // 三格都要对账:设置那格确认后端收下了,状态那格去问新起来的那条 Worker,
    // 占用那格是因为**开了语义召回就会长出一张向量表**(关掉则不会缩 —— 那也是
    // 一句要说准的话,所以两个方向都重量一次)。
    settle: () => {
      semanticSearchQuery.invalidate()
      searchStatusQuery.invalidate()
      searchStorageQuery.invalidate()
    },
  },
)

/**
 * 把 `vector` 与那两格原因抹成**缺席**(= 不知道)。
 *
 * 写成一只函数而不是 `{ ...prev, vector: undefined }`:契约上那一格是可选的,而
 * `exactOptionalPropertyTypes` 下「显式的 undefined」与「没有这一格」是两回事 ——
 * 前者过不了类型,后者才是我们要说的话。
 *
 * **`vectorError` / `vectorErrorKind` 必须跟着一起抹**(2026-09-17 与那两格同批加):
 * 它们说的是「上一条 Worker 为什么关回去了」。翻开关那一下新的一条还没起来,留着
 * 就是在「正在启动…」之后紧跟着一句上一任的死因 —— 与留着旧 `vector` 画「没跑起来」
 * 是同一个错。两格同生同灭,所以在同一处抹掉。
 */
function withoutVectorState(status: SearchStatusResponse): SearchStatusResponse {
  const {
    vector: _vector,
    vectorError: _vectorError,
    vectorErrorKind: _vectorErrorKind,
    ...rest
  } = status
  return rest
}

/* ── 模型那三颗钮(2026-09-17)──────────────────────────────────────────────
 *
 * 三条写路,一个模子:**当场把模型那一格改成我们要的那个态**(乐观),发出去,
 * 回执里带着后端那一刻的真状态就照抄一遍,最后 `settle` 去对一次账。
 *
 * ── 为什么乐观只改 `model.state`,不动别的 ────────────────────────────────
 * 进度那两格(`loadedBytes` / `totalBytes`)是**后端在数的东西**,壳猜不出来;
 * 猜一个 0 会让进度条从 0 跳到 43%,像是重来了一次。所以点下「下载」那一刻屏上
 * 是一条**不知道进度**的滑条(`Progress` 缺席 `value` 那一档),第一发轮询回来才
 * 变成真读数 —— 那正是「不知道就别给」。
 *
 * ── 为什么没有 `onError` 的 notify ────────────────────────────────────────
 * 与开关那一条不同:开关失败了屏上什么都看不出来(它自己弹回去),所以要一声通知。
 * 这三条失败了,**回执里的模型状态就是屏上那一行** —— 下载失败画的是 failed 那一态
 * 带原话,取消 / 删除失败画的是它们没能改掉的那个态。再弹一条 toast 是说两遍。
 */

/** 一条模型写路。`want` 是点下去那一刻屏上该变成的态(乐观)。 */
function modelMutation(
  name: string,
  want: SemanticModelPhase,
  call: (port: Awaited<ReturnType<typeof searchSettingsPort>>) => Promise<{
    success: boolean
    error?: string
    model?: NonNullable<SearchStatusResponse['model']>
  }>,
): Mutation<void, void> {
  return createMutation<void, void>(name, {
    optimistic: () => searchStatusQuery.patch((prev) => (prev === undefined
      ? prev
      : { ...prev, ...patchModelState(prev, want) })),
    run: async () => {
      const port = await searchSettingsPort()
      const response = await call(port)
      // 后端答得出此刻的状态就照抄 —— 那比再等一轮轮询早一个来回。
      if (response.model !== undefined) {
        const model = response.model
        searchStatusQuery.patch((prev) => (prev === undefined ? prev : { ...prev, model }))
      }
      if (!response.success) throw new Error(response.error || `${name} 未成功`)
    },
    settle: () => {
      searchStatusQuery.invalidate()
      // 下完 / 删掉之后磁盘上真的多了 / 少了一百多兆 —— 那一行得跟着变。
      searchStorageQuery.invalidate()
    },
  })
}

/**
 * 把模型那一格改成某个态,**其余格子原样留着**。
 *
 * 「管不了模型」的那台宿主(`model` 缺席)上一格都不动:凭空造一个 `model` 出来,
 * 屏幕上就会长出一行本不该有的模型行(见 `semanticModelPhaseOf` 的 unknown 那一格)。
 */
function patchModelState(
  status: SearchStatusResponse,
  state: SemanticModelPhase,
): Pick<SearchStatusResponse, 'model'> {
  const model = status.model
  if (model === undefined || state === 'unknown') return {}
  // 换了态就把上一任的读数与死因一起抹掉(与翻开关那一下抹 `vector` 同一条判例)。
  return { model: { id: model.id, state, ...(state === 'ready' ? { loadedBytes: model.loadedBytes, totalBytes: model.totalBytes } : {}) } }
}

export const downloadSemanticModelMutation = modelMutation(
  'search.downloadSemanticModel',
  'downloading',
  (port) => port.downloadModel(),
)

export const cancelSemanticModelMutation = modelMutation(
  'search.cancelSemanticModel',
  'absent',
  (port) => port.cancelModelDownload(),
)

export const removeSemanticModelMutation = modelMutation(
  'search.removeSemanticModel',
  'absent',
  (port) => port.removeModel(),
)

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 *
 * 这个文件的模块级副作用是那只 query 与四只 mutation(各自带监听表)。
 * 退役**复用它们各自已有的那一口拆卸**,不写第二套。`searchStatusQuery` 不在这里
 * 退役 —— 它的产地是 `search-catalog-source.ts`,那个文件自己管自己。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    semanticSearchQuery.reset()
    searchStorageQuery.reset()
    setSemanticSearchEnabledMutation.reset()
    downloadSemanticModelMutation.reset()
    cancelSemanticModelMutation.reset()
    removeSemanticModelMutation.reset()
  })
}
