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
          model.context_length === other.context_length
        )
      }),
  },
)
