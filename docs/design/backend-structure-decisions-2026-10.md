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
| D19 | 10-04 | 功能入口规矩的另一半 | **入口之间成 DAG**(不许循环),做成门:`bun run cycle:gate`(`scripts/feature-cycle-gate.mjs`,零基线硬闸:任何强连通分量含功能入口或总桶即红,并打出经过入口的最短环;10-04 立门时读数 0,不经入口的深层环 17 / 5 / 3 / 2 只打不判) | 没有它,别的功能会重演 providers 的崩溃 | 我(D18 的推论) |
| D20 | 10-04 | 光「依赖不成环」不够,要能读、能维护 | 定下可读性判据 R1–R6(见下节),每一步的去处选择与验收都按它判;不满足的方案即使无环也不选 | 用户:「我不希望最终得到的是一个我无法阅读和维护的代码库」 | 用户 |
| D21 | 10-04 | 包根的 `rpc/`、`runtime/`、`server/`、`features/`、`channel/`、`utils/` 从名字看不出里面是什么(违反 R1 / R2) | 目标:包根 = 后端自己的几只组装文件 + 一个功能一个目录。`runtime/` 去掉(D11);`server/` 的核心与 `rpc/` 的分发表合成 `http-server/`(「界面连进来的那台 HTTP 服务器:收请求、SSE 事件流、发现文件、来访者认证、按表分发」,它不认识任何具体功能);`rpc/domains/<d>.ts` 搬进各功能,叫 `<d>/client-api.ts`(「这个功能开放给界面调用的操作」;功能自述,`http-server/` 读表)。**10-04 修订**:最初写的 `api/` 与 `rpc.ts` 仍是技术名词,用户追问「rpc 指的是什么」后改名;`server/` 里属于具体功能的面(mcp-*、media-delivery、plugin-catalog、search-providers、settings-projection、live-session-delivery)搬进各功能;`channel/` → gateway;`features/` 按内容命名;`utils/` 按使用者归位 | 目录名要回答「这里是什么」;`rpc` / `server` / `runtime` 回答的是「用什么技术 / 在哪一层」 | 用户指出,我定方案 |
| D22 | 10-04 | 文件怎么命名(用户:同名文件太多、搜不出来;按行业标准定) | 命名规范 N1–N7(见下节):全包唯一、功能名打头、入口叫 `<功能>.ts` 且只用具名导出、泛名不单用、目录单数。N1 做成门 `bun run name:gate`(`scripts/file-name-gate.mjs`,基线 `docs/audit/file-name-baseline-2026-10.txt`,每个文件名的次数只减不增) | Angular / Google 风格指南与业界对桶文件的经验,加上本仓库的实测 | 用户授权,我按行业规范定 |
| D23 | 10-04 | 功能之间要不要分层次 | **要**:L0 基础件 / L1 领域事实 / L2 能力 / L3 编排 / L4 对外接口,以**标签表**表达(目录仍一个功能一个、平铺);只许高层引低层,同层经入口且不成环,L0 不引功能。今天违例 139 条,做成只减不增的门:`bun run layer:gate`(`scripts/feature-layer-gate.mjs`;层次表 `docs/audit/feature-layers-2026-10.json`,每个功能一行 feature / layer / why,没登记的功能即红;基线 `docs/audit/layer-violation-baseline-2026-10.txt` 按「从 → 到」成对计数,10-04 立门时 139 条 / 61 对)。R4 的功能地图 `docs/architecture/feature-map.md` 由 `bun run feature-map` 按这张表生成,`feature-map:check` 判它与代码一致 | Nx 模块边界与 Feature-Sliced Design;模拟证明 providers / engine / auth / usage 的环都是「一个目录里叶子与枢纽挤在一起」 | Fable(用户要求「合理的分层」) |
| D24 | 10-04 | providers 里「用服务商干活」的 29 只文件放哪 | 按各自依赖的层次去:发对话 / 造实例 → engine;按会话取空间设置 → sessions;模型目录服务三件 → settings;凭证一族 → `credentials/`;oauth 兼容门面 → auth;`external-agents/provider` 与 `usage/pricing` 进 providers;`oauth-token` / `jwt` → network;`request-dump` → logging;断三条边(构造参数注入) | 模拟:providers、spaces、auth、settings、sessions、credentials、usage 依次收口都不成环;d3x 把重文件塞进被 13 个功能当叶子的 spaces,spaces 一收口就 37 只环 | Fable |
| D25 | 10-04 | 凭证要不要单独成功能 | 新建 `credentials/`(凭证池、轮换、插件凭证策略、订阅额度路由、旧凭证迁移、token 写回) | 凭证今天散在 providers / spaces / auth 三处;放进任何一处都让那个功能既是叶子又是枢纽;名字无歧义、「凭证在哪」一个目录答完(R1 / R2);用户的偏好「不新建」让位于可读性(用户目标原话) | Fable |
| D26 | 10-04 | 各功能开给界面的操作(原 `rpc/domains/*`)搬进功能后会把功能重新变枢纽 | `<功能>-client-api.ts` 是功能的**第二个入口**,只许 http-server 引用;它可引任何功能入口,任何功能入口不许引它;入口无环门只算主入口 | 否则路线第 2 项会把零环结论翻掉 | Fable |
| D27 | 10-04 | engine 自己就是 247 只的环(只收口 engine 时) | 单独一批(F2→F4):前 core/engine 内核归 agent-loop;引擎组合根出成包根 `assemble-engine`;触发器各归其主;读当前引擎改读 `current.ts` 槽;六个功能全收口降到 3/2 | engine 的病与 providers 同种:内核(L1)、hub(L3)、组合根(L4)挤在一个目录 | Fable |
| D28 | 10-04 | 依赖规则用现成工具(dependency-cruiser)还是自己写 | 先用自己的脚本(复用 Fable 的模拟器口径:只看运行期值引用、类型引用擦掉、按入口判);dependency-cruiser 作备选 | 需要的判据(「SCC 里含功能入口」「层次标签表」)要定制;模拟器已在三批数据上与真代码对得上 | 我 |
| D29 | 10-04 | events 属于 L0 还是 L1(层次文档与层次表不一致) | **L1** | `runtime/events` 里的总线已钉成会话事件 / 全局事件的产品载荷(`session-event-bus` 等),认识产品概念,不是纯基础件 | 我 |
| D30 | 10-04 | `custom-probe-analyst.ts`(设置页「自动识别自定义服务商」那一步)这一笔放哪 | 暂放在它唯一的使用者旁边:`rpc/domains/providers-custom-probe-analyst.ts`(包根,L4,直连);D21 落地时并进 providers 的 client-api | Fable 的放法表写明终点是 providers 的 client-api、放 engine 过不了 R2;今天 client-api 还不存在,放包根与终点同层、零环 | 我 |
| D31 | 10-04 | 新功能 `credentials/` 的入口叫什么(新建 `index.ts` 会让 `name:gate` 升) | 按 N3 叫 `credentials/credentials.ts`;三道门(`cycle` / `entry` / `feature-map`,共用 `scripts/lib/backend-structure.mjs` 的 `entryFeatureOf` / `entryFileOf`)认两种入口形状:`<功能>/index.ts`,或目录里没有 `index.ts` 时的 `<功能>/<功能>.ts`(`scheduler/scheduler.ts` 是内部文件,入口仍是 `scheduler/index.ts`) | N3 是目标形状,新功能直接按它建;过渡期两种并存,路线第 6 项机械改名后只剩一种 | 我 |
| D32 | 10-04 | 断边 ③ 之后进程那台登录服务怎么拿令牌存放面 | `process-auth-service.ts`:`getAuthService()` 首次用到时建(D12);服务拿到的是一层**转交**存放面,每次读写令牌时才取装配经 `configureProcessAuthTokenStore` 交进来的那一台(第一次交的为准);没装配就读写令牌 = 抛「先装配」 | 只起 HTTP 面、不装配 backend 的宿主(九个 server 测试)也要能建服务、挂事件监听;转交让「建服务」与「交存放面」谁先谁后都行。与从前唯一的差别:没装配时读写令牌从「直接读写真凭证池」变成抛 —— 生产里所有令牌读写都在装配之后 | 我 |
| D33 | 10-04 | 断边 ② ③ 的两处装配注入挂在哪 | `backend.ts` 的 `configureAppRuntimeAdapters()`(与十一个 `configureApp*` 同一类幂等闩),不 `own()` | 两样都是无状态的函数 / 薄壳,装配之间不需要还原;挂进 `own()` 表会改 `owned-labels-snapshot.test.ts` 钉死的那张表。它们排在装配的最前面,原有各步的先后一步没动 | 我 |
| D34 | 10-04 | 模型目录服务搬进 settings 之后,九处 `import * as modelRegistry from '…/model-registry-service'` 怎么改走入口 | 设置入口交出同名命名空间 `export * as modelRegistry from './settings-model-registry-service.js'`,调用处 `modelRegistry.x` 一字不动 | 九处都叫 `modelRegistry`;逐个改成具名导入要动几十处调用,且与设置自己的同名函数(`getSpaceSettings` 等)易混 | 我 |
| D35 | 10-04 | 搬家后哪些引用改走入口 | 外面对搬走文件的引用、搬走文件对原来同目录兄弟的引用,非测试的一律改走入口,入口缺的名字补成具名导出(providers 入口追加一段,下一笔收口时与 `export *` 一起整理);测试里 `vi.mock` / 动态 `import()` 留深层,测试的静态 import 只在入口已交出全部名字时改走入口。原入口里对搬走文件的再导出(spaces → 池与规则、auth → 令牌写回、usage → 计价、providers → 请求转储)一律删掉,使用者改从新家入口拿 | 再导出留着就是低层入口引高层功能(spaces → credentials 即 L1 → L2),而且会把环带回来;`entry:gate` 的非测试处数因此 0 新增 | 我 |
| D36 | 10-04 | 从 providers / auth 搬进 logging / network 的两只模块让索引 Worker 变大了 504 字节 | 这两只模块的顶层只放字面量与函数:`gzip` 首次压缩时才 `promisify`,三个由算式写成的常量改成算好的字面量(注释里留原算式) | esbuild 只会整只摇掉顶层无副作用的模块,`8 * 60 * 60 * 1000` 这种算式与顶层函数调用都会留下;Worker 不许变大 | 我 |
| D37 | 10-04 | `usage/summary.ts` 里按凭证分桶的那块搬多少 | 只搬纯函数 `computeOnethingCredentialUsage` 与它签名里的两个类型(→ `credentials/credentials-usage.ts`);读账本再分桶的 `getOnethingCredentialUsage`(全仓零调用)留在 usage,改从凭证入口拿那个函数 | 派工单写的是「只搬函数」;usage → credentials 同层、经入口、不成环 | 我 |
| D38 | 10-04 | 删无人调用的 `providers/codex.ts` 包装后,测它的 `agent-loop/__tests__/codex-provider.test.ts` 怎么办 | 改测 `vendors/codex/agent-provider` 的构造门面(四个用例都自带 `fetchImpl`,刷新用例自带 `refreshOAuthToken`,包装多出的两样缺省在测试里不起作用);令牌字面量多一格 `refreshToken`,按门面入参类型断言一次 | 断言一字不动;生产里 `createCodexAgentProvider`(包装那一只)零调用者,`engine-process-providers.ts` 的再导出一起删 | 我 |
| D39 | 10-04 | providers 入口交出哪些名字 | 只交「外面真在用」的:非测试引用、今天已经走入口的测试、壳的测试夹具(`apps/desktop-react/src/data/__fixtures__`)要的名字,外加边界规则要入口交出的十个服务商定义契约类型;一律从**声明它的那只文件**具名导出、按九类分组(197 个:值 116、类型 81),`export *` 一行不剩。只被测试深层引用的名字(各家的构造门面、方言、地址常量等)不进入口 | R6「入口交出的名字越少越好」;从声明处导出是同一个符号,入口闭包反而少了两只纯转发文件(287 → 286) | 我 |
| D40 | 10-04 | `engine/stream/codex-native-tools.ts` 对 `vendors/codex/native-tools.ts` 的引用 | 本笔留作深层引用(改成相对路径,不经包的 exports),是 providers 一行里唯一的非测试深层引用;第二部分改成行为名册的可选钩子 `nativeTools` 后消失 | 交给入口就等于让入口点名 codex(`provider:gate` 会多一对);provider-entry 问题 5 的定论本来就是改钩子 | 我 |
| D41 | 10-04 | 旧桶 `providers/agent-providers.ts`(纯转发,原入口与总桶 `runtime/index.ts` 都 `export *` 它) | 删掉;总桶那一行 `export * from './providers/agent-providers.js'` 一起删(总桶仍 `export *` providers 入口);唯一剩下的使用者 `sse.test.ts` 改引 `sse.js` | 收口后零生产使用者;全仓没有经总桶拿 providers 名字的地方(TS checker 逐个解析过,0 处) | 我 |
| D42 | 10-04 | 两条边界规则把「内部门面经入口取类型」写死了:`provider-table.ts` 必须出现入口说明符、`ipc-types.ts` 必须出现 `./index.js`、入口必须交出 `./provider-definition.js` | **10-04 修订**(审第一部分时改判):改规则。`checkRuntimeOwnsProviderRegistry` 改认 `provider-table.ts` 直取兄弟文件 `./registry.js` 与 `./ipc-types.js`,`checkRuntimeOwnsProviderDefinitionTypes` 改认 `ipc-types.ts` 直取 `./provider-definition.js`、不再要求入口交出 `./provider-definition.js`;入口删掉那十个只为迁就规则交出的契约类型,`provider-table.ts` 改回相对引用。(第一部分的做法是不改门、让两只门面经入口只取类型) | R6:入口只交出外面真用的名字;同一个功能里的文件经自己的入口取名字本来就不合规矩,规则是合包前「app 层委派给 runtime」的化石 | 用户(协调者转达) |
| D43 | 10-04 | 壳的测试夹具(provider-entry 问题 6) | 选 A:两只夹具改走 providers 入口(`BUILTIN_PROVIDER_MANIFESTS`、`providerInfoOfManifest` 因此进入口) | providers 归位之后入口是轻的那一个(286 只、零设置 / 会话);壳 vitest 失败集合前后逐条相同 | 我 |
| D44 | 10-04 | exports 删深层键之后,测试里还写着包名深层说明符的地方(`vi.mock`、`typeof import()`、入口没交出的名字) | 改成相对路径,深度不变;`vi.mock` 换的仍是同一只模块(按文件解析成同一个 id),被测代码经入口拿名字时照样拿到替身 | D35 允许测试的 `vi.mock` / 动态 import 留深层;exports 只留 `./runtime/providers` 一个键,包名就只能指入口 | 我 |
| D45 | 10-04 | `provider:drill` 改前就是假红(模板 `acme-drill.test.ts.txt` 还引 s17 搬走的 `spaces/provider-credentials`) | 顺手修:模板里入口交出的名字走入口,入口不交出的五个与凭证规则按相对路径直取 | 模板反正要改(它用的十个深层键都删了);修好后 drill 直接跑绿 | 我 |
| D46 | 10-04 | codex 的原生工具(订阅登录下的原生出图)怎么不让引擎点名 codex(provider-entry 问题 5 ②) | 行为名册 `VendorRuntime` 加可选钩子 `nativeTools(context)`(context:生效配置的三格、工具开关、工具能力、按需取目录条目的 `modelInfo()`),codex 在自己的 `runtime.ts` 里填它,判据逐字搬自原来的 `shouldResolveCodexNativeTools` + `resolveCodexNativeToolsFromModelInfo`;providers 新增 `provider-native-tools.ts`(`resolveProviderNativeTools` 按名册找这一家、有钩子就问;`PROVIDER_NATIVE_IMAGE_GENERATION_TOOL` 是协议层的工具名);引擎的 `engine/stream/codex-native-tools.ts` 换成 `engine-native-tools.ts`,只把设置里的模型目录服务绑成「取目录条目」。钩子挂在 `VendorRuntime` 而不是调查文档写的 `VendorRuntimeKit`(后者是工厂交给各家的工具箱,方向反了) | 引擎不再认识 codex;`provider:gate` 收掉 `engine/stream/{codex-native-tools,stream-executor}.ts` 两对;先看开关 / 能力 / OAuth、都过了才问目录,与从前同一个先后。系统提示快照里的 `codexNative` / `'codex-native'` 是 `@shared/ipc/chat.ts` 的契约字段,本笔不改名,所以 `engine/prompt/system-prompt-snapshot.ts` 那一对还在 | 我 |
| D47 | 10-04 | 自定义服务商选 openai-responses / gemini-generateContent 线时的底配方(问题 5 ③):名册声明还是协议层通用配方 | 选名册声明:`Dialect` 加 `referenceFor?: WireId`,官方 openai / gemini 两家在自己的方言文件里声明自己是那条线的参考配方(建表 + 登记两步照旧,只多这一格),`custom-from-spec.ts` 按线查方言表(`referenceDialectFor`),`rebased` 把这一格连同 `label` 一起剥掉;从前那张写着 `"openai"` / `"gemini"` 的四格表 `CUSTOM_ADAPTER_BASE_DIALECT` 换成函数 `customAdapterBaseDialectId(wire)`,答出的 id 逐格同值 | 更简单的一边:gemini 的底只有三格,但 openai 的底是 openai 自己那份二十来格的 `OPENAI_DIALECT_SPEC`(数据标签、私有旋钮、原生出图、缓存键),提成协议层通用配方要么整份照抄、要么仍 import 那一家;声明只动两家各一格 + 一个查表函数。`provider:gate` 收掉 `custom-from-spec.ts` 的 gemini / openai 两对,drill 不受影响(虚构的 acme 不声明) | 我 |
| D48 | 10-04 | 测某一家服务商的测试住在别的功能里(问题 2) | 只测一家的 10 份搬进 `vendors/<id>/__tests__/`(claude 3、codex 4(含原生工具判据与钩子)、deepseek 1、gemini 1、kimi-code 1 —— kimi-code 那份改从 auth 入口拿 auth 服务);对好几家都跑的 6 份(`attachment-parts` / `provider-retry-after` / `thinking-wire` / `tool-call-done-timing` / `provider-error-classification-object` / `sse`)搬进 `providers/__tests__/`,**不改成遍历名册** | 那 6 份测的是线协议在各家构造门面上的行为,每个用例给的是那一家门面自己的参数、断言的是那一家的线形状,换成遍历名册就得改断言;线协议层 D17 已并进 providers,它们本来就是 providers 的内部测试(调查文档 2.2 节写的正是这条路)。测试原样搬,只重算相对路径,断言一字未改 | 我 |
| D49 | 10-04 | 打在 providers 内部文件上的整块工厂 `vi.mock`(问题 7) | 六份测试(`settings-domain`、`credentials-*` 四份、`plugins/llm`)的 `provider-table` / `ipc-env` 替身改打在服务商入口上,写成 `importOriginal` 展开再覆盖,一份测试并成一条;`import-side-effect-free` 的 `initializeRegistry` 桩也改打在入口上 —— 装配处 `engine-chat-facade` 已经经入口拿它,不需要 search 那次的参数注入。`rpc/__tests__/models-domain.test.ts` 换 codex / Copilot 模型取数的两条留在那一家的文件上 | 被测代码都经入口拿这几个名字,替身打在入口上才是「替换外面看得见的那个名字」;models-domain 那两条要换的是 codex 行为名册那一行**内部**调的取数函数,参数注入得在 codex 的 `createModelsFetcher` 上开一个口、或在测试里照抄那一行的接线,两样都不比现在简单,而且断言测的正是 codex 拉取器的合并逻辑。调查文档 A 类其余整块工厂的目标已在 s17 搬出 providers(engine / settings / credentials),不在本笔 | 我 |
| D50 | 10-04 | 搬测试让别的功能的入口棘轮上升(agent-loop 194 → 203、auth 44 → 45) | 接受并收紧基线(D14 的口径) | 搬进 providers 的测试照旧要 agent-loop 的循环原语与 `provider-error-classification`、auth 的测试令牌池,那是真实的耦合;agent-loop 入口今天不交出循环原语,是 agent-loop 自己收口时的事 | 我 |
| D51 | 10-04 | engine 归位(D27)搬进 agent-loop 的 39 只内核文件叫什么 | 按 N2 一律 `agent-loop-<原名>.ts`,已经以 `agent-loop-` 打头的四只(`-runtime` / `-executor` / `-selection` / `-turn`)不改名;四只改得更说内容:`core-stream-engine` → `agent-loop-stream-engine`(去掉旧层名 core)、`ports` → `agent-loop-engine-ports`、`stream-runtime`(引擎 runtime 十二槽的适配器类型)→ `agent-loop-engine-adapters`、内核桶 `engine-primitives` 直接成为 agent-loop 的入口 `index.ts`(见 D52);反向进 engine 的两只叫 `engine-agent-loop-stream-runtime` / `engine-agent-loop-stream-selection`;`content/*.md`(压缩提示词)随 `agent-loop-compact-prompt` 一起搬 | 「功能名打头、按内容命名、不用层字眼」;`name:gate` 131 → 122(`ports` / `selection` / `stream-executor` / `stream-processor` / `stream-runtime` / `ids` / `skill-review` 等重名消失) | 我 |
| D52 | 10-04 | agent-loop 的入口装什么(旧入口只再导出 `stream-runtime` / `selection` 两只,而它们反向进了 engine) | 旧入口的内容随那两只去 engine;前 core/engine 的内核桶 `engine/engine-primitives.ts`(678 行、全是具名再导出)**就是**内核对外的那张脸,原样成为 `agent-loop/index.ts`,92 处 `…/engine/engine-primitives` 引用随之改走 agent-loop 入口;另补三组外面真在用的内核名字(消息来源判据 / `mintTurnPrincipal` / 流发送器 / `IPCEmitter` / 回合序号 / 工具结果文本 / 压缩文件清单 / 引擎端口类型 / 触发器表),外面非测试的深层引用 29 处改走入口,测试不动 | 不这样做,agent-loop 的入口棘轮会因为搬进来的深层引用从 203 涨到 236;改完是 207(+4 全是测试与总桶,见 D62)。入口自己仍有一行 `export *` 的总桶在引它,删总桶时一起清 | 我 |
| D53 | 10-04 | 随内核搬的测试 | 只测搬走文件的测试跟着走:31 份进 `agent-loop/__tests__/`(`core-` 前缀去掉、补 `agent-loop-`),2 份反向进 `engine/__tests__/`,四只触发器的 5 份去 goals / toc / skills,`runtime.test` 去 gateway,`gateway-session-runtime.test` 去包根 `__tests__/assemble-engine-gateway-session.test.ts`;同时测好几只的留在原处 | 测试与被测文件同住,`entry:gate` 量到的才是真耦合;失败集合按搬家表映射路径后比较 | 我 |
| D54 | 10-04 | 断 `turn-principal → collab/drive-guard`(Fable 第 5 节第 2 步) | `ProductStreamEnginePorts` 加第六个可选端口 `collabDrive: { isTrusted(command) }`,**缺席 = 谁也证明不了**(与协调者没起来、没有令牌时同一个答案,失败即关);`mintTurnPrincipal` 多一个参数 `proveCollabDrive`,引擎从端口取;`createBoundStreamEngine` 填 `isTrustedCollabDrive`。`stream-engine.ts` 里房间入口那一处 `isTrustedCollabDrive` 判据本笔不动 | 内核不认识协作功能;生产上端口总是填的,行为逐字相同;那一处房间判据是 engine(L3)→ collab(L3)同层边,不是本笔要断的那条 | 我 |
| D55 | 10-04 | 触发器表(`TriggerManager` / `triggerManager` / `Trigger` / `TriggerContext`)住哪、什么时候拆 | 住内核新文件 `agent-loop/agent-loop-trigger-manager.ts`,经 agent-loop 入口交出;登记函数 `registerBuiltinTriggers`(连同它的模块级闩)进包根 `assemble-engine.ts`。**第 3 步的这一半提前到第 2 步做**:三只触发器搬去 goals / toc / skills 时就得决定 `Trigger` 类型从哪拿,放进组合根等于让三个 L2 功能为一步去引包根,下一步又要改回来 | 零时机变化(实例照旧是模块级 const,登记照旧在装配那一行);每步的模拟读数照实报 | 我 |
| D56 | 10-04 | `stream/stream-executor.ts` 的 `getStreamEngine()` 怎么改成「经已持有的 runtime」 | 引擎经它持有的 runtime 调执行器时把自己交过去:`agent-loop-stream-engine.ts` 的三个 `runtime.streams.executeMessageStream({...})` 各多一格 `streamControllers: this`,执行器只用这四个方法(登记 / 摘 abort 控制器、取追话 / 续话队列);缺了就抛,不回落去读槽 | 生产上 `getStreamEngine()` 读到的就是正在调它的那只引擎,同一个对象;四份直接调执行器的测试从「替身打在组装文件的 getter 上」改成「参数里给替身」,断言不动 | 我 |
| D57 | 10-04 | 读当前引擎的 `getStreamEngine` / `getStreamEngineSafe` 住哪(Fable 第 4 步) | 函数体逐字搬进包根 `current.ts`(它本来就只是读槽);`assemble-engine.ts` 不再导出它们(不留第二条路);goals / collab ×5 / voice / scheduler / headless / music(动态 import)/ RPC 的 chat 与 session-command 改引 `current.js`;12 份测试的替身改打 `current.js` 并 `importOriginal` 展开(sessions-domain 那份并进它已有的那条替身)。`getOnethingRuntime` / `getConversationRuntime` 只有测试用,留在 `assemble-engine.ts` | `current.ts` 零出边(只有类型引用),读引擎的人从此不 import 装引擎的那只组装文件 | 我 |
| D58 | 10-04 | 三只装配件合成一只后,类型名放哪 | `StreamEngine`(= `ProductStreamEngine<EventBus>`)进 `engine/stream-engine.ts` 并经引擎入口交出;`MainOnethingRuntime` 留在 `assemble-engine.ts`(`current.ts` 纯类型引它);`runtime.ts` 进 gateway 叫 `gateway-onething-runtime.ts`;`execution-context.ts` 进 sessions 叫 `session-execution-context.ts` 并经会话入口交出 `fixedExecutionContext`(21 处改走入口) | tasks / plugins / backend / current 要的只是类型名,不该从组合根拿 | 我 |
| D59 | 10-04 | `agent-loop-executor → 总桶`(只为 `hashSections`) | 改引 evals 入口(相对路径 `../../evals/index.js`;包的 exports 没有 evals 入口键,不为一处新增) | Fable 第 5 节的两个选项之一;evals 入口与引擎无环(`cycle:gate` 0) | 我 |
| D60 | 10-04 | 引擎收口:入口交出哪些名字、深层键怎么处理 | 入口按五类具名导出 38 个名字(值 21、类型 17)(引擎本体、装配拆件、拿服务商干活的门面、引擎 runtime 工厂、流运行时钩子类型),全部从声明处导出,R3 说明书写在文件头;旧入口里指向别的功能文件的再导出(`mintTurnPrincipal`、消息来源判据、端口类型)删掉,使用者改从 agent-loop 入口拿;总桶里引擎那几行改从引擎入口拿(边界规则 `checkRuntimeOwnsStreamRuntimeWiring` 要总桶出现那两个名字);exports 删 11 个 `./runtime/engine/*` 深层键,只留 `./runtime/engine`;`evals/turn-incident.ts` 的动态 import 改成引擎入口;测试里 `vi.mock` / 动态 import / 入口没交出的名字留深层(包名改相对,D44),一份同时替身 `engine-process-providers` 的测试保留深层静态 import(改走入口会绕过它自己的替身) | D35 / D39 / D44 同一口径;引擎一行入口棘轮 186 → 29,非测试 0 | 我 |
| D61 | 10-04 | 引擎批让三道棘轮的几行上升 | 接受并收紧(D14 / D50 口径):entry 的 agent-loop 203 → 207(测试与总桶对内核文件的深层引用)、gateway 13 → 14(总桶与组装文件对 `gateway-onething-runtime` 的引用;gateway 入口带着各渠道,不为组装文件把它们拖进来);layer 新增两对:`(包根槽位) → agent-loop` 1(`channel/origin.ts` 引消息来源判据,从前是同一条边指向 engine)、`skills → engine` 1(技能复盘触发器归 skills 之后引引擎的杂活回合,Fable 第 6 节 (c) 类);assembly 基线两行改路径(同一个模块级 `let` 换了文件:`error-details` → `agent-loop-error-details`、`engine/triggers/index` → `assemble-engine`) | 都是真实的耦合换了住处,不是新长出来的;总数 entry 2711 → 2546、layer 97 → 60 | 我 |
| D62 | 10-04 | 总桶 `runtime/index.ts` 那行 `export * from './agent-loop/index.js'` | 删掉 | 它从前转发的是旧 agent-loop 入口那两只(随它们去了 engine,全仓经总桶拿它们的 0 处,tsc 逐个解析过);内核桶成了 agent-loop 入口以后,这一行让总桶在被整只动态 import 时把约 600 个内核名字全挂上,esbuild 摇不掉 —— 实测桌面主进程包多出 50KB(`agent-loop-tool-orchestration` 1290 → 20077 字节等)。删掉后比改前还小 2252 字节。与 D41 同一判法 | 我 |
| D63 | 10-04 | 包根归位 A:`rpc/domains/<d>.ts` 各归哪个功能(D21 修订) | 按内容判,一个域对应一个功能;对应不到同名功能的六处:`app-state` → sessions(当前会话、已读标记、工作区页签树都挂在会话上,`sessions/current-session.ts` 本来就在那里;storage 是 L0、不认识会话)、`channel-identity` → gateway(渠道身份,`channel/` 在 B 部分并进 gateway)、`chat` → engine(停流、活流表、标题、提示词快照都是发对话那台机器的事)、`models` → providers(模型目录查询;目录服务 D24 在 settings,但「哪家有哪些模型」是服务商的事实)、`oauth` → auth、`host-mcp` → acp(ACP A4-a 宿主工具面,桥在 `acp/host-mcp-bridge.ts`);`logs` / `goal` / `permission` + `permission-grants` / `resources` / `evals-access` 分别进 logging / goals / permissions / resource / evals | R1:「X 的界面操作在哪」看功能目录就答得出 | 我 |
| D64 | 10-04 | 一个功能有几只域时合成一只还是分几只 | 分:`<功能>-client-api.ts` 放与功能同名的那只域,其余按方面 `<功能>-client-api-<方面>.ts`(sessions 五只:主 / commands / events / app-state / live-delivery;evals、acp 各三只;permissions、providers、gateway 各两只;全仓 55 只、40 个功能);只有 D30 的「自动识别」并进了 `providers-client-api.ts`(它只服务 `providers.probeCustom`,日志命名空间 `providers.probe` 不变,只把局部变量改名 `probeLog`) | sessions 主域 625 行,三只合成一只是 900 多行;一只域一只文件,搜 `sessions-client-api` 一次出全家(N1 / N2) | 我 |
| D65 | 10-04 | `server/` 里属于具体功能的面放哪 | 只有 HTTP 服务器用的投递件 / 投影 / 单槽端口进那个功能的 client-api 方面文件(`sessions-client-api-live-delivery`、`media-client-api-delivery`、`plugins-client-api-catalog`、`search-client-api-providers`、`settings-client-api-projection`;`mcp-face` → `acp-client-api-host-mcp-face`,因为它守的是 ACP 宿主工具面的桥凭据,不是 MCP 客户端);别的功能也要的 MCP 私密字段规则 `mcp-secrets.ts` 与 server 自己那台 MCP 客户端 `mcp-server-client.ts`(原 `mcp-client.ts`)进 mcp 主体、经 mcp 入口具名交出 | 前者只有 HTTP 服务器引,放第二入口里谁也绕不进去(D26);后者被设置面的出界投影引用,走主入口才不是跨功能深层引用 | 我 |
| D66 | 10-04 | 分发表改成名册的形状 | 每只 client-api 文件用 `defineClientApi({ id, router, handlers, serveBeforeIdentity? })` 交出一行常量 `<域>_CLIENT_API`(`ClientApiRow` 与 `defineClientApi` 住 `http-server/http-server-dispatch-table.ts`);名册 `http-server/http-server-client-api-roster.ts` 是一张有序数组,成员两种:名册行与 feature(轨迹、自进化);挂载时名册行变成 id 照抄、只注册那一个域的 feature,所以 `dumpFeatures()` 的 id / 顺序 / 注册项计数与从前逐字相同;每行上方那段「为什么排在这里」的注释原样留在名册里;函数仍叫 `registerAppRpcDomains` | 与服务商名册 `vendors/manifests.ts` 同一个做法(功能自述、别人读表,R4);装配顺序是行为,注释是它的理由,不能散进各功能 | 我 |
| D67 | 10-04 | HTTP 路由在用户 token 闸前点名 ACP(`serveBridgeRequest`) | 改成名册行的可选格 `serveBeforeIdentity`,路由逐行问 `PRE_IDENTITY_ROWS`(今天只有 `host-mcp` 一行);路由静态 import 名册 —— 加载序不变,路由早就经 server runtime → `backend.ts` 拿到了整张名册;`currentHostMcpBridge` 从 `host-mcp` 域搬进 face 文件,两只文件只剩单向引用 | 不走 `FeatureContext.registerDisposer`:那会让 `rpc:host-mcp` 多一格注册项,`app-rpc-features.test` 钉死的快照会变;未装配的 HTTP 面上 `/api/mcp` 的答复与从前相同 | 我 |
| D68 | 10-04 | D26 的门怎么判 | 新门 `bun run client-api:gate`(`scripts/client-api-gate.mjs`,零基线硬闸,CI 已接):client-api 文件 = `runtime/<功能>/<功能>-client-api[-<方面>].ts`(只看路径,`scripts/lib/backend-structure.mjs` 的 `clientApiFeatureOf`;runtime 里名字带 `-client-api` 却不是这个形状 = 红);允许引它的只有 `http-server/`、同功能的另一只 client-api、测试、例外表里逐对写了理由的两处(`features/builtin/trajectory.ts` → sessions 事件域,B 部分随轨迹归位时消失;`acp-client-api.ts` → `sessions-client-api.ts`,认领远端会话要走 `sessions.create` 同一条路,调用时才动态 import);少于 40 只 client-api 或 3000 个扫描文件 = 红;自检 17 条。`cycle:gate` 的环判据照旧只算主入口 | 说明符采集与解析复用 `entry:gate` 那一份(给它的 `main()` 加了入口守卫,被别的脚本 import 时不跑) | 我 |
| D69 | 10-04 | 第二入口在 entry / layer 两道门里怎么算 | entry:引 client-api 不算深层(谁能引由 D68 管);layer:层次表加一行第二入口槽位 `(开给界面的操作)` L4(`"secondEntry": true`,按「它被谁引、它引谁」:只被 http-server 引、引任何入口,所以与 http-server 同站 L4,不与所属功能同层),加 `http-server` 槽位 L4;http-server 里五只按路径归 L0 的包根槽位:本机信任、RPC 沙箱、租户目录、发现文件读写两只(被 L2 功能当判据或地址簿用,自己只引 storage 与槽位) | 读数:entry 2546 → 2331、layer 60 / 33 → 57 / 31(`acp → (包根)` 与 `(包根槽位) → (包根)` 两对消失,`headless → (包根)` 2 → 1)、name 122 → 109,三份基线已收紧 | 我 |
| D70 | 10-04 | CLI daemon(`headless/backend.ts`)深层 import RPC 资源域的三只投影函数 | 三只函数(`serializeSpec` / `serializeOutcome` / `serializeReadOutcome`)逐字拆进 `runtime/resource/resource-wire-views.ts`,经资源入口交出;界面的资源域与 CLI 都从那里拿 | 不拆就是一个 L3 功能去引别人的第二入口(D68 红);三个出口共用一份投影的理由(K4-b)不变 | 我 |
| D71 | 10-04 | http-server 的入口与宿主怎么引它 | 入口 `http-server/http-server.ts`(exports 键 `./http-server`)按四类交出:HTTP 面、server runtime、发现文件、桌面内嵌与本机信任声明;`apps/server`、`apps/desktop-react/electron/main.ts`、冒烟探针改走它。功能要的小件不走入口(入口会把整台服务器连同 `backend.ts` 拖进来、立刻成环),走九个深层键 `./http-server/http-server-{host-trust,sandbox,tenant-paths,discovery,runtime-facade,dispatch-table,principal,resource-envelope,audience}.js` | 删掉 13 个 `./rpc/*`、`./server/*` 键 | 我 |
| D72 | 10-04 | 搬进 `runtime/` 的文件引包根文件的写法 | 一律写包说明符(`@onething/backend/current.js`、`…/http-server/http-server-x.js`),搬家脚本按需补 exports 键;测试照旧写相对路径 | `architecture-boundaries.test.ts`「runtime 的相对 import 不出 runtime」 | 我 |
| D73 | 10-04 | 迁来的域文件头注释里有 `ipcMain.handle` / `apps/electron/src/main/…` 这类历史句子,runtime 的宿主禁令按字面扫,搬进 runtime 就红 | 改写成人话(「主进程 IPC 的 `handle` 注册」「旧 Vue 宿主主进程的 `ipc/x.ts`」),意思不变 | 那两条规则不剥注释是有意的(防「注释里教人这么写」),不为搬家放松 | 我 |
| D74 | 10-04 | `transport:gate` 的口径 | `forks:` 扫描范围 = `http-server/` 整棵 + 全部 client-api 文件(判据同 D68);基线五行只改路径、数字不变;壳文件 `lines:` 那行指向 `http-server-routes.ts`(732 不变);自检夹具改用新路径 | 量程覆盖「派发树」整体的意图(C0 R2)不变 | 我 |
| D75 | 10-04 | `provider:drill` 改前就是假红(模板还引 s19 删掉的 `./runtime/engine/error-details` 键) | 顺手修:改走 agent-loop 入口 | 与 D45 同一判法 | 我 |

## 可读性判据(D20)

- **R1 找得到**:问「X 在哪」,看 `packages/backend/` 的目录列表就能答出一个目录;一个功能不散在两个以上的目录。
- **R2 名字说人话**:目录名是一个说得清的功能名词(会话、设置、服务商、凭证……),文件名说清这个文件做什么;不用层字眼,不用只有作者懂的缩写。
- **R3 入口即说明书**:每个功能的 `index.ts` 文件头用几句人话写:它是做什么的、对外交出哪几类东西、它依赖哪些功能;交出的名字按类分组,不是一大串 `export *`。
- **R4 方向一眼看得出**:有一张**生成出来**的功能地图(谁依赖谁、按层次排好),放在仓库里并由门保证与代码一致;依赖只朝一个方向(D19)。
- **R5 一个功能能单独读懂**:读一个功能,不需要先读另一个功能的内部文件;功能之间只经入口。
- **R6 小而完整的对外面**:入口交出的名字越少越好;总桶 `runtime/index.ts`(今天约 2300–2760 个名字,口径不同读数不同)最终删除。


## 命名规范(D22,10-04 定)

起因:用户指出「最好不要用一个文件名,不然搜索出来的内容太多了」;并授权「文件命名按行业标准、规范来做」。今天 `packages/backend` 1470 个非测试文件里 132 个文件名重复(`index.ts` 98、`types.ts` 36、`ipc-operations.ts` 20、`runtime.ts` 18、`registry.ts` 17、`manifest.ts` 17、`dialect.ts` 15、`store.ts` 10 ……)。

参照的行业规范:
- Angular 官方风格指南:文件名「先写它属于哪个功能、再写它是什么」,单词之间用连字符;理由正是「用编辑器的模糊搜索能直接找到」(<https://angular.dev/style-guide>)。
- Google TypeScript 风格指南:文件名全小写、单词分隔一致(它用下划线;本仓库全仓已统一用连字符,保持一致比换风格更重要)(<https://google.github.io/styleguide/tsguide.html>)。
- 关于「桶文件」(只做 `export *` 转发的 `index.ts`)的业界经验:它是循环依赖的高发点,会拖慢构建与编辑器、妨碍摇树;Next.js、Atlassian 去掉桶文件后构建与编辑器明显变快(<https://reactuse.com/blog/barrel-files-tree-shaking/>、<https://atharvacm.dev/blog/barrel-exports-hidden-cost>)—— 与本仓库 providers 一个入口 `export *` 全交出去造成 60 模块环的实测一致。

规则:
- **N1 文件名全包唯一**:按文件名搜索只出一个结果。门:`bun run name:gate`,重名数只减不增(今天 132),目标 0。
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
   **前半 10-04 已落地**(文件归位 + 建 `credentials/` + 断三条边 + 三处惰性化,决策 D30–D38;实施结果见 `feature-layers-and-provider-placement-2026-10.md` 第 9 节);
   **收口第一部分 10-04 已落地**(入口只用具名导出、外面的非测试引用全走入口、exports 只留 `./runtime/providers`,决策 D39–D45;实施结果见 `provider-entry-2026-10.md` 第 8 节),
   **第二部分 10-04 已落地**(测试搬家、`nativeTools` 钩子、`Dialect.referenceFor`、入口替身改 `importOriginal`,D42 修订与 D46–D50;同一文档第 9 节)。providers 一行入口棘轮 123 → 19,非测试 0。
3. **engine 归位**(D27,F2→F4)。**10-04 已落地**(内核归 agent-loop、组合根出成包根 `assemble-engine.ts`、触发器各归其主、引擎经入口收口,决策 D51–D62;实施结果见 `feature-layers-and-provider-placement-2026-10.md` 第 10 节)。
4. 其余按层次收口:collab 的叶子下沉、tools access-control、prompts→plugins 等违例逐条结;每个功能收口都过入口无环门。
5. **包根归位**:`server/` 核心 + `rpc/` 分发表 → `http-server/`;`rpc/domains/<d>` → `<d>/<d>-client-api.ts`(D26 第二入口);`server/` 里各功能的面回各功能;`channel/` → gateway;`features/`、`utils/` 按内容归位;删兼容桶 `store.ts`(拆 59 处整块 mock)。
   **A 部分 10-04 已落地**(`http-server/` + 55 只 client-api 文件 + 名册 + `client-api:gate`,决策 D63–D75;落地记录见 `server-client-split-2026-10.md` §6「包根归位 A」);B 部分(`channel/` / `features/` / `utils/` / `store.ts`)待做。
6. **机械改名一批**:去掉 `runtime/`(D11);入口 `index.ts` → `<功能>.ts`(N3);文件名加功能前缀消重名(N1 / N2 / N4);目录单数(N5)。
7. 包名、应用名(N7)。
