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

### 目录规矩(第一个领域 search 立下,后面的领域照抄)

**一个领域的家是 `runtime/<d>/`。** 产品文件原地不动;从前散在别处的两片搬进来,各占一个按角色命名的子目录:

- **`runtime/<d>/kernel/`**:从前的 `core/<d>`。一个 `core/<d>` 只有在**别的领域也真 import 它**时才配留在 core
  (那才是通用骨架);只服务本领域的内核(search 的 `core/search` 就是:除 search 自己以外零真实 importer,其余命中
  全是注释)并进领域,改叫 kernel。搬家不改它的身份:它仍是零依赖的骨架。
- **`runtime/<d>/wiring/`**:从前的 `backend/wiring/<d>`。它是装配层,只是住进了领域的家。
- RPC 处理器(`rpc/domains/<d>.ts`)这一步不动 —— RPC 注册表那张表的形状是第④步的事。

**守门规矩按路径角色判,不按住址判**(语义一条不放松):

1. kernel 当 core 判:core 身上的禁令(electron / `@shared/ipc` / 原生依赖 / MCP、ACP SDK / zod 等,以及「core 在最底层」)
   原样作用于 `runtime/*/kernel/**`。另加一条更紧的闭包:kernel 的非测试文件只许 import 自己那个 kernel 目录里的东西、
   `@onething/backend/core/**`、`@shared/*`(core 本来就许;`@shared/ipc` 照旧被 core 那组禁令拦着)与 node 内建 ——
   同领域的产品文件、`wiring/`、脊柱、第三方包一概不许。内核要能原样拿走,它就不能认识自己被谁用。
   (search 落地时这条连 `@shared` 也不许;mcp 内核从 `@shared/mcp/types` 取契约形状,并进来时按「kernel 当 core 判」放开。)
   「专属」怎么量:除了直接 import,还要看 core 的大桶 `core/index.ts` 有没有再导出它、有没有人经大桶拿它的名字 ——
   大桶再导出而没人用,就删掉那段再导出;有人用,它就不是专属内核,留在 core。
2. `runtime/<d>/wiring/**` 当装配层判:享有与 `backend/wiring/**` 逐条相同的规则集(可以 import 脊柱与 `@shared/ipc`,
   electron / `@main` / `@preload` 照禁),「产品层不许 import 脊柱」「三棵子树的相对 import 不出子树」两条对它豁免。
   反方向镜像 `*.wiring.ts` 那条:runtime 里**不在任何 `wiring/` 目录**的非测试文件不许 import `runtime/*/wiring/**`。
   这与 `*.wiring.ts` 后缀是两回事:后缀标的是**产品文件**里那道「只许说跨进程词汇」的窄口,目录标的是**装配层本身**。
3. 接线里指向脊柱的 import 一律写包说明符(`@onething/backend/wiring/logging/index.js` 这类,exports 缺键就补,风格照
   脊柱现有的 `.js` 键);**唯一的例外是内部会话模块**(`session/reads.ts`、`session/event-log.ts` 等,
   `scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles`)—— 那条门规定它们不许有 exports 键,所以接线
   照包根脊柱文件的样子相对 import 它们。runtime 子树的新键照 runtime 的风格不带 `.js`,目录桶有自己的键。
4. `assembly:gate` 的尺子跟着角色走:`runtime/` 子树照旧不量,但它下面每个 `<d>/wiring/` 都量,基线里搬家文件的行只改路径。
5. 按旧路径写的领域断言(search 的「只有一条查询路」、尸检表、「内核不点任何能力名」)只改路径。

搬家脚本是可复用的(会话 scratchpad 里的 `fold-domain.mjs <d> [--kernel] [--dry]`:`git mv` + 相对路径按搬家前的落点
重算 + 包说明符与注释里的路径改写 + exports 键改名补齐),`--kernel` 由「`core/<d>` 是否只有本领域在用」决定。

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
