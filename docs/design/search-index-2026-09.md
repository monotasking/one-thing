# 检索重建 —— 联邦骨架 × 账本投影 × 函数流水线(2026-09,v3 终稿)

> 起因(09-02 用户):「view 的壳能搜到、React 壳搜不到;把 message 说得很精确仍搜不到。做一个可扩展、
> 用到设计模式的方案;多类同时搜怎么搜;能力增删要容易;条数与分页要抽象。」
>
> v1(同日上午)只治消息一路;六个候选比稿后用户拍:**A 联邦总览做骨架、事件投影建索引、函数式流水线做查询**。
> **v3(09-02 晚,用户认可「抛开现状从头做」那版)**:在 v2 之上定四件事——①引擎 = SQLite FTS5,**走 Node / Electron 内建的 `node:sqlite`,不用 better-sqlite3**(09-02 深夜勘察修正:better-sqlite3 是 V8 ABI 专属插件,仓里那块按 Node 22 v127 编,在 castlabs Electron 41 的 v145 下**加载失败**,electron-builder.yml 里「已按 Electron ABI 编好」那句是错的,且它在仓里零运行时消费者;`node:sqlite` 在 Node 22.22 / Electron 41(node 24.14)下实测 FTS5 在、`loadExtension` 在,零原生依赖、零 ABI 问题;引擎住 runtime。**注意 FTS5 的 trigram 分词器查询短于 3 字不出结果**,中文双字词全灭,所以分词仍由 core 的 TS 分析器做,FTS5 只索引一列预切好的 token 串(`unicode61`),实测「私发」「身份牌」双字三字都命中,短语核验在 TS 侧照旧;Node 版本地板 ≥ 22.13(`node:sqlite` 免 flag),启动时压掉它的 ExperimentalWarning);②语义召回从「留位」改为**第二期必做**(sqlite-vec + 本地小嵌入模型,与词法 RRF 融合);③文档模型加**关系**(消息∈会话、消息→提到的文件、工具调用→碰过的文件、会话∈空间),「哪些对话改过这个文件」是关系查询不是特例;④查询理解加**时间与实体抽取**(「上周」「八月」、文件名、符号名),时间在结果面上是一条可拖的轴;⑤**AI 自己是搜索的消费者**:助手检索历史 / 相关文件走同一份索引同一条查询路(surface = agent-tool,授权段管可见性),索引即助手记忆底座,不建第二套。原 v2 拍点 丙 / 丁 / 戊 / 己 随这一版一并认可为推荐值;仍待拍:甲(账本三事件)、乙(默认字段)。
> 本文是拍定后的细版。§0 结论与拍点 → §1 现状病根 → §2 目标边界 → §3 总体形 → §4 能力模型
> → §5 索引:账本投影 → §6 查询:流水线 → §7 全部档与分页 → §8 契约 → §9 壳 → §10 分期与门 → §11 反证 → §12 拆旧 → §13 留账。

---

## 0. 一页结论

**三件东西,三条不变量。**

| 件 | 是什么 | 不变量 |
| --- | --- | --- |
| **能力注册表**(联邦骨架) | 每一类能搜的东西是一个 `SearchCapability`,注册一条、注销一条;壳的 tab 从表里读 | 所有能力对外说同一种 `Candidate`,编排者不认识任何具体能力 |
| **账本投影索引**(建) | 消息 / 会话标题 / 笔记的索引是 `events.jsonl`(+ 会话 meta)的**确定性函数**,进程内同步观察者增量折,快照是检查点 | 索引 ≡ fold(账本, 检查点),坏了重放,不做迁移 |
| **查询流水线**(查) | `parse → plan → sources → merge → rank → page → snippet`,每段纯函数,源是候选流 | 全部档的合并规则是**一段显式代码**,不是散在各处的常量 |

**规模**(真库只读):441 会话 / 9616 条消息 / 正文 7.0MB(`messages.jsonl` 391MB、`events.jsonl` 480MB,大头是工具结果与推理)/ 中文 29%。引擎 `node:sqlite` FTS5(内建,零原生依赖;分词在 TS,FTS5 只吃预切 token 列;`InvertedIndex` 接口保留,纯 TS 实现为测试替身),冷建从账本重放 ≈ 5s(后台,期间可查旧快照),增量折毫秒级,查询 < 10ms;第二期 sqlite-vec 加向量列。

**拍点**(用户拍;粗体 = 推荐):

| # | 问题 | 选项 |
| --- | --- | --- |
| 甲 | 会话改名 / 归档 / 删除今天**不在账本里**(走 meta.json + 总线) | **(a) 补三条账本事件 `session/renamed` `session/archived` `session/deleted`**,索引只吃一路;(b) 索引吃两路:账本 + meta 观察 |
| 乙 | 默认索引字段 | **(a) 正文 + 会话标题 + 附件名;推理做「含推理」开关;工具结果不索引**;(b) 推理默认含 |
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

边界:不做向量检索(留 `Ranker` 位)、不做文件内容索引(文件仍按名扫)、工具结果不索引(拍点乙)。

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
                     │  meta.json / 账本 meta 事件(拍点甲)──▶ SessionMetaFeed │
                     │  InvertedIndex + DocTable ──checkpoint──▶ <store>/index/ │
                     └───────────────────────────────────────────────────────┘
```

落位(三层不变):

```
packages/core/search/
  candidate.ts        Candidate / Target(可辨识联合)/ SearchQuery / PageRequest / SearchPage
  capability.ts       SearchCapability 接口 + CapabilityRegistry
  analyzer/           Analyzer + CjkBigram + LatinWord + Composite(带原文偏移)
  index/              InvertedIndex + DocTable + PostingsCodec + Bm25
  pipeline/           parse / plan / fanout / merge / rank / page / snippet(全是纯函数)+ compose
  cursor.ts           CursorCodec(不透明串 ⇄ {capability, kind, payload})
packages/onething-runtime/src/search/
  index/              IndexProjector(吃事件折文档)/ SessionMetaFeed / IndexStore(快照原子写)/ SearchIndexService
  capabilities/       messages.ts sessions.ts daily.ts(索引型)files.ts(扫描型)actions.ts prompts.ts(静态型)
  service.ts          SearchService = registry + pipeline + index 的门面
packages/backend/wiring/search/
  index.ts            装配:起 SearchIndexService、挂 append observer、订 meta 事件、注册六个能力 + 插件能力
packages/backend/rpc/domains/search.ts   契约扩展(§8),http 分叉照旧
packages/shared/ipc/search.ts            SearchRequest / SearchResponse 只加不改;新增 capabilities 路由
apps/desktop-react/src/search/           tab 从 capabilities 读;消费 total / cursor / relaxed / groups / index
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

```ts
export interface SearchCapability {
  readonly id: string                          // 'messages' | 'sessions' | 'files' | 'actions' | 'prompts' | 'daily' | 'plugin:<id>'
  readonly labelKey: string                    // i18n 键,壳画 tab 用
  readonly kind: 'indexed' | 'scan' | 'static' | 'remote'   // 成本模型,编排者据此给预算与超时
  supports(query: SearchQuery): boolean        // 空词 / 命令语法 / 路径语法 —— 自己答,switch 不替它答
  search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage>
}
```

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
  kind: 'message' | 'session' | 'daily'
  key: string                         // message: `${sessionId}:${messageId}`;session: sessionId;daily: path
  sessionId?: string
  spaceId?: string
  role?: 'user' | 'assistant'
  time: number
  archived: boolean
  fields: { title: number; content: number; reasoning: number; attachments: number }   // 各字段 token 长度(BM25 用)
  relations?: Array<{ rel: string; to: string }>   // v3:关系边 —— 'in-session' / 'mentions-file' / 'touched-file' / 'in-space';由 feed 产文档时一并给,索引服务存成一张边表
}

关系边让「哪些对话改过这个文件」「这条消息碰过哪些文件」成为一次边表查询(`relations` 过滤片),不给任何能力开特例;工具调用碰过的文件从 `tool/call` 事件的参数里抽(edit / write / read 的 path),这是 §5.2 投影表多认一行,不是新机制。
```

倒排按 `(field, term) → postings[docId, tf]`。**正文不存**:摘要时按 `key` 回读原文(消息:走既有活投影 / 事件回读;笔记:读文件)。

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
| `session/workdir-changed` / `model-changed` / `agent-changed` | 无关,跳过 |
| **`session/renamed` / `session/archived` / `session/deleted`**(拍点甲 a,S0 补) | 更新 `session` 文档标题 / 该会话全部文档的 `archived` / 整会话墓碑 |

拍点甲选 (b) 时,后三行改由 `SessionMetaFeed` 提供:订阅总线 `SESSION_RENAMED` / `session:deleted` + 归档写口(`updateSessionArchived` 后发一条内部事件),效果相同,只是索引多吃一路。

**空间归属**:`spaceId` 来自会话 meta(`workspaceId`),建文档时取,`session/moved` 今天不存在(会话不跨空间移动),不处理。

### 5.2b 喂索引的不止账本:`DocumentFeed`(09-02 下午,用户提「symbol 检索」后抽开)

索引服务不直接认识账本。它收一组 **feed**,账本只是第一个:

```ts
interface DocumentFeed<TKey = string> {
  readonly id: string                                  // 'ledger' | 'files' | …
  readonly kinds: Doc['kind'][]                        // 它产哪几种文档
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

- 观察者只做 `projector.enqueue(sessionId, record)`(入内存队列,O(1)),真正折在下一 tick 的微任务批里——append 路径上零 IO、零分析器。
- 折的时候若该会话的投影状态不在缓存(冷会话),按 `projection-cache` 的边界:**不在写路径上读整文件**;把该会话记进「待补」,由后台任务从检查点 seq 读尾巴补齐(`drainSessionLogEventTail`,`seq <= lastSeq` 幂等)。
- 折坏了(reduce 抛)→ 该会话检查点作废,后台整会话重建;其它会话不受影响。

### 5.4 检查点与快照

```
<store>/index/
  search.v1.bin        倒排 + DocTable(PostingsCodec:词典排序字符串表、docId 增量 varint、tf)
  checkpoint.v1.json   { version, analyzerId, sessions: { [sessionId]: { lastSeq, metaRev } }, daily: { [path]: mtime } }
```

- 启动:读快照 + 检查点 → **立刻可查** → 后台对每个会话比 `lastSeq`(账本文件尾 seq,`stat` + 读尾一行)与 `metaRev`(meta.json mtime),差的排队补折;账本里有、检查点没有的整会话建;检查点有、盘上没有的墓碑。
- 写快照:关闭时;每 200 次增量或 5 分钟;临时文件 + rename。
- 版本:`version` 或 `analyzerId` 不符 → 丢快照全量重放(≈5s,后台)。**不做迁移**。
- 墓碑超过 20% 后台压缩。
- `index/` 是派生数据,删掉即重建,与 `log/` 看门人无关。

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

`①严格(AND + 短语相邻核验)→ ②去相邻约束 → ③AND→「至少命中一半的词」→ ④单词`。plan 只产出阶梯,fanout 按阶梯逐级试,**第一级有结果即停**,结果标 `relaxed`。壳写「已放宽:按任一词匹配」。**不静默放宽**。

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
fanout(registry) = async (ctx, q, page) => {
  const caps = ctx.capabilities(q)                    // 单类:[那一个];全部:registry.list().filter(c => c.supports(q))
  const budgets = ctx.budgetPolicy(q, caps)           // §7.1
  const settled = await Promise.allSettled(caps.map(c => withTimeout(c.search(q, budgets[c.id], ctx), budgets[c.id].timeoutMs)))
  return settled.map(toGroup)                          // 失败 / 超时 = 该组 { error } 不拖死别组
}
```

### 6.4b authorize:谁在问,就只给谁能看的

```ts
type VisibilityRule = (principal: SearchContext['principal'], candidate: Candidate) => boolean
```

在 fanout 之后、merge 之前对每条候选跑该能力 manifest 声明的 `visibility`(缺省规则见 §4.1b)。**AI 当调用者**(agent-tool surface)时走的就是这条:collab 的 `history` 授权模型翻译成 messages 能力的一条 visibility 规则,不另写一套搜索。被滤掉的候选不计入 `total`。

### 6.5 merge / rank / page / snippet

- **单类**:merge 是恒等;rank 由能力自己给的 `score` 决定(索引型 = BM25 × 字段权重 + 30 天半衰 + 用户消息 ×1.1 + 标题命中置顶;同分按时间倒序——确定性,cursor 才稳);page 按 cursor;snippet 对索引型回读原文开 120 字窗,区间转原文偏移。
- **全部**:merge = 按组摆(§7),rank 只在组内,page 不做。
- BM25:k1=1.2,b=0.75;字段权重 title 2.0 / content 1.0 / attachments 1.0 / reasoning 0.6。

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

`SearchResult` 加 `target?: { kind: string; payload: unknown }` 与 `facets?: Record<string, unknown>`(旧字段 sessionId / messageId / filePath 照旧填,保旧壳)。`SearchCategory` 类型保留为 `string` 别名,`isSearchCategory` 改问 registry。Vue 壳零改动可用。

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
| **S0 契约 + 账本三事件 + 语料** | `@shared/ipc/search.ts` 扩展 + `capabilities` 路由;拍点甲 a:账本加 `session/renamed` / `archived` / `deleted` 三事件(写口各一处,影子对账不受影响——它们不进消息投影);从真库抽脱敏语料 2000 条进 `core/search/__tests__/fixtures/` | typecheck;`sessions:shadow-battery` 绿;语料脚本只读 |
| **S1 内核** | `core/search/`:candidate / capability / registry / analyzer / index / pipeline / cursor 全部纯实现 | 单测:切分黄金表、编解码往返 ≡ id、语料 20 条查询期望集(含「身份牌已私发四人」必中、全角必中、`/cmd` 不被吃)、放宽阶梯逐级、前缀上限、cursor 稳定;基准 2000 条查询 < 5ms;`boundary:gate` 绿(core 零依赖) |
| **S2 能力包装(行为零变化)** | 六个内置能力按三种基座包装,`plugin-search-registry` 并成 `remoteCapability`;`SearchService` 门面;**消息那一路暂仍是旧扫描**(scan 基座) | 对账门 `search:parity-A`:真库 200 随机查询 × 每类,新旧结果集逐字同(此期不许有差) |
| **S3 索引 + 投影** | `runtime/search/index/`:IndexProjector / **SqliteIndex(`node:sqlite` FTS5 unicode61 吃 TS 预切 token 列 + 文档表 + 边表,`InvertedIndex` 接口的产品实现)** / checkpoint / 观察者挂接 / 后台补折;messages / sessions / daily 换成 `indexedCapability` | 对账门 `search:parity-B`:索引严格档命中集 ⊇ 旧扫描命中集(差集逐条打印,按 filters 对齐);冷建 / 快照 / 内存读数记回 §0;折坏隔离用例;`sessions:shadow-battery` 绿 |
| **S4 壳** | React 壳按 §9;Vue 壳零改动验证 | `gate:search-messages` 扩 6 断言(total / 放宽 / 分组 / 归档徽 / 跨空间 / tab 随注册表);ui:consume 只减不增;a11y 零违例 |
| **S5 退役** | 删 `searchMessages` 旧扫描、`iterateSessionMessages` 端口、`switch(category)`、写死配额表、`SearchCategory` 字面量;CLAUDE.md 与 collab 文档改写(§12) | 全仓绿;grep 零残留 |
| S6(缓议) | 文件内容源(`rg --json` 作 scan 能力)、第二 Ranker(向量) | 另案 |

S1 与 S0 并行;S2 依赖 S1;S3 依赖 S0(三事件)+ S2;S4 依赖 S3。S1 / S2 / S3 各是一张 opus 派工单,附本文对应节 + 三张状态表要求。

---

## 11. 反证(每期拆掉即红)

- **设计层的反证(每版设计交卷前)**:陌生能力演练(§4.2b)+ 七轴发散演练(§4.4)。用一个设计时没想过的能力走一遍「要改哪些文件」;答案不是「能力模块 + 壳渲染模块 + 两行注册」就打回。本文 v2 第一稿没做这一步,被用户用 symbol 一问就露了 feed 与 Target 两个枚举点——这就是立这条的起因。

- S1:拆 `PhraseVerifier` → 「身份 … 牌」假阳性红;拆 NFKC → 全角红;拆前缀上限 → `a` 展开红;改 cursor 不带 queryHash → 索引变后翻页错位红。
- S2:任一能力从注册表摘掉 → parity-A 该类红 + `capabilities` 路由少一项红;`budgetPolicy` 改回常量 → 「command 意图 actions 8 条」用例红。
- S3:观察者不 enqueue → 「发一条消息立刻可搜」真机红;`run/end` 前建文档 → 「流式中不出半条」红;折坏不隔离 → 「一会话坏其它照搜」红;检查点不比 `metaRev` → 改名后标题搜不到红。
- S4:tab 写死 → 注销一个能力 tab 仍在红;`total` 缺席时画「加载更多」→ 红。

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

- 拍点甲选 (b) 时,归档写口今天没有内部事件,要补一条;选 (a) 则三事件进账本一次到位——推荐 (a),它也顺手补了「账本是唯一真相」今天的一个洞。
- 跨类混排若将来要做:每路给 0–1 置信度 + 类别先验,在 `merge` 换一个实现即可,骨架不动。
- 十万条以上换 `InvertedIndex` 实现(FTS5),接口不变;届时再评估 better-sqlite3 打包税。
- 文件内容检索是 S6 的第一件:`scanCapability` 包 `rg --json`,cursor = 文件位置。
