import type { OpenRouterModel } from '@shared/ipc/providers'
import { createQueryFamily } from '../data/kernel'
import { providerSettingsPort } from '../data/provider-settings-port'

/**
 * 模型目录的取数 —— **K1 的样板格**(数据层双原语的第一处真消费者)。
 *
 * 从前这块是 providers store 里的一套手写状态机:`catalog` / `catalogStatus` /
 * `catalogError` / `catalogFetchedAt` 四张表 + 一个 `inflight: Map` 折叠 +
 * 一个 `ensureCatalog(pid, force)`,一共约 45 行。四张表退役,换成下面这一族 ——
 * 键控缓存、并发折叠、keep-previous、身份稳定全部来自 kernel,这里只剩
 * 「怎么问后端」这一件真正属于这块面的事。
 *
 * 两处判据留在这里,因为它们是**这一口的事实**,不是 kernel 的:
 *
 *  ① `ctx.force` 原样递给后端。`listModels(pid, forceRefresh)` 那一口自己有缓存,
 *    「刷新目录」这颗钮要的正是绕过它 —— kernel 不替它决定,只把意图带到。
 *  ② 后端答 `success: false` 是**失败**,不是「空目录」。所以这里抛,让 kernel
 *    记进 `error` 并**留住上一份目录**(错误与旧数据共存)。返回一个空数组会
 *    把「拉不到」画成「这一坑没有模型」—— 那是编。
 *
 * 不弹通知:人正在看这块面,错误就地画在表头下面那一行,离出事的地方最近
 * (这条纪律从旧 store 原样搬过来)。
 *
 * ── 批 7b 起它有**两个**消费者,而且这正是它存在的意义 ─────────────────────
 * `data/models-source.ts`(模型抽屉与读数环)从前有自己的一族目录缓存,走
 * `models-port.listModels(pid)`。两条线落在**同一口**:两个端口的真实现都是
 * `modelsApi.getModelsWithCapabilities`,同一条 RPC 路由、同一份 model registry、
 * 同一个 `ModelsListResponse`。所以那一族退役,目录在这个进程里只剩这一格。
 *
 * 两个消费者读法不同、判据不同,但**答案同源**:设置面读整份 `OpenRouterModel`
 * (要价格与能力),抽屉只投 `{id, contextLength}`(`toCatalogModels`)——
 * 投影在读的那一侧做,缓存只有这一份。
 *
 * 文件位置留在 `providers/` 而不是搬去 `data/`:它今天的两个消费者一个在这里、
 * 一个在 data,搬家会动到不属于那一批的文件(`providers/store.ts` 与
 * `ProviderSettingsPanel.tsx` 的 import),而位置本身不影响「只有一格」这件事。
 */
export const catalogQuery = createQueryFamily<readonly OpenRouterModel[]>(
  'providers.catalog',
  async (ctx) => {
    const port = await providerSettingsPort()
    const response = await port.listModels(ctx.key, ctx.force)
    if (!response.success) throw new Error(response.error ?? '')
    return response.models ?? []
  },
  {
    /**
     * 「这一份目录和上一份一样吗」。逐条比 id ——
     * 目录是一张**由 id 认身份**的表,别的字段(价格、上下文)变了当然算变。
     * 所以这里比的是 `models` 数组的**引用逐个**:后端每次都新造对象,
     * 于是逐条比引用等价于「每次都算变了」……那就白比了。
     *
     * 真正划算的判据是**逐条比 id 与那几格会上屏的数**:目录一天变不了几次,
     * 而「刷新了但内容没变」是最常见的那一次 —— 它不该让整张表闪一下。
     */
    equals: (a, b) =>
      a.length === b.length &&
      a.every((model, index) => {
        const other = b[index]
        return (
          model.id === other.id &&
          model.name === other.name &&
          model.context_length === other.context_length &&
          JSON.stringify(model) === JSON.stringify(other)
        )
      }),
  },
)
