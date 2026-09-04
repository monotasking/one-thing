# 检索重建 —— 联邦骨架 × 账本投影 × 函数流水线(2026-09,v3 终稿)

> 起因(09-02 用户):「view 的壳能搜到、React 壳搜不到;把 message 说得很精确仍搜不到。做一个可扩展、
> 用到设计模式的方案;多类同时搜怎么搜;能力增删要容易;条数与分页要抽象。」
>
> v1(同日上午)只治消息一路;六个候选比稿后用户拍:**A 联邦总览做骨架、事件投影建索引、函数式流水线做查询**。
> **v3(09-02 晚,用户认可「抛开现状从头做」那版)**:在 v2 之上定四件事——①引擎 = SQLite FTS5,**走 Node / Electron 内建的 `node:sqlite`,不用 better-sqlite3**(09-02 深夜勘察修正:better-sqlite3 是 V8 ABI 专属插件,仓里那块按 Node 22 v127 编,在 castlabs Electron 41 的 v145 下**加载失败**,electron-builder.yml 里「已按 Electron ABI 编好」那句是错的,且它在仓里零运行时消费者;`node:sqlite` 在 Node 22.22 / Electron 41(node 24.14)下实测 FTS5 在、`loadExtension` 在,零原生依赖、零 ABI 问题;引擎住 runtime。**注意 FTS5 的 trigram 分词器查询短于 3 字不出结果**,中文双字词全灭,所以分词仍由 core 的 TS 分析器做,FTS5 只索引一列预切好的 token 串(`unicode61`),实测「私发」「身份牌」双字三字都命中,短语核验在 TS 侧照旧;Node 版本地板 ≥ 22.13(`node:sqlite` 免 flag),启动时压掉它的 ExperimentalWarning);②语义召回从「留位」改为**第二期必做**(sqlite-vec + 本地小嵌入模型,与词法 RRF 融合);③文档模型加**关系**(消息∈会话、消息→提到的文件、工具调用→碰过的文件、会话∈空间),「哪些对话改过这个文件」是关系查询不是特例;④查询理解加**时间与实体抽取**(「上周」「八月」、文件名、符号名),时间在结果面上是一条可拖的轴;⑤**AI 自己是搜索的消费者**:助手检索历史 / 相关文件走同一份索引同一条查询路(surface = agent-tool,授权段管可见性),索引即助手记忆底座,不建第二套。原 v2 拍点 丙 / 丁 / 戊 / 己 随这一版一并认可为推荐值;仍待拍:甲(账本三事件)、乙(默认字段)。
> **v3.1(09-04,用户令「搜索方案做一遍 review」后折入,并按用户令给三件事排期设方案)**:审查挖出四处真机会挂、两处自己违反「core 里不出现能力名」的法、一批 v2 残句,全部折进正文:
> ①`node:sqlite` 只有同步 API,索引服务整体搬进 `worker_threads`(§5.3),主线程零 sqlite;②授权从流水线里的「事后过滤」改为能力查询的输入(§6.4b),否则 total 与 cursor 都是假的;
> ③正文**存进**文档表(总共 7MB),短语核验与摘要都在库内做,不再回读账本(§5.1);④拍点甲改推荐 (b):删会话是 `rmSync` 整个目录,`session/deleted` 无处可写,
> 而 `DocumentFeed` 的指纹 + 总线既有事件已经覆盖三件事(§5.2);⑤`Doc.kind` / 字段名 / 检查点形状三处枚举点改成能力自述(§5.1 §5.4);⑥rank 里的消息语义搬回能力(§6.5);
> ⑦法条做成边界检查器规则(§10 S0)。**新排三期**:S6 AI 自己是搜索的消费者(§14)、S7 语义召回 sqlite-vec(§15)、双 core 索引持有权并入 S3(§5.6)。
> 本文是拍定后的细版。§0 结论与拍点 → §1 现状病根 → §2 目标边界 → §3 总体形 → §4 能力模型
> → §5 索引:账本投影 → §6 查询:流水线 → §7 全部档与分页 → §8 契约 → §9 壳 → §10 分期与门 → §11 反证 → §12 拆旧 → §13 留账 → §14 AI 消费者 → §15 语义召回。

---

## 0. 一页结论

**三件东西,三条不变量。**

| 件 | 是什么 | 不变量 |
| --- | --- | --- |
| **能力注册表**(联邦骨架) | 每一类能搜的东西是一个 `SearchCapability`,注册一条、注销一条;壳的 tab 从表里读 | 所有能力对外说同一种 `Candidate`,编排者不认识任何具体能力 |
| **账本投影索引**(建) | 消息 / 会话标题 / 笔记的索引是 `events.jsonl`(+ 会话 meta)的**确定性函数**,进程内同步观察者增量折,快照是检查点 | 索引 ≡ fold(账本, 检查点),坏了重放,不做迁移 |
| **查询流水线**(查) | `parse → plan → sources → merge → rank → page → snippet`,每段纯函数,源是候选流 | 全部档的合并规则是**一段显式代码**,不是散在各处的常量 |

**规模**(真库只读):441 会话 / 9616 条消息 / 正文 7.0MB(`messages.jsonl` 391MB、`events.jsonl` 480MB,大头是工具结果与推理)/ 中文 29%。引擎 `node:sqlite` FTS5(内建,零原生依赖;分词在 TS,FTS5 只吃预切 token 列;`InvertedIndex` 接口保留,纯 TS 实现为测试替身),**整个索引服务住一个 `worker_threads` Worker**(`node:sqlite` 只有同步 API,主线程碰它就是卡桌面),冷建从账本重放 ≈ 5s(Worker 里,期间主线程可查旧数据),增量折毫秒级,查询 < 10ms(含一次 postMessage 往返);脱敏后的正文存进文档表(7MB),摘要与短语核验都在库内;第二期 sqlite-vec 加向量列(§15)。

**拍点**(用户拍;粗体 = 推荐):

| # | 问题 | 选项 |
| --- | --- | --- |
| 甲 | 会话改名 / 归档 / 删除今天**不在账本里**(走 meta.json + 总线) | (a) 补三条账本事件 `session/renamed` `session/archived` `session/deleted`;**(b) 索引不加账本事件:`LedgerFeed` 的指纹 `lastSeq:metaRev` 认改名与归档,指纹 `undefined` 即墓碑,活着时订总线既有的 `session:renamed` / `session:deleted`**(v3.1 改推荐:删会话是 `rmSync` 整个目录,`session/deleted` 要写进的账本自己已经没了;而且改名归档不是「这条会话的历史」,塞进 events.jsonl 是借账本当总线) |
| 乙 | 默认索引字段 | **(a) 正文 + 会话标题 + 附件名;推理做「含推理」开关;工具结果不索引**;(b) 推理默认含 |
| 庚 | 一个 store 两个 core(桌面持 `desktop` 锁、daemon 持 `daemon` 锁,daemon 从不看 `run/http.json`,两者同时装配是常态)谁建索引 | (a) 发现文件式单写者:先来的写 `run/index-owner.json` 当写者,后来的开只读句柄当读者(WAL 允许),写者 pid 死了读者接管(§5.6;与 08-24「store 不要锁」同一条路);(b) 两个写者都折、靠按键整体替换幂等;(c) 只有 HTTP 面持有者建索引,其它进程没有搜索。**09-04 用户裁:先不做**——S3 不含 §5.6,`ownership.ts` 不建;库开 WAL,两个进程同时当写者时靠按键整体替换幂等兜底(即事实上的 (b)),`status` 路由的 `mode` 一格暂恒 `'owner'`,§5.6 留作方案 |
| 辛 | AI 当调用者时缺省能看多远(§14) | **(a) 当前空间里的非协作会话 + 自己是成员的协作房**(与 collab `history` 工具今天的可见规则同一条);(b) 只见本会话;(c) 全部空间 |
| 壬 | 语义召回缺省开关(§15;要下载约 110MB 模型、冷嵌入占 CPU 数分钟) | **(a) 默认关,设置里一键开,开了才下载**;(b) 默认开 |
| 癸 | 嵌入模型运行时(§15) | **(a) `@huggingface/transformers` wasm 后端,零原生依赖**;(b) `onnxruntime-node`(N-API,过 gate:native,快约 2 倍,多 30MB 原生包) |
| 丙 | 归档会话 | **(a) 搜得到带徽**(v3 已认可) |
| 丁 | 多词语义 | **(a) 全部命中优先,零命中按阶梯放宽并明说**(v3 已认可) |
| 戊 | 跨空间 | **(a) 默认当前空间,一键全部并带徽**(v3 已认可) |
| 己 | 全部档 | **(a) 分组总览不混排不分页,每组「查看全部」进单类 tab 翻页**(v3 已认可) |

---

## 1. 现状病根(不重复 v1,只列结论)

产地 `runtime/src/search/{search-runtime,providers}.ts` + `backend/wiring/search/providers.ts` + `backend/rpc/domains/search.ts`。

- **无索引**:每次搜索 `iterateMessagesRaw` 全库读盘解析(1.6s),纯小写 `indexOf`。
- **能力写死七处**:`SearchCategory` 字面量、adapters 接口、`switch(category)`、`all` 档配额表与拼接次序、providers 函数、`@shared/ipc` 常量表、壳 tab。增删一类改七处。
- **无查询模型 / 无打分 / 无分页协议**:查询是字符串(只剥 `>` `/`),消息无打分,`limit` 断在会话循环外层(20 条只覆盖前 8 个会话),响应无 total / cursor。
- **归档跳过、跨空间隐藏、全角 / 换行 / 词序任一差异即零命中。**

装配是规整的(端口注入、单槽端口、插件注册表),中间层是空的。本方案只重建中间层,装配与契约只加不改。

---

## 2. 目标与边界

目标(优先序):**找得到**(不受空白 / 全角 / 大小写 / 词序影响,中文按字、英文按词与前缀)→ **快**(边打边出 < 10ms)→ **说实话**(总数 / 放宽了吗 / 归档 / 空间 / 索引在追吗)→ **一份**(桌面 / server / CLI / 两壳共用)→ **可增删**(能力一行注册)。

边界:文件内容索引缓议(文件仍按名扫,S8)、工具结果不索引(拍点乙)。向量召回是 S7(§15),不再是「留位」。

---

## 3. 总体形

```
                     ┌──────────────── 查询侧(纯函数流水线,core/search/pipeline)────────────────┐
 壳 ─rpc search.query─▶ parse ─▶ plan ─▶ fanout(capabilities.filter(supports)) ─▶ merge ─▶ rank ─▶ page ─▶ snippet ─▶ SearchResponse
                                              │            │           │
                                        messages     sessions      files      actions   prompts   daily   plugin:*
                                        (indexed)    (indexed)     (scan)     (static)  (static)  (index) (remote)
                                              └────┬───────┘                                        │
                                                   ▼                                                ▼
                     ┌──────── 索引侧(账本投影,runtime/search/index)────────┐            插件注册表(既有,并入)
                     │  events.jsonl ──append observer──▶ IndexProjector.fold │
                     │  meta.json mtime + 总线 renamed/deleted + 目录监视 ─▶ 同一个 LedgerFeed(拍点甲 b)│
                     │  InvertedIndex + DocTable ──checkpoint──▶ <store>/index/ │
                     └───────────────────────────────────────────────────────┘
```

落位(三层不变):

```
packages/core/search/
  candidate.ts        Candidate / SearchQuery / PageRequest / SearchPage(target 与 preview 都是开放的 {kind, payload})
  capability.ts       CapabilityManifest / SearchCapability 接口 + CapabilityRegistry
  analyzer/           Analyzer + CjkBigram + LatinWord + Composite(带原文偏移)+ 分析器注册表
  index/              InvertedIndex / DocTable / VectorIndex **接口** + MemoryIndex(纯 TS,测试替身;产品实现在 runtime)
  pipeline/           parse / plan / fanout / merge / rank / page / snippet(全是纯函数)+ compose
  cursor.ts           CursorCodec(不透明串 ⇄ {capability, kind, payload})
  (法条:本目录不出现任何能力 id 字面量,不在 kind 上 switch —— 边界检查器 `checkCoreSearchNamesNoCapability` 守,S0 立)
packages/onething-runtime/src/search/
  index/              SqliteIndex(node:sqlite FTS5 + 文档表 + 边表 + 检查点,InvertedIndex 的产品实现)
                      / IndexProjector(吃事件折文档)/ LedgerFeed / DocumentFilter 列表 / ownership.ts(§5.6)
                      / worker.ts(Worker 入口:持有 SqliteIndex,收 enqueue / query / status / preview)
                      / worker-host.ts(主线程侧代理:起 Worker、postMessage 往返、崩了重起)
                      / SearchIndexService(主线程门面,只认 worker-host)
  embedding/          S7:Embedder 接口 + 注册表 + transformers-wasm.ts(§15)
  capabilities/       messages.ts sessions.ts daily.ts(索引型)files.ts(扫描型)actions.ts prompts.ts(静态型)
  service.ts          SearchService = registry + pipeline + index 的门面
packages/onething-runtime/src/toolkit/builtin/search.ts   S6:`search` 工具(§14),吃注入的 SearchAdapter,不 import backend
packages/backend/wiring/search/
  index.ts            装配:起 SearchIndexService(Worker)、挂 append observer、订总线 session:renamed / deleted、注册六个能力 + 插件能力、给 search 工具装适配器
packages/backend/rpc/domains/search.ts   契约扩展(§8),本机可信分叉照旧
packages/shared/ipc/search.ts            SearchRequest / SearchResponse 只加不改;新增 capabilities / preview / invoke / status 路由
apps/desktop-react/src/search/           tab 从 capabilities 读;消费 total / cursor / relaxed / groups / index;目标渲染注册表 + 预览渲染注册表
每个宿主的构建配方各加**一个 Worker 入口**(React 主进程 esbuild 第三入口、CLI esbuild 第二入口、server vite SSR 第二入口),产物与宿主入口同目录,`new Worker(new URL('./search-worker.js', import.meta.url))`
```

---

## 4. 能力模型(联邦骨架)

### 4.0 开闭原则的硬指标(09-02 用户令:「不能加一个功能就改一下架构」)

**加任何一种能力,允许动的只有两处:能力自己的模块(runtime)+ 它在壳里的渲染模块(壳)+ 各一行注册。**
core / 索引服务 / 流水线 / 契约 / 全部档逻辑 / 壳的 tab 与过滤片 —— 一个字不改。做不到就是骨架没抽到位,打回重抽。

达成这条的办法只有一个:**凡是「按能力枚举」的地方,全部改成「能力自述、别人读表」。** 下面逐个枚举点清账:

| 从前的枚举点 | 现在由谁说 |
| --- | --- |
| `Target` 联合(core 里列六种目标形) | 目标形是能力自己定义的 payload,core 只认 `{ kind: string; payload: unknown }`;壳按 `kind` 从渲染注册表取渲染器 |
| 意图前缀(`/` `>` 命令、`#` symbol) | 能力在 manifest 里声明 `intentPrefixes`;`parse` 读注册表 |
| 预算加权(命令意图给 actions 8 条) | 能力在 manifest 里声明 `budget: { default, whenIntent: {...} }`;`budgetPolicy` 读表 |
| 索引字段与权重(消息 title 2.0 / content 1.0;symbol 名字精确 ×3) | 能力在 manifest 里声明 `schema`(字段 → 分析器 id + 权重);索引服务按 schema 建字段 |
| 喂索引的来源(账本) | `DocumentFeed` 由能力自带;索引服务收一组 feed |
| 过滤片(空间 / 角色 / 时间 / 归档) | 能力声明 `facets`;壳从注册表读出可用的过滤片 |
| 壳的 tab / 图标 / 标签 | manifest 的 `labelKey` / `icon` |

### 4.1 一种候选,所有能力都说它

```ts
/** 一次搜索里「一条可能的结果」。能力只产它,流水线只吃它。core 对 payload 一无所知。 */
export interface Candidate {
  capability: string
  id: string                         // 能力内唯一、跨次稳定
  title: string
  subtitle?: string
  ranges?: Range[]                   // title 内高亮(原文偏移)
  score: number                      // 能力内可比;跨能力不可比
  time?: number
  target: { kind: string; payload: unknown }   // **开放**:形由能力定义并导出类型,壳按 kind 取渲染器
  facets?: Record<string, string | number | boolean>   // 键由能力的 manifest.facets 声明
  preview?: { kind: string; payload: unknown }   // 富预览(开放,同 target;壳渲染器自带 Preview)
  parent?: string                       // 层级结果:上级候选 id(目录 › 文件 › 符号)
  explain?: unknown                     // ctx.debug 时才填:分数拆解 / 命中词
}

export interface SearchQuery {
  raw: string
  ast: QueryNode
  intent: string                     // 由注册表里的 intentPrefixes 判出;缺省 'content'
  filters: Record<string, unknown>   // 键由各能力的 facets 声明;core 不解释
}
export interface PageRequest { limit: number; cursor?: string }
export interface SearchPage { items: Candidate[]; total?: number; cursor?: string; relaxed?: 0 | 1 | 2 | 3; took: number }

/** 一次搜索的现场。能力与流水线各段都收它;它是唯一带「谁 / 在哪 / 还要不要」的东西。 */
export interface SearchContext {
  principal: { kind: 'user' | 'agent' | 'plugin'; id: string; sessionId?: string }   // 谁在问(§6.4b 授权用)
  surface: string                       // 'palette' | 'composer-mention' | 'composer-command' | 'cli' | 'agent-tool' | 插件自报
  spaceId: string
  signal: AbortSignal                   // 换词即取消
  debug?: boolean                       // 填 Candidate.explain
  now: number
}
```

### 4.1b 能力自述(manifest):一个能力对外说的全部话

```ts
export interface CapabilityManifest {
  id: string
  labelKey: string
  icon: string                                   // 宿主图标名
  kind: 'indexed' | 'scan' | 'static' | 'remote'
  intentPrefixes?: string[]                      // 例:actions ['/', '>'];symbols ['#', '@']
  budget: { default: number; timeoutMs: number; whenIntent?: Record<string, number> }
  facets?: Array<{ key: string; type: 'enum' | 'range' | 'boolean'; values?: string[] }>
  schema?: Record<string, { analyzer: string; weight: number }>   // 索引型才有:字段 → 分析器 + 权重
  order: number                                  // 全部档分组的缺省次序;按意图的重排由 `orderWhenIntent` 声明
  orderWhenIntent?: Record<string, number>
  visibility?: VisibilityRule                    // 谁能看(§6.4b);缺省:用户全可见 / agent 只见本会话 / 插件只见自己产的
  surfaces?: string[]                            // 只在哪些消费面参与;缺省全部
}
export interface SearchCapability {
  readonly manifest: CapabilityManifest
  supports(query: SearchQuery): boolean
  search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage>
  feed?: DocumentFeed                            // 索引型自带来源(§5.2b);索引服务从这里收
}
```

`parse` / `budgetPolicy` / 全部档排序 / 壳 tab / 壳过滤片 —— 全部是「读注册表里各 manifest 然后算」的纯函数,里面没有任何能力的名字。

### 4.2 能力接口与三种基座

能力接口只有 §4.1b 那一份(`manifest` + `supports` + `search` + 可选 `feed`);v2 里那份把 id / labelKey / kind 平铺在接口上的旧形已删,别再写第二份。`supports` 自己答空词 / 命令语法 / 路径语法,switch 不替它答;`search` 收到的 `ctx.principal` 是**授权输入**(§6.4b),能力在自己的查询里用它,不许无视。

三种基座是**三个高阶函数**(不是抽象类;用户拍了非 OO 包装,但形状一样):

| 基座 | 谁用 | `search` 的实现 | 分页 |
| --- | --- | --- | --- |
| `indexedCapability({ manifest, retrievers: [lexical(index), …], fuse = rrf })` | messages / sessions / daily | 每个 `Retriever` 产候选流(词法 = 倒排;向量 = 将来),`fuse` 融合(缺省 RRF,倒数排名融合:各路名次取倒数相加);只有一路时 fuse 是恒等 | 稳定:cursor = `{queryHash, offset}`,结果集按 queryHash 缓存 30s(索引变了 hash 变,cursor 自然失效) |
| `scanCapability({ id, scan, match })` | files | 惰性 `AsyncIterable`:`scan(ctx)` 产路径流 → `match(query)` 过滤 → 取到 limit 停 | 续扫:cursor = `{position}`(扫描器可从位置继续;目录变了接受微漂) |
| `staticCapability({ id, items, score })` | actions / prompts | 全量内存表 → 打分 → 排序 | 一次全给(`cursor` 恒缺席) |
| `remoteCapability({ id, call, budget })` | 插件(并入既有 `plugin-search-registry`) | 调插件、限时、结果只带 `plugin-action` target | 不分页 |

### 4.2b 演练:加 symbol 检索要动哪里(设计交卷前必做的「陌生能力演练」)

| 处 | 动什么 |
| --- | --- |
| `runtime/search/capabilities/symbols/`(**新目录,一个模块**) | `manifest`(id / label / icon / kind:'indexed' / intentPrefixes ['#','@'] / budget / facets [language, symbolKind] / schema { name: {analyzer:'identifier', weight:3}, container: {…} })、`feed`(FileTreeFeed:监视接入目录、mtime:size 指纹、documentsOf = 抽取器)、`extractor/`(tree-sitter WASM + 正则兜底)、`target.ts`(导出 `SymbolTarget = { path, line, column, name, symbolKind }` 类型) |
| `backend/wiring/search/index.ts` | `register(symbolsCapability)` **一行** |
| `apps/desktop-react/src/search/targets/symbol.tsx`(**新文件**) | 渲染器:名字 + `path:line` + 按 symbolKind 取图标;点开 → 查看器定位到行 |
| `apps/desktop-react/src/search/targets/index.ts` | `registerTargetRenderer('symbol', SymbolRow)` **一行** |

**不动的**:core 全部(candidate / capability / registry / analyzer / index / pipeline / cursor)、`SearchIndexService`、契约、全部档逻辑、壳的 tab / 过滤片 / 分组 / 分页。
分析器 `identifier` 若 core 里没有,由能力模块自带并在 manifest 里带 `analyzers: { identifier: … }` 注册——分析器注册表同款,core 不枚举分析器名。

单文件大纲(查看器 ⌘F / 侧栏)复用同一个抽取器不经索引,按 mtime 缓存;一个产地两种消费。

**再往下一层:语言是抽取器自己的注册表,不是 symbol 能力的枚举。** 用户 09-02 追问:「symbol 会有不同语言的识别,底座扎不扎实?」同一条法再用一次——能力对语言的关系,与骨架对能力的关系同形:

```ts
// runtime/search/capabilities/symbols/extractor/registry.ts
export interface SymbolExtractor {
  readonly id: string                       // 'ts' | 'python' | 'go' | 'regex-fallback'
  matches(file: { path: string; languageId?: string }): boolean   // 自己认自己的文件(后缀 / shebang / 查看器已判出的 languageId)
  extract(source: string, file): Symbol[]   // 纯函数:源码 → 符号表;不做 IO
}
registerSymbolExtractor(extractor)          // 一行;先注册的先问,`regex-fallback` 以 fallback 标记殿后
resolveSymbolExtractor(file)                // 与查看器 `content/viewer/registry.ts` 的 registerViewer / resolveViewer 同款
```

- **加一种语言 = 一个抽取器模块 + 一行注册**;symbol 能力、feed、索引、⌘F、大纲一字不改。tree-sitter 语法是抽取器私有的懒加载依赖,不是骨架的依赖。
- **文件是什么语言**只判一次:复用查看器已有的文件类型判定(`data/viewer-kinds.ts` 的 `resolveViewerKind`),抽取器只在 `matches` 里读它,不各自再猜一遍后缀。
- **⌘F / 大纲 / 工作区符号检索**三个消费者都只调 `symbolsOf(file)`(按 mtime 缓存的那一层),谁也不认识语言。
- **无抽取器的语言**:`regex-fallback` 用通用启发式(`function|def|class|fn|func` 后跟标识符)给一个粗结果,并在 Symbol 上标 `confidence:'heuristic'`,壳画淡一档——不藏、不装准。

三层同一条法:骨架不枚举能力,能力不枚举语言,语言不枚举文件后缀(读查看器的判定)。

**演练规则(写进 §11)**:任何一版设计交卷前,拿一个设计时没想过的能力(本次是 symbol;下次换「网页书签」「邮件」)走一遍上表;超出「能力模块 + 壳渲染模块 + 两行注册」的,就是漏抽的枚举点,回去抽。

### 4.3 注册表

```ts
export function createCapabilityRegistry() {
  const map = new Map<string, SearchCapability>()
  return {
    register(cap: SearchCapability): () => void,   // 重名抛;返回注销
    get(id: string): SearchCapability | undefined,
    list(): SearchCapability[],                    // 注册顺序 = 缺省展示顺序
  }
}
```

装配层 `backend/wiring/search/index.ts` 注册六个内置能力;插件管理器在插件启用 / 禁用时 `register` / 注销 `plugin:<id>`。索引服务从注册表里收 `feed`,壳从 `search.capabilities` 路由收 manifest(tab / 图标 / 过滤片 / 分组次序都从这里算),壳侧另有一张 **目标渲染注册表**(`registerTargetRenderer(kind, Component)`),缺渲染器的 kind 画成「只有标题的一行」并在 dev 下 warn——绝不因为壳没跟上而把结果吞掉。
**加一类 = 一个文件 + 一行注册;删一类 = 删文件 + 删那一行;壳 tab 由 `search.capabilities` 路由读出,自动增减。**

---

### 4.4 发散演练:把后面两年可能的需求先走一遍(09-02 用户令:「不能等我说出需求再扩架构」)

方法:沿**七条变化轴**各列几个具体需求,每一个都问同一句「要改哪些文件」。答案落在能力模块与壳渲染模块之外的,就是骨架缺一条缝;缝当场补进本文,不等需求来。补缝的手段只有三种:**列表**(可增)、**注册表**(可增删)、**接口 + 缺省实现**(可换)。绝不是「加一个 if」。

| 轴 | 需求(举例,都是这个产品里有产地的) | 落在哪条缝 | 演练结论 |
| --- | --- | --- | --- |
| **① 来源** | 浏览器书签 / 历史(browser 域)、媒体库(文件名 + AI 说明)、待办(todo-plan)、目标(goals)、技能(skills)、MCP 工具目录、设置页(像 macOS 搜设置)、终端历史、剪贴板 | 能力 + feed(§5.2b);静态小表走 static 基座 | 全部只动能力模块。设置页要「点开定位到某一格」= target payload 自定,壳渲染器自带 |
| **② 匹配方式** | 模糊(⌘P 式子序列)、正则、大小写敏感、拼音 / 首字母搜中文、同义词、拼写纠错、自然语言日期(「上周」) | **`QueryExpander` 注册表**(§6.2b,新补):term → 候选 terms 带权;`Normalizer` 列表(§6.1,新补) | 第一稿把「前缀展开」写死在分析器查询侧 —— 是枚举点,已抽成 expander 注册表;前缀 / 模糊 / 拼音 / 同义各一个 expander |
| **③ 召回方式** | 向量 / 语义检索、混合召回(词法 + 向量)、按结构查(AST 查询) | **`Retriever` 列表 + 融合函数**(§4.2 索引基座,新补):`retrievers: [lexical, vector]`,RRF 融合 | 第一稿只留了 `Ranker` 位 —— 向量是**召回**不是排序,位留错了;已补 |
| **④ 结果形** | 富预览(图片缩略、代码高亮片段、消息上下文前后各两条)、结果上的动作(打开 / 复制路径 / 固定 / 删除 / 拖进输入框)、层级结果(目录 › 文件 › 符号) | `Candidate.preview?: { kind, payload }`(开放,同 target);壳目标渲染注册表条目 = `{ Row, Preview?, actions? }`;层级 = `Candidate.parent?` | 都是能力自述 + 壳渲染器自带;core 不认识 |
| **⑤ 消费者** | 命令面板、输入框 `@` 文件抽屉与 `/` 命令抽屉(**今天各自手写的两个选择器可以退役,改成同一台引擎的两个 surface**)、CLI `onething search`、web、插件 `api.search.query`、**AI 自己搜自己的历史**(工具) | `SearchContext.surface`(新补)+ `SearchContext.principal`(新补) | 能力的 `supports` 可按 surface 答(文件抽屉里 actions 不参与);**AI 当调用者**引出下一轴 |
| **⑥ 谁在看** | 用户 / agent / 插件三种调用者;collab 的 `history` 工具有一套授权模型(谁能看哪间房);跨空间可见性;插件只能看自己的 | **授权段**(§6.4b,新补):`authorize(principal, candidate)` 在 fanout 与 merge 之间,规则由能力在 manifest 里声明 `visibility`,缺省「用户全可见、agent 只见本会话与授权房、插件只见自己产的」 | 第一稿没有「谁在问」这一维,是真缺缝;补 |
| **⑦ 数据治理** | 不索引某会话 / 某目录 / 某模式(用户排除清单)、脱敏(密钥样式的串不进索引)、按空间隔离、索引大小上限、懒建(接入目录很大时首次查询才建)、后台优先级与省电 | `DocumentFilter` 列表(§5.2c,新补:`(doc) => doc | null`,排除与脱敏各一个);feed 的 `policy: { build: 'eager'|'lazy'|'on-demand', priority }`(新补);`InvertedIndex` 接口允许分片实现 | 治理是索引侧的横切面,列表即可;不进能力 |
| **⑧ 交互** | 边打边出(各组渐次到达)、换词即取消在飞的、检索历史 / 最近搜过、固定结果、保存的检索、只搜当前会话 / 当前文件 | 流水线输出改为 **`AsyncIterable<GroupResult>`**(§6.5b,新补;RPC 适配器收齐后一次回,推送适配器逐组推,流水线不改);`SearchContext.signal: AbortSignal`(新补);历史 / 固定 / 保存是壳侧或一个 `static` 能力(「最近搜过」本身是一类结果) | 第一稿输出是一次性的 `SearchPage`,渐次到达要改流水线 —— 已改成可迭代 |
| **⑨ 排序个性化** | 点击回流加权、「相关 / 最新」切换、A/B 两个排序器、固定结果置顶 | `Ranker` 接口 + `RankingSignals` 提供者(新补:点击日志等,缺省空) | 换排序器 = 换一个实现 |
| **⑩ 语言** | 日 / 韩、变音符折叠(é→e)、RTL、繁简互搜 | 分析器注册表(已有)+ `Normalizer` 列表(繁简、变音各一个) | 只加不改 |
| **⑪ 可解释 / 可观测** | 「为什么命中」、慢查询、索引健康 | `Candidate.explain?`(`ctx.debug` 时才填)、`perfCount` 环(既有)、`index.status()` | 已有或加一格 |

**演练暴露并已补的缝(相对 v2 第一稿)**:expander 注册表、normalizer 列表、retriever 列表 + 融合、principal + 授权段、surface、signal、可迭代输出、document filter 列表、feed 构建策略、preview / actions / parent、ranking signals、explain。**十二处,全部是列表 / 注册表 / 接口,零 if。**

**明说做不到「免费扩」的一件事**:跨能力混排。各能力的分数不同量纲,要混排必须每路给出 0–1 置信度 + 类别先验 —— 那是**换 `merge` 的实现**(接口在),不是改骨架;但换了之后每个新能力都要多答一问「你的置信度怎么算」。拍点己选 (a) 就永远不用答。

### 4.5 预览:媒介开放、基数开放、零副作用(09-02 用户三问:不只文本 / 能否多条 / 能否一步步深入)

预览不是候选上多一个字段,是一条链:**要不要算 → 什么时候算 → 是什么媒介 → 几条一起看 → 谁来画 → 算不出怎么办**。六问都由能力自述、壳读表;骨架只认 `{ kind, payload }`。

**① 要不要算、什么时候算** —— manifest 一格 `preview?: { mode: 'inline' | 'lazy' }`。inline 随候选带(便宜:动作说明、符号签名、会话概览);lazy 选中再取(消息上下文、代码片段、缩略图),路由 `search.preview`,↑↓ 换行即 abort 上一条。

**② 媒介是开放的:预览 payload 是一个「媒介描述」,不是文本**

```ts
interface PreviewPayload { kind: string; payload: unknown; title?: string; actions?: ActionDescriptor[] }
```

`kind` 由壳侧 **预览渲染注册表** 解析(`registerPreviewRenderer(kind, Component)`),缺省注册这些——每一个都复用已有产地,不新写渲染器:

| kind | payload | 画它的既有件 | 注意 |
| --- | --- | --- | --- |
| `text` / `markdown` | 字符串 + 高亮区间 | markdown 块渲染器 | |
| `code` | 文本 + 语言 + 命中行 | 查看器只读态(语法高亮同源) | |
| `message-context` | 命中消息 ± N 条 | 聊天流的消息渲染(同一套块) | 工具卡折叠、不触发任何「已读」 |
| `image` | `media://` / `blob:` 引用 + 尺寸 | 媒体面板的图片件 | **引用不传字节**;缩略优先,原图按需 |
| `audio` / `video` | 引用 + 时长 + 封面 | 音乐 / 媒体的播放件 | **peek 语义:不自动播、不改播放队列、不记播放历史** |
| `pdf` / `html` | 引用 | 查看器对应 handler(html 在沙箱 iframe) | |
| `diff` | 两份文本 / 两份引用 | 既有 DiffMock 的正式件 | 也是「比较」模式的底 |
| `session-overview` / `symbol-definition` / `file-excerpt` / `note-excerpt` | 结构化 | 各自 Preview 组件 | 见能力表 |
| `descriptor` | 插件描述树 | 插件 UI slot 渲染器 | 插件预览走既有协议 |
| `composite` | `PreviewPayload[]` + 布局提示 | 网格 / 并排 / 堆叠 | ④ 用 |

**文件类的预览一律复用查看器注册表**:`resolveViewer(file)` 已经按文件类型分发到文本 / 代码 / 图片 / 媒体 / PDF,预览就是查看器的「peek 态」(只读、无编辑、无持久化)。加一种媒介 = 查看器加一个 handler,预览自动跟上;反之查看器不认识的,预览也诚实地画「不支持预览 · 在外部打开」。

**③ 几条一起看:基数是请求的一部分**

```ts
search.preview({ items: Array<{ capability; id; target }>, mode: 'single' | 'compare' | 'batch' })
```

| mode | 何时 | 谁答 | 画法 |
| --- | --- | --- | --- |
| `single` | 选中 1 条 | 该能力 `preview(candidate)` | 单窗 |
| `compare` | 选中 2 条,壳判「可比」(同 kind:两条消息 / 两个文件 / 两个符号 / 同一文件两版本) | 各自 `preview` 后壳组 `composite{layout:'side-by-side'}`;能力可选实现 `compare?(a, b)` 给更好的形(如 `diff`) | 并排 / diff |
| `batch` | 选中 N > 2 | 各自 inline 预览(不取 lazy 的)+ 一段汇总(N 条 / 几种 kind / 时间跨度);图片类组 `composite{layout:'grid'}` | 网格 / 清单 |

多选是列表的能力(⇧ / ⌘ 点选、⌘A),与预览基数解耦:选了就把 items 交上去,预览窗按 mode 与 kinds 决定怎么画;能力不知道「多选」这回事,除非它选择实现 `compare`。

**④ 谁来画 / ⑤ 算不出** —— 预览渲染注册表按 kind 取组件,没有的画 Row 放大版;预览窗状态表:empty / loading(120ms 后才画骨架)/ ready / error(原话,列表不受影响)/ 超量(截断并标)。**零副作用**是硬规矩:预览不改已读、不改会话打开态、不写最近、不改播放队列、不触发文件 mtime。

**⑥ 布局按消费面**:面板左列表右预览;抽屉不画;窄窗行下展开。

### 4.6 续搜:先问它是不是真需求(09-02 用户反问「续搜真的是一个功能吗」)

第一稿把续搜写成「帧栈 + 结果集句柄 + 每能力自报去向表」,是照 VS Code / Finder 的形抄的,没有先问这个产品里谁会用、多常用。回到真库量了一次,再逐个场景过:

**真库读数**(只读):441 会话,每会话消息数 p50 = 4、p90 = 42、p99 = 296、最长 536;≥50 条的 40 个,≥100 条的 26 个。用户消息 4431 条里 10% 提到一个文件路径。

| 场景 | 真实吗 | 最简机制 | 需要「帧栈」吗 |
| --- | --- | --- | --- |
| 搜到一个会话(标题命中),想在**这个会话里**找那句话 | 真,但只对长会话有意义(≥50 条的 40 个,占 9%;半数会话只有 4 条,打开就看见) | **范围片**:结果上一键「在此会话内搜」= 加一个 `sessionId` 过滤片,检索框保留;点 × 去掉 | 否,一层 |
| 搜到一条消息,想看**前后文** | 真,最常见 | **预览**(message-context ± N 条)+ 点开定位到那条;不是搜索的下一步 | 否 |
| 搜到一个文件,想知道**哪些对话改过 / 讨论过它** | 真(10% 用户消息提到文件;「上次让它改 X 是哪次」是高频问句) | **枢轴**:结果上一键「提到它的消息」= 换到 messages 档、种子词 = 文件名 | 否,是换一次查询 |
| 搜到一条消息,想找**它提到的那个文件** | 真但低频;消息里的文件引用已经可点(消息引用 P0–P2) | 消息渲染里的引用链接 | 否 |
| 结果太多,想**再加一个词缩小** | 真 | 在检索框里再打一个词(AND 语义就是它) | 否;「在结果里搜」与加词等价 |
| 会话按标题搜出一批,想**只在这批里**找消息 | 偶发 | 范围片可以收多个会话(选中几条 → 「在这些会话内搜」→ `sessionIds:[…]`);≤50 个 id 直接带,超过就是用户该先缩范围 | 否 |
| 符号 → 引用处 / 定义 | 真,但那是 IDE 能力,是将来 `references` 能力自己的入口 | 结果动作跳到查看器 | 否 |
| 「那天我还聊了什么」 | 罕见 | 时间过滤片(`since/until`)从结果上一键设 | 否 |

**结论:续搜的真实形态是两个动作,不是一个栈。**

1. **范围片(scope chip)**:任何结果都能把自己变成一个过滤片贴在检索框旁——会话 → `sessionId`,文件 → `dir`,消息 → `sessionId` 或当天时间段。片是**过滤条件的可视化**,与用户手打 `session:xxx` 是同一格数据(`filters`),不是新的状态。多选结果 → 片收数组。
2. **枢轴(pivot)**:结果上「以它为词搜另一类」——文件 → 提到它的消息、会话 → 它的消息(等价于范围片 + 清词)、消息 → 同名文件。它就是**换一次查询**(capability + query + filters 三格一起换)。

两者都是 `ActionDescriptor.kind === 'continue'`,产出一个 `SearchScope`(§4.6 第一稿那个值对象保留),但**壳把它落成「替换当前查询状态」而不是 push 一帧**。返回靠检索框本来就该有的**查询历史**(↑ 回上一条、⌘[ 后退),与浏览器地址栏同形——每条历史记 `{ query, capability, filters, selected }`,回去时原样,这已经覆盖「一步步深入、随时退回」,不需要面包屑栈。

**从第一稿删掉的**:`within: resultSetId` 与服务端结果集缓存(没有一个场景非它不可;多会话范围片 ≤50 个 id 直接带)、面包屑帧栈(查询历史即可)、`continuations` 那张「去向表」里的推测项(同一天的其它会话、相似图)。留下的能力自报接口只剩:`actions?(candidate)` 里 `kind:'continue'` 的项各自带一个 `SearchScope`。**加一种续搜 = 能力多返回一个动作**,骨架不变——这条演练结论不受缩水影响。

**如果将来某个场景真需要栈**(例如 references → 调用链多层跳转),`SearchScope` 值对象与查询历史都在,把历史从线性改成树是壳侧一处改动;先不做。

## 5. 索引侧:账本投影

### 5.1 文档模型

一条消息一份文档,一个会话标题一份文档,一篇每日笔记一份文档,同一张 `DocTable`:

```ts
interface Doc {
  docId: number                       // 内部递增
  capability: string                  // 产它的能力 id(v3.1:原来这里是 'message' | 'session' | 'daily' 字面量 —— 那是 core 里的枚举点,symbol 文档塞不进去;删)
  key: string                         // 能力内唯一:message `${sessionId}:${messageId}`;session sessionId;daily path;symbol `${path}#${name}`
  time: number
  facets: Record<string, string | number | boolean>   // 键由 manifest.facets 声明(sessionId / spaceId / role / archived / language …);core 不解释,只按键过滤
  fields: Record<string, string>      // 键由 manifest.schema 声明;值是**脱敏后的原文**(v3.1:存,不再回读 —— 真库正文总共 7MB,存进去毫无代价,而回读冷会话是每页 20 次文件读)
  relations?: Array<{ rel: string; to: string }>   // 关系边 —— 'in-session' / 'mentions-file' / 'touched-file' / 'in-space';由 feed 产文档时一并给,索引服务存成一张边表
}
```

关系边让「哪些对话改过这个文件」「这条消息碰过哪些文件」成为一次边表查询,不给任何能力开特例;工具调用碰过的文件从 `tool/call` 事件的参数里抽(edit / write / read 的 path),这是 §5.2 投影表多认一行,不是新机制。哪个能力对外暴露边查询,由它自己在 manifest 里声明一个 facet(messages 声明 `touchedFile` / `mentionsFile`,查询时翻成边表 join);core 只提供边表与 join,不认识 rel 的名字。

SqliteIndex 的表:`docs(docId, capability, key, time, facets json, fields json, truncated)`、`docs_fts(docId, field, tokens)`(FTS5 unicode61,每字段一行,tokens 是 TS 分析器预切好的串,带位置)、`edges(fromDoc, rel, to)`、`checkpoint(feedId, key, fingerprint)`。**短语核验在 FTS5 里做**:bigram 相邻即短语,`"身份 份牌"` 就是短语查询,不再有 TS 侧的第二次核验;摘要从 `fields` 开窗,区间经分析器的偏移映射转回原文。`MemoryIndex`(core,纯 TS)只为单测与「换实现不改上层」的活证据而存在。

### 5.2 投影器:哪些事件折成什么

`IndexProjector` 是一个 fold:`(state, event) → state`,复用 core 的 `reduceSessionProjection` 拿到**结算后的**消息文本,不自己拼 chunk。

| 账本事件 | 动作 |
| --- | --- |
| `session/created` | 建 `session` 文档(标题此刻可能为空,后续 meta 更新) |
| `user/message` / `system/message` / `message/imported` | 折进投影状态;**立即**建 `message` 文档(用户消息一到就可搜) |
| `assistant/chunks` / `assistant/part-end` | 只折进投影状态,**不建文档**(流式中不搜半条) |
| `run/end` | 把本 run 的助手节点物化(`materializeNode`),建 / 替换 `message` 文档;附件名、推理(开关)一并 |
| `user/message-edited` | 替换该 `message` 文档 |
| `message/deleted` | 墓碑 |
| `session/compacted` / `session/cleared` | 被压缩 / 清空的消息打墓碑(按投影状态里消失的节点) |
| `tool/call` | 不建文档;从参数里抽 path(edit / write / read),给本 run 的助手文档加 `touched-file` 边 |
| `session/workdir-changed` / `model-changed` / `agent-changed` | 无关,跳过 |

**改名 / 归档 / 删除不经账本**(拍点甲 b):这三件事是会话的元数据,不是它的历史。`LedgerFeed.fingerprint(sessionId) = lastSeq:metaRev`,metaRev 变了(改名、归档)就整键重折;目录没了指纹回 `undefined` 就是墓碑;活着的时候 `LedgerFeed.subscribe` 挂三样:进程内 append 观察者(§5.3,毫秒级)、总线 `session:renamed` / `session:deleted`(既有事件,`global-events.ts` / `session-events.ts`)、以及 `sessions/` 目录的 `fs.watch`(去抖 500ms,**为了另一个进程写的账本**,§5.6)。归档今天没有总线事件,靠 metaRev 兜住即可(下次查询前的目录监视会碰到 meta.json 的 mtime)。

**空间归属**:`spaceId` 来自会话 meta(`workspaceId`),建文档时取,`session/moved` 今天不存在(会话不跨空间移动),不处理。

### 5.2b 喂索引的不止账本:`DocumentFeed`(09-02 下午,用户提「symbol 检索」后抽开)

索引服务不直接认识账本。它收一组 **feed**,账本只是第一个:

```ts
interface DocumentFeed<TKey = string> {
  readonly id: string                                  // 'ledger' | 'files' | …
  readonly capabilities: string[]                      // 它替哪几个能力产文档(能力 id;v3.1 前这里是 Doc['kind'] 字面量,同一个枚举点)
  subscribe(onChange: (key: TKey, hint?: unknown) => void): () => void   // 有变化就喊一声(不带内容)
  fingerprint(key: TKey): string | undefined           // 变没变;undefined = 已不存在(墓碑)
  documentsOf(key: TKey): AsyncIterable<DocPayload>    // 这一把钥匙下的全部文档(整键替换,幂等)
  keys(): AsyncIterable<TKey>                          // 全量重建 / 启动校对时枚举
  policy?: { build: 'eager' | 'lazy' | 'on-demand'; priority?: number }   // 账本 eager;文件树 lazy(首次查询才建);大目录 on-demand
}
```

- `LedgerFeed`:key = sessionId,`subscribe` 挂 §5.3 的观察者,`fingerprint` = `lastSeq:metaRev`,`documentsOf` = §5.2 那张表折出来的消息 / 会话文档。
- `FileTreeFeed`(S6 / symbol 用):key = 文件路径,`subscribe` 挂文件监视(`fs.watch` / chokidar,只在「接入目录」内),`fingerprint` = `mtime:size`,`documentsOf` = 抽取器产的 symbol 文档。
- `SearchIndexService` 对所有 feed 一视同仁:变化 → 入队 → 去抖 → `fingerprint` 比对 → 整键替换;检查点按 `feedId/key` 记。**加一种来源 = 加一个 feed,索引服务与倒排一字不改。**

### 5.2c 索引前的横切面:`DocumentFilter` 列表

```ts
type DocumentFilter = (doc: DocPayload, ctx: { feedId: string; key: string }) => DocPayload | null   // null = 不索引
registerDocumentFilter(filter)     // 按注册序串行;任一返回 null 即止
```

缺省两个:**排除清单**(用户设置里的「不索引这些会话 / 目录 / 模式」)与**脱敏**(密钥样式 `sk-…` / `Bearer …` / 长随机串整段替换为占位,不进倒排也不进摘要)。空间隔离不在这里做——它是查询时的 facet,索引照建。

### 5.3 增量:挂在同步观察者上

`registerSessionLogEventAppendObserver`(`backend/session/event-log.ts`)已经存在:一条事件在**分配到 seq 的同一个同步段**通知观察者,落盘仍排队异步;观察者抛出不挡落盘。`projection-cache.ts` 就是这样挂的活投影。索引观察者与它**同款**:

- 观察者只做 `worker.postMessage({ type: 'enqueue', sessionId, record })`(结构化克隆一条事件,微秒级),**主线程上零 IO、零分析器、零 sqlite**。
- **为什么是 Worker 不是「下一 tick」**(v3.1):`node:sqlite` 只提供 `DatabaseSync`,每条语句都阻塞事件循环;core 就是 Electron 主进程,HTTP/SSE 面、流式回复、权限往返全在这条线程上。冷建 5 秒 = 桌面卡 5 秒,`run/end` 折一条 30 万字的消息 = 几十毫秒的长帧,正是 09-03 流式卡死那种病。所以 Worker 是**唯一**持有 sqlite 句柄的地方;主线程侧 `worker-host.ts` 把 `enqueue` / `query` / `status` / `preview` 四种消息做成 Promise 往返(query 一次往返 < 1ms),Worker 崩了记一条 `error` 日志、重起、从检查点续;两次连续崩就报 `index.status() = { error }` 不再重起。
- Worker 里的折:队列去抖 50ms 成批;若该会话的投影状态不在缓存(冷会话),按 `projection-cache` 的边界:**不在写路径上读整文件**;把该会话记进「待补」,由后台任务从检查点 seq 读尾巴补齐(`drainSessionLogEventTail`,`seq <= lastSeq` 幂等)。
- 折坏了(reduce 抛)→ 该会话检查点作废,后台整会话重建;其它会话不受影响。
- 门:`gate:search-index` 里量**主线程事件循环延迟**(`perf_hooks.monitorEventLoopDelay`)—— 冷建全程 p99 < 20ms、增量折期间 < 5ms;把索引服务改回主线程跑这条门必红。

### 5.4 检查点与快照

```
<store>/index/
  search.v1.sqlite      docs / docs_fts / edges / checkpoint 四张表(WAL 模式);S7 加 vec_docs
  search.v1.sqlite-wal / -shm
<store>/run/
  index-owner.json      { pid, host: 'desktop' | 'daemon' | 'server', startedAt }(0600;§5.6)
```

- 检查点就是库里那张 `checkpoint(feedId, key, fingerprint)`,**按 feed 记,不按 feed 名枚举**(v3.1:原来写的 `{ sessions: …, daily: … }` 是枚举点)。库头 `meta(version, analyzerId, embeddingModelId)` 三格,任一不符 → 丢库全量重放(≈5s,Worker 里)。**不做迁移**。
- 启动:打开库 → **立刻可查** → 后台对每个 feed 跑一遍校对:`feed.keys()` 逐键比 `fingerprint`,差的排队整键重折;库里有、feed 说不存在的墓碑。
- 写:每条语句自己就是持久的,没有「写快照」这回事;每 200 次增量或 5 分钟 `PRAGMA wal_checkpoint(PASSIVE)`。
- 墓碑超过 20% 后台 `VACUUM`(Worker 里,读者不受影响)。
- `index/` 是派生数据,删掉即重建,与 `log/` 看门人无关。

### 5.6 一个 store 两个 core:索引持有权(拍点庚 a)

**现状**:桌面持 `desktop` 锁、CLI daemon 持 `daemon` 锁、`server:start --force` 什么锁都不持;桌面只在 `run/http.json` 有活记录时挂靠别人的 core,而 daemon **从不看这份文件**,永远自己装配一份 backend。所以「桌面 + daemon 同时在」是常态,两个进程各有一个 `SearchIndexService`,盯着同一个 `search.v1.sqlite`。

**办法**(与 08-24「store 不要锁,单写者走发现文件 + 拒写」同一条路,`ownership.ts`):

| | 写者(owner) | 读者(reader) |
| --- | --- | --- |
| 怎么当上 | 起 Worker 时没有活的 `index-owner.json`(pid 不在了就是不活;判据与 `discovery.ts` 的 `isAlive` 同款去掉端口那半)→ 写自己的记录,`DatabaseSync(path)` 读写打开 | 有活的记录且不是自己 → `DatabaseSync(path, { readOnly: true })`;WAL 模式下读者与写者互不阻塞 |
| 做什么 | 折、校对、检查点、VACUUM、答查询 | 只答查询;不折、不写;`index.status()` = `{ mode: 'reader', owner: { host, pid } }`,壳把「索引更新中」那行改画「由 <host> 维护」 |
| 别人写的账本 | `LedgerFeed` 的目录监视(§5.2)在 ~1s 内看到另一个进程 append 的 events.jsonl,按指纹整键重折 —— 这就是读者写的消息能被搜到的路 | 自己 append 的事件也只能等写者的目录监视;进程内观察者在读者模式下**不入队**(入了也没处折) |
| 交接 | dispose 时删记录,**只删 pid 是自己的**(与 `removeHttpDiscovery` 同一条规矩) | 每次查询前与每 30s 复查一次持有者;pid 死了 → 写自己的记录、重开读写句柄、跑一遍 §5.4 的校对补齐停摆期间的差、切成写者。两个读者同时发现写者死了 → 谁的 `O_EXCL` 建文件成功谁是写者,另一个照旧读 |

**明说的取舍**:读者写的消息要绕一圈目录监视才进索引,延迟 ~1s 而不是毫秒;两个进程同时活着时 `index/` 目录只有一份数据、一个写者,永远不会双写。选 (b) 两写者幂等会把「谁的检查点算数」变成竞态;选 (c) 会让 daemon 在桌面开着时没有搜索,而 `onething search`(CLI)正是 daemon 的口。

**门**(进 S3):单测里同一 store 起两个 `SearchIndexService`(两个 Worker),第二个必是读者且答同一条查询结果逐字同;删掉第一个的记录并把 pid 换成死号 → 第二个在下一次查询时接管并补折停摆期的差;真机 `gate:search-index` 起 `dist/server` 两份(第二份 `--force`),断言第二份 `status.mode === 'reader'`、两份查询同答、杀第一份后第二份 `mode === 'owner'`。

### 5.5 大正文与 blob

`events.jsonl` 里超过 64KB 的正文是 blob 引用(`blobs/<hash>`),投影 materialize 时经既有 `ProjectionBlobResolver` 解出;真库最长 31 万字 3 条,分析器对单文档设 200k 字上限(超出只索引前 200k,DocTable 标 `truncated`),避免一条消息占掉一秒。

---

## 6. 查询侧:流水线

```ts
export const search = compose(parse(normalizers), plan(expanders), fanout(registry), authorize(policy), merge, rank(ranker, signals), page, snippet)
// 每段:(ctx, input) => output,纯函数;fanout 与能力 search 是唯一的异步段;整条的输出是 AsyncIterable<GroupResult>(§6.5b)
// 括号里的是各段的可替换件:列表 / 注册表 / 接口 —— 段本身不认识任何能力
```

### 6.1 parse:字符串 → SearchQuery

- 归一化两侧同一条 **`Normalizer` 列表**(按序应用,每个带偏移映射):缺省 NFKC、小写、空白折一、零宽删、中文标点映射;繁简 / 变音符折叠是再加两项。**保留偏移映射**(归一化后下标 → 原文下标,高亮永远指原文)。
- 语法:空格 = AND;`"..."` = 短语;`-x` = NOT;`kind:messages` `role:user` `space:all` `since:7d` 是过滤片(也可由壳以结构传入)。
- 意图:遍历注册表里各 manifest 的 `intentPrefixes`,命中哪个能力的前缀就是哪个意图(能力 id 即意图名);`path` 由 files 能力声明一个判据函数;都不中 = `content`。**前缀符号不再被吃**,它是意图的证据;core 里没有任何前缀字面量。

### 6.1b 时间与实体抽取(v3)

parse 之后、plan 之前多一段纯函数:从查询里抽**时间表达**(「上周」「八月」「昨天下午」「9/1」→ `since/until` 过滤,词从 ast 里摘掉)与**实体**(像文件名的、像标识符的、像会话标题的 → 各自的 boost 与 intent 证据)。抽取器是列表(中文 / 英文时间各一个,实体按正则),抽不到就什么都不做。壳把抽到的时间画成一条可拖的轴,拖动即改 `since/until`。

### 6.2 plan:放宽阶梯

`①严格(AND + 短语相邻)→ ②去相邻约束 → ③AND→「至少命中一半的词」→ ④单词`。plan 只产出阶梯,fanout **对每个能力各自**按阶梯逐级试,该能力第一级有结果即停,结果标 `relaxed`;全部档里 messages 放宽到 ③ 不影响 sessions 停在 ①。scan / static / remote 型能力不吃阶梯(它们的匹配语义自带模糊),manifest 声明 `relax: false` 即只跑 ①。壳写「已放宽:按任一词匹配」。**不静默放宽**。

### 6.2b expander:查询词 → 候选词(注册表)

```ts
interface QueryExpander { id: string; expand(term: QueryToken, vocab: Vocabulary): Array<{ term: string; weight: number }> }
```

缺省一个 `prefix`(末词在词典区间展开,上限 64)。模糊(编辑距离 ≤1 在词典上)、拼音 / 首字母、同义词、拼写纠错各是一个 expander,注册即生效;权重进打分。expander 只看词典不看文档,所以是纯函数、可单测。

### 6.3 analyzer(索引与查询共用)

| 文本 | 文档侧 | 查询侧 |
| --- | --- | --- |
| CJK | 字二元(bigram);单字补 unigram | 同左 |
| 拉丁 / 数字 | `\p{L}\p{N}_` 连续段,小写;camel / snake 再拆一层并保留整词 | 同左,**末词前缀展开**(词典区间,上限 64) |
| 混排 | `CompositeAnalyzer` 按字符类别分段 | 同左 |

为什么二元不分词:小语料词典分词召回差且模型造词多;二元召回全、精确靠短语核验补回。

### 6.4 fanout:问能力

```ts
fanout(registry, budgetPolicy) = async function* (ctx, q, ladder) {
  const caps = q.capability === 'all' ? registry.list().filter(c => c.supports(q)) : [registry.get(q.capability)]
  const budgets = budgetPolicy(q, caps)                       // §7.1
  const inFlight = caps.map(c => runLadder(c, q, ladder, budgets[c.manifest.id], ctx).then(toGroup, toErrorGroup))
  for await (const group of settledInOrderOfArrival(inFlight)) yield group   // 谁先答完谁先出(§6.5b);失败 / 超时 = 该组 { error } 不拖死别组
}
// runLadder:按 §6.2 对这一个能力逐级试;超时用 ctx.signal 派生的 AbortSignal 传进 search(),不是外面包一层 withTimeout 让它继续白算
```

### 6.4b 授权是查询的输入,不是结果的过滤(v3.1)

```ts
type VisibilityRule = (principal: SearchContext['principal']) => VisibilityScope   // 返回「这个人能看的范围」,形由能力定义:messages 返回 { spaceIds, sessionIds?, excludeKinds }
```

v3 把授权写成 fanout 之后对每条候选跑一遍 `(principal, candidate) => boolean`。那是**结果过滤**:能力按 `limit=20` 查回 20 条,滤掉 15 条,壳拿到 5 条却带着「还有下一页」的 cursor,`total` 也是滤前的数。改法:manifest 的 `visibility` 是 `principal → 范围`,由 **fanout 在调 `search()` 之前算好塞进 `SearchQuery.filters`**,能力在自己的查询里用(SqliteIndex 就是 WHERE 子句),`total` / `cursor` / `relaxed` 都是授权之后的真数。流水线里保留一段 `assertAuthorized`:对回来的候选再跑一次范围判断,漏网的**丢掉并记 `warn`**(能力实现有 bug 的证据),不承担正确性。

缺省规则(§4.1b):用户 → 全可见;agent → 拍点辛;插件 → 只见自己产的文档。**AI 当调用者**(agent-tool surface)时走的就是这条:collab 的 `history` 工具今天的可见规则(自己是成员的房)翻译成 messages 能力 `visibility` 里的一支,不另写一套搜索。

### 6.5 merge / rank / page / snippet

- **单类**:merge 是恒等;rank 只做 `Ranker` 接口一件事:按能力给的 `score` 排,同分按时间倒序(确定性,cursor 才稳);page 按 cursor;snippet 从文档表的 `fields` 开 120 字窗,区间经偏移映射转回原文。
- **分数怎么算是能力的事,不是流水线的事**(v3.1:v3 把「用户消息 ×1.1、标题命中置顶、30 天半衰」写在这一段,那是 messages 的语义混进 core)。索引基座的缺省打分器读 manifest 的 `ranking` 一格:`{ halfLifeDays?: 30, boosts?: Record<facetKey, Record<value, number>>, pinFieldHit?: 'title' }`,messages 声明 `boosts: { role: { user: 1.1 } }, pinFieldHit: 'title'`;core 里没有 role 也没有 title 这两个词。BM25 由 FTS5 的 `bm25()` 出(k1=1.2,b=0.75),字段权重按 `manifest.schema` 的 weight 传给它。
- **全部**:merge = 按组摆(§7),rank 只在组内,page 不做。

---

### 6.5b 输出是可迭代的,不是一次性的

流水线整条的返回值是 `AsyncIterable<GroupResult>`:一个能力答完就 yield 一组。两种适配器消费它:**RPC 适配器**收齐再一次性回 `SearchResponse`(今天的契约);**推送适配器**逐组经既有推送面(桌面 IPCBridge / web SSE)推 `search:progress`,壳边到边画。换词时壳 abort `signal`,在飞的组丢弃。流水线自己不知道有几种消费方式。

## 7. 全部档与分页(拍点己)

### 7.1 预算策略是一段显式代码,但它读的是各能力的自述

```ts
export function budgetPolicy(q: SearchQuery, caps: SearchCapability[]): Record<string, Budget> {
  return Object.fromEntries(caps.map(c => {
    const m = c.manifest
    return [m.id, { limit: m.budget.whenIntent?.[q.intent] ?? m.budget.default, timeoutMs: m.budget.timeoutMs }]
  }))
}
```

今天 `all` 档那张写死表(chats 6 / messages 5 / files 10 / daily 6 / prompts 6 / actions 4|8)翻译成六个 manifest 各自的 `budget`;**这个函数里没有任何能力的名字**,想改某一路的配额改它自己的 manifest。用户习惯 / 设置面的覆盖若要做,是「替换这一个函数」而不是在里面加 if。

### 7.2 全部档 = 分组总览

- 组的次序:按各 manifest 的 `order`(命中意图时用 `orderWhenIntent[intent]`)升序。今天两种次序(命令意图 actions, prompts, sessions, daily, files, messages;否则 sessions, prompts, daily, files, messages, actions)翻译成六个 manifest 的两格数字,可感知行为逐字保留。
- 每组带 `total`(能力知道就给)和「查看全部」→ 切到该能力 tab,cursor 从头。
- **不跨类混排**:各路 `score` 不可比(BM25 与静态打分与文件名匹配不是一个量纲);混排出来的次序说不出理由。要混排就得给每路做置信度换算(C 方案),不推荐。
- **不分页**:总览的目的是「大概在哪一类」;要翻页去单类。

### 7.3 单类分页

`CursorCodec` 把 `{ capability, kind, payload }` 编成 base64url 串;三种 payload 见 §4.2。契约上 `cursor` 缺席 = 取尽,`total` 缺席 = 不知道。壳只认这两条,不再用「回来的比要的少」猜。

---

## 8. 契约(只加不改)

```ts
// @shared/ipc/search.ts
export interface SearchRequest {
  query: string
  category: string                    // 能力 id 或 'all';不再是字面量联合,由 registry 校验
  limit?: number
  cursor?: string
  filters?: SearchFilters
}
export interface SearchResponse {
  success: boolean
  results: SearchResult[]             // 既有形一字不动(单类:本页;全部:各组拼接,保旧壳)
  total?: number
  cursor?: string
  relaxed?: 0 | 1 | 2 | 3
  index?: { pending: number; stale: boolean }
  groups?: Array<{ capability: string; label: string; total?: number; results: SearchResult[]; error?: string }>
}
// 新路由
export const searchRouter = defineRouter<SearchRoutes>('search', ['query', 'capabilities', 'preview', 'invoke'])
// preview  { items[], mode } → PreviewPayload | { error }
// invoke   { capability, actionId, items[] } → { ok } | { error }(能力自报的后端动作;danger 的壳先二段确认)
// capabilities → CapabilityManifest[](注册顺序;壳的 tab / 图标 / 过滤片 / 分组次序全部从这里算)
```

`SearchResult` 加 `target?: { kind: string; payload: unknown }` 与 `facets?: Record<string, unknown>`(旧字段 sessionId / messageId / filePath 照旧填,S4 之前的 React 壳与 CLI 不改也能用)。`SearchCategory` 类型保留为 `string` 别名,`isSearchCategory` 改问 registry。再加一条 `status` 路由 → `{ mode: 'owner' | 'reader' | 'error'; owner?: { host; pid }; pending: number; vector?: 'off' | 'downloading' | 'embedding' | 'ready' }`(§5.6 / §15;壳的「索引更新中」行与 gate 都读它)。

---

## 9. 壳(React)

- tab / 图标 / 过滤片 / 分组次序全部由 `search.capabilities` 回来的 manifest 算出;`all` 固定第一。
- 结果行按 `target.kind` 从目标渲染注册表取组件(`src/search/targets/<kind>.tsx` 一种一文件);缺渲染器画标题行并 dev warn。
- 单类:列表 + 底部 `total` / 「加载更多」(有 cursor 才画)/ 「已放宽」行 / 「索引更新中(剩 n)」行。
- 全部:分组,组头带 `total` 与「查看全部」;某组 `error` 时组头一句「没搜成」。
- 过滤片:空间(当前 / 全部)、角色、时间、含归档、含推理;过滤片是结构传 `filters`,不拼字符串。
- 徽:归档、空间(仅在「全部空间」下画)。
- 点消息 → 既有 `locate-message` 落点。
- 三张状态表(生命周期 / UI 生命状态 / 交互状态)随 S4 交卷;基础件先行,`ui:consume` 只减不增。

---

## 10. 分期与门

| 期 | 交什么 | 门 |
| --- | --- | --- |
| **S0 契约 + 法条 + 语料** | `@shared/ipc/search.ts` 扩展 + `capabilities` / `status` 路由;边界检查器新规则 `checkCoreSearchNamesNoCapability`(`packages/core/search/**` 零能力 id 字面量、零 `switch` on kind,目录不存在时跳过并打印);从真库抽脱敏语料 2000 条进 `core/search/__tests__/fixtures/`(**不加账本事件**,拍点甲 b) | typecheck;`boundary:gate` 绿;语料脚本只读 |
| **S1 内核** | `core/search/`:candidate / capability / registry / analyzer / index(接口 + MemoryIndex)/ pipeline / cursor 全部纯实现 | 单测:切分黄金表、编解码往返 ≡ id、语料 20 条查询期望集(含「身份牌已私发四人」必中、全角必中、`/cmd` 不被吃)、放宽阶梯按能力逐级、前缀上限、cursor 稳定、授权范围进 filters 后 total 为真数;基准 2000 条查询 < 5ms;`boundary:gate` 绿(core 零依赖 + 零能力名) |
| **S2 能力包装(行为零变化)** | 六个内置能力按三种基座包装,`plugin-search-registry` 并成 `remoteCapability`;`SearchService` 门面;**消息那一路暂仍是旧扫描**(scan 基座) | 对账门 `search:parity-A`:真库 200 随机查询 × 每类,新旧结果集逐字同(此期不许有差) |
| **S3 索引 + 投影** | `runtime/search/index/`:**Worker**(worker.ts / worker-host.ts,三个宿主各加一个构建入口)/ SqliteIndex(FTS5 unicode61 吃 TS 预切 token 列 + 文档表存正文 + 边表 + 检查点表,WAL)/ IndexProjector / LedgerFeed(观察者 + 总线 + 目录监视)/ DocumentFilter 两个缺省;messages / sessions / daily 换成 `indexedCapability`(持有权 §5.6 缓议,不建 ownership.ts) | 对账门 `search:parity-B`:索引严格档命中集 ⊇ 旧扫描命中集(差集逐条打印,按 filters 对齐);`gate:search-index`:冷建事件循环 p99 < 20ms、改名归档删除各一例经 feed 生效;折坏隔离用例;`sessions:shadow-battery` 绿;冷建 / 库大小 / 内存读数记回 §0 |
| **S4 壳** | React 壳按 §9(目标渲染注册表 + 预览渲染注册表 + 范围片 / 枢轴 + 查询历史) | `gate:search-messages` 扩 7 断言(total / 放宽 / 分组 / 归档徽 / 跨空间 / tab 随注册表 / 读者模式提示);ui:consume 只减不增;a11y 零违例 |
| **S5 退役** | 删 `searchMessages` 旧扫描、`iterateSessionMessages` 端口、`switch(category)`、写死配额表、`SearchCategory` 字面量;CLAUDE.md 改写(§12,含第 317 行「跨会话索引归 apps/server,主进程不许加库」那句)与 collab 文档 | 全仓绿;grep 零残留 |
| **S6 AI 消费者** | `search` 工具(§14):`toolkit/builtin/search.ts` + `SearchAdapter` 注入 + 场景可见 + 提示词片段;messages `visibility` 的 agent 支(拍点辛) | store 级测试:三种 principal 各得各的;`sessions:shadow-battery` 加一幕「助手用 search 找到上周那句并引用」(假 provider 脚本化调用);场景面快照更新;`transport:gate` 不动 |
| **S7 语义召回** | sqlite-vec 扩展装载 + `Embedder` 注册表 + wasm 嵌入器 + `vectorRetriever` + RRF 融合 + 设置开关(拍点壬)+ 模型下载(§15);`gate:native` 扩到 sqlite 扩展;`gate:packaged` 断言 `status.vector === 'ready'` | 黄金复述集 20 条(改写句 top-5 必中);parity-B 仍绿(词法路一字不动);事件循环门在嵌入期间仍绿;`gate:native` 两运行时装载扩展绿;打包门绿 |
| S8(缓议) | 文件内容源(`rg --json` 作 scan 能力);`@` 文件抽屉 / `/` 命令抽屉改成同一引擎的两个 surface;collab `history` 工具并入 `search`(kind 过滤) | 另案 |

S1 与 S0 并行;S2 依赖 S1;S3 依赖 S0 + S2;S4 依赖 S3;S5 依赖 S4;S6 依赖 S3(要索引才有意义,壳无关);S7 依赖 S3;S6 与 S7 可并行。S1 / S2 / S3 / S6 / S7 各是一张 opus 派工单,附本文对应节 + 三张状态表要求。

---

## 11. 反证(每期拆掉即红)

- **设计层的反证(每版设计交卷前)**:陌生能力演练(§4.2b)+ 七轴发散演练(§4.4)。用一个设计时没想过的能力走一遍「要改哪些文件」;答案不是「能力模块 + 壳渲染模块 + 两行注册」就打回。本文 v2 第一稿没做这一步,被用户用 symbol 一问就露了 feed 与 Target 两个枚举点——这就是立这条的起因。

- S1:拆 `PhraseVerifier` → 「身份 … 牌」假阳性红;拆 NFKC → 全角红;拆前缀上限 → `a` 展开红;改 cursor 不带 queryHash → 索引变后翻页错位红。
- S2:任一能力从注册表摘掉 → parity-A 该类红 + `capabilities` 路由少一项红;`budgetPolicy` 改回常量 → 「command 意图 actions 8 条」用例红。
- S3:观察者不 enqueue → 「发一条消息立刻可搜」真机红;`run/end` 前建文档 → 「流式中不出半条」红;折坏不隔离 → 「一会话坏其它照搜」红;检查点不比 `metaRev` → 改名后标题搜不到红。
- S3(v3.1 补):索引服务改回主线程 → 事件循环门红;授权改回结果过滤 → 「滤后 total 为真数」用例红;摘掉目录监视 → 「另一个进程写的消息搜得到」红;`Doc.capability` 改回字面量联合 → `checkCoreSearchNamesNoCapability` 红。(持有权那两条反证随 §5.6 缓议。)
- S4:tab 写死 → 注销一个能力 tab 仍在红;`total` 缺席时画「加载更多」→ 红。
- S6:工具无视 `ctx.principal` → agent 搜到别的空间红;`visibleIn` 改成恒真 → 协作房里同时出现 `history` 与 `search` 的场景面快照红;工具 import backend → 边界红。
- S7:词法路碰了一字 → parity-B 红;嵌入在主线程跑 → 事件循环门红;扩展只在 Node 下装载 → `gate:native` Electron 那一列红;模型 id 变了不重嵌 → 「换模型后复述集」红。

---

## 12. 拆掉的旧裁定

| 旧 | 出处 | 当时理由 | 今天 |
| --- | --- | --- | --- |
| 「跨会话搜索 / 索引归 apps/server,不进 Electron 主进程」 | CLAUDE.md | 07-04 弃 sqlite 后怕主进程再长回一个库 | 索引是账本的投影、纯 TS、可丢可重放;「一个 core」之后主进程就是 core |
| 「中文子串匹配几乎必空——但不要上分词」 | collab-history-search.md §5.1 | 小语料 OR 过召回 | 二元 + AND 优先 + 短语核验 |
| 归档跳过 / 剥 `>` `/` / `all` 配额常量 / `SearchCategory` 字面量 | providers.ts, search-runtime.ts, shared/ipc | 无记录 | 拍点丙 / 意图路由 / `budgetPolicy` / registry |

`onething.sqlite`(260MB,06-30 起未动)是遗物,另案清。

---

## 13. 留账

- 归档今天没有总线事件,拍点甲 b 下靠 `metaRev` + 目录监视兜住(~1s);若将来要毫秒级,给归档写口补一条总线事件是一处改动,不进账本。
- 跨类混排若将来要做:每路给 0–1 置信度 + 类别先验,在 `merge` 换一个实现即可,骨架不动。
- 读者模式(§5.6)下自己写的消息要等写者的目录监视,延迟 ~1s;壳在 `status.mode === 'reader'` 时「索引更新中」那行改画「由 <host> 维护」,不装成实时。
- Worker 崩两次即停(§5.3):停了之后 messages / sessions / daily 三路答 `{ error: 'index unavailable' }`,不回退到旧扫描(S5 已删),壳照 §9 画「没搜成」。
- `@huggingface/transformers` 的 wasm 后端在 Electron Worker 与 Node Worker 里都跑,但**首次装载 ~300ms**,S7 的 Worker 在开关打开后才 import 它(动态 import,不进主 bundle 的关键路径)。
- 文件内容检索是 S8 的第一件:`scanCapability` 包 `rg --json`,cursor = 文件位置。
- 三条法条的机械化只做了第一条(core 零能力名)。「能力不枚举语言」「语言不枚举后缀」等 symbol 能力真来了再各立一条检查。

---

## 14. AI 自己是搜索的消费者(S6)

### 14.1 一句话

助手拿到一个 `search` 工具,走的是**同一份索引、同一条流水线、同一个注册表**,只是 `SearchContext.surface = 'agent-tool'`、`principal.kind = 'agent'`。索引即助手记忆底座;不建第二套「记忆检索」。

### 14.2 工具

`packages/onething-runtime/src/toolkit/builtin/search.ts`,`ReadOnlyTool` 一族(`effects: []`,没有沙箱、没有取消点以外的副作用),与 `time` / `web_search` 同形;与协作 `history` 工具的关系是**同一模式**(`HistoryTool` 靠注入的 `adapters.search` 查,`search` 靠注入的 `SearchAdapter` 查),runtime 不 import backend。

```ts
export const SearchInputSchema = z.object({
  query: z.string().min(1).describe('What to look for. Plain words; quotes for an exact phrase; -word to exclude.'),
  kind: z.string().optional().describe('Restrict to one kind. Omit for everything. Kinds are listed in the tool description.'),   // 能力 id;描述里的清单由适配器在注册时从 registry 生成,工具源码里没有能力名
  scope: z.enum(['session', 'space', 'all']).optional().describe('How far to look: this conversation, this space (default), or everything you may see.'),
  since: z.string().optional().describe('Only results after this time: ISO date, or relative like 7d / 2w.'),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional().describe('Default 8.'),
  expand: z.string().optional().describe('A result id from a previous call: return its full context (the message with a few before and after, or the file excerpt) instead of searching.'),
})
```

- **输出**:`textResult`,每条一行 `[<id>] <kind> · <title> · <time> — <snippet>`,末尾一行 `total N · relaxed? · index pending?`(说实话那三格);`expand` 返回该候选的预览(§4.5 的 `PreviewPayload` 按 kind 转成文本:`message-context` 就是前后各两条的对话原文,`code` / `file-excerpt` 就是带行号的片段)。id 是 `${capability}:${candidate.id}`,跨调用稳定。
- **可见范围**:`scope` 只能**收窄**不能放宽——上限由拍点辛定的缺省规则给(`visibility(principal)`),`scope: 'all'` 在拍点辛 a 下等于「当前空间 + 我的房」,不是全部空间。范围进 `filters`(§6.4b),工具本身不判断。
- **场景**:`visibleIn(scene)` 在普通聊天 / goal / task 都可见;协作房里也可见,但 messages 那一路的 agent 支已经把「不是成员的房」排掉,所以与 `history` 并存不越权(S8 再议并入)。
- **提示词**:工具自带 `prompt`(随回合面进出,同 `edit` 那套):「用户问『上次』『之前聊过』『那个文件是哪次改的』时先 search 再答;引用结果时带 id 或时间,不要复述整段」。写事实不写回避指令(08 判例)。
- **预算**:`limit` 上限 20、`timeoutMs` 由各能力 manifest 的 `budget` 给;工具调用不走推送适配器,收齐再回(RPC 适配器那一路)。
- **审计**:同其它工具,`tool/audit` 事件照记;`ctx.debug` 不开,`explain` 不进工具输出。

### 14.3 装配

`backend/wiring/search/index.ts` 在注册完能力后 `registerSearchToolAdapter({ search: (input, principal) => service.search(...) , preview: … })`,工具在 `full` 与 `headless` 两个目录里(server / CLI daemon 也能用),`readonly` 目录也有(它零副作用)。principal 从 `RunContext.invocation.principal` 来(toolkit 已有 `Principal`,agent 主体化那条线的产物),`sessionId` 从 `invocation.sessionId`,`spaceId` 从 `session.metadata.workspaceId`。

### 14.4 陌生能力演练(本节自己也要过一遍)

加 symbol 能力之后,`search` 工具**一字不改**就能搜符号:kind 清单从 registry 生成,结果行的 `<kind>` 与 snippet 由候选自带,`expand` 走同一条 preview 路。这是「AI 消费者」不另立一套的证据。

---

## 15. 语义召回:sqlite-vec + 本地嵌入(S7)

### 15.1 一句话

在 `SqliteIndex` 里多一张 `vec_docs(docId, embedding float[384])`(sqlite-vec 的 `vec0` 虚表),索引基座的 `retrievers` 从 `[lexical]` 变成 `[lexical, vector]`,RRF 融合(k = 60)。词法路一字不动,parity-B 继续守它。

### 15.2 三件原生相关的事,按法条办

| 件 | 是什么 | 法条怎么过 |
| --- | --- | --- |
| `sqlite-vec` | 纯 C 的 SQLite 可加载扩展,npm 包 `sqlite-vec` 带平台子包(`sqlite-vec-darwin-arm64` 等,各一个 `vec0.dylib/.so/.dll`) | 法条明文允许「SQLite 这类内建 / 纯 C 扩展」,但**只许门证明**:`gate:native` 扩一列——对当前平台那份扩展,分别在系统 Node 与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 下 `new DatabaseSync(':memory:', { allowExtension: true }).loadExtension(path)` 并跑 `select vec_version()`;`nm -u` 只许出现 `sqlite3_*` 符号 |
| 嵌入运行时 | 拍点癸 a:`@huggingface/transformers` wasm 后端,零原生;模型 `multilingual-e5-small` int8(384 维,约 110MB,中英日韩都行——真库中文 29%) | 零原生就零法条问题;wasm 在 Worker 里跑,主线程零 CPU |
| 打包 | 扩展文件 `asarUnpack`;mac 硬化运行时下**未签名的 dylib 装载会失败**,electron-builder 对 Mach-O 一律签,但要由 `gate:packaged` 证:打包 app 起来后 `search.status().vector === 'ready'` | 门证,不写注释 |

### 15.3 嵌入器是注册表,模型是数据

```ts
export interface Embedder {
  readonly id: string                 // 'transformers-wasm:multilingual-e5-small-q8'
  readonly dims: number
  ready(): Promise<void>              // 下载 / 装载;幂等
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>
}
registerEmbedder(embedder)            // 换 onnxruntime-node(拍点癸 b)= 一个模块 + 一行
```

- 模型文件落 `<store>/models/embeddings/<modelId>/`(与 sherpa 的 `models/` 同一层,看门人不管它);首次开启时下载,进度进 `status.vector = 'downloading'`;失败 = 开关自动关回去并 `warn`,不重试到死。
- `meta.embeddingModelId` 进库头(§5.4):换模型 = 后台全量重嵌,`vec_docs` 清空重灌,词法路照常;嵌完之前 vector 路不参与(`status.vector = 'embedding'`)。
- 嵌什么:manifest `schema` 里标 `embed: true` 的字段(messages 的 `content`、sessions 的 `title`、daily 的正文);单文档超 512 token 切段,每段一行,`docId` 相同、`chunk` 序号不同;`DocumentFilter` 在嵌入前已跑过(脱敏后的文本才进模型)。
- 成本(真库读数估算):9616 条消息 ≈ 1.4 万段,wasm 单段 ~40ms → 冷嵌 ≈ 9 分钟,Worker 后台、限速(每批 32 段后让出 50ms),`gate:search-index` 的事件循环门在嵌入期间照量;增量每条消息 ~40–120ms,在 Worker 里,用户无感。

### 15.4 什么时候走向量路

查询嵌入也要 ~40ms,命令面板边打边出的 < 10ms 预算容不下它。所以向量路**不是每次都跑**,由索引基座读 manifest 的 `retrievers.vector.when` 决定(数据,不是 if):

| when | 含义 | 谁用 |
| --- | --- | --- |
| `'relaxed'`(缺省) | 词法严格档零命中、走到放宽阶梯 ② 及以后才加向量路 | messages / daily |
| `'explicit'` | 只在 `filters.semantic === true`(壳的「语义」片)或 surface = `agent-tool` 时 | sessions(标题短,向量意义小) |
| `'always'` | 每次都跑(接受 +40ms) | 将来的笔记 / 知识库类能力 |

融合:RRF,`score = Σ 1 / (60 + rank_i)`;`explain` 标出这条来自哪路。壳在结果上画一枚「语义」小徽(不是计数徽),让用户知道这条不是字面命中。

### 15.5 门

- `gate:native`:扩展两运行时装载绿(§15.2)。
- 黄金复述集 20 条(`core/search/__tests__/fixtures/paraphrase.json`,从脱敏语料里人工写:「把钥匙发给他们了吗」→ 期望命中「身份牌已私发四人」那条),向量路 top-5 必中;词法路对同一集合允许零命中(那正是它存在的理由)。
- parity-B 绿(词法路未动);事件循环门在冷嵌期间绿;`gate:packaged` 断言 `vector === 'ready'`(开关打开、模型预置在测试 store 里,不真下载)。
- 反证见 §11 S7。
