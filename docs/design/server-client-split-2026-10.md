# server / client 拆分与合包(2026-10-01 拍板)

> 调查依据:`docs/audit/code-placement-2026-10.md`(全仓地图、依赖矩阵、shared 用法分类、三条路的比较)。
> 方向背景:`docs/design/architecture-direction-2026-10.md` §1(一个后端、其余都是客户端;两个进程)。

## 0. 已拍板的三件事

1. **三个包合并**:core、runtime、backend 合成一个 server 包。
2. **保留一个瘦 shared**:只放 server 与 client 之间的契约(RPC 方法表、请求 / 响应形状、事件词汇、发现文件记录),
   加上**两边必须算出同一个答案**的纯逻辑(会话投影、引用标记、资源地址、权限效果表、文本编辑、斜杠命令表……)。
   shared **不依赖 node、不 import 任何 server 或 client 包**。依赖方向只有一种:`client 侧 → shared ← server 侧`,
   client 与 server 互不 import。
3. **撤销拍板 #25**(「import 了脊柱的算接线、放 backend;其余算逻辑、放 runtime」):合包以后,同一个功能的逻辑与接线
   住同一个目录。

## 1. 四步

| 步 | 内容 | 动到哪 | 为什么排在这 |
| --- | --- | --- | --- |
| ① | shared 瘦身 + 收编两边共用的纯逻辑 + 拆 core ↔ shared 的环 + 立边界门 | shared、core 的共用件、runtime 的 3 个文件、client 侧的 import | 它划出边界;规模小、风险低;做完 client 与 server 在代码上就已分开 |
| ② | 机械合包:core 余下 + runtime + backend → 一个 server 包(gateway 一并) | 只动 server 内部 | ①之后 client 不再碰 server 代码,这一步不牵涉界面 |
| ③ | 按领域把 `runtime/<d>` 与 `wiring/<d>` 合进同一个目录 | server 包内部,逐领域 | 「读代码不用跑七个地方」的真正收益;与②分开,每一步都能单独回退 |
| ④ | 两个进程:Electron 不再装配后端、凭证归后端、客户端能力移出后端、CLI 走 HTTP | Electron 主进程、CLI、凭证 | 另一条线;①–③做完,改的只剩两个壳 |

## 2. 第①步细则

**①a 事件词汇只留一个主人。** 今天 `SESSION_EVENT_TYPES` / `SESSION_COMMAND_TYPES` 定义在 `core/events`,
`shared/events` 又反过来借 core,core 也借 shared —— 一个环。词汇是契约,主人定为 shared;core 改为从 shared 取。
同理 `shared` 里借 core 的其余几处(`defineRouter` 的 `core/ipc`、`core/json`、`core/interaction`、`core/permission`、
`core/tools`、`core/plugins/notify-sound`):属于契约的搬进 shared,属于 server 的让 shared 不再引用。

**①b 只有一边在用的,搬回那一边。**
- 只有 server 用:`defaults/ai-settings.ts`;`defaults/settings.ts` 里的出厂设置(client 只用 `DEFAULT_NETWORK_SETTINGS`
  一个常量 —— 它留在 shared 的一个小文件里,其余归 server)。
- `cli/protocol.ts`:CLI 命令与 daemon 两边都用,daemon 在④退役;①先不动,④随 daemon 处理。
- 零使用:`fonts.ts`、`tool-errors.ts`、`tool-failure-params.ts` —— 删(先 grep 核实)。
- 今天没有客户端调用、但属于 API 的域契约(evals、gateway、scheduler……)**留在 shared**:它们是契约,不是「一边用的东西」。

**①c 收编两边共用的纯逻辑。** 先把 client 侧对 core / runtime 的 import 改成指向**具体文件**(不经桶),算出真正的值依赖
闭包,只搬这个闭包:会话投影(`core/session/projection` 及其依赖)、引用标记(`core/references`)、资源地址
(`core/resource` 里解析 / 比较地址的那几件,不连带工具系统)、权限效果表(`effectPolicyFor` 及其表)、文本编辑
(`core/text`)、斜杠命令表、runtime 的 `prompts/prompt-references`、`pets/rig-spec`(`alu.rig` 是给开发页的,随
rig-spec 一起或留给 server 侧的宠物数据,按依赖定)。server 侧对这些的 import 一并改指 shared(codemod,不留转发壳)。

**①d 立边界门(零基线硬闸,`scripts/headless-boundary-check.ts`)。**
- shared 只 import shared 自己:不许 `@onething/*`、不许 `node:` / node 内建模块、不许 electron。
- client 侧(`apps/desktop-react/src`、`apps/mobile`、`packages/client`)的非测试代码只许 import `@shared/*`、
  `@onething/client` 与自己(`apps/desktop-react/src` → `electron/native-view-protocol.ts` 是页面与主进程之间的协议,
  属 client 内部,单独放行)。测试与 `__fixtures__` 写明理由后放行。
- 现有「壳不许 import runtime 的服务商代码」(P4)并入这一条。

**①e 验收。**
- typecheck:node、desktop、mobile 零错;`server:build`、`build:cli`、`web:build` 成功,web 包无 `node:`;
  桌面主进程按壳的 esbuild 配方打包成功(打到临时目录,不启动应用)。
- 快照逐字不变:vendor-facts、四套线协议、出厂设置冻结;会话投影相关的测试(含 `sessions:hydration-contract` 一类
  可在临时库上跑的)全绿。
- vitest:packages 全量与壳全量的失败集合是基线的子集(基线红见 `architecture-direction-2026-10.md` 各期记录)。
- `sessions:shadow-battery` 与 P0 前的结果逐行相同。
- boundary(含新门)/ transport / log / provider gate 绿。

## 3. 第②步要点(①落地后细化)

- 机械搬迁:只改路径,子目录原样保留,三份 exports 表合成一份;`@onething/core/*`、`@onething/runtime/*` 的 import
  全部 codemod 成新包路径,不留别名。
- 边界检查器里 98 条「X 必须住在某一层」的位置断言:改写为合包后的规矩(例如「引擎骨架目录不点任何领域名」),
  或在说明理由后退役;不许删断言凑绿。
- 包内环与单文件打包:每一小步跑 server / CLI / 桌面主进程打包与 shadow-battery。
- **会和别的会话的在途改动大面积冲突**:挑别的会话都停下的窗口,一次做完一次提交;开工前先问。

## 4. 第③步要点

逐领域(先选最散的:search、mcp、acp、plugins、collab、music),照 provider 试点的做法:先量、立快照、搬、证明不变、
一个领域一笔提交。目标:一个领域在 server 包里只有一个目录。

### 目录规矩(search 立下,2026-10-02 拍平后改写,2026-10-03 去 core 收尾)

**用户拍板(2026-10-02):server 包内部不再区分「接线」与「产品逻辑」。** 一个功能的文件平铺在 `runtime/<d>/` 下,
没有 `wiring/` 子目录。理由:后端只剩一个包、将来只跑在一个后端进程里;「接线」那一层原本是为了让同一份逻辑装进
多个宿主(Vue 主进程、server、CLI daemon、React 壳)而存在的,宿主收敛成一个以后它没有对象了。测试要注入假件,
靠函数参数就行,不需要一层目录来表达。(search 那批立的是「产品住领域根、装配住 `wiring/`」,同一天被这条拍板取代。)

**用户拍板(2026-10-02 / 03):core 也不要了,gateway 是普通功能。** core 的「零依赖骨架」原本是为了让界面那侧复用;
第①步以后界面只许 import `@shared` 与 `@onething/client`,碰不到 core 了,所以这一层同样没有对象。分三批做完(2026-10-03):
批 1 撤掉 core 这一层的规则、14 个小目录并进 runtime;批 2 是 `core/{plugins,session,engine,agent-loop}`;批 3 删掉大桶
`core/index.ts`、根上三只文件各回各家、`core/__tests__/` → 包根 `__tests__/`、gateway 子树 → `runtime/gateway/`,`core/` 目录删除。

**今天的 `packages/backend` 只有两样东西**:

- **包根**:后端的入口与门面 —— `backend.ts`(`createOnethingBackend`)/ `store.ts` / `current.ts` / `host-ports.ts` +
  `server/`(HTTP/SSE 门面,含各宿主门面共用的 `OnethingRuntimeFacade` 契约 `server/runtime-facade.ts`)/ `rpc/` / `stores/` /
  `session/` / `channel/` / `features/` / `provider-binding/` / `utils/` / `__tests__/`。
- **`runtime/<d>/`**:一个功能一个目录,平铺。这个功能的全部文件,不分「产品」「装配」「骨架」。同名冲突按文件**做的事**起名
  (不用 wiring / host / bound / app / assembly / core 这类「层」的字眼);目录桶 `index.ts` 冲突时,领域根的那个留作对外入口,
  另一个按内容改名;内容上是同一件事的两半(例如协议 + 实现)也不合,只在落地记录里列出来。`runtime/<d>/kernel/` 与其他子目录
  一样只是子目录。目录名与包根目录同名会触发 I1,这时按内容另起目录名(去 core 批 1 时包根还有 `events/`,core 的 `events/` 因此先落在 `runtime/event-bus/`;
  收尾整理 2 把包根 `events/` 也搬进 runtime,两半并成 `runtime/events/`)。
- RPC 处理器(`rpc/domains/<d>.ts`)不动 —— RPC 注册表那张表的形状是第④步的事。

**功能入口(用户拍板 2026-10-03)**:每个功能只通过自己的入口 `runtime/<d>/index.ts`(`@onething/backend/runtime/<d>`)对外交出能力;
功能目录里其余文件是内部实现,外面(包根、别的功能、apps、scripts、evals)不许直接引用,目录里的文件互相按相对路径 import。
目的是读一个功能先看它的入口就知道它对外给了什么。一个功能在 `packages/backend/package.json` 的 exports 里只有入口这一个键。
棘轮 `bun run entry:gate`(`scripts/feature-entry-gate.mjs`,基线 `docs/audit/feature-entry-baseline-2026-10.txt`,只许降);
总桶 `runtime/index.ts`(再导出 2337 个名字)最终要拆掉,它在棘轮里单记一行 `(总桶)`。逐功能收口,search 是第一个(见 §6)。

**撤掉的规则**(理由都是同一句:core / gateway 不再是层):

1. core 的专属禁令(`@shared/ipc`、better-sqlite3、MCP / ACP SDK、zod / diff / uuid,以及只许 `@anthropic-ai/sdk` 的第三方包批准表):
   `checkCoreForbiddenImports`、`checkCorePackageDependencies`(批 1)。宿主那一半并进 `checkRuntimeHostBoundary`。
2. 「core 在最底层」、kernel 的 import 闭包(`checkRuntimeDomainKernelImportClosure` 与架构测试里同名那条)(批 1)。
3. 「core 的大桶必须交出这几个名字」(`checkCorePublicExports`,批 1);大桶本身批 3 删掉。
4. 只为「不许回到 core」而立的位置断言:`core/tools/` 下 13 只纯模块、core 的 storage 下 `app-state.ts`(批 1),core 的 engine 下
   `system-prompt-snapshot.ts` / `plugin-context.ts`(批 2);批 3 撤掉装它们的那条 `checkCorePromptContextRegistryOwnedByRuntime`,
   以及 `checkSharedOwnsJsonProtocol` 里「core 下不许有 `json.ts` / 不许有 `./core/json` 键 / 不许在 core 里抄一份」三格
   (后一格没有改成扫整个后端:后端里有几只按需写的本地小帮手,判据只对 core 成立)。
5. 架构测试「core 无宿主 import」、I2(`core/<d>/x.ts` 与 `runtime/<d>/x.ts` 不许同名)(批 3:core 没了)。
6. 「gateway 只依赖 core + `@shared`」(检查器 `checkGatewayHostBoundary` 的依赖那一半、架构测试同名那条)与「runtime 不许 import
   gateway」(架构测试 runtime 那条里的一格)(批 3:gateway 搬进 runtime 成了普通功能)。
7. 「说明符里不许出现 `packages/backend/core/` / `packages/backend/gateway` 仓内路径」两条(`checkMainUsesCorePackageImports`、
   `checkMainUsesGatewayPackageImports`)(批 3:两个目录都没了,runtime 那条照旧管)。
8. 用户插件(仓外)许 import core 包说明符的那个口子(批 3;样例插件零处用它)。

**保留的规则**:

1. client → shared ← server 边界(`checkSharedImportsOnlyShared`、`checkClientImportsOnlySharedAndClient`)。
2. 后端(包根 + runtime)不许 import electron / `@main` / `@preload` / 渲染层别名;runtime 不许 cordis(cordis 只许包根用)。
3. 「子树的非测试相对 import 不出自己的子树」:今天只剩 `runtime/` 一棵,指向包根的一律写包说明符;唯一的口子照旧是 runtime 相对
   import 内部会话模块(`scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles` 不许有 exports 键,批 3 起整个后端包都能碰)。
   测试基建(`__tests__/`、`testing/`)不进 exports。
4. I1(包根目录不与 runtime 领域同名;排除名单只剩 `runtime`)。
5. **内容**断言按新路径继续守:「内核不点名具体功能」(`checkCoreKnowsNoConcreteFeatures`,量接收了 core 文件的 17 个 runtime 目录、
   从 core 并进 `runtime/plugins/` 的 58 只插件契约 / 内核文件、core 根上那三只文件的新家)、「内置插件只经注入的 api 认识宿主」
   (放行的是插件契约那一批文件)、「检索内核不点名能力」、「provider-agnostic 层不点名服务商」、各「X 拥有 Y」的位置断言。
6. `assembly:gate` 量整个 `packages/backend`(批 3 起不再跳过 core / gateway / kernel);新进尺子的文件按当时的值记入基线,只许降。

搬家脚本都在会话 scratchpad 里:`fold-domain.mjs` / `flatten.mjs` / `flatten-wiring-*.mjs`(第③步),`s4-move-core.mjs`
(去 core 批 1:普通文件改名、import / exports 精确键 / 注释路径改写、过时路径按文件名找现址,带 `--dry`)、
`s4-move-core2.mjs`(批 2:换领域表与改名表,过时路径先找 `packages/shared/` 下的原样镜像)、
`s4-dissolve-barrel.mjs` + `s4-move-core3.mjs` + `s4-reformat-imports.mjs`(批 3:拆大桶、按任意源 / 目标表搬家、多行 import 还原)。

## 5. 第④步要点

见 `architecture-direction-2026-10.md` §1:Electron 改为启动 / 停止后台后端(不开机自启,可配置随 Electron 退出或常驻)、
凭证导出(口令加密)→ 迁移 → 后端管理(主密钥进系统钥匙串)、对话框 / 深浅色 / 用户点的打开链接移出后端、
agent 请求打开链接改为卡片按钮、CLI 命令改走 HTTP 而 daemon 退役、插件与 gateway 挂到后端。

## 6. 进度

### ①落地记录(2026-10-01,未提交)

**一句话**:shared 里已经没有任何 `@onething/*` import,core ↔ shared 的环拆掉了;client 侧离开 server 包只差
5 个文件(会话投影的 4 个 + 输入框标记 1 个),它们被别的会话正在改的 `apps/desktop-react/src/data/chat-*`
钉住,本步没动,新门因此有 1 条红(见下面「没做完的」)。

**①a 拆环。** 词汇的主人定为 shared:`core/events/session-{command,event}-types.ts` → `shared/events/`,core 的
引擎从 `@shared/events/session-*-types` 取;`shared/events/session-{commands,events}.ts` 照旧再导出,壳里的 import
一字不改。shared 借 core 的其余几处,属于契约的整块搬进 shared:`core/ipc/index.ts`(`defineRouter` 与类型内核)
并进 `shared/ipc/router.ts`;`core/json.ts` 并进 `shared/json.ts`;`core/events/stream-chunks.ts` 并进
`shared/events/stream-chunks.ts`(连同基形状 `StreamChunkBase`,事件总线反过来从 shared 取);
`core/interaction/types.ts`、`core/plugins/notify-sound.ts`、`core/permission/principal.ts`、`core/mcp/types.ts`、
`core/session/events/{types,origin}.ts`、`core/session/tool-call-inspection.ts`、`core/engine/context-compact-content.ts`
原目录名搬进 shared。只有一两个类型被契约借用、文件本身是后端机制的,只把那几个类型拆出来(原文件从 shared 取):
`LogLevel` → `shared/logging/types.ts`;`CoreMCPProbeResult` → `shared/mcp/types.ts`;内存报告的 8 个形状 →
`shared/memory/types.ts`;`PermissionGrant` / `PermissionGrantScope` → `shared/permission/grant.ts`(原文件要用
`node:crypto`,不能整个搬);`JsonSchema` → `shared/toolkit/json-schema.ts`;轨迹树的 10 个形状 →
`shared/session/trace/types.ts`;`RuntimeHostCapabilities` → `shared/contracts/runtime-capabilities.ts`。
`cli/protocol.ts` 没有搬,只是它 import `Principal` 的那一行跟着改指 `../permission/principal.js`。

**①b。** `defaults/settings.ts` 与 `defaults/ai-settings.ts` 搬到 `packages/backend/stores/defaults/`(只有后端在用;
runtime 只有测试在用,测试不受包方向约束,所以不放 runtime —— 放 runtime 还得改名成 `*.wiring.ts` 才能说
`@shared/ipc`);`DEFAULT_NETWORK_SETTINGS` 留在 `shared/defaults/network.ts`,后端那份出厂设置从这里取。
三份测试跟着模块走到 `backend/stores/defaults/__tests__/`。backend 的 exports 表加了两格
(`./stores/defaults/{settings,ai-settings}.js`,给 runtime 与壳的测试用)。零使用的 `fonts.ts`(连同只测它的
`fonts.test.ts`,12 条)、`tool-errors.ts`、`tool-failure-params.ts` 已删。

**①c。** 先用类型检查器把 client 侧的每个名字落到定义它的文件,再从这些文件沿值导入求闭包。闭包起初有 41 个
文件、1.3 万行 —— 投影的折叠器为了两句报错文案和两个步骤标题,一路拖进了引擎本体(`agent-loop-executor.ts`
2751 行)、`stream-processor`、`tool-orchestration` 和整套日志内核。这几件是纯的,拆出来:两句报错 →
`shared/engine/tool-call-errors.ts`,步骤类型与标题 → `shared/engine/tool-step.ts`;引擎改从 shared 取。拆完闭包
只剩投影真正要的东西,日志、引擎、调度器全部出局。搬进 shared 的(原目录名):`references/`(整个编解码器目录,
含 `plain-text-stream.ts` 与 `index.ts` —— 它的「陌生能力演练」测试按目录断言文件清单,拆开就要改断言)、
`text/line-edit.ts`、`resource/ref.ts`、`toolkit/effects.ts`、`slash-commands.ts`、`permission/rejection-message.ts`、
`tools/tool-result.ts`、`engine/tool-step.ts`、`session/interrupted.ts`、`session/events/chunk-codec.ts`、
`session/projection/{surface,stop-reasons}.ts`、runtime 的 `pets/rig-spec.ts` 与 `pets/builtin/alu.rig.ts`。
`alu.rig` 随 rig-spec 一起搬:它是纯数据(只 import rig-spec 的类型),后端的宠物清单与开发页都直接用它;
让开发页改走 RPC 会改变那一页的行为。只测这些模块的 12 份测试跟着搬到 shared 的 `__tests__`;既测它们又测
后端代码的测试留在原处,只改 import。server 侧对这些模块的 import 全部用脚本改指 `@shared/...`(按类型检查器
解析出的定义文件改,不按字符串;core / runtime 的桶里对它们的再导出直接删掉,没有留转发壳)。core 的 exports
表删了失效的 10 格(`./ipc`、`./json`、`./text`、`./references`、`./references/*`、`./slash-commands`、
`./resource/ref`、`./session/events/chunk-codec`、`./session/projection/stop-reasons`、`./plugins/notify-sound`)。
手机的 tsconfig 删掉了 `@onething/core/*` 那条路径别名 —— 手机从此在结构上就看不见 core。

**①d 新门**(`scripts/headless-boundary-check.ts`,零基线硬闸):
- `checkSharedImportsOnlyShared`:shared 的非测试代码只许 import shared 自己;不许 `@onething/*`、node 内建、electron、
  第三方包。测试另放行 `vitest` 与 node 内建。唯一的点名放行是 `shared/backend/http-discovery.ts` 的四个 `node:`
  内建,理由写在检查器里(见「待拍」)。
- `checkClientImportsOnlySharedAndClient`:`apps/desktop-react/src`、`apps/mobile/{app,src}`、`packages/client` 的非测试
  代码只许 import `@shared/*`、`@onething/client` 与自己;类型导入一样算。`src → electron/native-view-protocol` 单独
  放行;测试与 `__fixtures__` 放行。P4 的 `checkReactShellReadsProvidersOverRpc` 是它的子集,已并入并删除。
- 注入验证:在 shared、壳、client 包各放一个探针文件(`node:fs`、`@onething/core/...`、爬出包外的相对路径、
  `@onething/runtime/...`、`../electron/main`),两条都当场红;`../electron/native-view-protocol` 不红。探针已删。

**跟着改的旧规矩**(意图不变,只是主人换了住址,都写了理由):会话词汇门的两张权威表改指 shared;四条
「packages/core owns …」(工具失败参数摘要、权限拒绝文案、流式块协议、JSON 协议)改成「packages/shared owns …」,
「不许重抄一份」的禁令从 shared 挪到 core 一侧,退役的再导出门面不许回来;「core 工具帮手测试」那条把
`tool-result.test.ts` 的必需位置改到 shared;内置插件那条放行 `@shared/*` 但仍禁 `@shared/ipc`(`log-monitor`
从前经 `@onething/core/events` 取词汇,现在只能经 shared)。`architecture-boundaries.test.ts` 没有冲突的断言,未改。
provider 棘轮基线里 7 行 `packages/shared/defaults/settings.ts` 改成新路径(文件原样搬家,对数不变)。

**其余搬动**:`shared/ipc/__tests__/permission-response-mirrors.test.ts` 搬到 `backend/wiring/permission/__tests__/`
—— 它拿 core 的 `Permission.Response` 与 shared 的两份镜像做编译期比对,而 shared 的测试从此不许 import core;
比对的意图原样保留。codemod 产出的 150 行超长单行 import 按周围风格折成了多行,纯排版。git 状态:`git mv` 的
改名已暂存,8 个新拆出来的 shared 文件未跟踪,没有提交。

**改了断言数据的测试(只有一处,搬家逼出来的)**:`core/resource/__tests__/stranger.test.ts` 按目录断言内核的
文件清单,`ref.ts` 搬走后清单里删掉了它,同时把 `shared/resource/ref.ts` 加进同一道「不许出现能力名字」的扫描,
覆盖面没有缩。另有两处是源码里指向测试文件的路径字符串(`ephemeral-policy.ts` 的证明指针、两条注释),跟着改。

**没做完的(被别的会话的文件钉住)**:下面 5 个文件仍在 server 包里,因为搬它们就得改 `apps/desktop-react/src/data/chat-*`:
`core/session/projection/{reducer,chat-messages,blobs}.ts`、`core/session/render-anchors.ts`(`chat-source.ts`、
`chat-materialize.ts`、`chat-fold.ts`、`chat-materialize.test.ts` 在 import 它们)与 runtime 的
`prompts/prompt-references.ts`(`chat-port.test.ts` 在 import 它)。它们的依赖已经全部在 shared 里,所以收尾只是
5 个 `git mv` + 改那几个 chat-* 文件的 import 行 + 其余 client 文件(`content/assemble/anchor.ts`、
`data/page-references.ts`、`references/kinds/{dir,file}.ts`)的 import 行。在那之前,新门的 client 一条是红的,
红的就是这 7 个文件。

**待拍**:①`shared/backend/http-discovery.ts` 是 shared 里唯一碰 node 的文件(读发现文件、判活),后端与
`@onething/client/node` 都要它,两边互不 import,照抄两份又违背它文件头的判例 —— 本步点名放行;合包以后它该
去哪(例如 client SDK 的 node 入口拥有它、后端经 client 包读),需要拍。②runtime 与壳各有几份测试为了拿一份
完整的出厂设置 import 了 `@onething/backend/stores/defaults/*`(测试不受包方向约束,但读起来是「client 测试碰了
server 包」)。③`bun run assembly:gate` 是红的,红在本步没碰过的 `wiring/music/radio.ts`(模块级 let 9 → 10),与本步无关。


**①收尾(提交时补)**:被别的会话未提交的 `src/data/chat-*` 钉住的 5 个模块(会话投影的 `reducer` / `chat-messages` /
`blobs`、`render-anchors`、runtime 的 `prompt-references`)暂留 server 侧;边界门里用 `CLIENT_SIDE_PENDING_MOVES`
**临时放行**那 8 条具体 import —— 只许删不许加,每一条必须仍命中真实 import,搬完即红提示删除。等那批文件落定后补搬。

### ①收尾 + ②落地记录(2026-10-02,未提交)

**一句话**:client 侧对 server 包的 import 清零,`CLIENT_SIDE_PENDING_MOVES` 整张表删掉;`@onething/core`、
`@onething/runtime`、`@onething/gateway` 三个包原样并进 `@onething/backend`(子树 `core/`、`runtime/`、`gateway/`),
workspace 只剩 `packages/backend` 与 `packages/client`;shared 里最后一个碰 node 的文件(发现文件)拆完,shared 的
边界门不再有任何点名放行。只改了路径与配置,没有合并任何领域目录(那是第③步)。

**①收尾。** 搬进 shared 的(原目录名,`git mv`):`core/session/projection/{reducer,chat-messages,blobs,types}.ts` →
`shared/session/projection/`,`core/session/render-anchors.ts` → `shared/session/`,runtime 的
`prompts/prompt-references.ts` → `shared/prompts/`。比 brief 多一个 `projection/types.ts`:reducer 与 chat-messages
都从它取类型,而 shared 不许 import core,它的依赖又全在 shared 里 —— 不搬就搬不动另外两个。只测这些模块的 3 份测试
跟着搬(`projection-{crash-half,retry-discard}.test.ts` → `shared/session/__tests__/`,`prompt-references.test.ts` →
`shared/prompts/__tests__/`)。import 改写用类型检查器按「名字定义在哪个文件」改(含经 `@onething/core/session`、
`../projection/index.js` 这类桶拿到名字的 18 处拆行),core 投影桶与 runtime prompts 桶里对它们的 5 行再导出删掉,
core exports 表删掉失效的 3 格;bun 跑的三个脚本(`session-verify.ts`、`session-hydration-contract.ts`、
`search-corpus-extract.mjs`)与 3 处测试里的动态 `import()` 也一并改指 shared。**被别的会话钉住的 `src/data/chat-*`
只改了 import 语句的模块路径**,共 7 行;其中 `chat-materialize.ts` 那一条一次从 core 的会话桶拿四个名字、分别定义在
三个文件里 —— 只许改路径、不许拆行,所以在 `shared/session/projection/` 立了一个目录桶 `index.ts`(就是 core 投影桶
原来的前四行,随文件一起搬来),那一行指向它。

**②机械合包。**
- 搬家(一律 `git mv`,子目录原样):`packages/core/*` → `packages/backend/core/`(380 个文件),
  `packages/onething-runtime/src/*` → `packages/backend/runtime/`(1551),`packages/gateway/src/*` →
  `packages/backend/gateway/`(34);三个包的 `package.json` 与 runtime / gateway 的 `tsconfig.json` 删除。
- import 改写:`@onething/(core|runtime|gateway)…` → `@onething/backend/(core|runtime|gateway)…`(2764 处),
  `packages/core`、`packages/onething-runtime/src`、`packages/gateway/src` 的字面路径同步改(约 700 处,含注释);
  搬家改了深度的相对路径按「搬家前解析到哪个文件」重算(22 处,含 `new URL('…', import.meta.url)` 与测试里拼的夹具
  路径;搬家后再用「HEAD 树里落得到、现在落空」的体检扫了一遍全仓,清零)。
- `packages/backend/package.json`:`exports` 由仓里实际出现的 import 说明符生成,精确键、无通配兜底 —— 原有 83 格不动,
  新增 329 格(`./core/…`、`./runtime/…`、`./gateway/core`;旧包里键名与文件名不一致的映射原样保留,例如
  `./core/search/index` → `./core/search/index/index.ts`、`./runtime/gateway` → `./runtime/gateway-runtime.ts`)。
  `dependencies` 合并三个包的第三方依赖(`@zip.js/zip.js`、`pinyin-pro`、`undici`、`ws` 从 runtime 并入;`diff`、
  `yaml` 两边同版本),指向自己的 `@onething/*` 删除。`packages/client/package.json` 里早已不用的
  core 依赖一并删除(①之后 client 不 import 任何 server 包)。
- 锁文件:`npm install --package-lock-only` 与 `bun install` 重生成,只有 workspace 条目变化
  (`package-lock.json` +4 / −44,`bun.lock` +4 / −35);`node_modules/@onething` 只剩 `backend`、`client` 两个链接。
- 配置:根 `package.json` 的 `workspaces`、`tsconfig.node.json` 的 include、`eslint.config.js` 的两区路径、
  `apps/desktop-react/scripts/build-electron.mjs` 的 `SEARCH_WORKER_ENTRY` / `ACP_MCP_BRIDGE_ENTRY`、
  `.github/workflows/test.yml` 的测试清单、`apps/server/package.json`。`electron-builder.yml`、`apps/server/vite.config.ts`、
  `scripts/build-*.mjs`、手机的 Metro / tsconfig 里没有这三个包的路径,无需改。

**守门改写**(意图不变;按旧路径写的一律只改路径,失去意义的改成等价的目录规则并写明理由):
- 路径改写:`scripts/headless-boundary-check.ts` 里约 425 处字面路径与其中按转义写的正则;
  `architecture-boundaries.test.ts`、provider 棘轮(连同基线 75 行,对数仍是 111)、`log-check`、`session-check`、
  `provider-vendor-drill`、`backend-public-boundary` 的测试夹具同步。
- 改成目录规则的 8 条:①「core 的 `package.json` 只许批准过的依赖」→ core 子树的非测试代码不许 import 第三方包
  (批准表照旧);②「json 出口已退役」→ 合并清单里不许有 `./core/json`;③「runtime 清单要有 `./voice/*`」→ 合并清单
  要有 `./runtime/voice/providers`;④「runtime 不许 import `@onething/backend`」→ 不许 import 脊柱(包根或三棵子树以外的
  子路径),`providers/base` 的同款断言一并改;⑤ 新增「三棵子树的非测试相对 import 不出自己的子树」—— 包边界没了,
  相对路径能直接摸到脊柱,这条是那道包边界的目录形态(今天零越界,注入探针验过会红);⑥ I1 不把 `core/`、`runtime/`、
  `gateway/` 当领域名比对;⑦「宿主边界 / 插件测试 / 公开边界」三处原来以「住在 backend 包里」判装配层,改按
  「脊柱 = 三棵子树以外」判;⑧ `assembly-gate` 只量装配层,三棵子树按目录排除(它们合包前就不在扫描根里)。
  扫描根把 backend 与其子树并列的(`log-check`、provider 棘轮、会话词汇门)去掉重复的子树,免得同一处报两遍。
  边界门的断言总数合包前后都是 139。

**发现文件(待拍①落定)。** `shared/backend/http-discovery.ts` 只留记录形状、白名单式解析与 `httpDiscoveryUrl`;
碰 node 的读与两段判活拆成两份最小实现 —— `packages/backend/server/http-discovery-io.ts`(后端)与
`packages/client/http-discovery-io.ts`(`@onething/client/node`,多 store 根目录的三段解析)—— 逐字同形,
新测试 `backend/server/__tests__/http-discovery-io-parity.test.ts` 拿同一组样例(7 份文件、6 个 pid、4 种判活情形)
证明两份同答。边界门里 shared 的 node 豁免表删除。

**一处运行时可见的字符串变了**:`gateway/index.ts` 独立运行缺 runtime 时的报错提示里写着包名,随改名从
`@onething/runtime` 变成 `@onething/backend/runtime`(旧名已不存在,不改就是指错路)。

**不变的证据**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、`web:build` 成功,web 包无 `node:`;
桌面主进程四个 bundle 按壳的配方打到临时目录成功;packages 全量失败集合与改前逐条相同(19 条既有红,路径按搬家映射
后比对),壳全量同一条既有红;vendor-facts、四套线协议、出厂设置冻结快照没有一个 `.snap` 被改;shadow-battery 与改前
逐行相同(遮掉临时路径与会话 id;`refoldChecks` 是按时机采样的计数,一次跑出 216、复跑两次都是 217,与改前一致);
boundary / transport / log / provider gate 绿,assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10 那一条;
`gate:native` 7 个目标全过。`provider-vendor-drill` 用 `git worktree add HEAD` 起演练树,未提交时它量的是旧布局,
所以本步是在「HEAD + 工作区改动」铺出来的临时树上跑的同一套四条断言,全绿;提交之后直接跑脚本即可。

**仍在的字面旧路径**:只剩文档与历史记录 —— `docs/`、`apps/desktop-react/docs/`、`README.md`、`RESOURCES.md`、
`evals/*.md`、`resources/skills/onething-verification/SKILL.md`、`.pi-glla/` 的历史 JSON、`.design-sync/` 的样例与出处字段;
测试里当假目录树用的 `packages/core`(`files-panel.test.tsx`、`files-source.test.ts`、`gate-files.mjs`、
`wiring/tasks/__tests__/dispatch.test.ts` 的提示词文本)与搜索夹具 `corpus.json` 里的真实会话文本是数据,不改;
别的会话在途的 `src/data/chat-{fold,source}.ts` 里有 3 行注释提到旧路径,只许改 import 路径,没动。

### ③-search 落地记录(2026-10-02,未提交)

**一句话**:search 在 server 包里只剩一个家 `runtime/search/`。`core/search`(52 个文件,含测试与夹具)并进
`runtime/search/kernel/`,`backend/wiring/search`(15 个,含 7 份测试)并进 `runtime/search/wiring/`,一律 `git mv`;
`rpc/domains/search.ts` 按约定没动(第④步)。目录规矩见 §4「目录规矩」。

**搬家与改写**(会话 scratchpad 的 `fold-domain.mjs search --kernel` 一次做完,在 HEAD 的临时 worktree 上重放一遍与
主检出逐字相同):
- 包说明符 `@onething/backend/core/search…` → `@onething/backend/runtime/search/kernel…`;脊柱里指向接线的
  `./wiring/search/…`(`backend.ts`)、`../wiring/search/…`(`server/runtime.ts`)、`../search/…`(`wiring/plugins/api.ts`)
  与 `import-side-effect-free.test.ts` 的动态 import 改成 `@onething/backend/runtime/search/wiring…`。
- 接线里指向脊柱的相对 import 改成包说明符(`stores/*`、`utils/ripgrep`、`store`、`events/*`、`session/access`、
  `wiring/{logging,notes,settings,engine,plugins,toolkit}/*`、`server/host-trust`、`rpc/domains/search`);
  **`session/reads.js`、`session/event-log.js` 两处保持相对路径**(源文件与测试里的 `vi.mock` 各一处),理由见 §4 第 3 条。
- 夹具路径跟着落点重算:`golden-snapshot` / `corpus` / `semantic` 三份测试拼的 `…/core/search/__tests__/fixtures`、
  `fixtures.test.ts` 指向 `scripts/lib/search-corpus-redact.mjs` 的那一级、`scripts/lib/search-corpus-redact.mjs` 的再导出、
  `gate-search-index.mjs` 与 `search-corpus-extract.mjs` 读写夹具的字面路径。
- 注释里的旧路径同步改(壳的 i18n / SearchFooter / SearchPanel.test / search-settings-source、`packages/shared/ipc/search.ts`、
  兄弟接线 `acp/mcp-bridge-path`、`notes/index`、`pets/chattiness`、`skills/note-vault-roots`、build-electron.mjs 的说明);
  根 `CLAUDE.md` 的五处路径与 `wiring/<domain>/` 那句目录清单(原写 33 个且早已过时,改成今天的 41 个,search 已不在其中)。
  `docs/` 与各 app 的 `docs/` 是历史,不改。
- `packages/backend/package.json` exports:改名 6 格(`./core/search{,/__tests__/index-contract,/__tests__/unit-fixtures/corpus,
  /index/types,/redact}` → `./runtime/search/kernel…`,`./wiring/search/providers.js` → `./runtime/search/wiring/providers`,
  挪到 `./runtime/search` 那一组后面),新增 10 格:`./runtime/search/wiring`、`./runtime/search/wiring/plugin-search-registry`,
  以及脊柱的 `./events/event-bus.js`、`./rpc/domains/search.js`、`./session/access.js`、`./stores/app-state.js`、
  `./wiring/engine/execution-context.js`、`./wiring/plugins/api.js`、`./wiring/toolkit/{catalog,runner}.js`。
- Worker 产物的位置契约不受影响:`runtime/search/wiring/worker.ts` 按宿主 bundle 自己的 `import.meta.url` 找旁边的
  `search-worker.cjs`,源码住哪不进这条算术;Worker 入口 `runtime/search/index/worker.ts` 没动,三份构建配方无需改。

**守门改写**(语义不放松;前四条是新规矩,后面是路径改写):
1. 边界检查器 `checkCoreForbiddenImports` 同时扫 `runtime/*/kernel`(目录现算,不写领域名);新增
   `checkRuntimeDomainKernelImportClosure`(kernel 只许 import 自己目录 / `@onething/backend/core/**` / node 内建)与
   `checkRuntimeProductDoesNotImportDomainWiring`(runtime 里不在 `wiring/` 目录的非测试文件不许 import `runtime/*/wiring/**`,
   包说明符与相对路径都判)。`checkRuntimeHostBoundary` 让 `runtime/<d>/wiring/**` 吃脊柱那套规则(`APP_ASSEMBLY_FORBIDDEN_PATTERNS`),
   `checkRuntimeWiringModulesStayAtTheEdge` 对它豁免;两种 wiring 的关系写在 `isRuntimeDomainWiringFile` 的注释里。
   断言总数 139 → 141。
2. `architecture-boundaries.test.ts`:「core 不碰 electron / 宿主」扫 core 加每个 `runtime/*/kernel`;新增「kernel 在最底层」
   一条(13 条);「runtime 产品层不许 import 脊柱」与「三棵子树相对 import 不出子树」对 `runtime/<d>/wiring/**` 豁免。
   检查器里没有与前者同名的断言(查过),无需豁免。I1 / I2 不受影响(`core/search` 没了,`search` 退出 I2 的比对)。
3. `scripts/lib/backend-public-boundary.mjs`:「内部会话模块只许脊柱碰」那条把 `runtime/<d>/wiring/**` 算作脊柱。
4. `assembly:gate`:runtime 子树照旧不量,但下钻量每个 `runtime/<d>/wiring/`;基线里 `wiring/search/providers.ts 1`
   改写为新路径,数字不变。transport / log / session / provider 四门的基线与白名单里没有 search 的旧路径。
5. 路径改写:「检索只有一条查询路」的尸检表与 `facadeFile`(扫描树表里与 `runtime/search` 重复的那一格删掉,写了注释)、
   「内核不点任何能力名」的目标目录。后者原来目录不在时打一行 ok(「S1 pending」),改成目录不在就红 —— 这是收紧。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功,`dist/{server,cli}/search-worker.cjs`
都在(1283480 → 1283608 字节,多出的是 bundle 里 12 条模块路径注释变长);桌面四个 bundle 打到临时目录成功;
`golden-hit-sets.json` 没动,三份 json 夹具是纯改名(`git diff -M --stat` 0 行增删);根全量 vitest 改前 11418 条 / 20 红,
改后 11419 条(多的是新断言)/ 19 红 —— 少的那条 `model-registry-abort` 是偶发红,单跑三次全绿,其余 19 条逐条相同;
壳全量 7344 条,同一条 summon-entries A9 红;`gate:search-index` 改前改后同为 71 ok + 4 FAIL,失败的步完全相同
(⑤d ×2 是第②步合包后 `grep -r packages/backend` 把 runtime 也扫进来的既有红,改后只是命中的路径换成新址;⑤c 计时、
⑪a 既有);boundary / transport / log / session / provider gate 绿,assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10;
`provider-vendor-drill` 在 HEAD 上与「HEAD + 工作区改动」上都绿。新规矩自证:在 `kernel/redact.ts` 加一行
`import … from '../service.js'`、在 `runtime/search/service.ts` 加一行 `./wiring/index.js` 与一行
`@onething/backend/runtime/search/wiring/worker`,边界门三条红、架构测试那条红,撤掉后回绿。
`git grep -nE "core/search|wiring/search"` 在代码 / 配置 / 脚本里为零,剩下的都在 `docs/` 与 `apps/desktop-react/docs/`。

### ③-mcp 落地记录(2026-10-02,未提交)

**一句话**:mcp 在 server 包里只剩一个家 `runtime/mcp/`。`core/mcp`(14 个文件,含测试)并进 `runtime/mcp/kernel/`,
`backend/wiring/mcp`(`subsystem.ts` 与它的测试,2 个)并进 `runtime/mcp/wiring/`,一律 `git mv`,脚本同上
(`fold-domain.mjs mcp --kernel`)。`rpc/domains/mcp.ts` 没动。领域根原有的 `manager.ts` / `index.ts` / `types.ts` 与
kernel 里的同名文件分住两层目录,不冲突;`bridge.wiring.ts` / `index.wiring.ts` 两个后缀文件原样不动。

**为什么算专属内核**:`core/mcp` 的真 importer 只有 mcp 领域自己(`runtime/mcp/{client,index,manager,bridge.wiring}.ts`
与 4 份测试)和脊柱(`host-ports.ts`、`server/{mcp-client,runtime}.ts`、`wiring/resource/mcp-provider.ts` 与 2 份测试)。
搬家时多查出一处:core 的大桶 `core/index.ts` 再导出了 mcp 的 41 个名字 —— 全仓**没有一处**经大桶拿这些名字
(按 import 语句里的名字逐个对过),所以删掉了这两段再导出,留一段注释写明去向。不删就是 core → runtime 的倒挂。

**改写**:
- 包说明符 `@onething/backend/core/mcp` → `@onething/backend/runtime/mcp/kernel`;`backend.ts` / `server/runtime.ts` 里的
  `./wiring/mcp/subsystem.js`、`../wiring/mcp/subsystem.js` → `@onething/backend/runtime/mcp/wiring/subsystem`。
- kernel 里三处 `../logging/index.js`(core 的日志)改成 `@onething/backend/core/logging`(相对路径会爬出 runtime 子树);
  接线与它的测试里的 `../logging/index.js` 改成 `@onething/backend/wiring/logging/index.js`。
- 注释与路径:`smoke-core-boot.mjs`、`assembly-lifecycle.test.ts`、`wiring/acp/subsystem{,.test}.ts`、`server/runtime.ts`、
  `packages/shared/{ipc/mcp.ts,ipc/__tests__/mcp-types.test.ts,mcp/types.ts}`、`toolkit/{families/external,guard-projection}.ts`、
  `scripts/probe-go-to-implementation.mjs`;根 `CLAUDE.md` 里 `McpSubsystem` 的路径、MCP 一节、core 子树目录清单、
  `wiring/<domain>/` 清单(41 → 40)与 I2 白名单那句。
- exports:改名 1 格(`./core/mcp` → `./runtime/mcp/kernel`),新增 1 格(`./runtime/mcp/wiring/subsystem`)。

**守门改写**:
1. kernel 闭包放开 `@shared/*`(检查器 `checkRuntimeDomainKernelImportClosure` 与架构测试「kernel 在最底层」同步),理由见 §4 第 1 条。
2. 检查器 `checkCorePublicExports`(「core 大桶要交出这几个公开接口」):`HeadlessMCPManager` 改由
   `runtime/mcp/kernel/index.ts` 交出,其余五个照旧问 core 大桶;桶文件不在也算缺。
3. I2 白名单删掉 `mcp/manager.ts` 一格(只减不增;core 那半已并进 `runtime/mcp/kernel/manager.ts`),剩 3 格。
4. 其余边界门、assembly / transport / log / session / provider 基线里没有 mcp 的旧路径。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功;桌面四个 bundle 打到临时目录成功;
根全量 vitest 前后都是 11419 条 / 19 红,失败集合逐条相同;壳 7344 条,同一条 A9 红;mcp / acp / resource-mcp /
assembly-lifecycle / mcp-wiring / 架构测试的重点子集前后都是 53 个文件 417 条全绿;`gate:acp`(node 跑 `dist/server` + 临时 store +
假 agent,含 ⑰ MCP 桥)前后都是 108 条 ok、0 红,㉒ 照旧按 opt-in 跳过;boundary / transport / log / session / provider gate 绿,
assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10;`provider-vendor-drill` 绿。`smoke:core` 有一条 MCP 早退泳道,但它
同一次运行里还要起 Electron 与隐藏窗口、不能单挑泳道,本批没跑。新规矩自证:`kernel/router.ts` 加一行 `../manager.js`
(领域根的产品文件)、`client.ts` 加一行 `./wiring/subsystem.js`、`bridge.wiring.ts` 加一行
`@onething/backend/runtime/mcp/wiring/subsystem`,边界门两条红(后缀文件也被新规矩拦住,窄口不含装配层)、
架构测试那条红,撤掉后回绿。`git grep -nE "core/mcp|wiring/mcp"` 在代码 / 配置 / 脚本里为零,剩下的在 `docs/`
与 `.pi-glla/` 的历史 JSON 里。

### ③-acp 落地记录(2026-10-02,未提交)

**一句话**:acp 在 server 包里只剩一个家 `runtime/acp/`。没有 `core/acp`,只搬接线:`backend/wiring/acp`(17 件 + 14 份测试,
共 31 个文件)并进 `runtime/acp/wiring/`,`git mv`,脚本同上(`fold-domain.mjs acp`,不带 `--kernel`)。`rpc/domains/{acp,host-mcp}.ts`
没搬(只改了 import)。`runtime/acp/` 与 `wiring/acp/` 没有同名文件(两边各有一个 `__tests__/`,搬后分住 `runtime/acp/__tests__/` 与
`runtime/acp/wiring/__tests__/`,不相交),无需改名。

**stdio 桥的构建契约不受影响**:桥的入口 `ACP_MCP_BRIDGE_ENTRY = packages/backend/runtime/acp/mcp-bridge/entry.ts` 本来就在
产品层、不在 `wiring/acp` 下,三份配方(`build-electron.mjs` 第四个 esbuild、`build-cli.mjs` 第三个、`build-server.mjs` ③)一字没改;
找产物的 `mcp-bridge-path.ts` 搬到 `runtime/acp/wiring/` 后仍按宿主 bundle 自己的 `import.meta.url` 往旁边找,源码住哪不进算术。
改后 `dist/{cli,server}/acp-mcp-bridge.cjs` 都在(748863 字节,与改前同),桌面四个 bundle 里也有它。

**改写**:
- 包说明符 `@onething/backend/wiring/acp/permission-bridge.js` → `@onething/backend/runtime/acp/wiring/permission-bridge`
  (桌面壳 `electron/main.ts`);脊柱里的相对 import(`backend.ts`、`server/{runtime,mcp-face}.ts`、`rpc/domains/{acp,host-mcp}.ts`、
  `wiring/{headless/backend,external-agents/index}.ts` 与 4 份测试)改成
  `@onething/backend/runtime/acp/wiring/…`。
- 接线里指向脊柱的相对 import 改成包说明符(`events/index`、`stores/{settings,sessions}`、`server/discovery`、`current`、
  `wiring/{logging,external-agents,interaction,permission,toolkit,tools,todo-plan}/…`);这批没有内部会话模块。
- 测试 `registry.test.ts` 按 `__dirname` 找出厂名册 `resources/acp-agents` 的那一级重算(多一层 `../`)。
- 注释与配置:`electron-builder.yml` 的 asarUnpack 说明、`build-electron.mjs` 说明、runtime / stores 里提到接线路径的注释、
  provider 棘轮基线里一行路径(`claude packages/backend/wiring/acp/elicitation-bridge.ts` → 新址,对数仍是 111)、
  检查器 `checkRuntimeOwnsAcpClientRuntime` 里「接线不许自带 client / manager / types / index」的四个路径;根 `CLAUDE.md`
  的 `AcpSubsystem` 路径、MCP / ACP 一节、`wiring/<domain>/` 清单(40 → 39)与目录树注释。
- exports:改名 1 格(`./wiring/acp/permission-bridge.js` → `./runtime/acp/wiring/permission-bridge`),新增 16 格:
  `./runtime/acp/wiring/{events,host-mcp-bridge,host-mcp-port,projections,registry,session-lifecycle,subsystem}`,以及脊柱的
  `./current.js`、`./wiring/external-agents/{host-tools,spawn-env}.js`、`./wiring/interaction/no-human.js`、
  `./wiring/permission/message-anchor.js`、`./wiring/toolkit/{audit-sink,authorizer,file-adapters}.js`、
  `./wiring/tools/core/permission-policy.js`。

**守门**:规则本身这批没改;assembly 基线里没有 acp 的行;边界门断言数仍是 141,零红。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功,三份 `acp-mcp-bridge.cjs` 都在;
根全量 vitest 前后都是 11419 条 / 19 红,失败集合逐条相同;壳 7344 条,同一条 A9 红;acp 重点子集(`runtime/acp`、接线、
`external-agents` 两半、acp / host-mcp 两个 RPC 域测试、`acp-start`、`host-mcp-face`、`acp-defaults`、assembly-lifecycle、架构测试)
前后都是 49 个文件 421 条全绿;`gate:acp` 前后都是 108 条 ok、0 红(㉒ opt-in 跳过);boundary / transport / log / session / provider
gate 绿,assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10;`provider-vendor-drill` 绿。新规矩自证:`runtime/acp/client.ts` 加一行
`./wiring/permission-bridge.js`,「产品层不许 import runtime/*/wiring」当场红,撤掉回绿。`git grep -n "wiring/acp"` 在代码 / 配置 /
脚本里为零,剩 `docs/` 里 4 个文件。

### ③-plugins 落地记录(2026-10-02,未提交)

**一句话**:插件的产品半边与装配半边住进同一个领域目录 `runtime/plugins/`,后者在 `wiring/` 子目录;契约 + 内核
`core/plugins` **留在 core**(别的领域真 import 它:`runtime/scheduler`、`runtime/prompts/plugin-context*`、
`runtime/toolkit/{guard-projection,families/external}`、`runtime/engine`、`wiring/providers/credential-strategy`、
`wiring/deeplink`、`apps/cli/src/plugin-command.ts` 等),不带 `--kernel`。`backend/wiring/plugins`(19 件 + `builtin/` 插座 1 件 +
23 份测试,共 43 个文件)`git mv` 进 `runtime/plugins/wiring/`。`rpc/domains/{plugins,themes}.ts` 没搬(只改了 import)。

**同名文件**:`index.ts`、`skin.ts`、`theme-overrides.ts` 两边都有,搬后分住 `runtime/plugins/` 与 `runtime/plugins/wiring/`
两层,没有覆盖、没有改名;两个 `__tests__/` 同理。

**改写**:
- 脊柱与宿主里指向装配半边的 import(`backend.ts`、`host-ports.ts`、`server/runtime.ts`、`rpc/domains/{plugins,themes}.ts`、
  `wiring/{engine/stream-engine-bound,deeplink/confirm-card,tasks/dispatch}.ts`、`apps/cli/src/plugin-command.ts` 与各自的测试、
  `runtime/search/wiring/__tests__/plugin-search.test.ts`)改成 `@onething/backend/runtime/plugins/wiring…`。
- 接线里指向脊柱的 import 改成包说明符;内部会话模块(`session/{reads,commands}.js`)与测试基建
  `session/testing/facade-mock.js` 保持相对路径 —— 后者只给测试用,不该进 exports(脚本加了这条:目标在 `testing/` 或
  `__tests__/` 下的不改成包说明符)。
- 测试里按 `__dirname` / `import.meta.url` 拼的路径(`sample-plugins/plan-status`、仓根、`shared/ipc/chat.ts`、
  `runtime/collab/typing.ts`)按新落点重算。**一处脚本误改已撤回**:`background-layer.test.ts` 里当「越界路径」样本的
  `'../../secret.png'` 是测试数据,不是路径,脚本第一次把它也重算了;已恢复原样(与 HEAD 逐字相同),脚本改成「不是 import 的
  相对字符串只在它真指向磁盘上的东西时才重算」,在 HEAD 的临时 worktree 上重放一遍与主检出逐字相同。
- 注释与基线:assembly 基线 4 行路径(`events 1`、`host-ports 1`、`install 4`、`loader 2`,数字不变)、
  `core/session/events/ephemeral-policy.ts` 里指向测试文件的路径常量、`shared/ipc/channels.ts` 等注释;根 `CLAUDE.md` 插件一节
  「三个家」的装配半边路径与说明、host-ports 表、`wiring/<domain>/` 清单(39 → 38)与目录树注释、StreamEngine 一节。
- exports:改名 10 格(`./wiring/plugins/{background,file-import,index,install,loader,manager,skin,theme-overrides,webview,api}.js`
  → `./runtime/plugins/wiring{/…}`),新增 15 格:`./runtime/plugins/wiring/{commands,events,host-ports,llm,sessions,types}`,以及脊柱的
  `./channel/connector-registry.js`、`./wiring/collab/ingress.js`、`./wiring/deeplink/registry.js`、
  `./wiring/engine/{stream-engine-bound,stream/stream-executor}.js`、`./wiring/providers/{credential-strategy,credential-strategy-lifetime}.js`、
  `./wiring/variables/index.js`。

**守门改写**:
1. 检查器里按旧路径写的插件断言只改路径:`BUILTIN_PLUGIN_FACADE_DIR`(内置插件 id = 插座目录的文件名)、
   `BUILTIN_PLUGIN_LOADER_FILE`、`MAIN_FILE_IO_SYSTEM_DIRS` 里那一格;架构测试 I2 的结构豁免(按插座目录反查
   `runtime/plugins/<id>.ts`)改读 `runtime/plugins/wiring/builtin`。
2. 「插件行为测试不许住在装配树」(`checkPluginLogicStaysOutOfHostAssembly` 第 3 段)判「这个测试接了装配层」时,
   原来只认脊柱;现在 `runtime/<d>/wiring/**` 也算装配层(相对路径落进去、或包说明符 `@onething/backend/runtime/<d>/wiring…`)。
   不改的话,搬家后 `skin` / `theme-knobs` / `on-dispose-persistence` 三份装配测试会被误判成「站错了树」。
3. assembly 尺子照前一批的路径角色口径量到了搬家后的 4 个文件,数字不变。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli`(含 `apps/cli`)成功;桌面四个 bundle
打到临时目录成功;根全量 vitest 前后都是 11419 条 / 19 红,失败集合逐条相同(event-routing 那条既有红原样在,只是路径换了、
排序位置跟着变);壳 7344 条,同一条 A9 红;插件重点子集(`runtime/plugins` 两半、`core/plugins`、plugin-model-lifecycle、
plugins / themes 两个 RPC 域、plugin-search、CLI 的 plugin-command、deeplink、架构测试;拆除 CI 测试 `builtin-teardown` 在内)
前后都是 78 个文件、1054 条,1 红(event-routing 既有)、2 skipped;`gate:acp` 前后 108 ok;boundary / transport / log / session /
provider gate 绿,assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10;`provider-vendor-drill` 绿。新规矩自证:
`runtime/plugins/config.ts` 加一行 `./wiring/manager.js`,「产品层不许 import runtime/*/wiring」当场红,撤掉回绿。
`git grep -n "wiring/plugins"` 在代码 / 配置 / 脚本里为零,剩 `docs/` 里 9 个文件。

### ③-collab 落地记录(2026-10-02,未提交)

**一句话**:collab 在 server 包里只剩一个家 `runtime/collab/`。`core/actors`(Actor / mailbox / lease / envelope 的骨架,
5 件 + 5 份测试)并进 `runtime/collab/kernel/`,`backend/wiring/collab`(40 件 + `OWNERSHIP.md` + 32 份测试,共 73 个文件)
并进 `runtime/collab/wiring/`,一律 `git mv`。脚本加了 `--kernel=<dir>`(内核目录名与领域名不同):
`fold-domain.mjs collab --kernel=actors`。`rpc/domains/{collab,chat,sessions}.ts` 没搬(只改了 import)。

**为什么 `core/actors` 算 collab 专属内核**:它的真 importer 只有 `runtime/collab`(21 个文件)、`wiring/collab`(5)和脊柱的
2 份测试(`collab-mailbox-failure-lifecycle`、`collab-actor-open-lifecycle`);core 里别的目录没有相对 import 它,core 大桶
`core/index.ts` 也没有再导出它。core 下其余目录逐个量过(`agent`、`lifecycle`、`interaction`、`memory`、`resource`),
都有别的领域在用,留在 core。内核向外只伸手到 core:`../engine/ids.js`、`../session/storage/jsonl/codec.js`、
`../storage/json-file.js` 三处改成 `@onething/backend/core/{engine/ids,session/storage/jsonl/codec,storage/json-file}`。

**同名文件**:`actors/index.ts`、`agent-session.ts`、`index.ts`、`mentions.ts`、`reactions.ts`、`reply-quote.ts` 以及 4 份同名测试
两边都有,搬后分住 `runtime/collab/` 与 `runtime/collab/wiring/` 两层(`actors/` 也分成产品的 `runtime/collab/actors/` 与装配的
`runtime/collab/wiring/actors/`),没有覆盖、没有改名。

**改写**:
- 包说明符 `@onething/backend/core/actors` → `@onething/backend/runtime/collab/kernel`;`@onething/backend/wiring/collab/…` →
  `@onething/backend/runtime/collab/wiring…`(含 `scripts/collab-v3-migrate.mjs`);脊柱里的相对 import(`backend.ts`、`current.ts`、
  `server/runtime.ts`、`stores/sessions.ts`、`rpc/domains/{collab,chat,sessions}.ts`、`wiring/{engine,headless,toolkit,tools,
  variables,external-agents}/…`、`runtime/plugins/wiring/sessions.ts` 与各自的测试)改成包说明符。
- 接线里指向脊柱的 import 改成包说明符;`session/testing/facade-mock.js` 照上一批的规矩保持相对路径。
- CI:`.github/workflows/test.yml` 的 persistence 矩阵里 `packages/backend/core/actors/__tests__/mailbox-failure.test.ts` 改成新址
  (另一条 `packages/backend/__tests__/collab-mailbox-failure-lifecycle.test.ts` 没搬,不变)。
- 基线:assembly 基线 4 行路径(`actors/runtime.ts 3`、`agent-activity.ts 1`、`external-observability.ts 1`、`inspector.ts 1`,
  数字不变)。session-check 白名单与检查器里没有 `wiring/collab` / `core/actors` 的路径(`collab/tool-surface.ts` 单表那条断言
  指向产品层,本来就在 `runtime/collab/`,没动)。
- 根 `CLAUDE.md`:`wiring/<domain>/` 清单(38 → 37)与「collab 9.3k 行」那句、core 子树目录注释、StreamEngine 一节、目录树注释。
- exports:改名 4 格(`./core/actors` → `./runtime/collab/kernel`;`./wiring/collab/{index,ingress,actors/migrate}.js` →
  `./runtime/collab/wiring{,/ingress,/actors/migrate}`),新增 20 格:`./runtime/collab/wiring/actors/{engine-mind-port,
  execution-authorization,notebook-tool,runtime}`、`./runtime/collab/wiring/{board-store,budget,digest-runner,dm-tool,history-tool,
  inspector,members,room-config,room-create,say-tool,user-identity,venue}`,以及 core 的 `./core/engine/ids`、
  `./core/session/storage/jsonl/codec`、`./core/storage/json-file` 和脊柱的 `./wiring/toolkit/adapters.js`。
  脚本顺手修了一处:补键只认 import 位置上的说明符,注释里提到的路径不再长出键。

**守门**:规则本身这批没改;边界门断言仍是 141。补了上一批欠的探针 —— `checkPluginLogicStaysOutOfHostAssembly` 第 3 段的
新分支:`runtime/plugins/wiring/__tests__/` 里放一份只 import 产品层的测试,相对路径(`../../theme-overrides.js`)与包说明符
(`@onething/backend/runtime/plugins/theme-overrides`)两种写法都红;同一份再加一行 `import type … from '../api.js'`(接了
`runtime/plugins/wiring`)就按装配测试放行。撤掉后回绿。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli`(CLI daemon 装配 `collab: true`)成功;
桌面四个 bundle 打到临时目录成功;根全量 vitest 改前 11419 条 / 20 红、改后 / 19 红 —— 多出的那条是改前偶发的
`scripts/build-workspace-watch.test.mjs`(改后全量与单跑都绿),其余 19 条逐条相同;壳 7344 条,同一条 A9 红;collab 重点子集
(`runtime/collab` 三层、`core/actors` 旧址的测试随搬家进 kernel、`__tests__/collab-*` 生命周期、collab / chat 两个 RPC 域、
`sessions-collab-cursor`、`agent-self-gateway`、架构测试)前后都是 99 个文件 1613 条全绿;`gate:acp` 前后 108 ok;
boundary / transport / log / session / provider gate 绿,assembly gate 仍只红 `wiring/music/radio.ts` 9 → 10;`provider-vendor-drill` 绿。
新规矩自证:`kernel/lease.ts` 加一行 `../say.js`(领域的产品文件)、`runtime/collab/board.ts` 加一行 `./wiring/board-store.js`,
边界门两条红、架构测试「kernel 在最底层」红,撤掉回绿。`git grep -nE "wiring/collab|core/actors"` 在代码 / 配置 / 脚本里为零,
剩 `docs/` 里 10 个文件。

### ③-music 落地记录(2026-10-02,未提交)

**一句话**:music 在 server 包里只剩一个家 `runtime/music/`。core 下没有 music 专属目录;只搬接线:
`backend/wiring/music`(12 件 + 8 份测试,共 20 个文件)`git mv` 进 `runtime/music/wiring/`(`fold-domain.mjs music`)。
`rpc/domains/music.ts` 没搬(只改了 import)。两边没有同名文件。

**改写**:脊柱里指向接线的 import(`backend.ts`、`current.ts`、`rpc/{index,domains/music}.ts`、`wiring/{pets,resource,toolkit,
variables}/…` 与各自的测试、`__tests__/resource-music.test.ts`)改成 `@onething/backend/runtime/music/wiring…`;接线里指向脊柱的
import 改成包说明符(`session/reads.js` 照规矩保持相对路径);`runtime/music/resource-spec.ts`、`shared/ipc/{music,channels}.ts`
的注释路径同步。exports:改名 3 格(`./wiring/music/{dj-voice,radio,service}.js` → `./runtime/music/wiring/…`),新增 4 格
(`./runtime/music/wiring/{access,host-voice,operations,subsystem}`)。根 `CLAUDE.md` 的 `wiring/<domain>/` 清单(37 → 36)与目录树注释。

**既有红原样保持**:assembly 基线两行只改路径(`runtime/music/wiring/radio.ts 9`、`runtime/music/wiring/service.ts 3`),
判定仍是同一条红 `+ packages/backend/runtime/music/wiring/radio.ts: 9 → 10`,没有修它也没有改数字;vitest 的
`music-domain`、`music-projection`(整文件失败)、`resource-music` 三条既有红原样在。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功;桌面四个 bundle 成功;根全量 vitest
前后都是 11419 条 / 19 红,失败集合逐条相同;壳 7344 条,同一条 A9 红;music 重点子集(`runtime/music` 两半、三条既有红所在的
测试、`music-provider`、`music-context`、`wiring/pets`、架构测试)前后都是 31 个文件 393 条,3 个文件 / 2 条红(既有)、15 skipped;
`gate:acp` 前后 108 ok;boundary / transport / log / session / provider gate 绿;`provider-vendor-drill` 绿。新规矩自证:
`runtime/music/lyrics.ts` 加一行 `./wiring/service.js`,「产品层不许 import runtime/*/wiring」当场红,撤掉回绿。
`git grep -n "wiring/music"` 在代码 / 配置 / 脚本里为零,剩 `docs/` 7 个文件与 `apps/desktop-react/docs/` 1 个。

### 第③步小结(2026-10-02)

**六个领域各搬了什么**(全部 `git mv`,一个领域一笔提交):

| 领域 | 内核并入 `runtime/<d>/kernel/` | 接线并入 `runtime/<d>/wiring/` | 留在原地 |
| --- | --- | --- | --- |
| search | `core/search`(52 个文件) | `wiring/search`(15) | `rpc/domains/search.ts` |
| mcp | `core/mcp`(14);core 大桶删掉 41 个没人用的再导出 | `wiring/mcp`(2) | `rpc/domains/mcp.ts` |
| acp | —(没有 `core/acp`) | `wiring/acp`(31) | `rpc/domains/{acp,host-mcp}.ts`;stdio 桥入口本来就在 `runtime/acp/mcp-bridge/` |
| plugins | —(`core/plugins` 有别的领域真用,留 core) | `wiring/plugins`(43,含 `builtin/` 插座) | `core/plugins`、`rpc/domains/{plugins,themes}.ts` |
| collab | `core/actors`(10,内核目录名与领域名不同) | `wiring/collab`(73) | `rpc/domains/{collab,chat,sessions}.ts` |
| music | —(core 下没有 music 专属目录) | `wiring/music`(20) | `rpc/domains/music.ts` |

**立下的目录规矩**(详见 §4「目录规矩」;六个领域搬完当天又拍平了一次,下面是拍平后的口径):
1. 一个领域的家是 `runtime/<d>/`,一个功能的文件平铺在那里,不分「接线」与「产品逻辑」;只服务本领域的内核住 `kernel/`。
2. `core/<d>` 只有在**别的领域也真 import 它**时才留在 core;量的时候连 core 大桶 `core/index.ts` 的再导出一起查。
3. kernel 当 core 判:core 的禁令全数作用于它,另加闭包(只许自己目录、`@onething/backend/core/**`、`@shared/*`、node 内建)。
4. runtime 其余文件与脊柱同一套宿主禁令;「runtime 不许 import 脊柱 / `@shared/ipc`」与 `*.wiring.ts` 窄口一起撤掉。
5. import 脊柱写包说明符;内部会话模块(`privateSessionFiles`)与测试基建(`…/testing/`)保持相对路径、不进 exports ——
   「子树相对 import 不出子树」为前者留了唯一的口子。
6. 同名冲突按文件做的事起名,不用「层」的字眼;按旧路径写的领域断言只改路径,前提消失的断言撤掉并写明。
   边界门断言 139 → 141(search 批加 kernel 闭包与「产品层不许 import 领域接线」)→ 139(拍平撤掉后者与 I3 的另一半)。

**`backend/wiring/` 还剩 36 个目录**,本步没动。去向(2026-10-02 拍定):

- **照同样办法平铺进 `runtime/<d>/`**:`runtime/` 里有同名领域的那些 —— agent-loop、agents、ambient、auth、evals、
  external-agents、files、goals、interaction、markdown、media、notes、pets、project-dirs、providers(33 个文件)、scheduler、
  settings、skills、tasks、terminal、toc、todo-plan、toolkit(25)、tools、usage、variables、voice。
- **接线-only 的六个在 `runtime/` 下各立一个目录**:`deeplink`、`quota`(只有接线)、`memory`、`permission`、`resource`
  (另一半在 `core/<d>`,有别的领域在用,留 core)、`gateway`(另一半是 `packages/backend/gateway/` 子树)。
- **待议**:`engine`(93 个文件,装配骨干)、`logging`(横切设施,fan-in 高)、`headless`(CLI daemon 的装配点)—— 算不算
  「一个领域」先讨论再搬。

### ③-拍平 落地记录(2026-10-02,未提交)

**一句话**:按用户拍板「server 包内部不再区分接线与产品逻辑」(§4),六个已搬领域的 `runtime/<d>/wiring/**` 平铺进
`runtime/<d>/`,`wiring/` 子目录全部消失;一笔做完(scratchpad 的 `flatten.mjs`,在 HEAD 的临时 worktree 上重放一遍,
除下面列的手改文件外与主检出逐字相同)。187 个文件 `git mv`(含 88 份测试,进同领域已有的 `__tests__/` 或
`actors/__tests__/`),另有 9 个 `runtime/plugins` 文件因与 `core/plugins` 同名(I2)按内容改名。

**同名改名表**(新名按文件做的事起,不用「层」的字眼;领域根的 `index.ts` 一律保留为对外入口):

| 旧路径(`packages/backend/runtime/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `search/wiring/index.ts` | `search/service-setup.ts` | 起索引 Worker、接三条订阅、造 `SearchService` 装进单槽、按设置换 Worker |
| `search/wiring/providers.ts` | `search/install-providers.ts` | 把宿主的取材面装进进程单槽(`configureAppSearchProviders`) |
| `search/__tests__/visibility.test.ts`(原产品测试) | `search/__tests__/capability-visibility.test.ts` | 考的是 `capabilities/visibility.ts`;原接线那份 `visibility.test.ts` 考 `search/visibility.ts`,接过这个名 |
| `plugins/wiring/index.ts` | `plugins/plugin-system.ts` | 插件系统的启动入口(`bootstrapPluginSystem` / `PluginManager` 等) |
| `plugins/wiring/skin.ts` | `plugins/skin-table.ts` | 把活着的插件喂给裁决,产出档位表 |
| `plugins/wiring/theme-overrides.ts` | `plugins/theme-override-table.ts` | 同上,产出 token 覆盖变量表 |
| `plugins/wiring/background.ts` | `plugins/background-table.ts` | 同上,产出背景层表(与 `core/plugins/background.ts` 同名) |
| `plugins/wiring/install.ts` | `plugins/npm-process.ts` | npm 机制本身:spawn 与平台差异(与 core 的编排同名) |
| `plugins/wiring/llm.ts` | `plugins/llm-service.ts` | `PluginLlmService`,受管 LLM 调用口的实现 |
| `plugins/wiring/loader.ts` | `plugins/disk-loader.ts` | 从磁盘扫描并加载插件 |
| `plugins/wiring/manager.ts` | `plugins/plugin-manager.ts` | `PluginManager`,包着 core 的 headless manager |
| `plugins/wiring/resources.ts` | `plugins/resource-verbs.ts` | 插件的三个动词接到内核上 |
| `plugins/wiring/sessions.ts` | `plugins/session-messenger.ts` | 跨会话投递与感知快照 |
| `plugins/wiring/store.ts` | `plugins/data-home.ts` | 插件数据的家目录根 |
| `plugins/wiring/webview.ts` | `plugins/webview-root.ts` | 自定义协议的静态根解析 |
| `collab/wiring/index.ts` | `collab/rooms.ts` | 房间一侧的对外面(进房、配置、建房、私聊房、活动、actor 运行时) |
| `collab/wiring/actors/index.ts` | `collab/actors/actor-io.ts` | actor 带 IO 的那一半(账落盘、mailbox 广播、宿主端口)的入口 |
| `collab/wiring/agent-session.ts` | `collab/agent-exec-session.ts` | 确保 agent 的执行会话、管已读游标与回声 |
| `collab/wiring/mentions.ts` | `collab/mention-stamping.ts` | 给 agent 发言里的 `@名字` 盖上 id |
| `collab/wiring/reactions.ts` | `collab/react-to-message.ts` | 表情回应的写入(校验、落盘、广播一次) |
| `collab/wiring/reply-quote.ts` | `collab/reply-quote-attach.ts` | 回复发出后补挂引用 |
| `collab/wiring/__tests__/{agent-session,mentions,reactions,reply-quote}.test.ts` | `collab/__tests__/{agent-exec-session,mention-stamping,react-to-message,reply-quote-attach}.test.ts` | 跟着被测文件改名 |
| `acp/__tests__/permission-bridge.test.ts`(原产品测试) | `acp/__tests__/client-permission.test.ts` | 考的是 `ACPClient` 的权限请求;原接线那份接过 `permission-bridge.test.ts`(被测文件就叫 `permission-bridge.ts`) |
| `acp/__tests__/session-lifecycle.test.ts`(原产品测试) | `acp/__tests__/client-session-lifecycle.test.ts` | 同理,考 `ACPClient` 的会话生命周期 |

**同名但内容是同一件事的两半(没合,留给下一步)**:`plugins/{skin,skin-table}.ts`、`plugins/{theme-overrides,theme-override-table}.ts`
(裁决 + 喂表);`collab/{mentions,mention-stamping}.ts`、`collab/{reactions,react-to-message}.ts`、`collab/{reply-quote,reply-quote-attach}.ts`、
`collab/{agent-session,agent-exec-session}.ts`(纯规则 + 带 IO 的写入);`core/plugins/<x>.ts` 与九个改名文件(协议 + 实现)。

**撤掉 / 改写的守门规则**:
1. 检查器:删 `isRuntimeDomainWiringFile`、`checkRuntimeProductDoesNotImportDomainWiring`(连同 `RUNTIME_DOMAIN_WIRING_SPECIFIER`)。
2. 检查器 `checkRuntimeHostBoundary`:runtime 不再禁 `@shared/ipc`,与脊柱同一套宿主禁令(另保留 cordis 禁令);
   I3 的 `*.wiring.ts` 窄口(`SHARED_CONTRACT_PATTERN_SOURCES` / `RUNTIME_WIRING_FORBIDDEN_PATTERNS` / `isRuntimeWiringFile`)删掉。
3. 检查器 `checkRuntimeWiringModulesStayAtTheEdge`(I3 的另一半「非 wiring 文件不许 import `*.wiring` 模块」)撤掉 ——
   前提是第 2 条那道窄口;而且原接线文件按设计就 import `*.wiring` 模块(`actor-io.ts` → `agent-replay.wiring` 等),留着第一跑就红。
4. 检查器 `checkPluginLogicStaysOutOfHostAssembly` 第 3 段(「插件行为测试不许住在装配树的 `__tests__`」)**整段**撤掉,不止上一批加的
   新分支:它比的两个 `__tests__` 目录现在是同一个。1)/2) 两段照旧,路径改成 `runtime/plugins/{builtin,disk-loader.ts}`。
5. 检查器 `checkRuntimeOwnsAcpClientRuntime`:「装配那一半不许自带 client / manager / types / index 门面」那张表清空(留注释):
   拍平后同名路径正是产品本体。`MAIN_FILE_IO_SYSTEM_DIRS` 那一格改成 `runtime/plugins`。
6. `architecture-boundaries.test.ts`:删「runtime 产品层不许 import 脊柱」(13 → 12 条);「子树相对 import 不出子树」去掉
   `wiring/` 豁免,换成唯一的口子 —— runtime 相对 import 内部会话模块(名单从 `backend-public-boundary.mjs` 现读;24 处走这个口子)。
7. `scripts/lib/backend-public-boundary.mjs`:能碰内部会话模块的从「脊柱 + `runtime/<d>/wiring`」改成「core / gateway 以外」。
8. kernel 规则(core 禁令 + 闭包)不动。边界门断言 141 → 139。
9. `assembly:gate`:从「脊柱 + `wiring/` + `runtime/*/wiring`」改量「脊柱 + `wiring/` + 整个 `runtime/`(kernel 除外)」;新进尺子的
   49 个文件按当时的值写进基线(合计 69 个模块级 let),基线从 58 个文件 / 92 个 let 变成 107 个 / 161 个;判定仍只红
   `runtime/music/radio.ts 9 → 10`。

**改写**:exports 改名 54 格(全部 `./runtime/<d>/wiring…` 与九个 plugins 键,无新增);import / `vi.mock` / 注释路径同步;
根 `CLAUDE.md` 的 runtime 一节、`wiring/<domain>/` 那句、边界检查器与架构测试两节、插件一节「住在哪」、MCP / ACP 一节、
StreamEngine 一节改成「一个功能一个目录、平铺」。`*.wiring.ts` 文件名没改:runtime 下还有 31 个(agents、auth、collab/actors ×4、
engine ×2、interaction、mcp ×2、plugins ×2、practice、prompts ×2、providers ×3、scheduler、skills、terminal ×2、toolkit ×4、
triggers、voice ×3),留给下一步。

**手改的文件**(不在脚本产物里):检查器、`architecture-boundaries.test.ts`、`backend-public-boundary.mjs`、`assembly-gate.mjs`
与基线、`CLAUDE.md`、本文;`search/index/projector.ts` 一处注释(`runtime/search/wiring` 指的是那个模块,保留成
`service-setup`,脚本按目录提法会写成 `runtime/search`)。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功,`dist/{server,cli}/` 的
`search-worker.cjs` 与 `acp-mcp-bridge.cjs` 都在;桌面四个 bundle 成功;根全量 vitest 改前 11419 条 / 19 红、改后 11418 条
(删掉一条架构断言)/ 18 红 —— 少的那条是 brief 点名会偶发的 `http.test` 文件面,其余 18 条按路径映射后逐条相同;壳 7344 条,
同一条 A9 红;`gate:acp` 前后 108 ok;`gate:search-index` 改前 72 ok + ⑤d ×2 + ⑪a、改后 71 ok + ⑤d ×2 + ⑤c + ⑪a、
改后重跑 72 ok + ⑤d ×2 + ⑤c —— ⑤d 两条是合包后的既有红,⑤c(计时)与 ⑪a 在这几批的基线里都出现过、此起彼伏;
boundary / transport / log / session / provider gate 绿,assembly gate 仍只红 radio.ts 那一条;`provider-vendor-drill` 绿。
88 份搬家 / 改名的测试逐行对照 HEAD,除 import 与路径行外零差异。kernel 规则仍会红:`runtime/mcp/kernel/router.ts` 加一行
`../manager.js`,检查器的闭包与架构测试「kernel 在最底层」都红,撤掉回绿。`git grep` 里 `(search|mcp|acp|plugins|collab|music)/wiring`
在代码 / 配置 / 脚本中为零。

### ③-收尾 A 落地记录(2026-10-02,未提交)

**一句话**:`packages/backend/wiring/` 下 36 个目录里的 28 个(agents ambient auth deeplink evals external-agents files goals
interaction markdown media memory notes permission pets project-dirs quota scheduler settings skills tasks terminal toc todo-plan
tools usage variables voice)平铺进 `runtime/<d>/`,一笔做完(scratchpad 的 `flatten-wiring.mjs` —— `flatten.mjs` 的一趟扫描与
目录 / 文件双映射,加上 `fold-domain.mjs` 的「搬进 runtime 的文件里指向脊柱的 import 改包说明符、脊柱指向搬家目标的相对 import
改包说明符、缺的 exports 精确键补上」;在 HEAD 的临时 worktree 上重放一遍,341 个产物文件与主检出逐字相同)。120 个文件
`git mv`(含 49 份测试与 `tools/core/CLAUDE.md`)。runtime 里原来没有同名目录的 deeplink / memory / permission / quota 新建了
`runtime/<d>/`;`core/memory`、`core/permission` 有别的领域在用,留在 core。剩下 8 个:agent-loop / engine / gateway / headless /
logging / providers / resource / toolkit。

**同名改名表**(新名按文件做的事起;领域根的 `index.ts` 一律保留为对外入口):

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `wiring/agents/index.ts` | `runtime/agents/agent-store-access.ts` | 绑在活 store 上的 agent 增删查改 + 现算在场面,一只转发入口 |
| `wiring/agents/presence.ts` | `runtime/agents/presence-from-sessions.ts` | 去会话索引取元数据喂 `computeAgentPresence` |
| `wiring/agents/profile.ts` | `runtime/agents/profile-for-session.ts` | 每回合一次,按会话从活 store 解出能力档案 |
| `wiring/agents/__tests__/{presence,profile}.test.ts` | `runtime/agents/__tests__/{presence-from-sessions,profile-for-session}.test.ts` | 跟着被测文件改名 |
| `wiring/auth/auth-service.ts` | `runtime/auth/process-auth-service.ts` | 进程里那一台 `authService` 单例 |
| `wiring/evals/incident.ts` | `runtime/evals/turn-incident.ts` | `createIncidentForTurn`:按一回合现场造事故包(迟到负信号的唯一入口) |
| `wiring/external-agents/index.ts` | `runtime/external-agents/connector-registry.ts` | 外部 agent connector 的绑定 / 取用 / 打断 / 释放,会话链接与权限、提问转手 |
| `wiring/goals/file-changes.ts` | `runtime/goals/file-change-collector.ts` | 去 `<store>/file-mutations/` 扫审计记录,投影成摘要与 diff |
| `wiring/goals/index.ts` | `runtime/goals/goal-manager.ts` | GoalManager:会话目标的唯一写者 |
| `wiring/markdown/asset-service.ts` | `runtime/markdown/asset-sandbox.ts` | 附件请求的工作区沙箱守卫(`prepareMarkdownRequest` / `clamp*`) |
| `wiring/markdown/__tests__/asset-service.test.ts` | `runtime/markdown/__tests__/asset-sandbox.test.ts` | 跟着被测文件改名 |
| `wiring/notes/index.ts` | `runtime/notes/notes-subsystem.ts` | `NotesSubsystem`:驱动注册、refresh、订设置、`noteRootsNow()` |
| `wiring/pets/chattiness.ts` | `runtime/pets/chattiness-watch.ts` | 订「设置刚保存过」,开口频率热生效 |
| `wiring/project-dirs/index.ts` | `runtime/project-dirs/bootstrap.ts` | `bootstrapProjectDirs` 暖缓存 + 提示词变量 |
| `wiring/scheduler/user-tasks.ts`(及其测试) | `runtime/scheduler/user-task-service.ts`(`__tests__/user-task-service.test.ts`) | 用户定时任务的起停、增删改与执行 |
| `wiring/skills/index.ts` | `runtime/skills/skill-operations.ts` | 技能读写 / 管理操作的转发入口 |
| `wiring/skills/loader.ts`(及其测试) | `runtime/skills/skill-sources.ts`(`__tests__/skill-sources.test.ts`) | 技能从哪些根加载(store、插件、自定义 / 接入目录、笔记库、打包资源) |
| `wiring/skills/manage.ts` | `runtime/skills/manage-setup.ts` | 把 `skill_manage` 接到用户技能目录与加载器 |
| `wiring/skills/session-skills.ts` | `runtime/skills/session-skill-cache.ts` | 会话可见技能表与缓存 |
| `wiring/toc/index.ts` | `runtime/toc/toc-recorder.ts` | 每个实质回合跑一次小模型、改写当前意图段 |
| `wiring/todo-plan/store.ts`(及其测试) | `runtime/todo-plan/todo-plan-service.ts`(`__tests__/todo-plan-service.test.ts`) | `TodoPlanRuntime` + 宿主端口 + 变更订阅 |
| `wiring/usage/index.ts` | `runtime/usage/usage-recorder.ts` | `recordUsage`:所有 LLM 调用进同一本账的唯一入口 |
| `wiring/variables/index.ts` | `runtime/variables/variable-system.ts` | 变量系统的启动、提供者注册与总线桥 |
| `wiring/voice/providers.ts`(及 `providers{,.live}.test.ts`) | `runtime/voice/provider-calls.ts`(`provider-calls{,.live}.test.ts`) | 把设置里的 key 绑到语音服务商调用上 |
| `wiring/permission/permission-grants.ts` | `runtime/permission/grant-storage.ts` | 授权存储路径 + 内置能力集;与 `core/permission/permission-grants.ts` 同名(I2),按内容改名,白名单不扩 |

**同名但内容是同一件事的两半(没合,留给下一步)**:`agents/{presence,presence-from-sessions}.ts`、`agents/{profile,profile-for-session}.ts`
(纯规则 + 喂活 store);`auth/{auth-service,process-auth-service}.ts`(类 + 进程单例);`evals/{incident,turn-incident}.ts`(事故包格式 +
按回合现场造包);`goals/{file-changes,file-change-collector}.ts`(净变更算法 + 扫盘);`markdown/{asset-service,asset-sandbox}.ts`(解析 / 保存 +
沙箱守卫);`pets/{chattiness,chattiness-watch}.ts`(档位表 + 热生效);`scheduler/{user-tasks,user-task-service}.ts`(任务文件仓 + 起停执行);
`skills/{loader,skill-sources}.ts`、`skills/{manage,manage-setup}.ts`、`skills/{session-skills,session-skill-cache}.ts`(机制 + 接到本机的根 / 设置);
`todo-plan/{store,todo-plan-service}.ts`(文件仓 + 运行时);`voice/{providers,provider-calls}.ts`(服务商实现 + 绑设置);各领域根 `index.ts` 与
改名后的那只入口(agents / external-agents / goals / notes / project-dirs / skills / toc / usage / variables)。

**守门**(规则本身不改,只改路径;前提随拍平消失的位置断言撤掉并在原处写明):
1. 检查器 `MAIN_CORE_SYSTEM_DIRS` 两格改成 `runtime/permission` 与 `runtime/tools/core` —— 尺子只跟着搬过去的文件走;不写
   `runtime/tools`,那里的纯模块本职做文件 IO,从没在这把尺子上。`quotaWiringDir` 改指 `runtime/quota`(那个目录就是原来的那一个)。
2. 撤掉五处「装配层那份转发壳回来即红」:`checkRuntimeOwnsProjectDirsStore` 的 `mainFiles`(5 条)、
   `checkRuntimeOwnsVariablesStoreAndHelpers` 的 `removedMainFacadeFiles`(9 条)、`checkRuntimeOwnsSchedulerCore` 的 `cron.ts` / `types.ts`、
   `checkRuntimeOwnsAuthCallbackServer` 的 `callback-server.ts`(连同只给它用的 `MAIN_AUTH_CALLBACK_SERVER_FORBIDDEN_PATTERNS`)——
   平铺之后同名路径正是产品本体;`checkRuntimeToolHelperTestsLiveInRuntimePackage` 的 `forbiddenMainTests`(4 条)——
   照搬过来成了「不许住在 runtime」,与本条「该住 runtime」自相矛盾;R4b 的「装配层不许有 `registry.ts`」照搬过来与下一条重复。
3. 改写而保留的:`checkCoreToolHelperTestsLiveInCorePackage` 的三条(core 的测试不许出现在 `runtime/tools/__tests__/`)、
   `checkRuntimeOwnsConcreteBuiltinTools` 的旧 builtin / tool-core 名单(改指 `runtime/tools/{builtin,core}/`,与已有的 `builtin/time.ts` 去重)、
   `checkRuntimeOwnsToolEditEngine` 的「不许再有一份 edit-engine 门面」(改指 `runtime/tools/core/edit-engine.ts`),以及各条按文件点名的
   内容断言(auth 单例、skills、markdown、voice、scheduler、sandbox)。
4. `architecture-boundaries.test.ts` 没有本批的路径,不动;I2 白名单不扩。assembly 基线 18 行只改路径、数字不变,仍只红 `radio.ts 9 → 10`。
5. 三份 `wiring/engine` 测试里 `vi.mock('…/wiring/tools/index.js')` 删掉:那个文件在 HEAD 上就不存在(R4b 删工具注册表时留下的死桩,
   什么都没桩),照搬过来会变成桩真的 `runtime/tools/index.ts`。

**改写**:exports 改名 31 格、新增 38 格(477 → 515;新增的是脊柱原来相对 import 的 runtime 键,以及搬进 runtime 的文件改写包说明符后
用到的 9 个脊柱键);内部会话模块与测试基建照旧走相对路径;import / `vi.mock` / 注释路径同步;根 `CLAUDE.md` 的 `wiring/<domain>/`
一句、目录树、host-ports 表、Permission 与终端两处改成新址。

**手改的文件**(不在脚本产物里):检查器、`assembly-lifecycle.test.ts` 一处注释(目录提法没认出改名)、上面三份 `wiring/engine` 测试、
`CLAUDE.md` 的散文、本文。

**拿不准、留给下一步**:`runtime/tools/core/{sandbox,permission-policy}.ts` 原样带着 `core/` 子目录过来,紧挨着 `runtime/tools/sandbox.ts`
(目录名 core 容易与 core 子树混,但两只文件不撞名,没动);新建的 `runtime/permission/` 与已有的 `runtime/permissions/` 并排(前者是授权存储
接到盘上 + 进程 `Permission`,后者是产品的授权 / 策略运行时)—— 合不合是内容的事;`apps/desktop-react/CLAUDE.md` 与各 `docs/` 里的旧路径是
历史记录,没改。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 均零错;`server:build`、`build:cli` 成功;桌面四个 bundle 成功;根全量 vitest
改前改后都是 11418 条 / 20 红,按路径映射后 19 条逐条相同,各差一条偶发:改前 `runtime-over-backend` 的 MCP start(临时目录 `ENOTEMPTY`)、
改后 `scripts/build-workspace-watch.test.mjs`(满载下的 watch 断言)—— 两条单跑都绿;壳 7344 条,同一条 A9 红;`gate:acp` 前后 108 ok;
boundary(139 条断言,前后输出逐字相同)/ transport / log / session / provider gate 绿,assembly gate 仍只红 radio.ts 那一条;
`provider-vendor-drill` 绿。测试里非 import 的差异只有 8 处注释路径、1 处 `path.join` 路径与上面三份死桩。`git grep` 里本批 28 个目录名的
`wiring/<d>` 在代码 / 配置 / 脚本(含根 `CLAUDE.md`)中为零。

### ③-收尾 B 落地记录(2026-10-02,未提交)

**一句话**:`wiring/{providers,toolkit,resource,agent-loop}` 平铺进 `runtime/<d>/`,一笔做完(scratchpad 的 `flatten-wiring-b.mjs`,
同 A 批的脚本换了领域表与改名表;**不动 git 索引** —— 普通文件改名,主索引留给提交;在 HEAD 的临时 worktree 上用独立
`GIT_INDEX_FILE` 重放一遍,336 个产物路径(103 个删除 + 233 个新增 / 改写)与主检出逐字相同)。103 个文件搬家(含 50 份测试与
一份 `__snapshots__`,快照逐字未变)。runtime 里原来没有 `resource/`,新建;`core/resource` 有别的领域在用,留在 core。
`packages/backend/wiring/` 只剩 engine / gateway / headless / logging(去向待定)。

**同名改名表**(新名按文件做的事起;领域根的 `index.ts` 保留为对外入口):

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `wiring/providers/index.ts` | `runtime/providers/chat-facade.ts` | provider 门面:注册表信息、`generateChatResponse` / `generateChatTitle` |
| `wiring/providers/custom-probe.ts`(及其测试) | `runtime/providers/custom-probe-analyst.ts` | 「自动识别」挑分析模型、请它分析、跑一轮 |
| `wiring/providers/manual-models.ts`(及其测试) | `runtime/providers/manual-model-store.ts` | 手填模型的读写(全局目录 + 每空间 `providers.json`) |
| `wiring/providers/model-registry.ts`(及其测试) | `runtime/providers/model-registry-service.ts` | 模型目录的刷新、落盘与查询 |
| `wiring/providers/registry.ts` | `runtime/providers/provider-table.ts` | 进程里那张内置 provider 表(注册、查找、缓存失效) |
| `wiring/providers/__tests__/agent-runtime-route.test.ts` | `runtime/providers/__tests__/agent-runtime.test.ts` | 考的是 `agent-runtime.ts`;`agent-runtime-route.test.ts` 这个名字留给产品那份 |
| `wiring/toolkit/index.ts` | `runtime/toolkit/tool-ports.ts` | 工具内核端口实现与投影器的出口 |
| `wiring/toolkit/catalog.ts` | `runtime/toolkit/tier-catalogs.ts` | 三档目录(desktop / headless / readonly);与 `core/toolkit/catalog.ts` 同名(I2) |
| `wiring/toolkit/runner.ts` | `runtime/toolkit/runner-factory.ts` | `createAppToolRunner`:把端口装进 `ToolRunner`;与 `core/toolkit/runner.ts` 同名(I2) |
| `wiring/agent-loop/index.ts` | `runtime/agent-loop/process-providers.ts` | 带本进程 fetch 的 provider 构造函数入口 |
| `wiring/agent-loop/providers/factory.ts` | `runtime/agent-loop/providers/process-factory.ts` | 工厂接上本进程的 fetch、请求转储、媒体读取、凭证与外部 agent |
| `wiring/agent-loop/providers/openai-compatible.ts` | `runtime/agent-loop/providers/openai-compatible-fetch.ts` | 给 OpenAI 兼容构造门面注入本进程的 fetch |

**同一件事的两半(没合)**:`providers/{custom-probe,custom-probe-analyst}`、`{manual-models,manual-model-store}`、
`{model-registry,model-registry-service}`、`{registry,provider-table}`、`{provider-facade,chat-facade}`;`agent-loop/providers/{factory,process-factory}`、
`{openai-compatible,openai-compatible-fetch}`;`core/toolkit/{catalog,runner}` 与 `runtime/toolkit/{tier-catalogs,runner-factory}`(协议 + 实现);
各领域根 `index.ts` 与改名后的入口(providers / toolkit / agent-loop)。

**守门**:规则不改,只改路径。检查器 `MAIN_CORE_SYSTEM_DIRS` 那格改成 `runtime/agent-loop`(目录尺子,现在量到产品那一半,照样全绿);
`checkCoreOwnsAgentLoopPureFacades` 的 13 条「装配层转发壳回来即红」撤掉(照搬过来 `providers/sse.ts` 正是产品本体,前提是两层),
「入口不许再导出 core API」那一条改指 `process-providers.ts` 保留;其余点名文件(provider 表、门面、模型目录、三档目录、`wiring.ts`)
改成新址。assembly 基线 5 行、provider-vendor 基线 7 行只改路径;`provider:gate` 仍 111 对、`provider-vendor-drill` 绿(它的
`ALLOWED_TOUCHES` 指两份名册与壳的 i18n,不受影响)。exports 改名 19 格、新增 19 格(515 → 534;新增里 5 个是脊柱键)。根 `CLAUDE.md` 的
`wiring/<domain>/` 一句、目录树、Tools — toolkit 与 Providers 两节改成新址。

**手改的文件**:检查器、`runtime/resource/index.ts` 文件头「目录名为什么是 wiring/resource」一段(改写成住处说明)、
`vendors/github-copilot/models.ts` 一处注释(花括号提法没认出改名)、`resource-dir.test.ts` 的 `TARGET_DIR`(那条测试拿
`packages/backend/wiring/resource` 这个真目录当被读的目标,写成 `path.join` 的分段字面量,脚本认不出;改成 `runtime/resource`,
第一轮改后全量里它红了两条,改完单跑 7 绿)、`CLAUDE.md` 散文、本文。

**拿不准**:`runtime/toolkit/wiring.ts` 这个文件名本身带层的字眼,不在冲突里,没改;`runtime/providers/{provider-facade,chat-facade}.ts`
并排,读者要看文件头才分得清。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle 成功;根全量 vitest 改前
11418 条 / 19 红,改后重跑 11418 条 / 19 红、失败集合逐条相同(第一轮改后多出的两条是 `resource-dir.test.ts`,见上「手改」);
vendor-facts 快照、线协议快照、出厂设置冻结测试前后都绿,快照文件未动;壳 7344 条同一条 A9 红;`gate:acp` 前后 108 ok;
boundary(139 条)/ transport / log / session / provider(111 对)门输出前后逐字相同,assembly 只多了一行路径(收紧提示里的
github-copilot 换了住址),仍只红 radio.ts;`provider-vendor-drill` 绿。测试里的非 import 差异 21 对,全是注释里的路径,外加上面那一处
`TARGET_DIR`。`git grep` 里 `wiring/(providers|toolkit|resource|agent-loop)` 在代码 / 配置 / 脚本(含根 `CLAUDE.md`)中为零。

### ③-收尾 C 落地记录(2026-10-02,未提交)

**一句话**:`wiring/{engine,logging,headless}` 平铺进 `runtime/<d>/`(engine 的 `stream/` `prompt/` `triggers/` 等子目录原样做
`runtime/engine` 的子目录),`wiring/gateway/host-ports.ts` 进 gateway 子树,**`packages/backend/wiring/` 整个删掉**。一笔做完
(`flatten-wiring-c.mjs`,同 B 批:普通文件改名、不动主索引;`core/` 子树不在脚本的改写范围里;在 HEAD 的临时 worktree 上用独立
`GIT_INDEX_FILE` 重放,441 个产物路径与主检出逐字相同)。99 个文件搬家,其中 69 份测试。

**改名表**:

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `wiring/engine/index.ts` | `runtime/engine/engine-layer.ts` | `createStreamEngineLayer()` + 读当前实例的四个访问器 |
| `wiring/engine/context-compact.ts` | `runtime/engine/compact-session.ts` | `compactSessionContext`:按会话从 store 取料、调模型、落盘;与 `core/engine/context-compact.ts` 同名(I2) |
| `wiring/logging/index.ts` | `runtime/logging/configure-logging.ts` | `configureLogging()` 那个唯一接线点 + 宿主侧 `getLogger` |
| `wiring/logging/__tests__/index.test.ts` | `runtime/logging/__tests__/configure-logging.test.ts` | 跟着被测文件改名(留着 `index.test.ts` 会被读成考产品层门面) |
| `wiring/gateway/host-ports.ts` | `gateway/lifecycle-port.ts` | IM 网关生命周期的注入端口(`configureGatewayHost`);文件头「为什么放在这里」一段改写 |

**同一件事的两半(没合)**:`runtime/engine/{index,engine-layer}.ts`(产品引擎出口 + 引擎层的装配与访问器)、`core/engine/context-compact.ts`
与 `runtime/engine/compact-session.ts`(算法 + 带 IO 的执行)、`runtime/logging/{index,configure-logging}.ts`(产品层门面 + 装配点)。

**守门**(逐条):
1. gateway 子树的依赖从「只 core」放宽成「core + `@shared`(含 `@shared/ipc`)」:shared 是 server ↔ client 的契约,后端引用它是合理的。
   检查器 `checkGatewayHostBoundary` 不再套 `/shared\/ipc/` 那一条(断言名同步改成 `… (core + @shared only)`);
   `architecture-boundaries.test.ts` 那条本来就不禁 `@shared`,改名字与理由。
2. I1:包根目录的排除名单删掉 `'wiring'`(那个目录不存在了),两段说明改写。
3. 检查器 `MAIN_CORE_SYSTEM_DIRS` 那格改成 `runtime/engine`(目录尺子,量到产品引擎那一半,照样全绿);内核闭包与「脊柱是什么」
   两段注释里的 `wiring/` 去掉;acp 那段历史注释改写。其余点名文件(stream-engine-runtime、tool-execution、stream-processor、
   image-stream、headless backend …)只改路径。
4. `assembly-gate.mjs` 只有注释提到 `wiring/`(量法本来就是「脊柱 + runtime(kernel 除外)」,删掉目录不需要改代码);基线 3 行只改路径。
   `gateway/lifecycle-port.ts` 进了 gateway 子树,而这把尺子不量 gateway,它那 1 个模块级 let 从此不在尺子上 —— 删掉那一行基线(不删
   就是一条「可以收紧」的提示)。
5. `exports` 改名 12 格、新增 15 格(534 → 549),`./wiring/…` 键为零。

**手改的文件**:检查器、`architecture-boundaries.test.ts`(协调者点名同步的那一只;`core/` 下其余文件没碰)、`assembly-gate.mjs` 注释与基线、
`gateway/lifecycle-port.ts` 文件头、`apps/desktop-react/tsconfig.json` 一处注释(json 不在脚本范围)、`runtime/agent-loop/providers/media-reader.ts`
与 `runtime/collab/agent-activity.ts` 各一处注释、根 `CLAUDE.md`(所有 `wiring/` 的描述改成现状)、本文。

**留下的**:`core/` 里还有三处注释写着旧路径(`core/engine/agent-loop-executor.ts:979`、`core/logging/types.ts:6`、
`core/session/__tests__/apply-chunk-tool-progress.test.ts:11`),按「别碰 core」没改。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle 成功;根全量 vitest 改前
11418 / 21 红,改后 11418 / 19 红 —— 按路径映射后改后的 19 条全在改前里,改前多的两条是前几批反复出现的偶发(`runtime-over-backend`
MCP start 的 `ENOTEMPTY`、`build-workspace-watch` 满载);壳 7344 条同一条 A9;`gate:acp` 前后 108 ok;boundary(139 条)/ transport /
log / session / provider / assembly 门输出前后逐字相同(assembly 仍只红 radio.ts);`provider-vendor-drill` 绿。
`sessions:shadow-battery` 前后各跑一次,遮掉临时路径 / 会话 id / 端口之后 130 行对 130 行,只差进度行的秒数与 `refoldChecks` 215 → 217
(采样次数,本身就随调度浮动 —— 前几批的两份存档也是 215 与 217);`compact-half-run-log` FAIL 与 `appendFailures 8` 两边一样。
`git grep` 里 `wiring/(engine|logging|headless|gateway)` 在代码 / 配置 / 脚本(含根 `CLAUDE.md`)中只剩上面那三处 core 注释。

### 去 core 批 1 落地记录(2026-10-03,未提交)

**一句话**:先撤 core 这一层的规则(撤完、一个文件都还没搬时 `boundary:gate` 绿,断言 139 → 135;架构测试 12 → 10 条全绿),
再把 core 的 14 个小目录并进 `runtime/<d>/`:agent → `runtime/agents`、**events → `runtime/event-bus`**、其余 12 个同名
(context / http / lifecycle 新建,interaction / logging / memory / permission / providers / resource / storage / toolkit / tools
并进已有目录)。118 个文件搬家(37 份测试)。一笔做完(scratchpad 的 `s4-move-core.mjs`:普通文件改名、不动主索引;在 HEAD 的临时
worktree 上用独立 `GIT_INDEX_FILE` 重放,578 个产物路径与主检出逐字相同 —— 先只放脚本时恰好差 7 只手改文件,补上手改之后零差异)。
`ls packages/backend/core` 剩 `__tests__ agent-loop engine plugins session freeze.ts gateway-runtime.ts index.ts runtime-facade.ts`。

**与本批任务表不同的一处**:core 的 `events/` 没有落到 `runtime/events`,而是 `runtime/event-bus/` —— 包根已经有一个 `events/`
(脊柱那一半:按会话词汇特化的 EventBus / RingBuffer / StreamChannel),同名会让 I1 红;I1 的豁免表是只减不增的棘轮,所以按内容
另起目录名。两者是同一件事的两半(通用总线 + 按会话载荷特化),没合。

**撤掉 / 改写的规则**(检查器 139 → 135 条;架构测试 12 → 10 条):

| 规则 | 处理 | 理由 |
| --- | --- | --- |
| `checkCoreForbiddenImports`(core + `runtime/*/kernel` 禁 `@shared/ipc` / better-sqlite3 / MCP、ACP SDK / zod / diff / uuid / electron) | 撤;宿主那一半并进 `checkRuntimeHostBoundary`(断言名改成 `packages/backend/core + runtime + packages/backend have no …`) | 零依赖骨架没有对象了;宿主禁令是保留的规则 |
| `checkRuntimeDomainKernelImportClosure` | 撤 | 源头是「kernel 当 core 判」 |
| `checkCorePackageDependencies`(core 只许 `@anthropic-ai/sdk`) | 撤 | 同上 |
| `checkCorePublicExports`(core 大桶必须交出 AgentEngine / EventBus / …) | 撤 | core 不再是对外的公共入口 |
| `checkRuntimeOwnsConcreteBuiltinTools` 里 13 格「`core/tools/*.ts` 不许存在」 | 撤这 13 格,其余照旧 | core 的 tools 目录整个并进 runtime,那些纯模块本来就住在 `runtime/tools/` |
| `checkCorePromptContextRegistryOwnedByRuntime` 里「core 的 storage 下 `app-state.ts` 不许存在」 | 撤这一格(断言名去掉 `and app state`) | 同上 |
| 架构测试「core 在最底层」「`runtime/*/kernel` 在最底层」 | 撤 | 同上两条 |
| 架构测试「core 无宿主 import」 | 留,不再套 kernel | 宿主禁令;kernel 由 runtime 那条管 |
| `MAIN_CORE_SYSTEM_DIRS` 的 `runtime/permission` | 从整个目录改成点名原来那四只文件 | core 的 permission 那一半本职要 `node:path`、从没在这把尺子上;尺子量的东西不变 |
| `checkCoreKnowsNoConcreteFeatures` | 量 core 剩下的部分 + 接收了 core 文件的 14 个 runtime 目录(整目录,今天零命中) | 内容断言跟着文件走;范围比「搬来的那些文件」宽 |
| 「X 拥有 Y」的位置断言(工具帮手测试、工具 schema 投影、会话命令 IPC 投影、授权文件存储、旧工具注册表不许复活等) | 只改路径,三条断言名改成新址 | — |
| I2 白名单 `storage/{file-storage,paths}.ts`、`tools/diff-hunks.ts` | 删,表空了 | core 那一半改名后不再同名 |

**冲突改名表**(新名按文件做的事起;领域根的 `index.ts` 保留为对外入口):

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `core/agent/index.ts` | `runtime/agents/agent-engine-exports.ts` | `agent-engine.ts` 的出口桶(只有 core 大桶在用) |
| `core/logging/index.ts` | `runtime/logging/logger-primitives.ts` | 日志内核七只文件的出口桶;`index.ts` 是产品层 `getLogger` 门面 |
| `core/memory/index.ts` | `runtime/memory/memory-registry.ts` | `MemoryHolder` / `MemoryRegistry` / `MemoryGovernor`;`index.ts` 是内存管理的装配 |
| `core/permission/index.ts` | `runtime/permission/permission-asks.ts` | `Permission` 命名空间:发问、应答、通道亲和、待答表 |
| `core/providers/index.ts` | `runtime/providers/stream-provider-contract.ts` | 流式 provider 的类型出口(只有 core 大桶在用) |
| `core/resource/index.ts` | `runtime/resource/resource-api.ts` | 资源内核的公共出口;`index.ts` 是资源的装配面 |
| `core/storage/index.ts` | `runtime/storage/storage-primitives.ts` | 文件 IO 原语的出口桶 |
| `core/storage/file-storage.ts` | `runtime/storage/file-storage-base.ts` | `CoreFileStorageProvider`,`file-storage.ts` 的基类(I2) |
| `core/storage/paths.ts` | `runtime/storage/store-layout.ts` | 按显式参数算 store 下各路径(I2) |
| `core/toolkit/index.ts` | `runtime/toolkit/tool-protocol.ts` | 工具内核(ToolSpec / Tool / Intent / Outcome / … / ToolRunner)的出口 |
| `core/toolkit/__tests__/runner.test.ts` | `runtime/toolkit/__tests__/tool-runner.test.ts` | 考 `ToolRunner`;`runner.test.ts` 是 runtime 那份装配冒烟 |
| `core/tools/index.ts` | `runtime/tools/tool-helpers.ts` | AgentEngine 那套最小工具系统与 abort / 效果 / 投影帮手的出口 |
| `core/tools/diff-hunks.ts` | `runtime/tools/diff-hunk-json.ts` | diff hunk 的数据形状与 JSON 编解码(I2) |
| `core/tools/registry.ts`(及其测试) | `runtime/tools/engine-tool-registry.ts` | AgentEngine 的最小注册表 + JSON Schema 投影;`runtime/tools/registry.ts` 这个名字被「R4b 删掉的旧注册表不许复活」守着 |

**同一件事的两半(没合)**:`events/` 与 `runtime/event-bus/`;`runtime/logging/{index,logger-primitives}`;
`runtime/memory/{index,memory-registry}`;`runtime/permission/{index,permission-asks}`;`runtime/resource/{index,resource-api}`;
`runtime/storage/{file-storage,file-storage-base}`、`{paths,store-layout}`、`{index,storage-primitives}`(`index.ts` 再导出一组原语);
`runtime/tools/{diff-hunks,diff-hunk-json}`;`runtime/toolkit/{index,tool-protocol}`;`runtime/providers/{index,stream-provider-contract}`。

**core 大桶**(`core/index.ts`,本批不删)再导出的 8 组改成从新址再导出;经大桶拿名字的真实使用者:`agent`(`AgentEngine` 与两个
事件类型:`server/runtime.ts`、`server/live-session-delivery.ts`、`server/__tests__/test-helpers.ts` 等)、`events`(`EventBus` /
`StreamChannel`:`server/runtime.ts`、`server/live-session-delivery.ts`、三份 server 测试、`session/__tests__/event-broadcast.test.ts`)、
`permission`(`Permission`:`server/runtime.ts`;`addGrant`:`runtime/music/radio.ts`);`context` / `interaction` / `providers` /
`storage` / `tools` 五组**没有**使用者(另有三份 radio 测试 `importOriginal` 整只大桶)。

**exports**:改名 12 格、新增 15 格(549 → 564;新增里 4 个是 `./core/engine/*` —— 搬进 runtime 的文件原来相对 import 它们,跨子树
改写成包说明符)。`./core/…` 键 26 → 18。

**手改的文件**:检查器、架构测试、`assembly` 基线(搬进 runtime 的三只文件按当时的值记入:`runtime/logging/port.ts` 2、
`runtime/permission/permission-grants.ts` 2、`runtime/storage/json-file.ts` 1,与第③步拍平同一个做法)、
`runtime/resource/__tests__/stranger.test.ts`(「内核不点名 scheme」那道门从前扫整个目录、并断言目录里正好是那 13 只文件;
现在目录里还住着资源装配与各家 provider,改成逐只确认名单上的内核文件都在、只扫它们 —— 改前全量里它红,改后单跑 3 绿)、
`apps/desktop-react/src/workbench/kinds.ts` 一处折行的注释路径、上一批留下的三处 core 注释、根 `CLAUDE.md`、本文。
脚本把 37 处早已过时的注释路径(`core/toolkit/effects.ts`、`core/resource/ref.ts`、`core/permission/principal.ts`、
`core/tools/tool-result.ts`、`core/events/session-*-types.ts`、`core/interaction/types.ts`)按文件名改成了 `packages/shared/` 下的现址。

### 去 core 批 2 落地记录(2026-10-03,未提交)

**一句话**:`core/plugins` → `runtime/plugins`、`core/session` → `runtime/sessions`(`storage/jsonl`、`projection/`、`trace/`、`events/`
等子目录原样做子目录)、`core/engine` → `runtime/engine`、`core/agent-loop` → `runtime/agent-loop`。174 个文件搬家(51 份测试)。一笔做完
(scratchpad 的 `s4-move-core2.mjs`,同批 1 的脚本换了领域表与改名表;别的会话在改的 `apps/desktop-react/src/data/chat-*` 不在改写范围;
在 HEAD 的临时 worktree 上用独立 `GIT_INDEX_FILE` 重放,786 个产物路径里只差 8 只手改文件,补上之后零差异)。
`ls packages/backend/core` 剩 `__tests__ freeze.ts gateway-runtime.ts index.ts runtime-facade.ts`。

**冲突改名表**:

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `core/plugins/index.ts` | `runtime/plugins/plugin-contract.ts` | 插件契约与内核的出口桶(`CorePluginAPI` …);`index.ts` 是插件系统产品那一半的出口 |
| `core/plugins/types.ts` | `runtime/plugins/plugin-api-types.ts` | 插件 api / definition / manifest 的类型面 |
| `core/plugins/log-monitor.ts` | `runtime/plugins/log-monitor-primitives.ts` | 无名的日志监控原语(缓冲、落盘、检索);`log-monitor.ts` 是那只内置插件本体,名字被插件 id 钉住 |
| `core/plugins/__tests__/llm.test.ts` | `runtime/plugins/__tests__/llm-protocol.test.ts` | 受管 LLM 口的协议层(声明门、输入校验、降级);`llm.test.ts` 考的是计费 / 配额 / 超时 |
| `core/plugins/__tests__/local-plugins.test.ts` | `runtime/plugins/__tests__/local-plugins-scan.test.ts` | 单文件插件的扫描语义;`local-plugins.test.ts` 考装载 |
| `core/plugins/__tests__/notify-sound.test.ts` | `runtime/plugins/__tests__/notify-sound-enum.test.ts` | 提示音枚举的形状;`notify-sound.test.ts` 考「响不响」三道闸 |
| `core/session/index.ts` | `runtime/sessions/session-primitives.ts` | Session / SessionManager / 状态 / 存储编解码的出口桶 |
| `core/engine/index.ts` | `runtime/engine/engine-primitives.ts` | CoreStreamEngine 与引擎零件的出口桶;`index.ts` 是 ProductStreamEngine 出口 |
| `core/agent-loop/index.ts` | `runtime/agent-loop/loop-primitives.ts` | `runAgentLoop` 与重试 / 调度 / 工具名表的出口桶;`index.ts` 是本进程那一半的出口 |

**同一件事的两半(没合)**:上表每一行的新旧两只(出口桶 + 领域根 `index.ts`、日志监控原语 + 插件本体、三对协议 / 行为测试);
`runtime/engine/{context-compact,compact-session}.ts`(算法 + 带 IO 的执行,上批已列);`runtime/sessions` 里会话内核与仓储驱动。

**守门**(检查器 135 条,前后条数相同;架构测试 10 条):
1. 位置断言只改路径;两条断言名改成新址(`runtime/agent-loop keeps loop primitives out of its process-providers entry`、
   `runtime/engine primitives keep prompt assembly out`),agent-loop 那条的提示语改指 `loop-primitives`。
2. 撤两格「不许回到 core」:`core/engine/system-prompt-snapshot.ts`、`core/engine/plugin-context.ts`(目录并进了 runtime)。
3. `checkRuntimeOwnsSystemPromptSnapshot` 里「经 core 的 engine 桶那条相对路径引组装函数」那一格:相对路径不存在了,判据改成
   「组装函数从 `@onething/backend/runtime/prompts` 引」(意图不变,今天绿)。
4. `MAIN_CORE_SYSTEM_DIRS` 的全套尺子量整个 `runtime/engine`;core 搬来的 `file-mentions.ts` 本职读文件(`node:fs`),改按文件 IO 那一级量
   (`MAIN_FILE_IO_SYSTEM_DIRS` 多一只文件,全套尺子遍历时跳过它)。
5. 「内核不点名具体功能」:`runtime/{sessions,engine,agent-loop}` 整目录量(今天零命中);`runtime/plugins` 只量从 core 搬来的 58 只文件
   (`CORE_MERGED_PLUGIN_FILES`)—— 产品那一半就是具体插件。
6. 「内置插件只经注入的 api 认识宿主」:放行从 `@onething/backend/core/**` 改成「`@onething/backend/runtime/plugins/` 下那张表上的契约 /
   内核文件」,其余照旧不许。改前改后都绿(搬家当场红过一次:`runtime/plugins/log-monitor.ts` 引 `plugin-contract`)。
7. 架构测试「provider-agnostic 层不点名服务商」改量 `runtime/agent-loop`、`runtime/engine` 整目录,照样绿。
8. `session:check` / `session:gate`:`scripts/session-check.mjs` 的规则 A / B 白名单 `core/session/commands.ts` → `runtime/sessions/commands.ts`
   (脚本改写),`session:check` 输出前后逐字相同(4 处既有发现)。
9. assembly 基线:新进尺子的 `runtime/engine/error-details.ts` 1、`runtime/sessions/lifecycle.ts` 1 按当时的值记入。
   `assembly-gate.mjs` 里「kernel 按 core 判」那句注释按协调者的话本批不动。

**exports**:改名 15 格、新增 4 格(564 → 568);`./core/…` 键 18 → 4(`./core`、`./core/gateway-runtime`、`./core/runtime-facade`,
以及新增的 `./core/freeze` —— 搬走的文件原来相对 import 它)。

**core 大桶**再导出的这 4 组改成从新址再导出。经大桶拿名字的使用者只有 agent-loop 一组:`runtime/collab/say-tool.ts`
(`registerRetiredAgentToolName`)、`runtime/sessions/history-messages.ts`(`getAIToolName` / `AgentProviderData`)、两份测试;
engine / plugins / sessions 三组没有使用者。

**手改的文件**:检查器;`packages/shared/ipc/chat.ts` 一处花括号提法、`shared/session/events/chunk-codec.ts` 两处「原 part-boundary.ts」
历史注释、`ui-stream-part-boundary.test.ts` 一处注释(那只状态机早已迁进 shared 的 chunk-codec,脚本找不到唯一现址);
`apps/desktop-react/src/data/chat-port.test.ts` 一行相对 import(它在 `chat-*` 名下但不在别的会话的改动里,不改 typecheck 就红);
`scripts/provider-vendor-drill/acme-drill.test.ts.txt` 一行 import(`.txt` 不在脚本范围;键改了名,不改演练就红);
`resources/skills/onething-verification/SKILL.md`、`scratchpad/shadow-replay.ts` 各一处路径;assembly 基线;根 `CLAUDE.md`;本文。
脚本把 10 处过时注释路径按 `packages/shared/` 下的原样镜像改成了现址。

**留下的**:别的会话在改的 `apps/desktop-react/src/data/chat-{fold,source}.ts`(及 `chat-source.test.ts`)里 7 处注释还写着 core 的旧路径,
没碰;`RESOURCES.md`、`evals/DESIGN.md` 里 4 处是合包以前的 `packages/core/…` 路径;`.pi-glla/` 与检索语料 fixture 是数据。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(产物 0 处 `node:`)
成功;根全量 vitest 改前 11416 / 19 红,改后 11416 / 19 红,失败集合逐条相同;壳 7344 / 1 红(A9),相同;`gate:acp` 前后 108 ok;
boundary(135 条)/ transport / log / assembly / session / provider / gate:native 门输出前后逐字相同(assembly 仍只红 radio.ts)。
`sessions:shadow-battery` 前后各 130 行,逐行比只差三行:两行 `web-<id>` 会话名、`refoldChecks` 216 → 217(采样次数,随调度浮动);
27 个场景的 PASS / FAIL 逐行相同,`compact-half-run-log` FAIL 与 `appendFailures 8` 两边一样。`provider-vendor-drill` 在主检出上红
(它在 HEAD 上开临时 worktree,而演练模板读的是工作区里已改的那份;HEAD 上还是旧的 exports 键),在重放 worktree 上做一笔不挂分支的
临时提交、从那里跑就全绿 —— 本批提交以后在主检出上同样会绿。

### 去 core 批 3 落地记录(2026-10-03,未提交)

**一句话**:大桶 `core/index.ts` 删掉,41 个经它取名字的文件改成从各功能目录取;core 根上三只文件各回各家;`core/__tests__/` → 包根
`__tests__/`;gateway 子树 → `runtime/gateway/`(它那个叫 core 的子目录改名 `hub/`);`runtime/tools/core/` 改名 `access-control/`;
`packages/backend/core/` 目录删除。三只脚本按序跑(scratchpad 的 `s4-dissolve-barrel.mjs` → `s4-move-core3.mjs` → `s4-reformat-imports.mjs`),
在 HEAD 的临时 worktree 上用独立 `GIT_INDEX_FILE` 重放,218 个产物路径里只差 33 只手改文件,补上之后零差异。
`ls packages/backend`:`__tests__ backend.ts channel current.ts events features host-ports.ts lifecycle.ts package.json provider-binding rpc runtime server session store.ts stores types.d.ts utils`。

**大桶的使用者**(改成从下列来源取):`RuntimeRequestContext` / `OnethingRuntimeFacade` / `createOnethingRuntimeFacade` / `Runtime*`
→ `@onething/backend/server/runtime-facade.js`(server 下的门面文件、`session/access.ts`、runtime 的 collab 各房间与工具、
`engine/execution-context.ts`、`plugins/commands.ts`、`tasks/dispatch.ts`、`toolkit/executions.ts` 与测试);`EventBus` / `StreamChannel` → `runtime/event-bus`;
`AgentEngine` 与两个事件类型 → `runtime/agents/agent-engine`;`Permission` / `addGrant` → `runtime/permission/permission-asks`
(三份 radio 测试的 `vi.mock(…, importOriginal)` 跟着改 mock 这只模块);`getAIToolName` / `AgentProviderData` /
`registerRetiredAgentToolName` 等 → `runtime/agent-loop/loop-primitives`。拆完一行的 import,原来写成多行的两处(`server/http.ts`、
`server/runtime.ts`)按原缩进还原成多行(否则 `transport:gate` 量的 `server/http.ts` 行数会变)。

**删掉的文件**(删掉大桶后零使用者):`runtime/agents/agent-engine-exports.ts`、`runtime/providers/stream-provider-contract.ts`、
`runtime/context/index.ts`(三只都只有大桶在用;`runtime/context/context-manager.ts` 照旧,被 `agents/agent-engine.ts`、
`providers/types.ts` 相对 import)。

**去向表**:

| 旧路径(`packages/backend/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `core/gateway-runtime.ts` | `runtime/gateway/conversation-runtime.ts` | 网关吃的那份会话运行时契约(`CoreConversationRuntime` …),随 gateway 走 |
| `core/runtime-facade.ts` | `server/runtime-facade.ts` | `OnethingRuntimeFacade`:各宿主门面(HTTP/SSE)共用的契约,住包根的门面目录 |
| `core/freeze.ts` | `utils/deep-freeze.ts` | 通用深冻结,插件快照、会话命令面三处在用 |
| `core/__tests__/*`(8 份) | `__tests__/*` | 包根的跨领域测试(架构测试等),原名不撞 |
| `gateway/**` | `runtime/gateway/**` | 用户拍板:core 没了,gateway 是普通功能 |
| `gateway/core/**` | `runtime/gateway/hub/**` | 渠道无关的网关本体(Gateway 注册表、bridge、会话表、权限协调、存储、中间件) |
| `runtime/tools/core/**` | `runtime/tools/access-control/**` | 沙箱根 + 权限策略两件 |

**同一件事的两半(没合)**:`runtime/gateway/conversation-runtime.ts` 与 `runtime/gateway-runtime.ts`(契约 + 产品侧实现;后者仍在
runtime 根上,本批没动);`utils/deep-freeze.ts` 与 `runtime/plugins/freeze.ts`(实现 + 插件那一份旧名出口)。

**规则**(检查器 135 → 132 条;架构测试 10 → 7 条):
- 撤:`checkMainUsesCorePackageImports`、`checkMainUsesGatewayPackageImports`(两个目录都没了,runtime 那条照旧管)、
  `checkCorePromptContextRegistryOwnedByRuntime`(批 1、2 已清空);`checkGatewayHostBoundary` 的依赖那一半(只留宿主禁令,断言名去掉
  `(core + @shared only)`);`checkSharedOwnsJsonProtocol` 里 core 的三格;用户插件许 import core 的口子;内置插件放行里 core 那一格。
- 架构测试撤:「core 无宿主 import」、I2、「gateway 只依赖 core + `@shared`」、runtime 那条里「不许 import gateway」。
- 改:子树概念只剩 runtime(检查器 `BACKEND_PRODUCT_SUBTREES = ['runtime']`、架构测试的子树相对 import、I1 排除名单只剩 `runtime`、
  `backend-public-boundary.mjs` 的「core / gateway 不许碰内部会话模块」);`checkRuntimeHostBoundary` 不再单独走 core(断言名
  `packages/backend/runtime + packages/backend …`);「内核不点名功能」补上 core 根上三只文件的新家;R4b 那张「不许复活」表里
  `runtime/tools/core/*` 那 11 格只改路径到 `access-control/`。
- assembly:不再跳过 core / gateway / kernel(注释重写);kernel 零个模块级 let,gateway 3 个文件按当时的值记入
  (`channels/wechat/ilink/sender.ts` 2、`hub/logging.ts` 2、`lifecycle-port.ts` 1 —— ③-收尾 C 删掉的那一行回到尺子上)。
- 别的门与配置只改路径:`eslint.config.js` 的 no-console 区去掉 core 两行、`session-check.mjs` 扫描面去掉 core 一行、
  `gate-search-index.mjs` 少一个 core 路径、`manifest-no-enumeration.test.ts` 扫描根去掉 core、两只 smoke 脚本改从功能目录 import。

**exports**:568 → 566(删 `./core` 与三只出口桶的键、`./runtime/context`,新增 `./runtime/agents/agent-engine`、`./runtime/providers/types`;
改名 7 格)。`./core/…`、`./gateway/…` 键为零。

**收尾 grep**:`backend/core|@onething/backend/core|packages/core/` 在代码 / 配置 / 脚本里为零;剩下的在文档(`README.md`、`RESOURCES.md`、
`evals/DESIGN.md`、`apps/desktop-react/docs/`、`docs/`)、数据夹具(检索语料 `corpus.json`、files-panel 测试与 `.design-sync` 预览里的
示例路径、`.pi-glla/`)、一个外部 URL(gemini-cli 的 `packages/core/…`,批 1 之前的一次改写把它误改成 `packages/backend/core`,本批改回原样),
以及别的会话在改的 `chat-{fold,source}.ts`。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(0 处 `node:`)成功;
根全量 vitest 改前 11416 / 20 红(19 + workspace-watch 偶发),改后第一次 11413 / 20 红(少的 3 条是架构测试按设计撤掉的,多出
`host-process` 一条 POSIX 信号偶发、单跑 5 绿,workspace-watch 这次没红),重跑 11413 / 19 红,与批 2 改后的 19 条逐条相同;
壳 7344 / 1(A9)相同;`gate:acp` 前后 108 ok;boundary(132 条)/ transport / log / assembly / session / provider / gate:native 门输出前后逐字相同;
`session:check` 只差扫描文件数 2730 → 2726(core 的大桶与三只出口桶删了),4 处发现相同;`sessions:shadow-battery` 前后各 130 行,
逐行只差两行 `web-<id>` 会话名;`provider-vendor-drill` 在主检出上就绿(本批没动演练模板)。

### 去 `.wiring` 后缀落地记录(2026-10-03,未提交)

**一句话**:`packages/backend` 下 31 只 `*.wiring.ts` 去掉后缀;它们的 3 份测试与 1 份快照跟着改名。后缀早在第③步拍平时就不再
表达任何权限(I3 与「非 wiring 文件不许 import `*.wiring`」两条一起撤了),这一笔只改名字。默认去掉 `.wiring`;去掉后与同目录文件
撞名的 10 只按**它比同名那一半多做的事**起名:只是「同一套 API 钉成 `@shared/ipc` 形状」的用 `ipc-` 前缀(仓里本来就有
`auth/ipc-operations.ts`、`mcp/ipc-operations.ts` 这样的名字),多做了别的事的按那件事起名。脚本 scratchpad 的 `s5-rename-wiring.mjs`
(普通文件改名、import / `vi.mock` / exports 精确键 / 注释里的路径提法按「目录 + 词干」查表改写,带 `--dry`);
四处裸写的 `service.wiring.ts`(终端三处、练习一处,脚本分不清)与说后缀规则「现在仍有效」的注释手改。

**去向表**(都在 `packages/backend/runtime/` 下):

| 旧名 | 新名 | 理由 |
| --- | --- | --- |
| `auth/types.wiring.ts` | `auth/ipc-types.ts` | 撞 `auth/types.ts`;把 auth 类型钉成 `@shared/ipc` 的 `OAuthToken` 等形状,别的不做 |
| `providers/types.wiring.ts` | `providers/ipc-types.ts` | 撞 `providers/types.ts`;同上,provider 的类型钉成 `@shared/ipc` 形状 |
| `providers/env.wiring.ts` | `providers/ipc-env.ts` | 撞 `providers/env.ts`;API key 环境变量那几个函数的 `@shared/ipc` 签名版 |
| `triggers/skill-review-state.wiring.ts` | `triggers/ipc-skill-review-state.ts` | 撞 `triggers/skill-review-state.ts`;把 `TSettings` 钉成 `AppSettings`,别的不做 |
| `engine/ipc-emitter.wiring.ts` | `engine/session-stream-emitter.ts` | 撞 `engine/ipc-emitter.ts`(泛型);这只把七个类型参数钉成会话流的 `Step` / `ToolCall` / 流结束数据 |
| `plugins/lifecycle.wiring.ts` | `plugins/lifecycle-hooks.ts` | 撞 `plugins/lifecycle.ts`(泛型注册表);多做的是进程里那一份钩子注册表 + 健康记账 |
| `mcp/index.wiring.ts` | `mcp/index-with-bridge.ts` | 撞 `mcp/index.ts`;内容就是「目录桶 + 工具桥」 |
| `prompts/resolver.wiring.ts` | `prompts/stored-prompt-resolver.ts` | 撞 `prompts/resolver.ts`;多做的是按提示词库(`store-bound` 的 `getPrompt`)解析引用 |
| `prompts/plugin-context.wiring.ts` | `prompts/plugin-context-breaker.ts` | 撞 `prompts/plugin-context.ts`;多做的是断路器记账 |
| `practice/service.wiring.ts` | `practice/service-slot.ts` | 撞 `practice/service.ts`;内容是单槽绑定 + 读单槽的那排自由函数 |
| 其余 21 只 | 去掉 `.wiring` | 不撞名:`agents/store-bound`、`collab/actors/{agent-replay,room-actor,room-replay,turn-context}`、`engine/session-turn-context`、`interaction/ipc-operations`、`mcp/bridge`、`plugins/tarball`、`providers/utility-model`、`scheduler/run-history-bound`、`skills/plugin-roots`、`terminal/{service,spawn-profile}`、`toolkit/{catalog-projection,execution-types,ipc-observer,mcp-catalog}`、`voice/{audio-router,host-ports,kws/engine}` |

测试:`plugins/__tests__/tarball.wiring.test.ts` → `tarball.test.ts`、`providers/__tests__/env.wiring.test.ts` → `ipc-env.test.ts`、
`toolkit/__tests__/ipc-observer.wiring.test.ts` → `ipc-observer.test.ts`(快照文件同名改,内容没动)。

**留着的层字眼**:`agents/store-bound.ts`、`scheduler/run-history-bound.ts`、`voice/host-ports.ts` 是默认去后缀得来的,不是新起的名字;
`-bound`(`prompts/store-bound.ts`、`engine/chat-logger-bound.ts` …)与 `host-ports.ts`(宿主表那一格的端口,`auth/` `shell/` `dialog/` …
都这么叫)在仓里本来就是通行的名字,本笔不动。

**同一件事的两半(没合)**:上表撞名的 10 对都是「泛型 / 产品半边 + 钉成 `@shared/ipc` 形状(或多一样东西)的半边」。其中两对值得单独
拿出来拍:`mcp/index.ts` 与 `mcp/index-with-bridge.ts`(规则撤了以后,桥可以直接进目录桶);`triggers/ipc-skill-review-state.ts` 只有
`engine/triggers/__tests__/` 下两份测试在用,产品代码零处 —— 它与 `skill-review-state.ts`、`skill-review-state-core.ts` 是同一件事的三层。

**exports**:566 → 566,29 格键与值改名(另外两只 `mcp/bridge`、`terminal/spawn-profile` 本来就没有键,只被相对 import)。

**改写的断言**(只改路径):检查器 `checkCoreOwnsToolSchemaProjection` 读 `toolkit/catalog-projection.ts`、`checkRuntimeOwnsProviderDefinitionTypes` 读
`providers/ipc-types.ts`、`agents/store-bound.ts` 与 `scheduler/run-history-bound.ts` 两条位置断言,`probe-go-to-implementation.mjs` 的四格
期望路径;检查器 2434 一带「文件名本批不改」改成现状。`token-store.wiring.ts` 那条「死文件回来就是红」原样保留(它守的是一个早就删掉的文件)。
`docs/audit/assembly-baseline-2026-09-02.txt` 四行改路径(`turn-context` / `practice/service-slot` / `terminal/service` / `voice/host-ports`),计数没动。

**收尾 grep**:`git grep "\.wiring"` 在代码 / 配置 / 脚本里只剩说明历史的注释(`mcp/index.ts`、`mcp/index-with-bridge.ts`、
`practice/service.ts`、`settings/host-ports.ts`、`shared/contracts/{acp,practice}.ts`、`shared/ipc/host-mcp.ts`、检查器 2434–2437 / 2459 /
6039 / 6210、`CLAUDE.md` 两句)与 `token-store.wiring.ts` 那条守死文件的断言;文档里的旧名(`docs/`、`apps/desktop-react/docs/`)不改。

**脚本与手改**:脚本改名 35 只、改写 169 只文件;在 HEAD 的临时 worktree 上用独立 `GIT_INDEX_FILE` 重放,输出与主检出逐行相同。手改 20 只:
`CLAUDE.md`、本文件、`docs/audit/assembly-baseline-2026-09-02.txt`、壳的 `content/terminal/session.ts`、检查器,以及注释改成现状的
`engine/{session-stream-emitter,session-turn-context}.ts`、`interaction/ipc-operations.ts`、`mcp/{index,index-with-bridge}.ts`、
`practice/{service,service-slot}.ts`、`prompts/plugin-context-breaker.ts`、`scheduler/run-history-bound.ts`、`settings/host-ports.ts`、
`triggers/ipc-skill-review-state.ts`、`voice/speech-output.ts`、`shared/contracts/{acp,practice}.ts`、`shared/ipc/host-mcp.ts`。
测试只改了 import 说明符、`vi.mock` 路径与两处注释里的路径;三份改名测试与快照内容逐字相同(只差 import 那一行)。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(0 处 `node:`)成功;
根全量 vitest 改前 11413 / 21 红,改后 11413 / 20 红 —— 按改名映射后唯一的差别是 `workspace-watch-driver` 改前红、改后绿(偶发);
`http.test` 文件面那条与 `build-workspace-watch.test.mjs` 前后都红,后者与 workspace-watch 单跑 22 绿;与去 core 批 3 改后相比也只差
这几条偶发(那次多一条 `host-process`)。壳 7344 / 1(A9)相同;`gate:acp` 前后 108 ok;boundary(132 条)/ transport / log /
assembly / session / provider / gate:native 门输出前后逐字相同(assembly 前后都红在 `music/radio.ts` 9 → 10,不是本笔的文件);
`assembly:check` 只差四行改了名的路径;`session:check` 2726 个文件 / 4 处发现相同;`sessions:shadow-battery` 前后各 130 行、前后都红
(`appendFailures 8 ≠ 0`,去 core 批 3 改后就是这样),逐行只差 `refoldChecks` 216 → 217 与两行耗时;`provider-vendor-drill` 绿。

### 收尾整理 2 落地记录:合三对目录(2026-10-03,未提交)

**一句话**:只合目录、不合文件内容。包根 `events/` 与 `runtime/event-bus/` 并成 `runtime/events/`(包根 `events/` 删掉,I1 本来就要求包根
目录名不撞 runtime 领域名);`runtime/permission/` 并进 `runtime/permissions/`;`runtime/gateway-runtime.ts` 搬进 `runtime/gateway/`。
脚本 scratchpad 的 `s5-merge-dirs.mjs`(底子是 `s4-move-core3.mjs`:普通文件改名、按表查;包根 → runtime 的相对 import 改包说明符,包根
那几只 `./events/x.js` 形的 exports 键改成 runtime 形;不带前缀的 `events/…` 只在包根文件里、且真指向包根 `events/` 下的文件时才改);
46 只文件搬家、202 只文件改写;在 HEAD 的临时 worktree 上用独立 `GIT_INDEX_FILE` 重放,输出逐行相同。

**撞名的去向**(都在 `packages/backend/` 下):

| 旧路径 | 新路径 | 理由 |
| --- | --- | --- |
| `events/index.ts` | `runtime/events/index.ts` | 对外入口(`createEventSystem` / `getEventBus` / `getStreamChannel`),目录桶留给它 |
| `runtime/event-bus/index.ts` | `runtime/events/bus-primitives.ts` | 泛型原语的桶;与仓里 `engine-primitives.ts`、`loop-primitives.ts` 同一种叫法 |
| `events/event-bus.ts` | `runtime/events/session-event-bus.ts` | 撞泛型 `event-bus.ts`;这只把总线钉成 `SessionBusMessage` / `GlobalEvent` |
| `events/ring-buffer.ts` | `runtime/events/session-ring-buffer.ts` | 撞泛型 `ring-buffer.ts`;缓冲钉成 `SessionBusMessage` |
| `events/stream-channel.ts` | `runtime/events/session-stream-channel.ts` | 撞泛型 `stream-channel.ts`;流通道钉成 `StreamChunk` |
| `events/types.ts` | `runtime/events/session-bus-types.ts` | 撞泛型 `types.ts`;总线回调类型钉成总线载荷 |
| `runtime/permission/index.ts` | `runtime/permissions/permission.ts` | 目录桶留给 permissions 原有的那只;这只是 `Permission` 的出口(并副作用 import `grant-storage.js`) |
| `runtime/gateway-runtime.ts` | `runtime/gateway/engine-conversation-runtime.ts` | `conversation-runtime.ts` 那份契约的产品侧实现:把 stream engine 包成网关的会话运行时 |

其余文件原名搬进新目录(`events/` 的 `delta-stamp` / `event-only-emitter` / `memory` / `stream-coalescer` / `tool-progress-stream` /
`ui-stream` 与 4 份测试,`event-bus/` 的 `event-bus` / `ipc-operations` / `ring-buffer` / `stream-channel` / `types` 与 3 份测试,
`permission/` 的 7 只文件与 13 份测试);测试名一个都不撞。

**同一件事的两半(没合)**:`runtime/events/` 里四对「泛型原语 + 钉成总线载荷的子类 / 别名」(`event-bus` / `session-event-bus`、
`ring-buffer` / `session-ring-buffer`、`stream-channel` / `session-stream-channel`、`types` / `session-bus-types`)与两只桶
(`index.ts` / `bus-primitives.ts`);`runtime/permissions/` 的两只桶(`index.ts` / `permission.ts`);`runtime/gateway/` 的
`conversation-runtime.ts` / `engine-conversation-runtime.ts`(契约 + 实现)。

**规则与门**(只改路径):检查器 `MAIN_CORE_SYSTEM_DIRS` 的 `packages/backend/events` → `runtime/events`(从此量整个 `runtime/events`,
原 core 原语那几只一并在内,照样全绿),点名的四只 permission 文件改到 `runtime/permissions/`(`index.ts` 那一格改成 `permission.ts`,
`permissions/` 原有的文件不进这把尺子);「不许在权限目录里再抄一份」与 `CORE_MERGED_RUNTIME_DIRS` 的两格、「runtime/events owns session
command/event IPC projections」(断言名跟着改)、`permission-grants.ts` 位置断言都只改路径。`probe-go-to-implementation.mjs` 的期望路径、
`docs/audit/assembly-baseline-2026-09-02.txt` 两行(`grant-storage` / `permission-grants`,计数没动)同步。

**exports**:566 → 567。改名 18 格(包根 `./events/*.js` 9 格改成 `./runtime/events/*`、`./runtime/event-bus*` 4 格、`./runtime/permission*` 5 格),
新增 `./runtime/events/memory`(`backend.ts` 从前相对 import 包根的 `./events/memory.js`,搬进 runtime 以后改走包说明符)。

**runtime 根上还散着的单文件(本笔不动,只列)**:除了领域桶 `runtime/index.ts`(`@onething/backend/runtime`,94 处在用),其余五只都是
stream engine 的东西,按内容属于 `runtime/engine/`:`runtime.ts`(`createOnethingRuntime`:引擎 + 会话运行时)、`product-stream-runtime.ts`、
`stream-runtime.ts`、`stream-processor.ts`(后两只与 `engine/` 里已有的同名文件撞名,搬时要按内容改名)、`stream-sender.ts`(流引擎的命令目标形状)。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(0 处 `node:`)成功;
根全量 vitest 改前 11413 / 19 红,改后 11413 / 20 红 —— 按路径映射后唯一的差别是 `build-workspace-watch.test.mjs` 改后红(偶发,单跑 4 绿);
壳 7344 / 1(A9)相同;`gate:acp` 前后 108 ok;transport / log / assembly / session / provider / gate:native 门输出前后逐字相同;boundary
132 条全 ok,只差一条断言名(`runtime/event-bus` → `runtime/events`);`assembly:check` 只差两行路径;`session:check` 2726 / 4 相同;
`sessions:shadow-battery` 前后各 130 行、前后都红在 `appendFailures 8 ≠ 0`,逐行只差 `refoldChecks` 215 → 217 与耗时;drill 绿。

### 收尾整理 3 落地记录:runtime 根上的五只散文件进 `runtime/engine/`(2026-10-03,未提交)

**一句话**:只搬家,不合内容。runtime 根上只剩总桶 `runtime/index.ts`(`@onething/backend/runtime`)。脚本 scratchpad 的
`s5-move-engine-root.mjs`(底子是 `s5-merge-dirs.mjs`,表换成单文件);8 只文件搬家(5 只源文件 + 3 份测试)、12 只文件改写;
在 HEAD 的临时 worktree 上用独立 `GIT_INDEX_FILE` 重放,输出逐行相同。手改 4 只:`CLAUDE.md` 的目录树、`stream-sender.ts` 的说明头、
两只改名文件补一段说明头;外加本文件。

| 旧路径(`packages/backend/runtime/` 下) | 新路径 | 理由 |
| --- | --- | --- |
| `runtime.ts` | `engine/runtime.ts` | 不撞名;`createOnethingRuntime`(引擎 + 会话运行时) |
| `product-stream-runtime.ts` | `engine/product-stream-runtime.ts` | 不撞名 |
| `stream-runtime.ts` | `engine/stream-runtime-factory.ts` | 撞 `engine/stream-runtime.ts`(适配器接口表);这只是按适配器表造 `CoreStreamEngineRuntime` 的工厂 |
| `stream-processor.ts` | `engine/stream-processor-factory.ts` | 撞 `engine/stream-processor.ts`(处理器本体);这只是把 onething 的选项形状转给 `createCoreStreamProcessor` 的工厂 |
| `stream-sender.ts` | `engine/stream-sender.ts` | 不撞名;流引擎的命令目标形状 |
| `__tests__/{product-stream-runtime,runtime}.test.ts` | `engine/__tests__/` 同名 | 测试跟着源文件走 |
| `__tests__/stream-processor.test.ts` | `engine/__tests__/stream-processor-factory.test.ts` | 同上,名字跟源文件 |

**同一件事的两半(没合)**:`engine/stream-runtime.ts` / `engine/stream-runtime-factory.ts`(接口表 + 工厂)、`engine/stream-processor.ts` /
`engine/stream-processor-factory.ts`(本体 + 选项转接的工厂)。

**exports**:567 → 567,改名 4 格(`./runtime/{runtime,product-stream-runtime,stream-processor,stream-sender}` → `./runtime/engine/…`;
`stream-runtime` 本来就没有键,只经总桶出去)。检查器两条位置断言(`product-stream-runtime.ts`、`stream-processor-factory.ts`)与
`probe-go-to-implementation.mjs` 三格只改路径。

**总桶 `runtime/index.ts` 的现状**(本笔不动):再导出 2337 个名字 —— 24 只领域桶 `export *`(`providers` 422、`tools` 215、`evals` 161、
`triggers` 116、`sessions` 114、`prompts` 107、`scheduler` 106、`search` 103、`agents` 100、…)加 `engine` / `skills` / `markdown` / `gateway`
四处点名导出。经它取名字的只有 17 只文件:包外 3 只(`evals/run.mjs`、`scripts/diagnose-weekly.mjs`、`scripts/gateway-smoke-test.ts`),
包根 8 只(`backend.ts` 与 `rpc/domains/{evals,evals-workbench,session-command}.ts` 及三份 mock 它的测试、`evals-access.ts` 只在注释里提到),
runtime 内 4 只;取的名字绝大多数是 evals 那一族。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(0 处 `node:`)成功;
根全量 vitest 改前 11413 / 21 红,改后 11413 / 19 红 —— 按路径映射后的差别只有改前两条偶发(`workspace-watch-driver`、`model-registry-abort`)
改后绿;壳 7344 / 1(A9)相同;`gate:acp` 前后 108 ok;boundary(132 条)/ transport / log / assembly / session / provider / gate:native /
`assembly:check` / `session:check` / drill 输出前后逐字相同;`sessions:shadow-battery` 前后各 130 行,除耗时外逐行相同(前后都红在 `appendFailures 8 ≠ 0`)。

### 功能入口第 1、2 笔落地记录:棘轮 + search 收口(2026-10-03,未提交)

**一句话**:立「功能入口」棘轮 `entry:gate`,search 第一个收口 —— 外面只从 `@onething/backend/runtime/search` 拿名字,exports 里 search 的深层键
15 个全删,棘轮里 search 一行 10 → 2(剩下两处都是构建 / 门脚本,见下)。

**第 1 笔:棘轮**(`scripts/feature-entry-gate.mjs`,`entry:check` / `entry:gate`,CI gates job 一步,基线 `docs/audit/feature-entry-baseline-2026-10.txt`)。
口径:扫 `packages/`、`apps/`、`scripts/`、`evals/` 的源文件(跳过 node_modules、点目录、构建产物),用 TypeScript 解析器取模块说明符
(`import` / 副作用 `import '…'` / `export … from` / `import = require` / 动态与类型位置的 `import()` / `require` / `vi.mock` 一族);包说明符先按
exports 精确键解析到文件(`./runtime/search/index` 这种键指的是 `index/` 子目录的桶,不是入口),解析到 `runtime/<d>/index.ts` 不计、到功能目录里
别的文件计一处、引用方自己在功能目录里不计;总桶 `runtime/index.ts` 单记 `(总桶)`。立尺时 2693 处 / 56 行。与会话里的量法 `deep.mjs`(2815)
对账:2815 − 168(`deep.mjs` 把 `…/index.js`、`…/index.ts` 形的入口当成了深层)+ 36(总桶它不数)+ 10(它的正则看不见的写法:8 处副作用
`import '…'`、2 处 `typeof import('…')`)= 2693。构建配方里按文件路径指 Worker 入口的字符串(`build-electron.mjs` 的 `SEARCH_WORKER_ENTRY`)
不是 import,不计。

**第 2 笔:search 收口**。入口 `runtime/search/index.ts` 在原有五行 `export *`(`providers` / `service` / `service-bound` / `capabilities` /
`text/plain`)之外加了外面真要的五个名字:`configureAppSearchProviders`、`createAppSearchService`、`unavailableIndexFace`、
`registerPluginSearchProvider`,与类型 `CapabilityManifest` / `PreviewPayload`。改走入口的 8 处:`backend.ts` 两处、`server/runtime.ts`、
`rpc/domains/search.ts`、`runtime/plugins/api.ts`、`rpc/__tests__/search-domain.test.ts` 两处、`__tests__/import-side-effect-free.test.ts`。
search 目录里 60 只文件的 100 处「用包说明符引自己的深层文件」改成相对路径(脚本 scratchpad 的 `s6-search-relative.mjs`),5 只非测试文件里
「从自己的入口取名字」改成直取定义它的那只文件(入口现在再导出 `service-setup` / `install-providers`,不改就是入口自引用的环)。
exports 567 → 552,删 15 键:`capabilities`、`index`、`index/worker-data`、`index/worker-host`、`service`、`service-bound`、`kernel`、
`kernel/__tests__/index-contract`、`kernel/__tests__/unit-fixtures/corpus`、`kernel/index/types`、`kernel/redact`、`service-setup`、
`plugin-search-registry`、`install-providers`、`embedding/transformers-onnx`(最后这个审过后删:门脚本改按相对文件路径引)。

**没进入口的两处**(棘轮里 search 剩下的 2):`scripts/gate-embed-runtime/entry.ts` 引 `embedding/transformers-onnx`(进入口就会把嵌入库的
动态 import 字面量带进主进程 bundle,而这道门的规矩正是「只 import 产品自己那份嵌入器」),改成按相对文件路径
`../../packages/backend/runtime/search/embedding/transformers-onnx.js` 引用 —— 门脚本有意引用内部文件,棘轮照数;`scripts/lib/search-corpus-redact.mjs` 按相对路径再导出 `kernel/redact.ts`(bun 跑的语料脚本,
走入口会把整个检索图连同 Worker 宿主一起拉进来),维持现状。

**测试改动**:`import-side-effect-free.test.ts` 改了测试逻辑 —— 从前桩打在入口的 `configureOnethingSearchProviders` 上、`install-providers` 经入口
取它;`install-providers` 进了入口以后再经入口取就是自引用,实测桩够不着(`'search'` 那一行数不到)。改成 `configureAppSearchProviders(configure?)`
把「真正去装」那一步当参数递进来(装配从不传),桩换成「调真的那一份、只把 configure 换成计数」,闩照样被测到。代价:`install-providers`
在 import 时若直接调真的 `configureOnethingSearchProviders`,这道栅栏不再看得见。其余测试只改 import 说明符。

**证据**:三份 `search-worker.cjs` 前后逐字节相同(1283673 / 1283673 / 1282203);`backend.ts`、`server/runtime.ts` 的静态 import 闭包前后同一组文件
(1456 / 1474),桌面 `main.cjs` 的 esbuild 输入同一组 2153 只,字节差(server +132、cli +332、桌面 +3241)是模块求值顺序与 esbuild 惰性初始化包装,
三份主进程 bundle 里嵌入库 / onnxruntime 字面量前后都是 0。变大的是**入口本身的闭包**:search 入口 156 → 683 只文件、总桶 697 → 870、
`plugins/api.ts` 791 → 878、`rpc/domains/search.ts` 185 → 686 —— 凡 import 入口的都背上了 `service-setup` 那棵树(包根 stores / session、notes、
toolkit、Worker 宿主);在宿主里它们本来就在,bun 下 import 总桶照常装得上。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;`server:build`、`build:cli`、桌面四个 bundle、`web:build`(0 处 `node:`)成功;根全量 vitest
11413 / 20 红,失败集合逐条相同(含偶发的 `workspace-watch-driver`);壳 7344 / 1(A9)相同;`gate:acp` 前后 108 ok;transport / log / assembly(radio.ts
9→10 前后都在)/ session / provider / gate:native / boundary(132 条)/ `assembly:check` / `session:check` / drill 输出前后逐字相同;`sessions:shadow-battery`
前后各 130 行,逐行只差 `refoldChecks` 216 → 217(前后都红在 `appendFailures 8`);`golden-hit-sets.json` 逐字不变;`entry:gate` 绿。`gate:search-index`
⑤d 两条的命中清单前后逐字相同,⑤c 前后都红;⑪a(等到 `model.state === 'absent'` 就读 `vectorErrorKind`,读的时候向量写路未必已经试过嵌入,
是门本身的竞态)HEAD 上跑 5 次红 1 次、改后跑 9 次红 7 次 —— 改后 server bundle 模块求值顺序变了,时序跟着挪,未查到行为差异。
审过后修门:那次 `waitForStatus` 改成等「`model.state === 'absent'` 且 `vectorErrorKind` 已有值」,再照旧判它等于 `'model'`。

### 功能入口第 3 笔落地记录:sessions 收口(2026-10-03,未提交)

**一句话**:sessions 的两个出口并成一个 —— `session-primitives.ts`(原 core 的会话内核出口,236 个名字)整段并进 `runtime/sessions/index.ts`
后删除,入口另加 `session-events`、`resource-spec` 两行 `export *` 与 `getMessagesPageFromJsonFilePath`;外面 100 处引用改走入口,exports 里
sessions 的深层键 14 个全删(552 → 538),棘轮 sessions 一行 88 → 1。

**合并前的核对**:两只出口导出的名字零重叠(114 / 236,同名 0);合并后逐个核对每个 `export *` 源模块的每个名字在入口上解析到同一个声明
(390 个,0 处被具名导出静默遮住);tsc 无 TS2308。

**深层目标的去向**(改前 88 处):

| 目标 | 处数 | 去向 | 理由 |
| --- | --- | --- | --- |
| `session-primitives` | 56 | 并进入口 | 本笔的主体;原文件删除 |
| `session-dehydrate` / `session-repository` / `stream-abort` / `ipc-operations` / `history-messages` / `branching` / `working-directory` / `storage-driver` | 6 / 5 / 3 / 3 / 2 / 1 / 1 / 1 | 改调用方(说明符换成入口) | 入口原本就 `export *` 了它们,外面只是走了深路径 |
| `storage/jsonl/codec`(collab mailbox) | 1 | 改调用方 | 用到的四个编解码函数早经 `session-primitives` → `storage/index` 出口 |
| `commands`(一份测试) | 1 | 改调用方 | `sanitizeSessionOnStartup` 早在 `session-primitives` 里 |
| `session-events` | 5 | 进入口 | RPC 域、引擎的事件记录器、包根 `session/event-log.ts` 都要它 |
| `resource-spec` | 2 | 进入口 | RPC 域与资源提供方要 `session:` scheme 的常量与规格 |
| `storage/json-message-page-file` | 1 | 进入口(具名一个) | 包根 `stores/session-repository/` 要按路径读 legacy JSON;它从前不进桶是为了让内核出口在浏览器里 import 得动,那条理由没了 |

目录内:3 只非测试文件(`session-repository` / `session-events` / `storage-driver`)原先从 `session-primitives` 取名字,按名字拆成直取各自的再导出源
(`store-helpers` / `storage/index` / `events/index` / `commands` / `timeline`,脚本 scratchpad 的 `s7-split-prim-imports.mjs`);包说明符引自己深层文件的
3 处改相对路径;目录内 9 份测试改走入口。全仓改写脚本 `s7-entry-rewrite.mjs`(通用:`<功能> [--alias-entry=…]`)。

**唯一留下的深层引用**:`runtime/search/index/ledger-feed.ts` 直取 `../../sessions/events/codec.js` 的 `parseSessionLogEventLog`。它跑在索引 Worker 里,
走入口会让 Worker 的静态闭包从 115 只涨到 349 只(把仓储、存储驱动、历史重建连着整棵 provider / agent-loop 树带进去),桌面 `search-worker.cjs`
实测 1282203 → 1685340 字节;直取以后 Worker 反而少了 11 只用不到的会话模块(1282203 → 1274739,server / cli 1283673 → 1276269)。

**白名单与内部会话模块**:`scripts/session-check.mjs` 点名的文件一个都没搬、没改名,只改了它们的 import;`session:check` 前后同 4 条命中(扫描数少 1,
是删掉的那只文件)。`backend-public-boundary.mjs` 的 `privateSessionFiles` 管的是包根 `session/`,本笔没加任何 exports 键,不涉及。

**入口闭包**:入口 289(旧 `index.ts`)→ 290(并入后);旧 `session-primitives` 那一侧是 54。凡原来只引内核那半边的,闭包都涨到入口的大小:
`session/refold-slices.ts` 55 → 291、`stores/session-repository/index.ts` 73 → 298、collab `mailbox.ts` 13 → 292(仍不碰包根脊柱:入口闭包里包根文件只有
`utils/deep-freeze.ts`,和从前一样)。宿主 bundle 的输入集合只少了被删的那一只;`main.cjs` / server `main.js` 涨 ≈ 25KB / 17.5KB,是从前被摇掉的内核导出
(例如 `SESSION_EPHEMERAL_FACT_POLICY` 那张表)因为总桶 `runtime/index.ts` 的 `export *` 现在连着它们而留了下来。循环依赖 / 初始化顺序:`import-side-effect-free`、
`assembly-lifecycle` 绿,server 单文件包经 `gate:search-index` / `gate:acp` / battery 起得来,CLI `--help` 在临时 store 上起得来且不写 store。

**验收(改前 / 改后)**:typecheck node / desktop / mobile 零错;四份构建成功(web 0 处 `node:`);根全量 vitest 11413 / 19 红 → 20 红,多出的是偶发的
`workspace-watch-driver`(单跑 18 绿),其余失败集合逐条相同;壳 7344 / 1 相同;`gate:acp` 108 ok;`sessions:shadow-battery` 前后各 131 行,逐行只差
`refoldChecks` 217 → 215(采样次数,两次跑之间本来就浮动)、都红在 `appendFailures 8`;`sessions:hydration-contract --all` 在固定夹具 store(battery 留下的临时
store 拷贝)上前后逐字相同,217 个会话 0 失败 —— 但这些会话都生于 2026-08-26 之后、没有 `messages.jsonl` 抄本(209 个 `no-transcript`、8 个 `no-events`),
所以这条合同在这里比不出实质差异;真店才有旧抄本,本批不碰真店。transport / log / assembly / session / provider / gate:native / boundary(132 条)/ drill 前后
逐字相同;`gate:search-index` ⑤d 命中清单前后相同、⑤c 前后都红、⑪a 前后都绿;golden 快照不变;`entry:gate` 绿(2598)。
