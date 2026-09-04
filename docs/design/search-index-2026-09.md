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

**规模**(真库只读):441 会话 / 9616 条消息 / 正文 7.0MB(`messages.jsonl` 391MB、`events.jsonl` 480MB,大头是工具结果与推理)/ 中文 29%。引擎 `node:sqlite` FTS5(内建,零原生依赖;分词在 TS,FTS5 只吃预切 token 列;`InvertedIndex` 接口保留,纯 TS 实现为测试替身),**整个索引服务住一个 `worker_threads` Worker**(`node:sqlite` 只有同步 API,主线程碰它就是卡桌面),增量折毫秒级,查询 < 10ms(含一次 postMessage 往返);脱敏后的正文存进文档表(7MB),摘要与短语核验都在库内;第二期 sqlite-vec 加向量列(§15)。

**冷建读数**(S3c 实测,`dist/server` + 真 Worker;原来这里写的 `≈ 5s` 是估的,现在是量的):

| 现场 | 会话 / 文档 | 库 | 冷建耗时 |
| --- | --- | --- | --- |
| 真库副本(`search:parity-B` 的临时 store,按体积取样 135/483 间、160 MiB) | 135 间 → **2998** 份文档 | 15.0 MiB | **1.0s** |
| 种出来的重现场(`gate:search-index` ⑤,300 间 × 30 条,含 10 条 > 64KB) | 300 间 → **9300** 份文档 | 44.5 MiB | **6.9 / 12.7s**(两趟;第二趟那台机器同时在跑别的活) |

「冷建耗时」= 从 server 进程起到 `search.status.docs` 涨停且 `pending === 0`,**包含**进程启动与装配那几秒,不只是折。期间主线程一直可查(见 §5.3 的事件循环读数)。

**拍点**(用户拍;粗体 = 推荐):

| # | 问题 | 选项 |
| --- | --- | --- |
| 甲 | 会话改名 / 归档 / 删除今天**不在账本里**(走 meta.json + 总线) | (a) 补三条账本事件 `session/renamed` `session/archived` `session/deleted`;**(b) 索引不加账本事件:`LedgerFeed` 的指纹 `lastSeq:metaRev` 认改名与归档,指纹 `undefined` 即墓碑,活着时订总线既有的 `session:renamed` / `session:deleted`**(v3.1 改推荐:删会话是 `rmSync` 整个目录,`session/deleted` 要写进的账本自己已经没了;而且改名归档不是「这条会话的历史」,塞进 events.jsonl 是借账本当总线) |
| 乙 | 默认索引字段 | **(a) 正文 + 会话标题 + 附件名;推理做「含推理」开关;工具结果不索引**;(b) 推理默认含 |
| 庚 | 一个 store 两个 core(桌面持 `desktop` 锁、daemon 持 `daemon` 锁,daemon 从不看 `run/http.json`,两者同时装配是常态)谁建索引 | (a) 发现文件式单写者:先来的写 `run/index-owner.json` 当写者,后来的开只读句柄当读者(WAL 允许),写者 pid 死了读者接管(§5.6;与 08-24「store 不要锁」同一条路);(b) 两个写者都折、靠按键整体替换幂等;(c) 只有 HTTP 面持有者建索引,其它进程没有搜索。**09-04 用户裁:先不做**——S3 不含 §5.6,`ownership.ts` 不建;库开 WAL,两个进程同时当写者时靠按键整体替换幂等兜底(即事实上的 (b)),`status` 路由的 `mode` 一格暂恒 `'owner'`,§5.6 留作方案 |
| 辛 | AI 当调用者时缺省能看多远(§14) | **(a) 当前空间里的非协作会话 + 自己是成员的协作房**(与 collab `history` 工具今天的可见规则同一条);(b) 只见本会话;(c) 全部空间 |
| 壬 | 语义召回缺省开关(§15;要下载约 110MB 模型、冷嵌入占 CPU 数分钟) | **(a) 默认关,设置里一键开,开了才下载**;(b) 默认开 |
| 癸 | 嵌入模型运行时(§15) | **(a) `@huggingface/transformers` wasm 后端,零原生依赖**;(b) `onnxruntime-node`(N-API,过 gate:native,快约 2 倍,多 30MB 原生包) |
| 癸' | 语义召回的**桌面打包档**运行时(癸 a 选定之后才冒出来的第二问:装 transformers 顺带拖进 onnxruntime-node 212M / onnxruntime-web 92M / @huggingface 48M / sharp+@img 17M。09-05 同机同一份构建产物、只换 `electron-builder.yml` 那几行的两趟 `du -sh` 读数:**全打进去 565M,全排除掉 309M**) | (a) 解包 `onnxruntime-web` 的 wasm(**约 +92M**,换来打包档能跑语义召回);(b) 改用 `onnxruntime-node`(拍点癸 b,**+212M**,是 N-API、已过 `gate:native`,但与癸 a 的「零原生」相反);**(c) 只在 server / CLI 供应,桌面档不带运行时 —— 09-05 编排者暂按 (c) 落地(保守缺省),待用户拍** |
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

`budget.whenIntent` 的**键是意图名,而意图名就是能力 id**(`parse` 认 `intentPrefixes` 之后把意图记成那个能力的 id),所以命令意图那一格写的是 `whenIntent: { actions: 8 }` —— S0 那张表里的 `command` 是笔误,S2 已按 `actions` 落地。

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
| `session/cleared` | 全部消息打墓碑(reducer 把节点全部 `hidden`) |
| `session/compacted` | **被压掉的消息照旧索引**,压缩卡自己不产文档(S3a 实测修正:reducer 的这一支只遮模型可见历史,屏幕上旧消息还在,打墓碑就是「看得见、搜不到」) |
| `tool/call` | 不建文档;从参数里抽 path(edit / write / read),给本 run 的助手文档加 `touched-file` 边 |
| `session/workdir-changed` / `model-changed` / `agent-changed` | 无关,跳过 |

**哪些事件触发重折,由投影器自述**(S3b 第二轮补):增量是**整键重折**,所以「这条事件
值不值得折」这个问题必须有人答,而答它的只能是「事件 → 文档」那张表本身 ——
`projector.ts` 的 `INDEX_DOCUMENT_EFFECTS` / `affectsIndexedDocuments(record)` 就是上面
这张表的另一半。**观察者(装配层)与 `LedgerFeed` 的目录监视只读它**,自己一个事件名都
不认识;加一种会改文档的事件 = 在那张表里改一行,两个读表的地方一字不动。表是
`Record<SessionLogEventType, boolean>`,漏一种当场 tsc 红。判据只有一条:**这条事件会不会
改变 `project()` 的产出** —— 所以 `session/compacted` 答 `true`(reducer 把那条占位消息
`hidden` 掉,而占位那条已经建过文档),而 `assistant/chunks` 答 `false`(折出来的文档逐字
相同)。不这么做的代价实测过:一轮回复几十次整键重折,每次读整份 `events.jsonl`。

**改名 / 归档 / 删除不经账本**(拍点甲 b):这三件事是会话的元数据,不是它的历史。`LedgerFeed.fingerprint(sessionId) = lastSeq:metaRev`,metaRev 变了(改名、归档)就整键重折;目录没了指纹回 `undefined` 就是墓碑;活着的时候 `LedgerFeed.subscribe` 挂三样:进程内 append 观察者(§5.3,毫秒级)、总线 `session:renamed` / `session:deleted`(既有事件,`global-events.ts` / `session-events.ts`)、以及 `sessions/` 目录的 `fs.watch`(**递归**——账本住子目录里,macOS kqueue 的非递归 watch 对子目录文件写入一声不吭,S3a 用例当场抓到;去抖 500ms;`recursive` 抛出退回非递归、再抛降级 30s 轮询,每档记 warn;**为了另一个进程写的账本**,§5.6)。归档今天没有总线事件,靠 metaRev 兜住即可(下次查询前的目录监视会碰到 meta.json 的 mtime)。

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
- 门:`gate:search-index` 里量**主线程事件循环延迟**(`perf_hooks.monitorEventLoopDelay`)—— 冷建全程 p99 < 20ms;增量折 **p99 < 5ms 只对「窗口里除了折没有别的事」成立**(门的 ⑤c:60 键整键重折,实测 p99 1.83–3.02ms),而**带真回合的窗口线是 20ms**(门的 ⑤b:20 条消息连发,实测 p99 5.61–9.86ms)—— 那个窗口的地板是**回合本身** 7ms 左右(把索引整个关掉跑同一段,p99 反而是 7.377ms),拿 5ms 卡它卡的是引擎不是折。把索引服务改回主线程跑这两条都必红。

### 5.4 检查点与快照

```
<store>/index/
  search.v1.sqlite      docs / docs_fts / edges / checkpoint 四张表(WAL 模式);S7 加 vec_docs
  search.v1.sqlite-wal / -shm
<store>/run/
  index-owner.json      { pid, host: 'desktop' | 'daemon' | 'server', startedAt }(0600;§5.6)
```

- 检查点就是库里那张 `checkpoint(feedId, key, fingerprint, keys_json)`,**按 feed 记,不按 feed 名枚举**(v3.1:原来写的 `{ sessions: …, daily: … }` 是枚举点)。`keys_json` 是 S3a 加的第四列:feed 的钥匙(sessionId)盖几十份文档(`sessionId:messageId`),整键重折后「上一轮有、这一轮没有」的那些要删,除了记下来没有别的问法(拿 facet 反查等于让索引认识 `sessionId` 这个键名)。库头 `meta(version, analyzerId, embeddingModelId)` 三格,任一不符 → 丢库全量重放(≈5s,Worker 里)。**不做迁移**。
- 启动:打开库 → **立刻可查** → 后台对每个 feed 跑一遍校对:`feed.keys()` 逐键比 `fingerprint`,差的排队整键重折;库里有、feed 说不存在的墓碑。
- 写:每条语句自己就是持久的,没有「写快照」这回事;每 200 次增量或 5 分钟 `PRAGMA wal_checkpoint(PASSIVE)`。
- 不做 `VACUUM`(要独占库,WAL 下挡读者,换来的只是磁盘占用,而派生数据删了即重建);写够 200 次做一次 `PRAGMA wal_checkpoint(PASSIVE)`。内容变了的文档直接删行重插(`deleteKey`),只有「钥匙不存在了」才进 `tombstones`。
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

**一个 AST 词摊成多词元 = 严格档的一条相邻短语**(S3b 第二轮修)。`minShouldMatch` 数的是
**查询 AST 里的词**(`2026-09-05` 是一个词),而分析器把它切成 `2026` `09` `05` 三个词元 ——
从前的翻译把三个词元摊成三个独立的词、再取 `min(1, 3) = 1`,于是「①严格 = 全 AND」在这一
形上实际是 **OR**(`2026-09-05` 把 `2026-09-06` 也召回;`身份牌` 把 `身份证` 也召回)。旧的
子串路不会这样,这是相对旧路的**过召回**,§2 的「找得到」不包括「多找到」。

所以阶梯多一维,由 plan 一处定,`LadderStep.multiTokenTerms`:

| 级 | `multiTokenTerms` | 这样一个词在这一级是什么 |
| --- | --- | --- |
| ① | `'phrase'` | 一条**相邻**短语(`"2026 09 05"`)—— 与用户手打 `"…"` 完全同一条翻译、同一个 `LexicalPhrase` |
| ② | `'phrase'` | 同一条短语,去掉相邻约束 = 这几个词元**同在一个字段里**(不要求顺序) |
| ③④ | `'split'` | 摊平成独立词元,由 `minShouldMatch` 说了算 —— 「至少一半的词」「任一词」这两句话到这里才数得着词元 |

为什么要这一格而不是拿 `minShouldMatch` 推:单个查询词的查询在四级上 `minShouldMatch` **都是
1**(`max(1, ceil(1/2))` 也是 1),推不出「这一级还认不认词的完整性」。

翻译一处改完(`buildLexicalQuery`),**两个索引实现一字不动** —— 因为它翻出来的就是既有的
`LexicalPhrase`,`MemoryIndex` 按分析器词位核相邻、`SqliteIndex` 按 FTS token 流核相邻,两边
本来就各自答过这份卷子;契约用例加同一组三档读数(严格只中那一天 → ②分着写的也中 →
③隔壁天才回来),两个实现各跑一遍。短语用的是**整份词元表**(含 camel 保留的那个整词),
不是挑出来的一部分:挑掉整词能让 `get user profile` 这种分写形也在①中,但 `SqliteIndex` 的
相邻判据走 token 流先后,只有「查询侧切法与文档侧逐字相同」两边才对得齐,挑一部分就会让两
个实现在混排词(`检索v2`)上分家。分写形由 ③ 接住。

代价一条(明说):成了短语的那个词不再吃前缀展开(`LexicalPhrase` 没有 `alternatives` 这一
格),边打边搜的 `getUse…` 在①②落空、由③接住;CJK 不受影响(二元词元长度恒为 2,拿一个
完整二元做前缀只展开出它自己)。

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

`CapabilityManifest` 的线上形(`SearchCapabilityManifestDto`)另有一格 `browse?: boolean`(S4b):
「**空词时我有浏览态**」。零词元的查询对索引恒零命中,所以「空输入框里列什么」只有能力自己答得出
(今天只有 `chats`:一条绕开索引直接调旧 `searchChats('')` 的路)。壳读这一格决定空词的「所有」档
去问谁 —— 因此壳里不必出现任何能力 id。core 那份 manifest 同名同义,但 core 自己不读它:它是一句
说给宿主听的自述。

`SearchResult` 加 `target?: { kind: string; payload: unknown }` 与 `facets?: Record<string, unknown>`(旧字段 sessionId / messageId / filePath 照旧填,S4 之前的 React 壳与 CLI 不改也能用)。`SearchCategory` 类型保留为 `string` 别名,`isSearchCategory` 改问 registry。再加一条 `status` 路由 → `{ mode: 'owner' | 'reader' | 'error'; owner?: { host; pid }; pending: number; vector?: 'off' | 'downloading' | 'embedding' | 'ready' }`(§5.6 / §15;壳的「索引更新中」行与 gate 都读它)。

---

## 9. 壳(React)

- tab / 图标 / 过滤片 / 分组次序全部由 `search.capabilities` 回来的 manifest 算出;`all` 固定第一。
- 结果行按 `target.kind` 从目标渲染注册表取组件(`src/search/targets/<kind>.tsx` 一种一文件);缺渲染器画标题行并 dev warn。
- 单类:列表 + 底部 `total` / 「加载更多」(有 cursor 才画)/ 「已放宽」行 / 「索引更新中(剩 n)」行。
- 全部:分组,组头带 `total` 与「查看全部」;某组 `error` 时组头一句「没搜成」。
- **全部档的空词是浏览态,不是分组总览**(S4b 修;09-01 用户裁定「所有档空词 = 全部会话列表、看得到总条数、能翻页」):壳在**零词元**时不发 `category: 'all'`(后端的 `'all'` 按 §7.2 是不分页的总览),而是问自述里 `browse: true` 的那些能力,**各一组、每组全量可翻页**;今天只有一个,于是屏幕上是一张平铺的会话列表 —— 与旧行为逐字相同。去问谁**从 manifest 自述读**,壳里因此没有一个能力 id(`no-capability-literals` 那道闸继续零 id)。有词照旧走分组总览。
- 过滤片:空间(当前 / 全部)、角色、时间、含归档、含推理;过滤片是结构传 `filters`,不拼字符串。
- **文件那一档的扫描根由壳递,不写 app-state**(S4b 修):`files` 在自述里声明 facet `{ key: 'dir', type: 'enum' }`(语义 = 只扫这一个目录;缺席 = 后端自己那张根列表),壳把 `useSessionCwd()` 当作缺省的 `filters.dir` **结构地**传进来。理由是旧行为:S4b 之前文件档搜的就是壳那条活跃会话工作目录,而后端的 `getSearchDirs()` 认的是**它自己**那条 `getCurrentSessionId()` —— React 壳从不告诉后端当前会话是谁,不递这一格会话目录下的文件就搜不到。「在此目录内搜」那颗范围片**替换**这个缺省,× 掉**回到缺省 cwd**(不是回到「无 dir」= 后端的根列表,那不是旧行为)。递得进来的只有 `isHostLocallyTrusted()` 那一支 —— 不可信端口本来就问不到 `files`。
- 徽:归档、空间(仅在「全部空间」下画)。
- 点消息 → 既有 `locate-message` 落点。
- 三张状态表(生命周期 / UI 生命状态 / 交互状态)随 S4 交卷;基础件先行,`ui:consume` 只减不增。

---

## 10. 分期与门

| 期 | 交什么 | 门 |
| --- | --- | --- |
| **S0 契约 + 法条 + 语料** | `@shared/ipc/search.ts` 扩展 + `capabilities` / `status` 路由;边界检查器新规则 `checkCoreSearchNamesNoCapability`(`packages/core/search/**` 零能力 id 字面量、零 `switch` on kind,目录不存在时跳过并打印);从真库抽脱敏语料 2000 条进 `core/search/__tests__/fixtures/`(**不加账本事件**,拍点甲 b) | typecheck;`boundary:gate` 绿;语料脚本只读 |
| **S1 内核** | `core/search/`:candidate / capability / registry / analyzer / index(接口 + MemoryIndex)/ pipeline / cursor 全部纯实现 | 单测:切分黄金表、编解码往返 ≡ id、语料 20 条查询期望集(含 `私发`(中文双字)与 `身份牌`(三字)必中、`"天黑请闭眼"` 短语必中、`身份牌 -女巫` 排除生效、全角必中、`/cmd` 不被吃)、放宽阶梯按能力逐级、前缀上限、cursor 稳定、授权范围进 filters 后 total 为真数;基准 2000 条查询 < 5ms;`boundary:gate` 绿(core 零依赖 + 零能力名) |
| **S2 能力包装(行为零变化)** | 六个内置能力按三种基座包装,`plugin-search-registry` 并成 `remoteCapability`;`SearchService` 门面;**消息那一路暂仍是旧扫描**(scan 基座);**扫描型包装 `timeoutMs=0`**(旧扫描路一道刹车也没有,真店 `searchMessages` 全库扫实测 1.6s,钉一个真预算会让慢盘 / 大店从「出结果」变成「没搜成」—— 不许多一道刹车),S3 换索引后再钉真预算 | 对账门 `search:parity-A`:真库 200 随机查询 × 每类,新旧结果集逐字同(此期不许有差)——**已由快照替代(S5)** |
| **S3 索引 + 投影** | `runtime/search/index/`:**Worker**(worker.ts / worker-host.ts,三个宿主各加一个构建入口)/ SqliteIndex(FTS5 unicode61 吃 TS 预切 token 列 + 文档表存正文 + 边表 + 检查点表,WAL)/ IndexProjector / LedgerFeed(观察者 + 总线 + 目录监视)/ DocumentFilter 两个缺省;messages / sessions / daily 换成 `indexedCapability`(持有权 §5.6 缓议,不建 ownership.ts)。**S3b:空词最近会话与日记快捷行保旧行为**——索引在结构上答不出这两件(零词元查询零命中;不存在的文件没有文档),所以 chats 空词绕开索引直接调旧 `searchChats`、daily 的「今天那一条」由从旧扫描器抽出的 `resolveDailyTodayShortcut` 补,位置与判定逐字沿用旧实现;**server 不可信端口不共用 store 级索引**(索引文档上没有 owner 这一格,共用即串 owner),那一支答「索引不可用」而不是共用一份库 | 对账门 `search:parity-B`:索引严格档命中集 ⊇ 旧扫描命中集(差集逐条打印,按 filters 对齐)——**已由快照替代(S5)**:参照物那条旧扫描路删了,判据换成 `runtime/src/search/__tests__/golden-snapshot.test.ts` 的严格档命中集快照;`gate:search-index`:冷建事件循环 p99 < 20ms、改名归档删除各一例经 feed 生效;折坏隔离用例;`sessions:shadow-battery` 绿;冷建 / 库大小 / 内存读数记回 §0 |
| **S4 壳** | React 壳按 §9(目标渲染注册表 + 预览渲染注册表 + 范围片 / 枢轴 + 查询历史) | `gate:search-messages` 扩 7 断言(total / 放宽 / 分组 / 归档徽 / 跨空间 / tab 随注册表 / 读者模式提示);ui:consume 只减不增;a11y 零违例 |
| **S5 退役**(**已落地 2026-09-05**,记录见下) | 删 `searchMessages` 旧扫描、`switch(category)`、写死配额表、`SearchCategory` 字面量清单;`iterateSessionMessages` 端口**留**(S4a 的消息预览用它读命中前后各两条);CLAUDE.md 改写(§12,含「跨会话索引归 apps/server,主进程不许加库」那句 —— S3 已改)与 collab 文档 | 全仓绿;grep 零残留;`gate:search` / `gate:search-messages` 离屏两条真机门仍绿(空词浏览态 = 删路不删行为的证词) |
| **S6 AI 消费者**(**已落地 2026-09-05**,记录 §14.5) | `search` 工具(§14):`toolkit/builtin/search.ts` + 单槽适配器注入 + 场景恒可见 + `spec.prompt`;messages **与 chats** `visibility` 的 agent 支(拍点辛 a);三档目录各注册一行 | typecheck 零;`boundary:gate` / `transport:gate` / `assembly:gate` / `log:gate` / `session:gate` 五闸全绿;`bunx vitest run {runtime,backend}/{toolkit,search} + backend/rpc + core/search` **99 文件 1104 例**(其中新增 4 份 61 例);反证三条各自真红(§11);**battery 那一幕没做**,理由与替代见 §14.5 ③ |
| **S7 语义召回**(2026-09-05 落地) | sqlite-vec 装载(`runtime/search/index/sqlite-vec.ts`)+ `Embedder` 注册表(`runtime/search/embedding/`,wasm 真件 + 确定性假件)+ `vectorRetriever` 两份(core 的同步件 / runtime 的过 Worker 件)+ RRF 融合 + `manifest.retrievers` 按召回器 id 的策略表 + 设置开关 `search.semantic`(拍点壬 a,**默认关**)+ 嵌入写路 `VectorWriter`(Worker 里,每批让出);`gate:native` 6 目标(多了 sqlite-vec 与 transformers 拖来的两个原生包);`gate:packaged` 断言 `vector === 'off'` + `vectorExtension === 'loadable'`(改判见 §15.5) | 复述集 20/20 向量路 top-5 命中、词法严格档 0/20;`search:parity-B` 三趟与 S3c 逐字同(红 0;该门 S5 退役,**已由快照替代**);`gate:search-index` 八条绿(⑧ 新增:开关 → `embedding → ready` 196ms → 改写句 7ms 经 HTTP 命中 → 两条各排第一);⑤ 三窗口不劣化(1.356 / 5.583 / 1.79ms);`gate:native` 0 失败;`build:unpack` 后 `app.asar.unpacked/**/vec0.dylib` 在且已签名 |
| S8(缓议) | 文件内容源(`rg --json` 作 scan 能力);`@` 文件抽屉 / `/` 命令抽屉改成同一引擎的两个 surface;collab `history` 工具并入 `search`(kind 过滤) | 另案 |

### S3b 落地记录(2026-09-05:索引服务接进宿主)

S3 拆成三批跑:**S3a** 索引服务本体(`2579d480`)、**S3b** 接进宿主(本批)、**S3c** parity-B
与事件循环门。S3b 交的是「三个宿主真的在跑索引」这一件:

- **装配**(`backend/wiring/search/index.ts`):`createAppSearchService()` 起
  `SearchIndexService`,库 `<store>/index/search.v1.sqlite`(经 `getOnethingStorePath()`
  派生),接上**三条订阅**(`registerSessionLogEventAppendObserver` / 总线
  `session:renamed` / `session:deleted`),全部收在同一个 disposer 里。
  **与派工单的一处出入**:dispose 的次序是「先摘订阅、再停 Worker」而不是反过来 ——
  先停 Worker 会让还挂着的观察者往一只已经没有的 Worker 上发 `enqueue`,那是一条没人接的
  被拒 Promise。
- **三路换索引型**:`capabilities/{messages,sessions,daily}.ts` 改成 `indexedCapability`
  + 一路 `createSqliteLexicalRetriever`;自述里补齐 `schema` / `facets` / `ranking` /
  `budget.timeoutMs: 300`(S2 那个 `0` 是给全库扫的临时豁免)。旧扫描函数与 `legacy.ts`
  一字未删(S3c 的 parity-B 拿它当参照)。
- **Worker 路径解析选了「跟着宿主产物走」**(`import.meta.url` 旁边找
  `search-worker.cjs`),不是「三个宿主各传一次」:后者是一处按宿主枚举的地方,加第四个
  宿主要改装配层签名与三处调用点。三份产物实测都解析得到 —— 两份 esbuild 产物走
  `shellEsbuildOptions` 的 `import.meta.url` → `pathToFileURL(__filename)` 垫片,
  server 那份是 vite SSR 的 ESM、`import.meta.url` 原生。
- **server 的第二次 esbuild**:`apps/server/vite.config.ts` 钉着 `inlineDynamicImports`
  (顶层 await 会让拆出去的 chunk 回环卡死模块求值),rollup 不允许「多入口 + inline」,
  所以 `server:build` 变成 `scripts/build-server.mjs` 两段:vite SSR 出 `main.js`,
  再一次 esbuild(与另外两个宿主同一份配方)出 `search-worker.cjs`。
- **判据分家**:`search:parity-A` 收成 `files` / `actions` / `prompts` 三档 + `all` 档里
  这三组 —— 换索引那三路与旧扫描**不该**逐字同(旧扫描是子串、索引是词与前缀),拿
  「逐字同」卡它们等于禁止 S3 发生;它们由 S3c 的 parity-B 按 ⊇ 判。

**读数**(2026-09-05,MacBook,隔离临时 store):

| 项 | 读数 |
| --- | --- |
| `gate:search-index`(真 `dist/server` + 假 provider) | 四条全绿;`status.mode = owner` |
| 用户消息落盘 → 可搜 | **81ms** / 135ms(两趟) |
| 助手回答 `run/end` → 可搜 | **109ms** / 228ms |
| 会话标题(chats 档)命中 | **4ms** |
| 三份 `search-worker.cjs` | 159KB(desktop / cli / server 同一份配方) |
| `search:parity-A`(135/483 会话 160MiB,200 查询 × 4 档) | 800 次对账逐字节相同,**76.7s** |
| 单测 | runtime/search + backend/rpc + wiring/search 60 文件 **509** 例绿 |

**留账**(S3c / S4 前要拍的):

1. ~~**空词不再答**~~(**S3b 补已修**):messages 仍是「有词才答」(索引对零词元零命中),
   但 chats 的空词**绕开索引**、逐字调旧 `searchChats` 答「最近几间会话」,命令面板的空态
   与旧壳一致;daily 照旧路 `all` 档的 `includeDaily`,空词整组不出现。这一格是过渡 ——
   「最近会话」该是它自己的 static 能力,见 §13。
2. ~~**daily 换索引丢了两件**~~(**S3b 补已修**):「今天那一条」由
   `resolveDailyTodayShortcut`(从旧扫描器循环体里原样抽出的同一份代码)补回,新旧两条路
   调的是它;位置照旧扫描器那只 `sort`——「新建」排最后、「打开今天」排最前,并按
   `filePath` 与索引答的那一份去重。按文件名日期匹配也仍然成立:`title` 是文件名主干,
   索引与查询走同一只 `compositeAnalyzer`,`2026-09-05` 切成 `2026` `09` `05`,所以
   `2026-09-05` 与 `09-05` 都命中(用例 `search/index/__tests__/daily-feed.test.ts`)。
   换来的是**正文可搜**。且 `DailyNotesFeed.keys()` 不递归,只认笔记根目录那一层。
3. ~~`messages` 的 `ranking.pinFieldHit: 'title'` 今天**永不触发**~~(**S3b 补已删这一格**):
   拍点乙 a 定的消息字段是正文 / 附件名 / 推理,没有 `title`,自述里留一句永不触发的话就是
   一句假话。§6.5 的原文暗示消息文档该带会话标题(那样副标题与置顶两件事一起成立),
   要那样先给投影器加字段,不是先在自述里声明。`chats` / `daily` 的 `pinFieldHit` 照留
   (它们真有 `title` 字段),用例钉死「声明了就必须在 `schema` 里」。
4. 副标题(消息的会话名、会话的预览文)不在文档里,从会话列表取,**带 1 秒有效期**的小表
   (`capabilities/indexed.ts`)。
5. 索引代次是**上一次查询时**的值(`trackIndexGeneration`)—— 真代次在另一条线程上,只能
   跟着回答捎回来,所以游标失效差一拍。
6. `gate:packaged` 新加的三条断言(`status.mode = owner` / `pending` 归零 / 刚发的消息搜
   得到)与 `asarUnpack: search-worker.cjs` 这一行,**本批没跑过** —— 起 .app 要人手点钥匙串。
7. 一个 store 两个 core 的索引持有权(§5.6)仍未做,`status.mode` 恒 `'owner'` / `'error'`。

#### S3b 第二轮(同日):两处白做工与过召回

1. **流式期间整会话反复重折**(白做工)。观察者对**每条**追加事件都 `touch(sessionId)`,
   而增量是整键重折 —— `assistant/chunks` 每 16ms 一批,一轮回复期间同一条会话被重读重折
   几十遍,折出来的文档逐字相同。治法是 §5.2 那句新加的话:判据 `affectsIndexedDocuments`
   **住投影器**,装配层的观察者与 `LedgerFeed` 的目录监视只读它(目录监视多一道尾读:从
   上次判过的 seq 起把新记录解出来问一句;账本没了 / 第一次见这把钥匙 / 账本没长
   (= meta 动了)/ 尾读窗口够不到,四种「问不出来」一律照喊)。读数是新加的
   `status().refolds`(真正折过几次,指纹没变的提前返回不算)。**与派工单的一处出入**:
   `session/compacted` 判 `true` 不判 `false` —— reducer 的这一支把那条占位消息 `hidden`
   掉,而占位那条已经建过文档,判 `false` 就是「屏幕上没有了、搜索里还搜得到」
   (`projector.test.ts` 里有折前折后的读数为证)。
2. **一个查询词摊成多词元时严格档变成 OR**(过召回)。见 §6.2 那张 `multiTokenTerms` 表与
   §13 的读数。翻译一处改完,`MemoryIndex` / `SqliteIndex` 一字未动,契约用例加同一组三档
   读数两边各跑一遍。

**第二轮读数**(同机同临时 store):`gate:search-index` 四条全绿,用户那句
**131 / 134 / 142ms**、助手那段 **107 / 114 / 123ms**(第一轮 81 / 135 与 109 / 228,未劣化);
`vitest` core/search + runtime/search + wiring/search + backend/rpc **69 文件 669 例**绿;
黄金查询严格档命中数合计 947 → 109,期望键一条没丢。

### S3c 落地记录(2026-09-05:两道门收口 S3)

交两件:对账门 `search:parity-B`,与 `gate:search-index` 从四条扩到七条。

#### parity-B:⊇ 成立,差集全部说得出理由

`bun run search:parity-B`(脚本跑在 bun 下答**旧扫描**,`spawn('node', ['dist/server/main.js'])`
答**索引** —— bun 没有 `node:sqlite`,而旧扫描要 TS 源码 + `?raw`,node 起不来;两条进程
不同时活着)。真库副本 135/483 间 / 160 MiB,查询集 = parity-A 那份生成法(同种子)去掉
`/` `>` 两类 + 13 条日期形,共 **183 条 × 3 档**,两侧 `limit` 都放到 500:

| 档 | 查询 | 旧命中 | 新命中 | ⊇ 成立 | 中段子串 | 脱敏吃掉 | 需放宽 | 截断跳过 | **红** | 归档(仅新) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| messages | 183 | 606 | 16751 | 172 | 11 | 2 | 0 | 7 | **0** | 4110 |
| chats | 183 | 74 | 198 | 183 | 0 | 0 | 0 | 0 | **0** | 14 |
| daily | 183 | 0 | 0 | 183 | 0 | 0 | 0 | 0 | **0** | 0 |

两趟读数逐字相同。三件要说清楚的:

1. **「脱敏吃掉」是这一批新添的一类差集**,不是原来 §13 预见到的两类之一 —— 它是真机跑出来的
   两条红,查了才知道:索引看得见的从来不是原文,是 `redactionFilter` 洗过的那一份(§5.2c),
   而 `redactText` 会把长标识符整段换成 `<redacted:token>`。实测
   `parseInt(elcc_bot_res_signal_buttonOnly_buttonNumber, 10)` → `parseInt(<redacted:token>, 10)`、
   `translatesAutoresizingMaskIntoConstraints = false` → `<redacted:token> = false`,于是查
   `Only` / `into` 旧扫描命中、索引结构上不可能命中。**这是设计定的语义,不是漏**,已进 §13。
   门的分类因此改成「拿洗过的那份文本问分析器」,三类一次判完(`classifyMissing`)。
2. **`daily` 两侧都是 0 条,⊇ 在这一档是平凡真** —— 这台机器上
   `resolveDailyNoteSearchDirs()` 答 `[]`(设置里 `useObsidianConfig: true`,但解不出目录),
   新旧两条路都没有笔记可搜。门会把这一行打出来,不装成守住了。
3. **截断的 7 条不进判据**:旧 `searchMessages` 攒够 limit 整体 break(按会话表次序),
   索引按分排序后切页 —— 同一个 500 切在不同位置,比的就成了「谁被截断」。

#### 顺手修的一个索引 bug:`status().pending` 在 flush 期间说谎

`flush()` 第一句是 `pending.clear()`,所以从出队到折完那一整段 `status()` 答 `pending: 0`,
`stale`(= `pending > 0 || building`)于是在索引**还在追账本**时说「追上了」。parity-B 就是被它
咬到的:等 `stale === false` 之后开始对账,跑到一半同一条查询多答出两条。`drain()` 早就认得
这一形(它的三个条件里有 `flushing !== undefined`),错的只是 `status()` 少问一句。修法是
`worker-core.ts` 加一格 `inFlight`,`pending = pending.size + inFlight.size`;用例
`worker-core.test.ts`「status().pending 把正在折的那一批算进去」(拿一把 `documentsOf` 会卡住的
feed 造现场),**反证**:把 `pending` 改回只数队列 → 该例红(`condition not met within 2000ms`)。

#### 契约只加一格:`search.status.docs`

修完 `pending` 之后 parity-B 仍然红 —— 第二次试错:改盯**一枚探针词的 `total`** 涨停,而探针词
一旦集中在早早折完的那几间会话里,它的 `total` 会在整份索引才折了一小半时就不动了。两次都是同一个
错:拿**局部**的量去判**整体**建完没有。所以给 `SearchStatusResponse` 加一格 `docs?: number`
(索引里现在有多少份文档,单调;问不出来时缺席)。这是**只加不改**,而且不是为门而生的格子 ——
壳的「索引更新中」那行要说「已收录 N 条」用的也是它。`search:parity-B` 与 `gate:search-index`
的等待判据统一成「`docs` 涨停 ∧ `pending === 0`,连着五拍」。

#### gate:search-index 扩到七条

新的 ⑤⑥⑦(①–④ 一字未动),两趟全绿:

- **⑤ 事件循环延迟**。量法是**第三条路**:`node --require scripts/lib/gate-loop-probe.cjs`
  预加载一只真的 `monitorEventLoopDelay`,门发 `SIGUSR2` 让它把直方图落盘再 reset。派工单给的
  两条各自的下场:(a) 在 `search.status` 上加 `loopDelay` = 契约里长出只有门会读的格子;
  (b) `--inspect` + CDP **实测走不通** —— `Runtime.evaluate` 的上下文里没有 `require`,
  `await import('node:perf_hooks')` 当场抛 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`。预加载
  这条路量的是真的 `monitorEventLoopDelay`,而产品代码一个字没动。
  **`resolution: 1` 不是 10**:同一台机器上一条完全空闲的事件循环,`resolution: 10` 读出来
  p50 **12.03** / p99 **12.06ms**,5 读 6.28 / 6.42,1 读 **1.27 / 1.33** —— 10 的底噪就已经越过了
  §5.3 给增量段定的 5ms 线。一次 200ms 的同步阻塞在 1 这档如实读成 `max 201.2ms`。
  现场是种出来的 300 间 × 30 条(含 10 条 > 64KB 的**内联**正文 —— 64KB 那条线管的是工具结果与
  附件,普通消息正文再长也直接写进事件行,而工具结果按拍点乙 a 根本不进索引,让它走 blob 是空转)。
  两趟读数:

  | 窗口 | p50 | p99 | max | 采样 | 判据 |
  | --- | --- | --- | --- | --- | --- |
  | ⑤a 冷建全程(9300 份文档) | 1.32 / 1.27 | **3.35 / 1.36** | 50.7 / 23.7 | 8586 / 5245 | < 20ms ✅ |
  | ⑤b 20 个真回合 | 1.34 / 1.27 | **9.86 / 5.61** | 67.8 / 38.9 | 2344 / 2615 | < 20ms ✅ |
  | ⑤c 只有折(60 键整键重折,每 5 条一条 70KB) | 1.27 / 1.27 | **3.02 / 1.83** | 52.3 / 17.3 | 42623 / 38258 | < 5ms ✅ |

  **⑤b 的线是 20ms 不是 5ms,理由是量出来的**:把索引整个关掉跑同一段(`ONETHING_SEARCH_WORKER`
  指到一个存在但不是 Worker 的文件 → 起两次都崩 → `mode: 'error'`、`docs: 0`),20 条消息的窗口读
  **p50 1.281 / p99 7.377 / max 27.4ms**;带索引是 **p50 1.270 / p99 5.9 / max 49.4**。**索引关掉
  反而更高** —— 这个窗口的地板是「20 个真回合」本身(HTTP、引擎、SSE、会话落盘),拿 5ms 卡它
  卡的是引擎不是索引。§5.3 那条 5ms 线因此搬去 ⑤c:那个窗口里除了折没有别的事,折一搬回主线程必红。
  另加 **⑤d 结构判据**(grep):`packages/backend/**` 与 `runtime/src/search/{service.ts,capabilities/**}`
  零 `node:sqlite` import —— 主线程碰不到 sqlite 是结构保证的,不是这次读数运气好。
- **⑥ 改名 / 归档 / 删除**(走 `sessions.rename` / `.updateArchived` / `.delete` 的真写面):
  改名后按新标题命中 **878 / 943ms**、旧标题不再命中;**归档后仍然搜得到且结果带 `archived`
  facet**(拍点丙 a 的可感知变化,旧 `searchChats` 是直接跳过)**945 / 968ms**;删除后 messages
  **631 / 644ms**、chats **1 / 2ms** 都不再命中。
- **⑦ 另一个进程写的账本**:门起一个 `node` 子进程往会话账本尾巴上追加一条 `user/message`,
  **5 / 634ms** 内搜得到(走的是目录监视那条路,不是进程内的 append 观察者)。

#### S3c 留账

1. **一次改一大批会话时,目录监视要等到 30 秒兜底扫描才看见**。⑤c 第一版用子进程批量追加 40 间
   会话,读数是「等折开始 **32964ms**,折本身 **55ms**」—— `fs.watch` 那条快路在一次 40 间目录的
   突发下没命中,落到了 `LedgerFeed` 每 30s 一轮的 mtime 兜底扫描。§5.6 说的是「~1s」,单间改动
   (⑦)实测也确实是 5–634ms,**只有突发这一形是 30 秒**。⑤c 因此改走进程内观察者
   (`sessions.addSystemMessage`),那条路毫秒级。这条延迟本身没修 —— 它只影响「另一个进程刚写完
   一大批」这一形,今天没有产品路径会这么写。
2. `daily` 档在 parity-B 里是平凡真(见上),要真守住它得先有一台配好日记目录的机器。
3. ⑤b 的 5ms → 20ms 是**读数支撑的改判**,不是放水;§5.3 原文那句「增量折期间 < 5ms」现在由
   ⑤c 守着,措辞该跟着改成「折的窗口里」——**未改正文,留给下一批**。

### S4b 落地记录(2026-09-05:壳收进一条数据路)

S4 拆成两批:**S4a** 目标 / 预览渲染注册表与四条口,**S4b** 壳这一侧的四个产地收进唯一那条
`search.query`(会话表 / 章节缓存 / `files.list` / 正文检索四路全删,`sources.ts` 随之删除,
`no-capability-literals` 那道闸从「骨架」收紧到整个 `src/search`)。

交卷时如实记了三条**可感知的行为变化**;其中两条是「本该保旧行为」的,已修:

| # | 出入 | 处置 |
| --- | --- | --- |
| 1 | 会话**预览文本**与**章节**不再可搜;命中从子串变成词与前缀 | **保留**(索引的语义,§2 拍定;要让章节可搜是给 chats 补一条 feed,后端另一批) |
| 2 | 空词的浏览态从默认档搬到了「会话」档(要先切档才能翻完全部会话) | **已修**:壳在零词元时改问自述里 `browse: true` 的那些能力(§9),断言搬回默认档,门里一档不切 |
| 3 | 文件档的根从壳 `useSessionCwd()` 变成后端 `getSearchDirs()`,会话目录下的文件搜不到(门里靠一句 `sessions.switch` 补偿) | **已修**:`files` 自述一格 `dir`,壳把 cwd 结构地递回去(§9);门里那句补偿删掉,改断言「会话 cwd 下种的文件在 files 档搜得到」 |

两处修法的共同判据:**不新增枚举点**。「空词问谁」与「扫描根是什么」都做成能力自述里的一格
(`browse` / `facets: [{ key: 'dir' }]`),壳读表 —— 所以壳里仍然一个能力 id 都没有,
而再来一个自报 `browse` 的能力,空词那一屏自己多一组(用例与 `gate:search` 各钉一条)。

### S5 落地记录(2026-09-05:退役旧扫描路)

一句话:**删的是「第二条路」,不是能力的实现。** 今天能搜到什么、看到什么一个字没变;
删完之后仓里只剩一条查询路 —— `search` RPC 域 → 进程单槽里的 `SearchService` → 注册表
→ 能力。

#### 删了什么(净删,行数按删前计)

| 删的 | 行数 | 它是什么 |
| --- | --- | --- |
| `runtime/src/search/search-runtime.ts` | 64 | `executeOnethingSearch` + `switch(category)` + `all` 档那张写死的配额 / 次序表 |
| `runtime/src/search/ipc-operations.ts` | 44 | `ONETHING_SEARCH_CATEGORIES` / `isOnethingSearchCategory` / `normalizeOnethingSearchCategory` / `executeOnethingSearchForIpc` |
| `runtime/src/search/protocol.ts` | 12 | 上面那张清单给契约层的转发口 |
| `runtime/src/search/providers.ts` 里的六个扫描器 + `executeSearch` + 两个入口门面 | 936 → **125** | 旧路的实现;`searchChats` / `searchMessages` / `searchDailyNotes` 三个整删,另三个搬家(见下) |
| `@shared/ipc/search.ts` 的 `SEARCH_CATEGORIES` / `isSearchCategory` 两条再导出(+ `shared/ipc/index.ts` 的转发 + `shared/ipc/__tests__/search.test.ts`) | 17 | 契约层转发的那张常量表 —— S2 起零生产消费者 |
| `backend/wiring/search/providers.ts` 的 `executeSearch` + `plugin-search-registry.ts` 的 `appendPluginSearchResults`(零消费者) | 门面 36 → **31**(整文件) | 旧路的装配层门面与它的插件并入口(插件走 `syncPluginSearchCapabilities` 那条真路) |
| `backend/server/runtime.ts` 的 `createSearchProvidersForContext` | 4 | 只为了拿 `createDailyNote` 而绕的那个门面;改成直接把 per-owner 取材面递给 `createDailyNote` |
| `scripts/search-parity-a.mjs`(418)/ `search-parity-b.mjs`(720)+ `package.json` 两条脚本 | 1138 | 见下「两道门为什么退役」 |
| 旧路的三个单测(`search-runtime` / `ipc-operations` / `providers`) | 327 | 被测对象没了 |

#### 留了什么,为什么

- **`iterateSessionMessages` 端口留着**。派工单原文要删它,但它今天有一个真消费者:
  S4a 的消息预览要读命中那条**前后各两条**(`capabilities/messages.ts` 的
  `messageContextPreview`)。它不是旧扫描路的遗物 —— 旧路用它做全库子串扫,那件事没了;
  预览那件事还在。注释已改成事实。
- **`server/search-providers.ts` 单槽留着**。`rpc/domains/search.ts` 的**不可信**那一支
  (独立部署的 server)照旧问它;它不是为旧路存在的,而是为「per-owner 沙箱里的同一件事」
  存在的。注释里两处「桌面走 `executeSearch`」改成了事实。
- **`actions` / `prompts` / `files` 三条的匹配器留着** —— 它们是**能力的实现**,不是第二条路。
  但从 `providers.ts` 那个 936 行的大文件搬进了各自的 `capabilities/<id>.ts`:
  一类 = 一个文件。每日笔记的配置、「今天那一条」与 `createDailyNote` 同理搬进
  `capabilities/daily-notes.ts`;`legacy.ts` 只剩「把一只
  `(query, limit, filters) => SearchResult[]` 包成基座」这一件事,改名 `scan-adapter.ts`
  (`legacyScanCapability` → `scanBackedCapability`、`LegacyBackedCandidate.legacy` →
  `ResultBackedCandidate.result`),文件头那段「S2 过渡件」的措辞改成事实:名字说它做的事,
  不说它的来历。三处共用的四件纯函数(查询归一化 / 子串打分 / 高亮区间 / `~` 展开)进
  `capabilities/text-match.ts` —— S5 之前 `normalizeQuery` 与 `normalizeOnethingSearchQuery`
  是**逐字相同的两份**,现在只有一份。

#### 「最近会话」不再借旧函数

`chats` 空词那一支(自述 `browse: true`)S3b 起是「绕开索引、逐字调旧 `searchChats('')`」。
S5 把它换成 `capabilities/sessions.ts` 自己的纯函数 `recentSessions`:去掉归档的 → 按
`updatedAt` 降序 → 切前 N 间 → 投影。这**就是**旧函数在空词下走过的路 —— 空查询时
`scoreText` 恒答 1,于是「按分排序」整段退化成 `updatedAt` 降序、`matchRanges` 恒缺席。
把退化形直接写出来,比留一只只在空词下才被调到的打分器诚实。

**证词是一份录音**:删旧函数**之前**,拿一张五间会话的夹具(含一间归档、一间无名、一间
中文标题)跑 `searchChats` 的 `('' | '   ' | '/' | '>') × (2 | 20)` 八种入参,把返回值原样
录成 `runtime/src/search/__tests__/__fixtures__/chats-browse.json`;新用例
`chats-browse.test.ts`(10 例)拿它逐条比,而且是**走能力那一层**问的(中间还隔着
`supports` 的空词判据、扫描基座的现造与投影)。派工单说的「把参照从旧函数换成固定快照」
就是这一份。

#### 两道对账门为什么退役,换成了什么

`search:parity-A`(S2)与 `search:parity-B`(S3c)的参照物都是那条旧扫描路。路删了,
参照物就没了 —— 一道拿不到参照物的门不是「还能跑的门」,是一句谎。所以它们连同
1138 行脚本一起退役。

它们守过的东西换成 `runtime/src/search/__tests__/golden-snapshot.test.ts`:S0 那份冻在仓里的
2473 份真语料灌进真 `SqliteIndex`,把 **20 条黄金查询 + 20 条黄金复述句**在**严格档**
(阶梯 ①:全 AND + 短语相邻)下的命中集录成 `__fixtures__/golden-hit-sets.json`
(7.4 KB,40 条,`{ total, keys }`,`keys` **排过序**)。三条判据:

- **判集合不判名次** —— 与 parity-B 的 ⊇ 口径同源:改字段权重只动次序不动召回,不该让
  回归网变红(§11 记过这条);召回变了一定是一件要解释的事。
- **复述集那 20 条也钉**:它们是 S7 给向量路出的卷子,词法严格档下今天 **0/20 命中**
  (与 S7 交卷读数逐字同)。钉住它,是为了让「向量路捞回来的到底是不是词法捞不到的」
  这句话有底片。
- 再问一句**独立于快照**的话:黄金表自己声明的期望键,严格档下只许差
  `corpus.test.ts` 里逐条解释过的那两条(`elcc_holiday_tranfer` 整词不在文档里、
  `ＦＡＣ 888` 是中段子串)。快照录错了,这一条会红。

重录口令 `ONETHING_SEARCH_GOLDEN_UPDATE=1`,**改它要在报告里写明理由** —— 它变了就是
「同一句话能搜到什么」变了。

#### 边界检查器换了守的方向

`checkRuntimeOwnsSearchIpcOperations` 守的是「旧路的编排别从 runtime 漏进装配层 / 契约层」,
它列的必需符号里有 `executeOnethingSearch` / `ONETHING_SEARCH_CATEGORIES` /
`createOnethingSearchProviders` / `searchDailyNotes` 这些**今天必须不存在**的名字 —— 原样留着
就是一道要求旧路活着的门。改写成 `checkSearchHasOneQueryPath`,三条判据:

1. 旧路的**形状与名字**(`switch(category)`、那张类别清单、三个已删扫描器的函数名、
   `parseDateFromPath`)在 `runtime/src/search` / `backend/wiring/search` /
   `backend/rpc/domains` / `@shared/ipc/search.ts` 里**一处都不许有**(只看代码行,注释随便写),
   那三个模块与两个 parity 脚本**存在即红**;
2. **契约层不许 import runtime**(`@shared/ipc/search.ts`):「能搜什么」由
   `search.capabilities` 那条路由答,不由一张转发过来的常量表答;
3. 装配层取材面门面 ≤ 40 行、十个能力文件一个都不许少(一类 = 一个文件)。

`checkCoreSearchNamesNoCapability` 一字未动。

#### 门与反证

| 门 | 读数 |
| --- | --- |
| `typecheck`(node + desktop) | 零 |
| `boundary:gate` | 0 failures;新规则 `search has exactly one query path` ok |
| `transport:gate` / `assembly:gate` / `log:gate` / `session:gate` | 四闸绿(assembly 99 / 63 文件不变;log 4;session 0) |
| vitest(core/search + runtime/search + runtime/toolkit + backend wiring/search · wiring/toolkit · rpc · server + cli) | **117 文件 1256 例**绿 |
| `eslint`(改动面) | 0 error(0 新增 warning;`headless-boundary-check.ts` 78 → 77) |
| `gate:search-index` | 八条绿(⑤ 冷建 p99 1.299ms / 增量 5.796ms / 只折 1.705ms;⑧ 语义 ready 318ms) |
| `gate:search`(离屏) | 绿 —— **空词浏览态**:默认档 20 行 → 翻页 25 行 → 「25 results · all shown」,一档没切 |
| `gate:search-messages`(离屏) | 绿 —— 八步全过 |
| 顺手一条纪律 | `gate-search.mjs` 也改成**离屏起**(`ONETHING_GATE_HEADLESS: '1'`,09-04 判例「真机门不许抢用户前台」);`gate-search-messages` 早就是了,这一道漏了。隐藏窗照样渲染与布局,门里那几发几何量测与截图读数一格没变 |
| 壳单测 `apps/desktop-react src/search` | 9 文件 188 例绿 |
| 净变化 | 46 文件 +2155 / **−2899** |

**反证**(逐条真跑过):

- 把 `golden-hit-sets.json` 里 `golden:私发` 的一个键改一字
  (`…37759a884977` → `…978`)→ 快照那一例红(`AssertionError: expected { …(40) } to
  deeply equal { …(40) }`,另外三例照绿 —— 独立那条判据不吃快照);
- 把 `chats` 空词那一支改成走索引(摘掉 `asksForRecentSessions` 那条 `search` 分叉)→
  `chats-browse.test.ts` + `capabilities.test.ts` 合计 **12 例红**;真机 `gate:search` 第 4 步
  红:`超时等待「浏览态第一页画出来」`,处境读数 `{rows: 0, more: null, empty: "No results"}`。
  **施工时踩过一次**:第一趟只重跑 `app:build` 就去跑门,门照绿 —— 这道门第 2 步自己
  `spawn('node', ['dist/server/main.js'])` 起一台 core,壳是**附着**上去的,所以答查询的是
  `dist/server` 那一份;要证伪必须先 `bun run server:build`。这一条记下来,下次别再被它骗;
- 把 `search-runtime.ts` 放回去 → `boundary` 的新规则红。

#### 留账

- **「最近几间会话」仍然挂在 `chats` 的自述下**(S3b 那条留账只做了一半)。S5 只做了
  「不再借旧函数」;把它抽成一条自己的 static 能力(自己的 manifest / 配额 / 次序 / 图标)
  仍未做 —— 那是一次**用户可感知**的改动(命令面板空态会多一组、次序会变),按判例得先问。
  今天的形状对这件事是友好的:`recentSessions` 已经是一只不吃索引的纯函数。
- **「新建今天的日记」那条快捷行的归属**照旧待定(见 §13),`resolveDailyTodayShortcut`
  只是换了个家。
- 真机门里**没有**一条断言日记快捷行 —— 它今天由 `capabilities.test.ts` 的三条用例守
  (不存在时排最后 / 存在时排最前并去重 / 与今天对不上时一条不多给)。要真机守它得先有一台
  配好日记目录的机器(§13 里 S3c 记过同一件事)。
- `runtime/src/search/index.ts` 这个桶现在只剩四行导出;`providers.ts` 只剩接口 + 单槽。
  下一次动这一片时可以考虑把 `configureOnethingSearchProviders` 那个进程单槽也收掉 ——
  它今天只服务两个不带参数的口(`resolveDailyNoteSearchDirs()` / `createDailyNote()`),
  两个口都能改成必须递取材面,那样 runtime 的检索这一片就零模块级状态。本批没做:
  改签名会碰到 `backend.ts` 的装配序,超出「删第二条路」的范围。

---

S1 与 S0 并行;S2 依赖 S1;S3 依赖 S0 + S2;S4 依赖 S3;S5 依赖 S4;S6 依赖 S3(要索引才有意义,壳无关);S7 依赖 S3;S6 与 S7 可并行。S1 / S2 / S3 / S6 / S7 各是一张 opus 派工单,附本文对应节 + 三张状态表要求。

---

## 11. 反证(每期拆掉即红)

- **设计层的反证(每版设计交卷前)**:陌生能力演练(§4.2b)+ 七轴发散演练(§4.4)。用一个设计时没想过的能力走一遍「要改哪些文件」;答案不是「能力模块 + 壳渲染模块 + 两行注册」就打回。本文 v2 第一稿没做这一步,被用户用 symbol 一问就露了 feed 与 Target 两个枚举点——这就是立这条的起因。

- S1:拆 `PhraseVerifier` → 「身份 … 牌」假阳性红;拆 NFKC → 全角红;拆前缀上限 → `a` 展开红;改 cursor 不带 queryHash → 索引变后翻页错位红。
- S2:任一能力从注册表摘掉 → parity-A 该类红 + `capabilities` 路由少一项红;`budgetPolicy` 改回常量 → 「command 意图 actions 8 条」用例红。
- S3:观察者不 enqueue → 「发一条消息立刻可搜」真机红;`run/end` 前建文档 → 「流式中不出半条」红;折坏不隔离 → 「一会话坏其它照搜」红;检查点不比 `metaRev` → 改名后标题搜不到红。
- S3(v3.1 补):索引服务改回主线程 → 事件循环门红;授权改回结果过滤 → 「滤后 total 为真数」用例红;摘掉目录监视 → 「另一个进程写的消息搜得到」红;`Doc.capability` 改回字面量联合 → `checkCoreSearchNamesNoCapability` 红。(持有权那两条反证随 §5.6 缓议。)
- S4:tab 写死 → 注销一个能力 tab 仍在红;`total` 缺席时画「加载更多」→ 红。
- S6(**已跑,读数在 §14.5**):工具无视 `ctx.principal`(改成恒 user)→ **8 例红**,其中就有「agent 搜到别的空间」;`visibleIn` 那一条**换了写法** —— 它本来就该恒真(越权不靠场景门,靠 messages 的 agent 支),所以反证改成「messages 摘掉 agent 支」→ **7 例红**,含「协作房里 `search` 与 `history` 并存时,不是成员的房被排掉」那一条;工具 import backend → `architecture-boundaries` 红(**不是** `boundary:gate`:那道门不查 runtime→backend 这条边,查它的是 `packages/core/__tests__/architecture-boundaries.test.ts`)。
- S7(**四条都真跑过,读数在括号里**):
  - 词法路碰了一字 → parity-B 红。演示用的是「把 messages 的 `relax` 关掉」(**27 红**,
    如 `holidayAfterhour` 旧 31 条 / 新 0 条)。**注意**:改字段权重**不红** —— parity-B
    判的是命中**集**的 ⊇,权重只动次序;要红就得动「哪些文档算命中」。
  - 扩展只在 Node 下装载(临时把 Electron 那一列跳过)→ `gate:native` **1 红**,
    行 `sqlite-vec-darwin-arm64` / `electron FAIL`。
  - 模型 id 变了不重嵌(把复述集用例里那次重嵌摘掉)→ 「换模型」那一条 **红**
    (`expected false to be true`)。
  - 授权改回「先 KNN 拿 k 条、回来再筛」→ 复述集 ③ **红**(`expected 1 to be 3`)——
    范围外的候选把名额占掉了,这正是 §6.4b 那条法在向量路上的落点。
  - **「嵌入搬主线程 → 事件循环门红」这条没法照原样跑**:`gate:search-index` ⑤ 那三个
    窗口跑的是**开关关着**的默认档,压根没有嵌入。换成一条**结构判据**(⑤d 第二条):
    `packages/backend/**`、`packages/core/**`、主线程侧的检索代码与壳的 electron 目录里
    零 `@huggingface/transformers` import —— 把它 import 到主线程当场红。

---

## 12. 拆掉的旧裁定

| 旧 | 出处 | 当时理由 | 今天 |
| --- | --- | --- | --- |
| 「跨会话搜索 / 索引归 apps/server,不进 Electron 主进程」 | CLAUDE.md | 07-04 弃 sqlite 后怕主进程再长回一个库 | 索引是账本的投影、纯 TS、可丢可重放;「一个 core」之后主进程就是 core |
| 「中文子串匹配几乎必空——但不要上分词」 | collab-history-search.md §5.1 | 小语料 OR 过召回 | 二元 + AND 优先 + 短语核验 |
| 归档跳过 / 剥 `>` `/` / `all` 配额常量 / `SearchCategory` 字面量 | providers.ts, search-runtime.ts, shared/ipc | 无记录 | 拍点丙 / 意图路由 / `budgetPolicy` / registry |
| **旧扫描路本身**(`search-runtime.ts` / `ipc-operations.ts` / `providers.ts` 三件 + 契约层那两条再导出 + `search:parity-A` / `search:parity-B` 两道门) | 同上 | S2 / S3 期间它是新路的**参照物**:「行为零变化」这句话得有个东西可比 | **S5(2026-09-05)删**。三条索引型能力早已不经它,三条静态 / 扫描型能力的匹配器搬回各自的 `capabilities/<id>.ts`;参照物没了,两道对账门也就不是「还能跑的门」而是一句谎,退役并换成严格档命中集快照 |

`onething.sqlite`(260MB,06-30 起未动)是遗物,另案清。

---

## 13. 留账

- 归档今天没有总线事件,拍点甲 b 下靠 `metaRev` + 目录监视兜住(~1s);若将来要毫秒级,给归档写口补一条总线事件是一处改动,不进账本。
- 跨类混排若将来要做:每路给 0–1 置信度 + 类别先验,在 `merge` 换一个实现即可,骨架不动。
- 读者模式(§5.6)下自己写的消息要等写者的目录监视,延迟 ~1s;壳在 `status.mode === 'reader'` 时「索引更新中」那行改画「由 <host> 维护」,不装成实时。
- Worker 崩两次即停(§5.3):停了之后 messages / sessions / daily 三路答 `{ error: 'index unavailable' }`,不回退到旧扫描(S5 已删,回退在结构上不可能了),壳照 §9 画「没搜成」。
- `@huggingface/transformers` 的 wasm 后端在 Electron Worker 与 Node Worker 里都跑,但**首次装载 ~300ms**,S7 的 Worker 在开关打开后才 import 它(动态 import,不进主 bundle 的关键路径)。
- 文件内容检索是 S8 的第一件:`scanCapability` 包 `rg --json`,cursor = 文件位置。
- **parity-B 的差集口径**(S3a 读数定的):旧扫描是子串匹配,索引是词与前缀,所以「查询是某个词元的**中段**」(`888` 打中 `00888`)旧路命中、索引永远不命中——那是 §2 拍定的语义,不是漏。parity-B 判 ⊇ 时允许**放宽到任一级**后再比,残差逐条打印并分类:能证明是「中段子串」的计入允许差,其余任何一条都红。**允许差就这一类**(S3c 一度有过第二类「被脱敏吃掉」,同批已删,见下条)。
- **`long-token` 误伤标识符已收窄,parity-B 不再有此类**(S3c 内的自我推翻)。真机第一版把「被脱敏吃掉」记成第三类允许差,那是**把误伤合法化**:被吃掉的两条 `translatesAutoresizingMaskIntoConstraints`(41 位)与 `elcc_bot_res_signal_buttonOnly_buttonNumber`(43 位)根本不是密钥,是正经标识符;它们的词元(`into` / `only` / `constraints` …)因此一个都没进倒排,用户搜 `Only`、`into` 就漏。**分开密钥与标识符的不是长度,是结构** —— 真密钥是无结构的随机串、几乎必含数字且数字散在串里;标识符是驼峰 / 蛇形拼起来的自然词。于是规则 7 加了 `accept` 谓词(`packages/core/search/redact.ts` 的 `isLikelySecretToken`,与规则 8 的 `isPublicIpv4` 同形,「洗」与「验」共用一个答案),**判据原文**:①按蛇形 + 驼峰拆开后**每一段都是 ≥ 3 位纯字母**的,放过(密钥拆不出这样的段);②否则,**至少含 3 个数字**的,洗;③否则,**含 `-` / `_` 且含数字**的,洗;④其余放过。刻意留的口子:纯字母、又拆不出词段的随机串(`aBcDeFgHiJ…`)会被放过 —— 方向是**少洗**,宁可漏洗一种今天没见过的形,也不再误伤正经标识符(多洗一个词就是倒排里少一个词)。读数:真语料重抽后 `<redacted:token>` 占位 278 → **162**(19 份文档,116 处标识符回到倒排),黄金表命中集一条没变(`corpus.test.ts` 的「恰好两条不中」逐字照旧);parity-B 重跑 **0 红**,`classifyMissing` 的 `'redacted'` 那一格与表上「脱敏吃掉」那一列一起删了 —— 再出现就是红。用例在 `scripts/__tests__/search-corpus-redact.test.mjs` 的「long-token 的取舍」一节(三条标识符放过 / 三条随机串照洗 / 同样 43 位一留一洗)。
- **一次改一大批会话时目录监视要等 30 秒**(S3c 读数):单间改动 ~0.5s 就折进去了(`gate:search-index` ⑦ 实测 5 / 634ms),但**一个子进程一次改 40 间**的突发下 `fs.watch` 那条快路没命中,落到 `LedgerFeed` 每 30s 一轮的 mtime 兜底扫描 —— 实测「等折开始 32964ms,折本身 55ms」。§5.6 写的「~1s」只对单间改动成立。今天没有产品路径会这么写(另一个 core 也是一条一条 append),所以没修。黄金表 20 条里恰好这两条(`elcc_holiday_tranfer` 差整词、`888` 中段)在严格档不中,用例钉死「恰好这两条」。整词那条 S3b 顺手看:前缀展开应也作用于 camel / snake 的整词词元。
- ~~**「严格档 = 全 AND」在「一个查询词分析成多个词元」那一形上实际是 OR**~~
  (**S3b 第二轮已修**,§6.2 那张 `multiTokenTerms` 表):①② 把这样一个词当一条短语,
  ③④ 才摊平。翻译一处改完,两个索引实现一字未动。真语料读数(20 条黄金查询,严格档命中
  数 旧 → 新):`身份牌` 42→5、`会话列表` 179→2、`屏幕使用时间` 289→7、
  `RedisMessageListenerConfig` 202→3、`PiiMaskingUtil` 27→8、`elcc_holiday_tranfer` 60→4,
  合计 947→109,**期望键一条没丢**(`corpus.test.ts` 的「恰好两条不中」逐字照旧)。
- **`elcc_holiday_tranfer` 那条期望键从此只在 ③ 回来**(S3b 第二轮留):它从前在生产的①里
  出现过,靠的正是上面那条 OR —— 语料里只有 `elcc_holiday_tranfer_audio`,查询的**整词**
  不在文档词表里,而当年 `min(1, 5) = 1` 让「命中 `elcc` 一个词元」就算数。收回过召回之后
  它诚实地落到 ③(`corpus.test.ts` 的放宽用例钉着)。真要让它回到 ①,治法就是本节上面那条
  「前缀展开应也作用于 camel / snake 的整词词元」—— 那要给 `LexicalPhrase.terms[]` 加
  `alternatives`,是两个索引实现的契约改动,自成一批。
- **bun 的运行时没有 `node:sqlite`**(实测 `No such built-in module`):vitest 走 node 所以用例是真的;任何起索引服务的门脚本必须用 node 或 Electron 起,不许 `bun xxx.mjs`。
- `SqliteIndex` 的 fts rowid = `docId*32 + 字段槽`,全库字段名上限 32(今天 4 个),超了当场抛。`search()` 先算全部命中再切页(`total` 要真数),真库量级要不要两段式留 S3b 真机读数定。
- **「最近几间会话」该是它自己的能力**(S3b 留;**S5 做了一半**):旧 `searchChats` 已随
  旧扫描路删掉,这一支改由 `capabilities/sessions.ts` 自己的纯函数 `recentSessions` 答
  (与旧函数逐字同,证词是删它之前录下的 `__tests__/__fixtures__/chats-browse.json`)。
  **没做的那一半**:它仍然借着 chats 的自述(配额 / 次序 / 图标)说另一件事。抽成一条
  自己的 static 能力会让命令面板的空态多一组、次序变一次 —— 那是用户可感知的改动,
  按判例得先问,所以没动。
- **「新建今天的日记」那条快捷行的归属**(S3b 留):它是一条**动作**不是一条笔记,
  今天由 daily 能力在 `search()` 里补进结果。将来要么归 `actions` 能力(它本来就是
  「动作」那一类),要么由 daily 自己声明一格 `actions?`(能力自述出「我这一类还能做什么」)。
  两条路都要先定契约。**S5 更正**:旧扫描器已删,但 `resolveDailyTodayShortcut` **没跟着删** ——
  它答的是「今天那个文件在不在」,索引在结构上答不出,所以它是 daily 这一类的实现而不是
  旧路的遗物;S5 只是把它连同每日笔记的配置一起搬进 `capabilities/daily-notes.ts`。
  归属这件事照旧待定。
- **S7 留账(一)——桌面打包档不带语义召回的运行时。已按拍点癸' 的 (c) 落地(09-05,
  编排者的保守缺省),三条路见 §0 拍点癸',待用户拍**。
  病是这样的:装 `@huggingface/transformers` 顺带装进 `onnxruntime-node` 212M /
  `onnxruntime-web` 92M / `@huggingface` 48M / `sharp` + `@img/*` 17M,全打进去
  `onething.app` 是 **565M**(09-05 实测)。而 `electron-builder.yml` 的 `files:` 里原有
  一句**早于 S7 的排除** `!node_modules/onnxruntime-web`(注释写的是「Electron 主进程
  用不着」)—— 于是 S7 交卷那一刻打包 app 里躺着的是 `onnxruntime-node`(用不上,因为
  嵌入器写死 `device: 'wasm'`)与 `onnxruntime-common`,**唯独缺了真正要用的 wasm 那
  一份**:多背两百多兆,还是跑不起来。
  **(c) 的落地**:那一句排除扩成六句(`@huggingface/transformers` / `onnxruntime-node` /
  `-web` / `-common` / `sharp` / `@img`),打包档 **565M → 309M**(同机同一份构建产物、
  只换这几行的两趟 `du -sh`;剩下的大头是 Electron Framework 自己的 260M)。
  **读数更正**:这条留账原来写的「S7 前 146M / S7 后 498M」这一趟**没能复现** ——
  Electron 41 的 Framework 单独就 260M,今天的 app 不可能是 146M;上面两个数是同一台机器、
  同一份 `apps/desktop-react/dist{,-electron}` 产物上量出来的,只有 `files:` 那几行不同。
  (c) 之后 S7 在打包档里的残留只剩 `sqlite-vec` 那几百 KB 与纯 JS 的
  `@huggingface/jinja` 十几个文件;六个被排除的包在 `app.asar` 的成员表里**一条都搜不到**
  (`asar list` 逐个 grep 计数全 0)。
  `sqlite-vec` 与它的平台子包**保留**(几百 KB 的纯 C 扩展,`gate:packaged` ④-c 的
  `vectorExtension === 'loadable'` 靠它)。**语义召回在 dev / server / CLI 上照旧是通的**
  (`gate:search-index` ⑧ 证),桌面打包档上则**优雅降级**:开关就算被打开,
  `import('@huggingface/transformers')` 抛 `ERR_MODULE_NOT_FOUND` →
  `VectorWriter.markOff` 把 `status.vector` 钉成 `'off'`、记**一条** `warn`(不是 `error`),
  词法路一个字不受影响。这条降级由 `search/embedding/__tests__/missing-runtime.test.ts`
  四例钉死(查询路 / 写路两个入口各证一遍、查一百次仍只有一条 warn、`'off'` 是吸收态)。
  施工时**顺手补了一个真漏**:`VectorWriter.embedQuery` 原来裸 `await this.ready()`,
  「开关开着 + 库已建好 + 没有新文档排队」那一形下第一条查询会把装载失败原样抛给调用方
  (而不是降级);现在它 catch → `markOff` → 答 `undefined`,且 `markOff` 改成幂等。
  用户拍 (a) 或 (b) 之后要动的就是那六行加 `asarUnpack`,以及把 `gate:packaged` ④-c 从
  「扩展可装载」升级成「真模型可装载」—— 别处一个字不用改(嵌入器是注册表里的一条)。
- **S7 待拍(二)——KNN 没有下限**。`k = 5` 答的永远是最近的五条,哪怕全都不相关(施工时
  在一间两条消息的 store 上量到:任何一句话都能把那两条召回)。机制留了
  `manifest.retrievers.vector.maxDistance`,**今天故意不定值** —— 阈值要拿真模型在真库上的
  读数定,而 e5 的余弦天生偏高、不相关的一对也常在 0.7 以上,凭空拍一个数会把该召回的切掉。
  今天的默认行为因此是「向量路把最近的几条无条件答回来」;它只在词法严格档零命中之后才
  加入(§15.4 的 `'relaxed'`),所以用户看到它时本来就在「没有字面命中」的处境里。
- **S7 待拍(三)——开关保存后不热生效**。`workerData` 在起 Worker 那一刻定死,改
  `search.semantic.enabled` 要下次起 core 才算数。热换要在装配层留一格可变状态去重启那条
  Worker,而 `assembly:gate` 正是立来禁这个的(它是**减少型**棘轮,新文件带 `let` 直接红)。
  治法有两条:把索引服务句柄挂到 `OnethingBackend` 的字段上并 `own()` 它(顺着组合根 A 的
  方向,那时 `stores/settings.ts` 可以经 `current.ts` 拿到它),或者给 Worker 加一条
  「换嵌入器」的消息(库不重开、只换 `VectorWriter`)。第二条便宜得多,但要先想清楚
  `vec_docs` 的维度换了怎么办(vec0 的维度写在建表语句里)。
- **S7:真模型冒烟没做成 —— 本机连不上 HuggingFace**。`huggingface.co` 的元数据是通的
  (`config.json` 答 307),但 `cdn-lfs.huggingface.co` **连不上**(curl 读数 `000`),
  `pipeline()` 在拉 tokenizer 时 `ECONNRESET`,两趟都一样。所以交卷用的是假嵌入器,
  **真模型的这几个数至今没有**:冷嵌一条消息多久、查询嵌入多久、复述集在真模型上中几条、
  110MB 下下来是几个文件。能证的只有半条:`import('@huggingface/transformers')` 本身
  **179ms**、版本 3.8.1、`env` 上 `cacheDir` / `localModelPath` / `allowLocalModels` /
  `remoteHost` 四格都在。**另外一件事实**:3.8.1 的 `env.backends.onnx.wasm` 上
  `Object.keys` 只见到 `wasmPaths` / `proxy`,**没有 `numThreads`** —— 嵌入器里那句
  「wasm 单线程」是尽力而为,不是保证。`wasmPaths` 这一格还提醒了上面待拍(一)的另一半:
  ORT-web 按**文件路径**读 `.wasm`,asar 里的路径不是真路径。
- **S7:设置页没有 UI**。`settings.search.semantic.{enabled,modelId}` 契约、默认值、归一化、
  装配读取全落了,**壳的设置页一格都没画**(那是壳线的活)。今天开它的办法是改
  `settings.json` 或走 `settings` 域的 RPC。
- **S7:切段是按字符边界回退,没有按 CJK 语义切**。`chunkForEmbedding` 找最近的换行 / 句号 /
  空格,回退超过一成就硬切。中文长段落里句号少的那种(代码块、日志)会切在词中间;真模型
  的读数出来之前不动它。
- **S7:`gate:search-index` ⑧ 判不了「走过 downloading」**。假嵌入器的 `ready()` 是空操作,
  两条消息一瞬间嵌完,150ms 的轮询抓不到中间态 —— 那会是一条只在慢机器上绿的断言。⑧ 改判
  「开关一路没有自己关回去」(模型装载失败那一支就是把它钉回 `'off'`)。真模型接上之后
  这一条可以升级。
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

落地时这一节有三处小出入(2026-09-05):

1. **末行只印发生过的那几格**。设计写的是「`total N · relaxed? · index pending?`」;实现里
   `relaxed` 与 `index pending` **为 0 时不印** —— 恒印一句 `relaxed 0` 是把常态说成一件
   需要注意的事。`total` 恒印。
2. **描述的第一句不枚举内容类型**。初稿写的是「past conversations, their titles, notes,
   files, and more」,而 `files` / `notes` 就是能力名 —— 那正是「工具源码里没有能力名」要挡的
   东西(写的时候没察觉,是新加的那条断言当场照出来的)。现在第一句只说「你能访问的一切」,
   类型清单只在 `Available kinds:` 那一行,由注册表生成。
3. **`limit` 超上限由契约挡在 `plan` 之前**,所以那次调用根本到不了适配器(`Outcome.kind`
   是 `invalid`,不是一次失败的搜索)。

### 14.3 装配(落地版)

`backend/wiring/search/index.ts` 在造完服务之后**装两个单槽**,两件都返回还原函数、
都收在 `createAppSearchService` 的同一个 disposer 里(还原次序与装配次序相反):

| 槽 | 装什么 | 住哪儿 |
| --- | --- | --- |
| `configureSearchToolAdapters` | `listKinds` / `search` / `preview` —— 工具的三件事 | 形在 `runtime/toolkit/builtin/search.ts`,实现 `backend/wiring/search/tool-adapters.ts` |
| `configureSearchVisibilityPort` | 「这个主体能看见哪几条会话」 | 形在 `runtime/search/capabilities/visibility.ts`,判据 `backend/wiring/search/visibility.ts` |

**与派工单的出入①:两个槽而不是一个。** 派工单写的是一次
`configureSearchToolAdapters({ …, visibilityPort })`。拆开的理由是**服务面不同**:
可见范围服务的是**能力的 manifest**(命令面板、CLI、将来任何消费面都走它),把它塞进
一个叫「工具适配器」的口里,名字就在说谎。两件仍然在同一行装配里装上、同一个 disposer
里落地,所以「生命周期一致」这件事一格没丢。

工具在 `full` / `headless` / `readonly` **三档目录**里各注册一行。`readonly` 也给 ——
那一档的判据是「对本机零副作用」(`effects: []`),不是「不读本机数据」(`read` 也在)。

**装配次序有一格是载荷承重的**:目录建在缝 4(`buildToolkitCatalog`),检索服务起在
缝 4.5(`createAppSearchService`)—— 目录建好的那一刻适配器**还没装**。所以工具的
`spec` 是一个 **getter**、描述里的 kind 清单每次现算;构造期抓一份就会永远印一张空清单。
这也顺带让「注销一个能力 → 描述少一项」成为一条真断言,而不是一句注释。

principal 从 `RunContext.invocation.principal` 来,`sessionId` 从 `invocation.sessionId`,
`spaceId` 从 `ctx.session?.metadata?.workspaceId`。**出入②:`metadata` 这一格此前没人填。**
`SessionSnapshot.metadata` 一直在类型上,但 `backend/wiring/toolkit/runner.ts` 的
`sessionSnapshotFor` 从来没写过它 —— 于是任何读它的工具拿到的都是 `undefined`,而那读起来
和「这条会话没有 space」一模一样。`search` 是第一个要问这件事的工具,所以那一行补上了
`workspaceId`(缺席仍是缺席:旧会话零迁移,读取端自己缺省成 default space)。

core 的 `Principal` 有 `system` 这一支而 `SearchPrincipal` 没有:**映射成 `agent`,不是
`user`** —— `systemPrincipal` 是最小权限的那一个,把它读成用户就是把兜底变成绕过。

### 14.3b 可见范围(拍点辛 a 的落地)

`messages` 与 `chats` **两份**自述都挂同一条规则 `sessionScopeVisibility`(派工单只点了
messages;chats 一起挂的理由是 `collab/visibility.ts` 的原话:一间看不见的房,不可见不是
「看不到内容」而是「这间房不存在」—— 连**房名**都不该出现在结果里)。

规则三支:`user` → `{}`(全可见);`plugin` → `{ sessionId: [] }`(只见自己产的,而今天没有
插件产会话文档,所以真值就是零条);`agent` → 端口给的允许清单。**端口没装时 agent 也是
空集** —— 一个答不出授权的宿主放行,那不是降级,是绕过。

判据在装配层(`backend/wiring/search/visibility.ts`),两条都不是那个文件自己写的:
「是不是协作」= `resolveCollabVenue(kind) !== 'chat'`(协作域那张唯一的门),「我是不是
成员」= `collabRoomVisibleUntil(room, agentId)`(`history` 工具今天用的同一个纯函数)。
core 与 runtime 的检索目录里没有 `collab` / `room` / `workspace` 这三个词。

**出入③:比 `history` 严一格。** `collabRoomVisibleUntil` 有三态(当前成员 `+∞` / 曾经
在场的一个时间戳 / 从不可见);而 `VisibilityScope` 是**逐键的合取**,表达不了「这间房
只到那一刻为止」(那要 sessionId 与 time 两格的联合约束,而合取会把这个时间窗施加到所有
别的会话上)。两条出路里取严的:**只收当前成员的房**。于是被移出的房在 `search` 里整间
不可见,`history` 仍然照旧给到移出那一刻 —— 已知取舍,不是漏。拍点辛 a 的原话是「自己是
**成员**的协作房」,严的那条正是它的字面意思。

**出入④:上限选了 (a) 截断 + warn,而且这不是二选一,是唯一选。** 派工单给的另一条
(`spaceId` + `kind != collab` 两片 + 房清单)在今天的契约下**表达不出来**:范围是
`Record<key, FacetFilter>` 的合取,写不了「(空间 X 且非协作)**或** 房在清单里」;而且
消息文档上根本没有 `kind` 这一格 facet(facets 是 sessionId / spaceId / role / archived /
time),要加就得动投影器 —— 那是 S3c 的地盘。所以走截断:上限
`VISIBLE_SESSIONS_CAP = 2000`(**不是派工单写的 500**:真库今天 469 条会话,500 只留 31 条
余量,再开三十来条会话就会开始静默丢;2000 在 SQLite 的绑定参数上限 32766 之下一个数量级,
又在真库之上四倍),到顶按 `updatedAt` 倒序留最近的那些并**记一条 warn**。

**第三条路没走,记在这里**:`{ spaceId: X, sessionId: { not: [空间里我不在的房] } }` 也是
合取可表达的,而且那份排除清单天然很短(只有「我不在的房」),不会有截断问题;代价是
**别的空间里我在的房看不见**。没选它是因为拍点辛 a 的第二半没有空间限定词。哪天截断
真的开始报警,这是第一个该考虑的替代。

### 14.4 陌生能力演练(本节自己也要过一遍)

加 symbol 能力之后,`search` 工具**一字不改**就能搜符号:kind 清单从 registry 生成,结果行
的 `<kind>` 与 snippet 由候选自带,`expand` 走同一条 preview 路。**这条已经是一条断言**
(`search-tool-store.test.ts`:注册一条 `symbol` 能力 → 描述当场多一项,注销 → 少一项),
不再只是一句话。

`expand` 的文本化是这只工具里**唯一**按 kind 分支的地方,而它分的是**预览载荷的形**
(`message-context` / `session-overview` / `note-excerpt` / `file-excerpt`),不是能力;
认不出的形走 JSON 缩排兜底 —— 一个新能力带来一种新预览形是设计允许的常态,不该让
`expand` 塌掉,而缩排的 JSON 至少是**真的内容**。

### 14.5 落地记录(2026-09-05)

**① 一处 core 改动:`applyVisibility` 从「覆盖」改成「取交集」。**

`scope: 'session'` 落成 `{ sessionId: '<本会话>' }`,而 agent 的可见范围也落在**同一个键**
上(`{ sessionId: [...] }`)。原实现 `{ ...query.filters, ...scope }` 会把那次收窄整个抹掉 ——
结果不是越权(仍在允许清单里),而是**它没照做**:模型说「只看这一条」,回来的是「你能看
的全部」。§6.4b 那句「范围赢」的忠实实现是交集,不是替换:交集两件事一起满足,而且永远
不会比 scope 宽。交集只在表达得出来的两形上做(允许清单 × 标量、允许清单 × 允许清单),
其余组合(区间、`not`)退回覆盖 —— 那是今天的行为,也仍然不放宽。四条新断言在
`core/search/__tests__/pipeline.test.ts`。

**② `scope` 只能收窄,而且模型点不了名。** 输入 schema 里没有 `sessionId` 这一格:
`scope: 'session'` 拿的是**调用坐标上**那条会话。所以「模型手打一条它看不见的会话」在契约上
就不可达 —— 这比「能提但会被挡」更强。`'space'`(缺省)与 `'all'` 都不加会话过滤,上限由
visibility 定;描述里写明了 `'all'` 不等于「每一个空间」。

**③ battery 那一幕没做,改在 store 级跑。**

派工单要我先看 `scripts/lib/gate-fake-provider.mjs` 能不能脚本化一次工具调用。**答案是不能**:
那只最小假 provider 只吐文本帧,`modelCapabilitiesByModel` 里写死 `tools: false`,它自己的
文件头也说「完整版本(带场景矩阵、工具调用)在 `scripts/shadow-battery.mjs`」。
**`shadow-battery.mjs` 那一只能**(`F.tool(id, name, args)` / `F.callTools()` 是现成的 DSL,
矩阵里已经有 `tool-loop` / `bash-step` 这些幕)。

没在那里加的理由是**那道门守的是别的东西**:`sessions:shadow-battery` 判的是账本重折的
确定性,把一条索引 Worker + sqlite + 一次**异步**追账本(索引 enqueue 是毫秒级但不同步,
下一轮要先等 `pending` 归零)塞进去,红了说不清是账本坏了还是索引没追上 —— 一道会闪红的
门比没有门更糟。

替代是 `backend/wiring/search/__tests__/search-tool-store.test.ts`:临时 store、**真**
SqliteIndex(同线程 `MessageChannel` Worker,与 `index-service.test.ts` 同一份夹具)、真
`SearchService`、真三档目录、经**成品** `createAppToolRunner` 跑完整条
(校验 → plan → 授权 → apply),连 `tool/audit` 都断言了。跑不到的只有「一个模型把这次调用
发出来」那一段,而那是 provider 接线,不是这只工具的事。

**④ 测试**(4 份新文件 61 例):

| 文件 | 考什么 |
| --- | --- |
| `runtime/toolkit/__tests__/search-tool.test.ts`(26) | 参数 → 查询、主体映射(含 system→agent)、四种预览载荷的文本化、时间解析、输出三格的诚实、适配器没装时结构化拒绝、场景恒可见 |
| `runtime/search/__tests__/visibility.test.ts`(9) | 三支规则的形、端口缺省是关、空集在两侧都是恒不命中、两份自述挂的是同一条 |
| `backend/wiring/search/__tests__/visibility.test.ts`(11) | 拍点辛 a 逐字拆开 + 反例(别的空间 / 我不在的房 / 我被移出的房 / agent·work 场子 / kind 认不出)+ 截断 |
| `backend/wiring/search/__tests__/search-tool-store.test.ts`(15) | store 级端到端(见 ③) |

**⑤ 留账**:

- 上限 2000 的截断路今天在真库上跑不到(469 条会话),所以那条 warn 从没在真机上出现过。
- `chats` 那一路的 inline 预览(`session-overview`)与 `expand` 走的是同一条 `service.preview`,
  但工具侧的 target 记忆是**每份适配器实例一份**的有界表(512 条,插入序淘汰):`expand`
  一个从没搜出来过的 ref 会拿不到 target,由 `service.preview` 如实答「画不出预览」。这与
  描述里那句「A result id from a previous call」一致,但它意味着**跨进程重启后旧 ref 展不开**。
- 适配器没装的宿主上,`search` 仍然注册在目录里,描述会如实说「this host has no search
  index」、调用会答「search unavailable」。没有做「装不上就不注册」,因为那要把工具注册与
  检索装配的次序绑死(见 §14.3 那一格)。

---

## 15. 语义召回:sqlite-vec + 本地嵌入(S7,2026-09-05 落地)

> 本节自 S7 落地起**按事实写**。原来的写法是方案,读数与出入逐条记在 §15.6。

### 15.1 一句话

`SqliteIndex` 多一张 `vec_docs_384`(sqlite-vec 的 `vec0` 虚表,**一段一行**:
`embedding float[384]` + 元数据列 `docId` / `chunk`),索引基座的 `retrievers` 从
`[lexical]` 变成 `[lexical, vector]`,RRF 融合(k = 60)。**词法路一字不动** ——
`search:parity-B` 三趟读数与 S3c 逐字相同(messages ⊇169 / 中段 21 / 需放宽 2 /
截断 8 / 红 0),它继续守着这一条。

### 15.2 三件原生相关的事,按法条办

| 件 | 是什么 | 法条怎么过 |
| --- | --- | --- |
| `sqlite-vec` | 纯 C 的 SQLite 可加载扩展,npm 包 `sqlite-vec` 带平台子包(`sqlite-vec-darwin-arm64` 等,各一个 `vec0.dylib/.so/.dll`) | **门证,不是注释**:`gate:native` 多一列 `sqlite-vec-<platform>-<arch>`,在系统 Node 与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 下各 `new DatabaseSync(':memory:', { allowExtension: true }).loadExtension(path)` 并跑 `select vec_version()`(装得上还得真能用);`nm -u` 只许 `sqlite3_*` 与 libc。**本机读数:未定义符号 21 条,全是 libc(`___memcpy_chk` / `_strtod` …),`sqlite3_*` 零条**(扩展靠 `sqlite3_api` 结构体调宿主,不必导入 sqlite3 符号),V8 / Node 内部符号 0 |
| 嵌入运行时 | 拍点癸 a:`@huggingface/transformers` wasm 后端(实测版本 3.8.1),模型 `multilingual-e5-small`(q8,384 维);**动态 import**,开关不打开一行不加载 | 它自己零原生。但**它拖进来两个原生包**:`onnxruntime-node`(prebuild 是 `bin/napi-v3/**`)与 `sharp` / `@img/sharp-<platform>`。产品从不加载它们(嵌入器写死 `device: 'wasm'`),可它们真的被打进 app —— 所以两块二进制**都进了 `gate:native` 的表**,实测都是 N-API,绿 |
| 打包 | 扩展文件 `asarUnpack`;mac 硬化运行时下未签名的 dylib 装载会失败 | `electron-builder.yml` 加了 `sqlite-vec*` 六行;实测 `app.asar.unpacked/node_modules/sqlite-vec-darwin-arm64/vec0.dylib` 在,且 `codesign -dvv` 读到 `flags=0x10002(adhoc,runtime)` —— electron-builder 真的签了它。`gate:packaged` 断言的是 `vectorExtension === 'loadable'`(见 §15.5 那条改判) |

**gate:native 现在 6 个目标,0 失败**:node-pty / sherpa-onnx-node / sherpa-onnx-darwin-arm64 /
**sqlite-vec-darwin-arm64** / **onnxruntime-node** / **@img/sharp-darwin-arm64**。

### 15.3 嵌入器是注册表,模型是数据

```ts
// 接口住 core(packages/core/search/index/types.ts)—— 向量召回器要认它
export interface Embedder {
  readonly id: string
  readonly dims: number
  readonly maxTokens: number
  ready(signal?: AbortSignal): Promise<void>          // 下载 / 装载;幂等
  embed(texts: readonly string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>
  countTokens(text: string): number                    // 切段判据
}
export type EmbedKind = 'query' | 'passage'            // e5 的前缀由嵌入器自己贴
registerEmbedder(factory)                              // runtime/search/embedding/registry.ts
```

- **`kind` 这一格是为前缀留的**:e5 要求查询写 `query: `、正文写 `passage: `。这条知识住
  `transformers-wasm.ts`,不许漏给调用方。
- 模型文件落 `<store>/models/embeddings/<modelId>/`(`getOnethingEmbeddingModelsDir()`,经
  `getOnethingStorePath()` 派生)。首次开启时下载,进度进 `status.vector = 'downloading'`;
  失败 = `VectorWriter` 把状态钉成 `'off'` 并 `warn`,**不重试到死**。
- **`meta.embeddingModelId` 进库头**:与当前嵌入器 id 不符 → `vec_docs` 清空 + 全库排队重嵌
  (`VectorWriter.reembedAll`),**词法路一行不动** —— 同一个库里两套派生数据,各自重建。
  (`version` / `analyzerId` 不符才是丢整个库。)
- **嵌什么**:manifest `schema` 里 `embed: true` 的字段。今天只有两处:messages 的
  `content`、daily 的 `content`。**chats 的 `title` 故意没有**(标题短,向量意义小,与
  §15.4 让 chats 走 `'explicit'` 是同一个理由)。attachments 是文件名、reasoning 默认不产,
  两样都没有「改写句能对上」的语义。
- 单文档超 `embedder.maxTokens` 切段(`chunkForEmbedding`,按**嵌入器自己的 tokenizer** 数,
  不按字数),`(docId, chunk)` 一段一行;一份文档最多 64 段(`MAX_CHUNKS_PER_DOC`,一道刹车)。
- `DocumentFilter` 在嵌入前已跑过 —— 写路读的是 `IndexedDoc.fields`,**脱敏之后**的正文。
- 后台限速:每段之间 `setImmediate` 让出一次,一段内每 32 条再让一次;
  `status.vector = 'embedding'` 直到追平,`status.vectorPending` 是还欠几份文档。
- **嵌入在 Worker 里**(`VectorWriter` 只由 `IndexWorkerCore` 构造),主线程零 CPU。
  `gate:search-index` ⑤d 加了一条结构判据:`packages/backend/**`、`packages/core/**`、
  主线程侧的检索代码与壳的 electron 目录里**零 `@huggingface/transformers` import**。

### 15.4 什么时候走向量路

查询嵌入也要时间,命令面板边打边出的预算容不下它。所以向量路**不是每次都跑**,由索引基座
读 manifest 的那张表决定(**数据,不是 if**)。v3.1 写的是 `retrievers: { vector: { when } }`;
落地时改成**按召回器 id 索引的表** —— core 因此连「向量」这个词都不认识,只认「这一路有没有
一条什么时候跑的规矩」:

```ts
retrievers?: Record<string, RetrieverPolicy>          // 键 = 召回器 id
interface RetrieverPolicy {
  when: 'relaxed' | 'explicit' | 'always'
  surfaces?: string[]                                  // 'explicit' 时,哪些消费面算「明说要了」
  maxDistance?: number                                 // 距离上限;今天故意留空,见下
}
```

| when | 判据(全读查询自己的事实) | 谁用 |
| --- | --- | --- |
| `'relaxed'`(缺省) | `ladder.level >= 1` —— 词法严格档零命中、走到放宽阶梯 ② 及以后 | messages / daily |
| `'explicit'` | `query.filters.semantic === true`,或 `ctx.surface` 在这条 policy 的 `surfaces` 里 | chats(`surfaces: ['agent-tool']`) |
| `'always'` | 每次都跑 | 将来的笔记 / 知识库类能力 |

**消费面的名字由能力列**(`surfaces: ['agent-tool']`),core 里一个消费面的字面量都没有;
`filters.semantic` 是**查询级的一个开关**(`SEMANTIC_FILTER_KEY`),不是任何能力的 facet。

融合:RRF,`score = Σ 1 / (60 + rank_i)`;`explain` 在 `ctx.debug` 时标 `retriever: 'vector'`
与 `distance`。**`total` 的规矩收紧了一格**:两路都出了候选时答**不知道**(缺席)——
KNN 数不出「一共有多少条相似的」,取词法那个数会在「词法零命中、向量出了五条」这一形上
写出 `total: 0` 配五条结果,那是壳画分页时当场露馅的假话(§7.3「不知道就别给」)。

**授权仍然是查询的输入**(§6.4b),而且是**在 KNN 里**生效的。实测的三种写法:

| 写法(五条向量,只有最远的两条在范围内,`k = 2`) | 读数 |
| --- | --- |
| 无过滤 | docId 1, 2(最近的两条) |
| `JOIN docs d ON d.docId = vd.docId WHERE d.cap = 'a'` | **`[]`** —— SQL 的 JOIN 是**后过滤**,两条全被筛掉 |
| `docId IN (SELECT docId FROM docs WHERE cap = 'a')` | **docId 4, 5** —— vec0 把它**下推进 KNN 扫描** |

所以实现走 `IN (子查询)`,范围的 SQL 由 `SqliteIndex.compileVectorScope` 编译 —— **与词法路
的 `buildScope` 是同一条编译**,两条召回路问索引的是同一句话。这一条不是优化,是正确性:
`k = limit × 4` 再回来筛的那种写法会让授权范围外的候选先占掉名额。

**KNN 没有下限**(施工时量出来的,原方案没写):`k = 5` 答的永远是最近的五条,哪怕全都
不相关 —— 一间只有两条消息的 store 上,任何一句话都能把那两条召回来。机制上留了
`maxDistance` 这一格,**今天故意不定值**:合适的阈值要拿真模型在真库上的读数定,而 e5 这类
模型的余弦天生偏高、不相关的一对也常在 0.7 以上,凭空拍一个数会把该召回的也切掉。
§13 有这一条待拍。

### 15.5 门

- **`gate:native`**:6 个目标 0 失败,`sqlite-vec` 那一列在两个运行时下真装真跑
  (`vec_version()` = `v0.1.9`)。反证:把 Electron 那一列跳过 → 当场 1 红。
- **黄金复述集 20 条**(`packages/core/search/__tests__/fixtures/paraphrase.json`):从脱敏
  语料人工写的改写句 → 期望键。卷子在
  `packages/onething-runtime/src/search/index/__tests__/semantic.test.ts`(隔壁就是
  `corpus.test.ts`),跑的是**真 `SqliteIndex` + 真 sqlite-vec + 假嵌入器**:
  - ① 向量路 top-5 **20/20 必中**;
  - ② 同一批查询,**词法路严格档 0/20**(最松那一档 11/20,只记读数不断言 —— 中文改写句
    与原文难免共用一两个二元词元,而 §15.4 让向量路从 ② 起才加入,判的本来就不是那一档);
  - ③ 授权是查询的输入(范围外的候选不占名额;空范围 = 空集,不是全库);
  - ④ 换 `embeddingModelId` → 向量清空、词法路命中数逐字不变、重嵌之后复述集又回来;
  - ⑤ 召回器 id 只有一个产地。
  - 现场读数:2000 份文档 → **4016 段**,重嵌一遍 7.2s(假嵌入器)。
- **`paraphrase.json` 是一份数据两个读者**:`cases` 是卷子,`synonyms` 是**假嵌入器的映射
  表**。所以这张卷子证的是**链路**(切段 → 写 `vec_docs` → 查询嵌入 → KNN → 授权 → 融合 →
  出候选)**不是模型**;模型本身的召回质量由真机冒烟说话。
- **`search:parity-B` 绿**(词法路未动),三趟读数与 S3c 逐字相同。反证:把 messages 的
  `relax` 关掉 → **27 红**。
- **`gate:search-index` 八条绿**(⑧ 是 S7 新加的):开关经 `settings.json` 打开、
  `ONETHING_SEARCH_EMBEDDER=fake` 换掉 modelId、同义表由
  `ONETHING_SEARCH_EMBEDDER_FAKE_TABLE` 指向复述集 → `status.vector` 走
  `embedding → ready`(196ms)、`vectorPending` 归零、复述集那条改写句 **7ms 经 HTTP 命中**、
  两条改写句**各把自己那条排第一**(区分度)。⑤ 三个窗口的事件循环读数不劣化
  (⑤a p99 1.356ms / ⑤b 5.583ms / ⑤c 1.79ms)。
- **`gate:packaged` 的断言改了**(相对方案原文):原来写「开关打开、模型预置在测试 store
  里,断言 `vector === 'ready'`」。落地改成**两格分开**:①`vector === 'off'`(拍点壬 a 的
  默认档 —— 打包 app 不许自作主张去下 110MB 模型,这一条守的正是「默认关」本身);
  ②`vectorExtension === 'loadable'`(装配时用一个 `:memory:` 库探一次)。**理由**:真 app
  里没有假嵌入器,打开开关就等于让这道门依赖网络、而且第一次跑要几分钟;探针与开关分成
  两格之后,「asarUnpack 漏了」在**默认档**上就抓得到,比原来那句更早。
- 反证见 §11 S7。

### 15.6 与方案的出入(逐条)

| 方案原文 | 落地 | 为什么 |
| --- | --- | --- |
| `vec_docs(docId INTEGER PRIMARY KEY, chunk, embedding)` | `vec_docs_384(embedding float[384], docId integer, chunk integer)`,docId **不是主键** | 一份文档多段,docId 不唯一;两列做 vec0 的**元数据列**才能进 `WHERE`。表名带维数是因为 vec0 的维度写死在建表语句里,换维度就得换表 |
| `VectorIndex.search(embedding, k, filter?: (doc) => boolean)`(S1 定的形) | `search(embedding, k, scope?: { capability, filters })` | 谓词是**结果过滤**,而 §6.4b 立的法是「授权是查询的输入」——闭包过不了 SQL 的 WHERE。改成与词法路同形的 facet 表 |
| `retrievers?: { vector?: { when } }` | `retrievers?: Record<string, RetrieverPolicy>` | 键写成「vector」就是在 core 里点名一条召回路。改成按召回器 id 索引之后,加第三条召回路是这张表多一行,core 一个字不改 |
| `gate:packaged` 断言 `vector === 'ready'` | 断言 `vector === 'off'` + `vectorExtension === 'loadable'` | 见 §15.5 那条 |
| 「开关保存后重读」 | **装配时读一次**,改开关下次起 core 才生效 | `workerData` 在 `new Worker(...)` 那一刻定死,热换开关要换一条 Worker,而那要一格装配级可变状态 —— `assembly:gate` 正是立来禁这个的。开关默认关,所以延迟只影响「刚打开的那一次」。§13 有这一条 |
| (方案没提) | `RetrieverPolicy.maxDistance` | KNN 没有下限,见 §15.4 末段 |
| (方案没提) | `status` 多两格:`vectorPending` / `vectorExtension` | 前者与 `pending` 同一种诚实(那一格数会话,这一格数文档);后者是 `gate:packaged` 在默认档上唯一能问的东西 |
