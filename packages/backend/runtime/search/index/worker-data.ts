/**
 * `workerData` 的形 —— 宿主递给 Worker 入口的那一份纯数据。
 *
 * 它单独一个文件而不是住在 `worker.ts` 里,理由只有一条:`worker.ts` 顶层就
 * `new SqliteIndex(...)` 开库,**被 import 一次就有副作用**。装配层要说出这个形
 * (`new Worker(url, { workerData })` 的第二个参数)却不该因此把库开在主线程上,
 * 所以类型住这里,桶出口出的也是这里。
 */

export interface IndexWorkerData {
  /** `<store>/index/search.v1.sqlite`。 */
  databasePath: string
  /** `<store>/sessions`。 */
  sessionsDir: string
  /**
   * 笔记库,**一个库一把 feed**(空 / 缺席 = 不装那一路 feed)。
   *
   * P2 之前这一格是 `notesDirs: string[]` —— 「每日笔记那几个目录」。今天说的是
   * 「这台机器上在册的笔记库」,所以它带 id(`vault` facet 写的就是它)与日记
   * 文件夹(`daily` facet 的判据)。**形状是纯数据**:`workerData` 要过结构化
   * 克隆,而笔记领域的 `NoteVault` 是个带方法的对象,过不去也不该过去 ——
   * Worker 那条线程是后台路,一条 CLI 命令都不许发。
   */
  vaults?: Array<{ id: string; root: string; dailyFolder?: string }>
  /** 推理段进不进索引(拍点乙:缺省不含)。 */
  includeReasoning?: boolean
  /** 各能力的字段表(manifest.schema);`embed` 那一格决定字段进不进向量索引。 */
  schemas?: Record<string, Record<string, { analyzer: string; weight: number; embed?: boolean }>>
  /** 库头 `meta.analyzerId`;与库里记的不符 → 丢库重建(§5.4)。 */
  analyzerId?: string
  /**
   * 语义召回(S7,拍点壬 a:**默认关**)。缺席 / `enabled: false` = Worker 连
   * sqlite-vec 扩展都不装,库与 S3 那时逐字一样。
   *
   * `modelId` 是**数据**:它在嵌入器注册表里找工厂(§15.3),Worker 这一侧不认识
   * 任何模型的名字。`modelsDir` 是 `<store>/models/embeddings`,由装配算好递进来
   * —— Worker 不许自己去解析 store 路径。
   */
  semantic?: {
    enabled: boolean
    modelId: string
    modelsDir: string
    /**
     * 这台机器上网要不要走代理(2026-09-17 加;**契约只加**)。
     *
     * 为什么它必须在 `workerData` 里:模型是**下载**来的,而 Worker 是另一条线程 ——
     * `@huggingface/transformers` 在它里面调的是那条线程自己的全局 `fetch`,与主进程
     * 里 provider 那只受管 fetch(`providers/bound-fetch.ts`)完全无关。09-17 用户真机
     * 事故就是这一条:设置里代理开着、provider 通得好好的,语义召回的模型却一个字节都
     * 下不来(`TypeError: fetch failed`,967ms),状态行只说「没跑起来」。
     *
     * 形状与 `settings.network.proxy` 逐格相同(这里**重写一遍形状**而不是引契约层的
     * 那个类型 —— 产品层不许认识跨进程词汇表),
     * 由装配层照抄进来;**判据不在这里**:装与不装、哪些主机绕过,由
     * `worker-network.ts` 用 provider 那条路**同一份**纯函数判(不抄第二份)。
     */
    proxy?: {
      enabled: boolean
      url: string
      bypassRules?: string
    }
  }
}
