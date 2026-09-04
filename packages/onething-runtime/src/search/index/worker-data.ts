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
   * 每日笔记根目录,**可以有几个**(空 / 缺席 = 不装那一路 feed)。
   *
   * 复数不是备用格:今天 `getDailyNoteProfiles` 对同一个配置根就可能答两个搜索
   * 目录(Obsidian vault 的 daily 子目录 + vault 根)。一个目录一把 feed,
   * 索引服务对它们一视同仁(§5.2b)。
   */
  notesDirs?: string[]
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
  }
}
