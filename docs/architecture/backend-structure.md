# 后端结构说明

这份文件给人读:`packages/backend` 今天是怎么组织的、为什么这样分、读一个功能该从哪里下手、各道门在守什么、常见的坑。
它写的是 2026-10 结构重整之后的现状。逐条的决策与理由在 `docs/design/backend-structure-decisions-2026-10.md`
(文中「D23」这类编号都指那张表),每个功能的一行说明与依赖由代码生成在 `docs/architecture/feature-map.md`,
给 AI 的简明规则在根目录的 `CLAUDE.md`。

## 1. 一句话

后端是**一个包** `@onething/backend`,包里**一个功能一个目录**、平铺在包根下;每个功能只经自己的**入口文件**对外;
功能之间按 **L0–L4 五个层次**只许往下引;界面连进来的 HTTP 服务器不认识任何具体功能,只读各功能自己登记的名册。

## 2. 为什么这样分

**按功能分,不按层分。** 从前后端是四个包(core / runtime / gateway / backend),每个包里又分 `wiring/`(接线)和产品逻辑。
结果是一个功能散在四五个地方:想知道「会话是怎么存的」要翻 core 的会话内核、runtime 的仓储、包根的命令面和 wiring 的接线。
用户拍板把它们合成一个包(D2),同一功能的逻辑与接线放进同一个目录、不再分子目录(D3、D4),core 的「零依赖骨架」也一起撤掉
(D5:它是为了让界面复用而设的,而界面早已碰不到后端代码),最后连 `runtime/` 这一层目录名也去掉(D11)。这与业界说的
「按功能分包,不按层分包」和「看顶层目录就该知道系统做什么」(Screaming Architecture)是同一个主张。

**每个功能只经一个入口对外(D9)。** 「入口」就是功能目录里与目录同名的那只文件,例如 `packages/backend/session/session.ts`。
功能目录里的其余文件都是内部实现,外面不许直接引用。这样读一个功能,先看它的入口就知道它交出了什么;改一个功能的内部,
也只需要对入口负责。

**入口之间不许成环(D18、D19)。** 2026-10-04 服务商功能曾用一个 `export *` 的入口把一切都交出去,结果卷进一个 60 只模块的
加载期环:某个子类 `class X extends Base` 在加载时读到的 `Base` 还是 `undefined`,程序直接崩溃。继承没法改成「用到时再取」,
所以唯一的办法是保证入口之间的引用是一张有向无环图。这条做成了零基线硬闸 `cycle:gate`。

**功能之间要分层次(D23)。** 光无环还不够:一个既被很多功能当叶子用、又去引很多功能的目录(既是叶子又是枢纽),迟早会再成环,
也读不懂。于是给每个功能贴一个层次标签,规定只许高层引低层。层次用一张**标签表**表达(`docs/audit/feature-layers-2026-10.json`),
目录照旧平铺 —— 这是 Nx 模块边界与 Feature-Sliced Design 的做法:

| 层 | 名字 | 含义 |
| --- | --- | --- |
| L0 | 基础件 | 不认识任何产品概念:存储、日志、网络、生命周期这类 |
| L1 | 领域事实 | 纯事实与纯逻辑,不读用户的存储、不起服务:服务商是谁怎么说、一轮对话的内核、工具的纯模块、提示词拼装 |
| L2 | 能力 | 有自己的存储或服务:会话、设置、凭证、检索、插件、MCP / ACP …… |
| L3 | 编排 | 把多个能力接成一台机器跑:对话引擎、多 agent 协作、IM 网关 |
| L4 | 对外接口 | 界面连进来的 HTTP 服务器、装配配方、各功能开给界面的操作 |

「服务商」一族就是按层次拆开的典型(D24、D25、D122):`provider/` 只放各家服务商的事实与纯逻辑(L1);「拿服务商去干活」
(造实例、跑一次对话、辅助模型调用)是 `provider-call/`(L2);凭证池与轮换是 `credentials/`(L2)。从前它们挤在一个目录里,
正是那个 60 只模块的环的来源。

**开给界面的操作是功能的第二个入口(D26)。** 每个功能开放给界面调用的操作(RPC 域的处理函数)写在
`<功能>/<功能>-client-api[-<方面>].ts` 里。它会引很多别的功能的入口(为了完成一次请求),如果把它也算进功能的主入口,
功能就又变成枢纽。所以它单独成一扇门:只许 HTTP 服务器引它,它可以引任何功能的入口,任何主入口都不许引它。层次表里它与
HTTP 服务器同站 L4,不与所属功能同层。

**HTTP 服务器只读名册(D21、D66、D219)。** `packages/backend/http-server/` 收请求、推 SSE 事件流、写发现文件、认来访者,
但不认识具体功能。哪些 RPC 域、按什么顺序挂载,写在名册 `http-server-client-api-roster.ts`;各功能的 server 门面按什么顺序
安装与拆除,写在 `http-server-runtime-roster.ts`。这与服务商名册是同一个做法:**能力自己登记一行,别人读表**。

**文件名要能搜出来(D22)。** 重整前 1470 只文件里有 132 个文件名重复(`index.ts` 98 只、`types.ts` 36 只),在编辑器里搜一个
文件名会出来几十个结果。命名规范 N1–N7 参照 Angular 与 Google 的 TypeScript 风格指南:文件名全包唯一、功能名打头、入口叫
`<功能>.ts`、泛名不单用、目录用单数。

## 3. 一个功能目录里有什么

以会话为例,`packages/backend/session/` 里会看到:

- **入口** `session.ts`:文件头用几句人话说明这个功能做什么、交出哪几类东西、依赖谁(可读性判据 R3)。外面一律写
  `import { … } from '@onething/backend/session'`。
- **第二入口** `session-client-api.ts`、`session-client-api-commands.ts`、`session-client-api-events.ts` …… 每只是一个 RPC 域
  或只给 HTTP 服务器用的一个方面。
- **内部文件** `session-commands.ts`(唯一的写面)、`session-reads.ts`(唯一的读面)、`session-store.ts`(会话表)……
  它们按相对路径互相引用。
- **子目录** `projection/`、`trace/`、`storage/` 这类按内容分的普通子目录,文件名带上子目录名(`session-projection-canonical.ts`)。
- **测试** `__tests__/<被测文件名>.test.ts`。

功能目录以外,包根只有组装文件:`backend.ts`(唯一的装配配方)、`backend-assemble-engine.ts`(装引擎)、
`backend-current.ts`(进程里「当前那份后端」的槽)、`backend-host-ports.ts`(宿主端口表)、`backend-shutdown.ts`(关机阶段表),
`backend-standalone-main.ts`(不带界面的后端进程入口,见下面「进程入口」),加上 `http-server/` 和放跨功能测试的 `__tests__/`。

还有两种特殊的门:

- **装配入口** `<功能>-configure.ts`:装配时才建的状态与接线 API。今天只有日志一家(`packages/backend/logging/logging-configure.ts`):
  它会建日志文件、目录管家、崩溃钩子,还要存储层。如果从日志的主入口交出,检索 Worker 为了拿一个 `getLogger` 就会把这些全带进
  自己的产物里,所以单开一扇门,只给装配方用(D191)。
- **进程入口**:被构建配方当作独立进程或线程起的文件,例如检索 Worker `packages/backend/search/index/search-index-worker.ts`、
  不带界面的后端进程 `packages/backend/backend-standalone-main.ts`(`server:build` 把它打成 `dist/server/main.js`,`server:start`
  与真机门跑的就是它;2026-10-05 从 `apps/backend-server` 并进来,D255–D258)和独立网关
  `packages/backend/gateway/gateway-standalone-main.ts`。它们按路径直接指要的模块(这样产物里只有真正需要的东西),
  反过来**不许被任何文件 import** —— 否则 import 它就等于启动了一个进程。

## 4. 读一个功能该怎么读

1. 先在 `docs/architecture/feature-map.md` 里找到这个功能那一行:它在哪一层、做什么、依赖哪些功能、入口交出多少个名字。
   依赖多的、在高层的功能(engine、collab),先读它依赖的低层功能会轻松很多。
2. 打开入口 `<功能>/<功能>.ts`,读文件头的说明书,再看它按类分组交出了哪些名字 —— 那就是这个功能对外承诺的全部。
3. 想知道界面能对它做什么,看 `<功能>-client-api*.ts`;每只文件导出一行 `defineClientApi({ id, router, handlers })`,契约在
   `packages/shared/ipc/` 里同名的路由文件。
4. 想知道它什么时候被装上、和谁接在一起,在 `packages/backend/backend.ts` 里搜它的入口名;装配期起的东西旁边都有一行
   `backend.own(...)`,那就是它的拆除。
5. 内部文件按文件名就能猜出内容(`<功能>-<做什么>.ts`);测试与被测文件同名,是最好的用法示例。

读的时候**不需要**先读另一个功能的内部文件(R5)。如果发现必须这样做,说明那两个功能之间的边没有走入口,值得记下来。

## 5. 各道门守什么

门 = 一个会让 CI 变红的检查脚本。「零基线硬闸」指一处命中就红;「棘轮」指按基线计数,只许减少不许增加。

| 门 | 守的规则 | 红了怎么办 |
| --- | --- | --- |
| `bun run entry:gate` | 功能外只经入口(D9);进程入口不被 import | 把要的名字加进对方入口的具名导出,改走入口。非测试一处就红;测试的深层引用按功能计数只许降 |
| `bun run cycle:gate` | 入口之间无环(D19) | 看它打出的最短环,找环上「低层引了高层」或「入口里放了实现」的那一处 |
| `bun run layer:gate` | 只许高层引低层(D23);新功能必须先登记层次 | 把文件搬到它真正依赖的层次,或改成「能力登记、低层读表」 |
| `bun run client-api:gate` | 第二入口只许 HTTP 服务器引;装配入口只许 L4 与 apps 引(D26、D68、D191) | 别的功能要用的那部分,搬进主入口能交出的文件里 |
| `bun run name:gate` | N1 重名、N2 功能名打头、N3 不许 `index.ts`、N4 泛名不单用(D22、D109、D119) | 按 `<功能>-<做什么>.ts` 改名;测试跟着改 |
| `bun run feature-map:check` | 功能地图与代码一致(R4) | 跑 `bun run feature-map` 重生成,不要手改 |
| `bun run assembly:gate` | 模块级 `let` 只许降 | 把状态挂到 `OnethingBackend` 实例上并 `own()`,或放进首次用到时才建的 `const` 持有器 |
| `bun run boundary:gate` | 后端不引 electron 等宿主代码、shared 只引自己、界面只引 shared 与 SDK、退役的东西不许复活 | 按它打出的断言名去 `scripts/headless-boundary-check.ts` 看那条规则 |
| `bun run provider:gate` | 服务商的名字不出现在它自己的目录之外 | 把这一家的特殊行为做成名册上的可选钩子 |
| `bun run transport:gate` | 不开新的手写通道;不拿 `context.transport` 判宿主能力或信任 | 走 `POST /api/rpc`;问宿主端口或本机信任 |

另外两处不是脚本门、但同样在测试里断言:`packages/backend/__tests__/import-side-effect-free.test.ts`(import 后端模块不做配置、
不读设置、不建仓库)与 `packages/backend/__tests__/architecture-boundaries.test.ts`(功能目录的相对 import 不出功能目录、会话内部
模块不外引、包根文件不与功能同名)。

功能内部只引兄弟文件、不引自家入口(D126)与入口不用 `export *`(N3)两条,由 `entry:gate` 守,都是零基线硬闸(D228,
拆分批 1 立门、批 2 清零,D235 / D236 / D241)。

## 6. 常见的坑

**同名不同物。** 两个不同的东西叫同一个名字,读者改走入口之后拿到的就可能是另一个。重整里遇到过三回:日志曾有两只不同的
`getLogger`(一只绑当前 root、一只绑 configure 自己的 root,D160 合成一只);事件总线的泛型基类与会话专用子类都叫 `EventBus`
(D191 把基类改名 `GenericEventBus`);项目目录有两份 `buildProjectDirsPromptVars`,一份按空间、一份按会话(D182 改成
`…ForSpace` / `…ForSession`)。新写名字时,先在全包搜一遍有没有同名的。

**桶文件。** 「桶」指只做 `export *` 转发的文件。它让入口一次交出几百个名字(违反 R6)、最容易卷进加载期的环(服务商的崩溃,D18),
还会让打包工具摇不掉没用的代码:一个总桶多转发了一行,桌面主进程包就大了 50KB(D62)。入口一律具名导出,只交外面真在用的名字。

**加载期取值。** 模块顶层就去读设置、建仓库、取「当前实例」,会让 import 顺序变成行为的一部分,是循环依赖与测试脆弱的根(D12、D13)。
需要状态时在首次用到时建,用一只 `const` 持有器装着;`import-side-effect-free.test.ts` 会数构造次数。

**入口里放实现。** 入口应该只有说明书和具名导出。入口里一旦写了实现(一段规则、一个类、一个 `main()`),别的功能为了那一点实现
引入口,入口又引回它们,环就出来了。重整时三处这样收:派工的规则搬进 `task/task-rules.ts`;网关的入口曾经同时是独立网关进程的
启动脚本,拆成不带 `main()` 的 `gateway-standalone.ts` 与进程入口 `gateway-standalone-main.ts`(D184、D207);MCP 的旧桶并进入口(D202)。

**测试替身打在哪。** 测试用 `vi.mock` 替换一只模块时,替的是**那只文件**。读者改走入口以后,打在内部文件上的替身可能拦不住任何人
(成了死桩,D173、D199);反过来,读者在功能内部引兄弟文件时,打在入口上的替身又够不着(D180)。规矩是:替身打在被测代码真正
引用的那只文件上;打在入口上时用 `importOriginal` 展开原模块再覆盖要替的名字(D49、D84),别写裸工厂。

**Worker 体积。** 检索 Worker 是单独打包的产物。从它的依赖闭包里多引一只带副作用或带存储层的模块,Worker 就会变大甚至在线程里
做不该做的事(D36、D155)。往 network、logging 这类被 Worker 用到的 L0 功能里加东西时,保持顶层只有字面量与函数。

**深层的包说明符。** `packages/backend/package.json` 的 exports 只认精确键,一个功能原则上只有一把入口键。测试里要引内部文件就写
相对路径(D44),不要为了一个读者去开深层键。

**登记的顺序就是行为。** 能力自登记以后,登记的先后可能变成用户看得见的顺序。例如协作四只工具改由 `registerCollabTools` 自登记后,
工具目录的插入序(也就是发给模型的 `tools[]` 顺序)变了(D143、D154)。改登记位置时把顺序当作行为来核对。

## 7. 去哪查更多

- 每一条决策的问题、选择、理由与拍板人:`docs/design/backend-structure-decisions-2026-10.md`。
- 层次是怎么推导出来的、服务商一族的放法表:`docs/design/feature-layers-and-provider-placement-2026-10.md`。
- 越层清零与深层引用收口的做法:`docs/design/layer-violations-to-zero-2026-10.md`、`docs/design/entry-stopped-sites-2026-10.md`。
- 服务端与客户端拆分、每一步的落地记录:`docs/design/server-client-split-2026-10.md`。
- 装配(`OnethingBackend`、`own()` / `dispose()`、宿主端口)的设计:`docs/design/backend-composition-root-2026-09.md`。
- 重写之前的 `CLAUDE.md` 全文:`docs/architecture/claude-md-archive-2026-10-04.md`。
