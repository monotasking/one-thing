# 后端结构重整 · 决策记录(2026-10)

这份文件按时间顺序记下后端(`packages/backend`)结构重整里每一个决策点:当时的问题、选了什么、为什么、谁拍的板。
目标(用户 10-04 定):**合理的分层、可读性、可维护性;不介意打破现有结构**。施工细节与验收数字在
`docs/design/server-client-split-2026-10.md` §6 的落地记录里,这里只记「为什么这样定」。

拍板人:用户 = 用户在对话里定的;我 = 实施者(Claude)按目标自定;Fable = 交给 Fable 模型做的决策。

| # | 日期 | 问题 | 决定 | 理由 | 拍板 |
| --- | --- | --- | --- | --- | --- |
| D1 | 10-01 | server 与 client 要不要拆、要不要共享包 | 拆;保留瘦的 `@shared`(契约 + 两边必须算得一样的纯逻辑,零 node);依赖只许 client → shared ← server | 两边要一致的东西只能有一个产地 | 用户 |
| D2 | 10-01 | core / runtime / gateway / backend 四个包 | 合成一个 server 包 `@onething/backend` | 一个功能散在四个包里读不懂 | 用户 |
| D3 | 10-02 | 合包后同一功能的逻辑与接线怎么放 | 撤销拍板 #25(逻辑归 runtime/<d>、接线归 wiring/<d>);同一功能同一目录 | 功能是读代码的单位,层不是 | 用户 |
| D4 | 10-02 | 目录里要不要再分 `wiring/` 子目录(「接线」与「产品逻辑」) | **不区分**,平铺 | 那是旧三层模型的包内习惯;后端只有一个包、一个进程,分层的理由已不在 | 用户 |
| D5 | 10-03 | core 要不要 | 不要;core 的「零依赖骨架」规则一起撤 | 它为界面复用而设,第①步之后界面碰不到后端了 | 用户 |
| D6 | 10-03 | 专属内核(只有一个功能用的 core/<x>) | 并进该功能的 `kernel/` 子目录(普通子目录,不带层规则) | 内聚的子模块,不是层 | 我(用户未否) |
| D7 | 10-03 | gateway 子树 | 成为普通功能 `runtime/gateway/` | core 没了它就是一个功能 | 我(用户未否) |
| D8 | 10-03 | `*.wiring.ts` 后缀 | 去掉;撞名按内容起名,不许用 wiring / host / bound / app / assembly 这类层字眼 | 后缀已不表达任何权限 | 用户 |
| D9 | 10-03 | 功能怎么对外 | **每个功能只经自己的入口 `index.ts` 对外**;棘轮 `entry:gate` 数「从外面引用功能内部文件」的处数,只减不增 | 读一个功能先看入口就知道它交出了什么 | 用户 |
| D10 | 10-03 | 宿主(Electron 主进程 / CLI)只经门面用后端 | 现在不做 | 第④步两进程拆分时自然完成,现在做是重复劳动 | 用户 |
| D11 | 10-03 | `runtime/` 这一层 | 最终去掉,功能直接放 `packages/backend/<功能>/`;先把包根里属于功能的几块并进功能,再机械去掉这层 | 名字已无含义 | 用户 |
| D12 | 10-03 | 入口拖进重模块(会话表加载即读设置 / 建仓库) | 先 A 后 B:先保留 5 处深层引用,再另一笔把「加载期取值」改成首次用到时建(const 持有器),然后收进入口 | 搬家与改行为分开,出问题分得清 | 用户 |
| D13 | 10-03 | import 后端模块时能不能读设置 / 建仓库 | 不能(`import-side-effect-free.test.ts` 有断言) | 加载期取值是循环依赖与测试脆弱的根 | 我(用户同意 D12 时一并) |
| D14 | 10-03 | `entry:gate` 的口径在搬家时变高(测试 mock 第一次被量到) | 接受数字变高,不改口径 | 那是真实的耦合,改口径等于藏起来 | 我 |
| D15 | 10-03 | `connected-directories` 归谁 | `runtime/files/` | 五个使用者问的都是「这个会话能碰哪些目录」;放 settings 会成 settings ↔ sessions 环 | 我 |
| D16 | 10-03 | 网络件(代理校验、受管 fetch) | 独立成 `runtime/network/` | 不属于服务商;索引 Worker 只要这两只,不该背整个 providers | 用户 |
| D17 | 10-03 | `agent-loop/providers/`(线协议、方言基类、思考线型) | 并进 `runtime/providers/` | 「各条线协议怎么拼」与「各家怎么说」是同一件事;消掉最重的 providers ↔ agent-loop 环 | 用户 |
| D18 | 10-04 | providers 一个入口全交出去 → 60 模块环、`class extends` 加载期 undefined | 推翻「providers 不拆」;**不新建功能**(`llm` 名字有歧义,CLAUDE.md「组件化而不是创建新的组件」),把「用服务商干活」那一类文件按内容分进已有功能;动手前先算入口图无环 | 一个既是叶子又是枢纽的功能不能只有一个入口;继承无法惰性化 | 用户 |
| D19 | 10-04 | 功能入口规矩的另一半 | **入口之间成 DAG**(不许循环),做成门 | 没有它,别的功能会重演 providers 的崩溃 | 我(D18 的推论) |
| D20 | 10-04 | 光「依赖不成环」不够,要能读、能维护 | 定下可读性判据 R1–R6(见下节),每一步的去处选择与验收都按它判;不满足的方案即使无环也不选 | 用户:「我不希望最终得到的是一个我无法阅读和维护的代码库」 | 用户 |
| D21 | 10-04 | 包根的 `rpc/`、`runtime/`、`server/`、`features/`、`channel/`、`utils/` 从名字看不出里面是什么(违反 R1 / R2) | 目标:包根 = 后端自己的几只组装文件 + 一个功能一个目录。`runtime/` 去掉(D11);`server/` 的核心与 `rpc/` 的分发表合成 `http-server/`(「界面连进来的那台 HTTP 服务器:收请求、SSE 事件流、发现文件、来访者认证、按表分发」,它不认识任何具体功能);`rpc/domains/<d>.ts` 搬进各功能,叫 `<d>/client-api.ts`(「这个功能开放给界面调用的操作」;功能自述,`http-server/` 读表)。**10-04 修订**:最初写的 `api/` 与 `rpc.ts` 仍是技术名词,用户追问「rpc 指的是什么」后改名;`server/` 里属于具体功能的面(mcp-*、media-delivery、plugin-catalog、search-providers、settings-projection、live-session-delivery)搬进各功能;`channel/` → gateway;`features/` 按内容命名;`utils/` 按使用者归位 | 目录名要回答「这里是什么」;`rpc` / `server` / `runtime` 回答的是「用什么技术 / 在哪一层」 | 用户指出,我定方案 |
| D22 | 10-04 | 文件怎么命名(用户:同名文件太多、搜不出来;按行业标准定) | 命名规范 N1–N7(见下节):全包唯一、功能名打头、入口叫 `<功能>.ts` 且只用具名导出、泛名不单用、目录单数 | Angular / Google 风格指南与业界对桶文件的经验,加上本仓库的实测 | 用户授权,我按行业规范定 |
| D23 | 10-04 | 功能之间要不要分层次 | **要**:L0 基础件 / L1 领域事实 / L2 能力 / L3 编排 / L4 对外接口,以**标签表**表达(目录仍一个功能一个、平铺);只许高层引低层,同层经入口且不成环,L0 不引功能。今天违例 139 条,做成只减不增的门 | Nx 模块边界与 Feature-Sliced Design;模拟证明 providers / engine / auth / usage 的环都是「一个目录里叶子与枢纽挤在一起」 | Fable(用户要求「合理的分层」) |
| D24 | 10-04 | providers 里「用服务商干活」的 29 只文件放哪 | 按各自依赖的层次去:发对话 / 造实例 → engine;按会话取空间设置 → sessions;模型目录服务三件 → settings;凭证一族 → `credentials/`;oauth 兼容门面 → auth;`external-agents/provider` 与 `usage/pricing` 进 providers;`oauth-token` / `jwt` → network;`request-dump` → logging;断三条边(构造参数注入) | 模拟:providers、spaces、auth、settings、sessions、credentials、usage 依次收口都不成环;d3x 把重文件塞进被 13 个功能当叶子的 spaces,spaces 一收口就 37 只环 | Fable |
| D25 | 10-04 | 凭证要不要单独成功能 | 新建 `credentials/`(凭证池、轮换、插件凭证策略、订阅额度路由、旧凭证迁移、token 写回) | 凭证今天散在 providers / spaces / auth 三处;放进任何一处都让那个功能既是叶子又是枢纽;名字无歧义、「凭证在哪」一个目录答完(R1 / R2);用户的偏好「不新建」让位于可读性(用户目标原话) | Fable |
| D26 | 10-04 | 各功能开给界面的操作(原 `rpc/domains/*`)搬进功能后会把功能重新变枢纽 | `<功能>-client-api.ts` 是功能的**第二个入口**,只许 http-server 引用;它可引任何功能入口,任何功能入口不许引它;入口无环门只算主入口 | 否则路线第 2 项会把零环结论翻掉 | Fable |
| D27 | 10-04 | engine 自己就是 247 只的环(只收口 engine 时) | 单独一批(F2→F4):前 core/engine 内核归 agent-loop;引擎组合根出成包根 `assemble-engine`;触发器各归其主;读当前引擎改读 `current.ts` 槽;六个功能全收口降到 3/2 | engine 的病与 providers 同种:内核(L1)、hub(L3)、组合根(L4)挤在一个目录 | Fable |
| D28 | 10-04 | 依赖规则用现成工具(dependency-cruiser)还是自己写 | 先用自己的脚本(复用 Fable 的模拟器口径:只看运行期值引用、类型引用擦掉、按入口判);dependency-cruiser 作备选 | 需要的判据(「SCC 里含功能入口」「层次标签表」)要定制;模拟器已在三批数据上与真代码对得上 | 我 |

## 可读性判据(D20)

- **R1 找得到**:问「X 在哪」,看 `packages/backend/` 的目录列表就能答出一个目录;一个功能不散在两个以上的目录。
- **R2 名字说人话**:目录名是一个说得清的功能名词(会话、设置、服务商、凭证……),文件名说清这个文件做什么;不用层字眼,不用只有作者懂的缩写。
- **R3 入口即说明书**:每个功能的 `index.ts` 文件头用几句人话写:它是做什么的、对外交出哪几类东西、它依赖哪些功能;交出的名字按类分组,不是一大串 `export *`。
- **R4 方向一眼看得出**:有一张**生成出来**的功能地图(谁依赖谁、按层次排好),放在仓库里并由门保证与代码一致;依赖只朝一个方向(D19)。
- **R5 一个功能能单独读懂**:读一个功能,不需要先读另一个功能的内部文件;功能之间只经入口。
- **R6 小而完整的对外面**:入口交出的名字越少越好;总桶 `runtime/index.ts`(今天 2337 个名字)最终删除。


## 命名规范(D22,10-04 定)

起因:用户指出「最好不要用一个文件名,不然搜索出来的内容太多了」;并授权「文件命名按行业标准、规范来做」。今天 `packages/backend` 1470 个非测试文件里 132 个文件名重复(`index.ts` 98、`types.ts` 36、`ipc-operations.ts` 20、`runtime.ts` 18、`registry.ts` 17、`manifest.ts` 17、`dialect.ts` 15、`store.ts` 10 ……)。

参照的行业规范:
- Angular 官方风格指南:文件名「先写它属于哪个功能、再写它是什么」,单词之间用连字符;理由正是「用编辑器的模糊搜索能直接找到」(<https://angular.dev/style-guide>)。
- Google TypeScript 风格指南:文件名全小写、单词分隔一致(它用下划线;本仓库全仓已统一用连字符,保持一致比换风格更重要)(<https://google.github.io/styleguide/tsguide.html>)。
- 关于「桶文件」(只做 `export *` 转发的 `index.ts`)的业界经验:它是循环依赖的高发点,会拖慢构建与编辑器、妨碍摇树;Next.js、Atlassian 去掉桶文件后构建与编辑器明显变快(<https://reactuse.com/blog/barrel-files-tree-shaking/>、<https://atharvacm.dev/blog/barrel-exports-hidden-cost>)—— 与本仓库 providers 一个入口 `export *` 全交出去造成 60 模块环的实测一致。

规则:
- **N1 文件名全包唯一**:按文件名搜索只出一个结果。门:重名数只减不增(今天 132),目标 0。
- **N2 全小写、连字符分词、功能名打头**:`<功能>-<做什么>.ts`,例如 `session-store.ts`、`session-client-api.ts`、`search-index-worker.ts`;服务商目录里 `claude-manifest.ts`、`claude-dialect.ts`。点号只用于固定后缀:`.test.ts`、`.d.ts`。
- **N3 入口文件 = `<功能>.ts`**(例如 `session/session.ts`),不用 `index.ts`;文件头是 R3 的说明书;**只用具名导出、按类分组,不用 `export *`**(业界对桶文件的教训,也是本仓库 providers 崩溃的原因)。`package.json` 的 exports 把 `./<功能>` 指向它。
- **N4 泛名不能单独作文件名**:`index` / `types` / `utils` / `helpers` / `service` / `manager` / `runtime` / `registry` / `store` / `core` / `common` / `misc` 只能跟在功能名后面(`session-types.ts`)。
- **N5 目录名用单数名词**(`session`、`permission`、`provider`):目录表示「这个功能」,单数拼进文件名前缀更短。习惯上只有复数形式的词(`settings`)保持原样。
- **N6 测试 = `<被测文件名>.test.ts`**,自带功能前缀;放在功能目录下的 `__tests__/`(全仓现状,保留)。
- **N7 包名、应用名同样要说清是什么**:`packages/client` → 连后端用的 SDK,`apps/server` → 不带界面单独跑的后端,具体新名随包重命名那一步定。

## 行业里组织代码放置的规范(10-04 调研)

| 规范 | 主张 | 对本仓库的含义 |
| --- | --- | --- |
| 按功能分包,不按层分包(package by feature, not by layer) | 一个功能的所有代码放在一起;按层(controller / service / repository)分会让一个功能的改动散落多处 | 与 D3、D4、D11 一致:顶层目录是功能,不是 `rpc` / `server` / `runtime` |
| Screaming Architecture(Robert Martin) | 看顶层目录就该知道系统做什么(会话、搜索、服务商),而不是用了什么框架 | 与 R1、R2、D21 一致 |
| 模块化单体(modular monolith) | 每个模块有自己的公开接口、拥有自己的数据;别的模块只经公开接口访问 | 与 D9 一致;补一条:**每个功能拥有自己在 store 里的数据**,别的功能不直接读写它的文件 |
| Nx 模块边界(enforce-module-boundaries) | 给每个库打 scope / type 标签,用规则规定哪类可以依赖哪类,lint 时拦截 | 功能之间不是平级的;用**标签表**表达层次,目录照旧平铺(守 R1) |
| Feature-Sliced Design | 少数几个层次,只许引用更低的层;同层互引被禁止,确有必要时要经专为对方开的公开接口;外部只能经切片的公开入口 | 「依赖只朝下」是解开 providers 环的正路:服务商「事实」与「用服务商干活」本来就在不同层次 |
| dependency-cruiser(`no-circular`,只看运行期依赖) | 业界常用的依赖规则检查工具;禁止循环、禁止跨模块深层引用 | 「入口之间不许成环」与层次规则可以用它实现,而不是手写脚本;纯 JS 依赖,不碰原生模块法 |
| 桶文件的经验(见 D22) | `export *` 的 `index.ts` 是循环依赖与构建变慢的高发点 | N3:入口只用具名导出 |

来源:<https://medium.com/expedia-group-tech/package-by-feature-not-by-layer-5ba04a070003>、<https://milanjovanovic.tech/blog/screaming-architecture>、
<https://milanjovanovic.tech/blog/where-vertical-slices-fit-inside-the-modular-monolith-architecture>、<https://nx.dev/docs/features/enforce-module-boundaries>、
<https://feature-sliced.design/docs/reference/public-api>、<https://feature-sliced.design/docs/guides/issues/cross-imports>、
<https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md>。

由此产生决策 D23(层次)与 D24–D27,详见 `docs/design/feature-layers-and-provider-placement-2026-10.md`(Fable 的决策全文、放法表、模拟结果与层次表)。

## 剩下的路线(10-04 按 D20–D28 重排)

1. **先立门**:N1 文件名重复(今天 132,只减)、入口无环(D19,零基线硬闸)、层次表与违例(D23,今天 139,只减)。
2. **providers 归位**(D24 / D25):29 只文件按层次去处、断三条边、`permission-policy` 惰性化,然后 providers 收口到一个入口(只用具名导出,N3)。
3. **engine 归位**(D27,F2→F4)。
4. 其余按层次收口:collab 的叶子下沉、tools access-control、prompts→plugins 等违例逐条结;每个功能收口都过入口无环门。
5. **包根归位**:`server/` 核心 + `rpc/` 分发表 → `http-server/`;`rpc/domains/<d>` → `<d>/<d>-client-api.ts`(D26 第二入口);`server/` 里各功能的面回各功能;`channel/` → gateway;`features/`、`utils/` 按内容归位;删兼容桶 `store.ts`(拆 59 处整块 mock)。
6. **机械改名一批**:去掉 `runtime/`(D11);入口 `index.ts` → `<功能>.ts`(N3);文件名加功能前缀消重名(N1 / N2 / N4);目录单数(N5)。
7. 包名、应用名(N7)。
