# 后端功能地图

> 由 `scripts/feature-map.mjs` 生成,**不要手改**。改了层次表(`docs/audit/feature-layers-2026-10.json`)或功能之间的引用之后跑 `bun run feature-map`;
> `bun run feature-map:check` 在 CI 里判这份文件与代码一致。

怎么读:

- 从上往下是从高层到低层;规矩是**只许高层引低层**(决策 D23),同层之间经入口且不成环(D19)。
- 「依赖的功能」是运行期值引用(只引类型的不算),数字是从这个功能的文件指向那个功能的文件的引用条数(同一对文件只算一条);标「越层」的是低层引高层,即 `bun run layer:gate` 记账的违例。
- 「入口交出」是入口 `<功能>/<功能>.ts` 交出的名字数(含再导出),越少越好(R6)。
- 「文件」是这个功能的非测试源文件数。括号里的行不是功能,是包根与 shared 按路径分的槽位。

## L4 对外接口

界面连进来的那台 HTTP 服务器、装配配方、各功能开给界面的操作。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| headless | 不带界面的后端(CLI 守护进程用的那一份装配配方;它引 backend.ts 是装配方引装配配方,没有功能引它)。 | (shared) 3 · (包根) 1 · (包根槽位) 1 · acp 1 · collab 1 · event 1 · permission 1 · resource 1 · session 1 · settings 1 · toolkit 1 | 1(值 1 / 类型 0) | 3 |
| (包根) | 包根其余文件:装配配方 backend.ts / backend-assemble-engine.ts、宿主端口表 backend-host-ports.ts(6b 起带包名前缀)、关机骨架 backend-shutdown.ts(2026-10-04 机械改名 6a 从 lifecycle.ts 改名,免得与功能目录 lifecycle/ 并排撞名;包根归位 B 之后包根只剩这几只与 backend-current.ts / backend-types.d.ts;2026-10-05 起还有不带界面的后端进程入口 backend-standalone-main.ts,从 apps/backend-server 并进来,D255–D258)。 | (包根槽位) 4 · logging 4 · http-server 3 · plugin 3 · session 3 · (装配入口) 2 · agent 2 · auth 2 · collab 2 · credentials 2 · engine 2 · eval 2 · external-agent 2 · gateway 2 · goal 2 · mcp 2 · permission 2 · skill 2 · storage 2 · terminal 2 · todo-plan 2 · voice 2 · (shared) 1 · acp 1 · agent-loop 1 · event 1 · feature-registry 1 · file 1 · interaction 1 · media 1 · memory 1 · music 1 · note 1 · pet 1 · practice 1 · project-dir 1 · provider-call 1 · quota 1 · resource 1 · scheduler 1 · scratchpad 1 · search 1 · settings 1 · task 1 · toc 1 · tool 1 · toolkit 1 · usage 1 · variable 1 | — | 5 |
| (开给界面的操作) | 各功能的第二个入口 <功能>/<功能>-client-api*.ts(决策 D26):名册里的域行、只有 HTTP 服务器用的投影与投递件。按「它被谁引、它引谁」判:只有 http-server 与同功能的 client-api 引它(client-api:gate 保证),它引任何功能的入口 —— 所以它与 http-server 同站 L4,不与它所属的功能同层;它引自己功能的文件算 L4 → 低层,不是违例。 | (shared) 85 · http-server 54 · session 51 · (包根槽位) 43 · logging 34 · settings 20 · provider 17 · plugin 15 · mcp 14 · eval 10 · file 9 · permission 9 · media 8 · acp 7 · tool 7 · auth 6 · space 6 · scheduler 5 · search 5 · storage 5 · todo-plan 5 · voice 5 · collab 4 · gateway 4 · music 4 · note 4 · prompt 4 · skill 4 · agent 3 · agent-loop 3 · goal 3 · markdown 3 · provider-call 3 · toolkit 3 · event 2 · interaction 2 · project-dir 2 · scratchpad 2 · usage 2 · variable 2 · (装配入口) 1 · credentials 1 · engine 1 · plugin-contract 1 · practice 1 · resource 1 · terminal 1 · theme 1 | — | 69 |
| (装配入口) | 功能里装配期才建的状态与接线 API(<功能>/<功能>-configure.ts,决策 D191;今天只有 logging-configure.ts):文件 sink、目录管家、崩溃钩子与 configureLogging()。它有模块级副作用、要存储层,经主入口交出会进检索 Worker,所以单开一扇门;只许包根、http-server、两种第二入口与 apps 引(client-api:gate 保证),它引 logging 的兄弟与 storage —— 所以站 L4。 | logging 11 · storage 1 | — | 1 |
| http-server | 界面连进来的那台 HTTP 服务器:收请求、SSE 事件流、发现文件、来访者身份与信任、请求中止、生命周期、桌面内嵌、server runtime 与门面,以及按名册分发界面操作(决策 D21 / D26)。 | (开给界面的操作) 64 · (包根槽位) 9 · (shared) 3 · logging 3 · session 3 · terminal 2 · (包根) 1 · acp 1 · collab 1 · event 1 · feature-registry 1 · plugin 1 · storage 1 · toolkit 1 | — | 19 |

## L3 编排

把多个能力接成一台机器跑。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| collab | 多 agent 协作:房间、成员、发言调度与裁判。 | session 35 · (shared) 31 · agent 25 · logging 21 · event 16 · storage 11 · (包根槽位) 6 · toolkit 5 · agent-loop 3 · settings 3 · usage 3 · provider-call 2 · external-agent 1 · interaction 1 · permission 1 · variable 1 | 416(值 315 / 类型 101) | 117 |
| engine | 对话引擎:收命令、跑一轮、持久化、发事件,是发对话的那台机器。 | agent-loop 19 · session 15 · (shared) 14 · logging 14 · provider 9 · settings 8 · agent 7 · event 6 · media 4 · plugin 4 · prompt 4 · provider-call 4 · skill 4 · toolkit 4 · collab 3 · mcp 3 · usage 3 · credentials 2 · eval 2 · project-dir 2 · quota 2 · goal 1 · interaction 1 · permission 1 · scratchpad 1 · storage 1 · todo-plan 1 · variable 1 | 26(值 10 / 类型 16) | 28 |
| gateway | 微信 / Telegram 渠道网关:收发消息与远程审批。 | (shared) 6 · agent-loop 6 · logging 4 · plugin 2 · session 2 · storage 2 · engine 1 | 49(值 23 / 类型 26) | 31 |

## L2 能力

有自己的存储或服务,靠事实与基础件干活。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| acp | ACP 外部 agent 的客户端、名册、桥接与权限。 | logging 18 · external-agent 6 · (shared) 3 · (包根槽位) 2 · agent-loop 2 · permission 2 · session 2 · terminal 2 · toolkit 2 · event 1 · interaction 1 · settings 1 · storage 1 · todo-plan 1 · tool 1 | 22(值 11 / 类型 11) | 33 |
| agent | agent 档案:身份、模型、执行器与在场状态。 | agent-loop 3 · logging 2 · session 2 · storage 2 · (shared) 1 · context 1 · event 1 · settings 1 · tool 1 | 34(值 29 / 类型 5) | 16 |
| ambient | 环境信息来源:时钟、天气等。 | settings 1 | 5(值 4 / 类型 1) | 6 |
| auth | 登录流程:OAuth 授权、刷新 token 与登录状态。 | logging 2 · agent-loop 1 · event 1 · network 1 · provider 1 · settings 1 · space 1 · storage 1 | 26(值 15 / 类型 11) | 14 |
| credentials | 凭证:每个空间的凭证池与解析规则、这条会话用哪把钥匙、失败换哪把、插件凭证策略、订阅额度路由、每把钥匙用了多少、OAuth 令牌写回与老凭证迁移(D25)。 | logging 5 · space 5 · provider 4 · auth 3 · (包根槽位) 2 · agent-loop 2 · session 2 · settings 2 · storage 2 · (shared) 1 · agent 1 · lifecycle 1 · plugin-contract 1 | 48(值 40 / 类型 8) | 17 |
| deeplink | 深链:这条链要给用户看什么、确认之后做什么。 | agent 1 · plugin-contract 1 | 27(值 16 / 类型 11) | 4 |
| eval | 评估:现场捕获、案卷、评判与校准。 | storage 7 · logging 4 · prompt 3 · settings 2 · credentials 1 · lifecycle 1 · provider 1 · session 1 · skill 1 · space 1 · usage 1 | 167(值 103 / 类型 64) | 30 |
| external-agent | 外部 agent 的连接器登记、宿主工具与改动收集。 | agent 3 · session 3 · logging 2 · tool 2 · toolkit 2 · interaction 1 · permission 1 · settings 1 · storage 1 | 61(值 32 / 类型 29) | 12 |
| feature-registry | AI 可挂卸的功能(feature)的注册基座:挂 / 卸 / 列、每项注册的账本(cordis 纤维),注册面只有 RPC 域与通用卸载钩子。名册(http-server)挂内置那批,自我进化的三只工具(toolkit)挂模型现场写的那批 —— 两边都用,所以站在 toolkit 那一层;它唯一一条朝上的边是把 RPC 域登记进 http-server 的分发表(`feature-registry-context.ts` → `http-server-dispatch-table.ts`),见层次违例基线。 | — | 14(值 7 / 类型 7) | 4 |
| file | 文件:接入目录、目录列表、读写与回滚、文件搜索与工作区监听。 | settings 2 · (包根槽位) 1 · logging 1 · session 1 · space 1 | 29(值 25 / 类型 4) | 14 |
| goal | 会话目标:状态、续推、记录与改动收集。 | (shared) 3 · event 3 · logging 3 · session 3 · (包根槽位) 2 · settings 1 · storage 1 | 56(值 49 / 类型 7) | 13 |
| interaction | 向用户提问(ask_user 一类交互)的登记表。 | (shared) 2 · logging 2 · session 1 | 11(值 7 / 类型 4) | 4 |
| markdown | Markdown 附件资源的沙箱与服务。 | note 2 · (包根槽位) 1 · settings 1 | 0(值 0 / 类型 0) | 4 |
| mcp | MCP 客户端、管理器、OAuth 与身份。 | logging 8 · (shared) 5 · storage 2 · agent-loop 1 · auth 1 | 33(值 29 / 类型 4) | 30 |
| media | 媒体库:图片与文件的入库、导出与生图结果。 | storage 4 · session 2 · (shared) 1 · (包根槽位) 1 · logging 1 | 30(值 22 / 类型 8) | 11 |
| music | 音乐与电台。 | logging 7 · (shared) 5 · (包根槽位) 5 · settings 5 · session 3 · voice 3 · storage 2 · agent 1 · lifecycle 1 · permission 1 · tool 1 | 27(值 18 / 类型 9) | 36 |
| note | 笔记领域:笔记库、Obsidian 与普通目录两种驱动、笔记根目录。 | (包根槽位) 2 · logging 2 · settings 2 · storage 2 | 21(值 15 / 类型 6) | 20 |
| permission | 权限:询问、授权记录与策略,以及策略的执行面(授权记录 + 无人值守 + 会话读面)与工具可读可写的沙箱根(2026-10-04 从 tool/access-control/ 并入)。 | (shared) 9 · session 3 · logging 2 · storage 2 · agent-loop 1 · event 1 · file 1 · note 1 · settings 1 · todo-plan 1 · tool 1 | 101(值 63 / 类型 38) | 16 |
| pet | 宠物系统:自述、名册、时刻与账本。 | logging 4 · (shared) 2 · settings 2 · agent-loop 1 · music 1 · provider-call 1 · usage 1 · voice 1 | 62(值 35 / 类型 27) | 17 |
| plugin | 插件系统:加载、管理器、注入给插件的 api 与安装分发(插件与宿主约定的词汇在 plugin-contract)。 | plugin-contract 32 · logging 27 · (shared) 11 · storage 6 · agent-loop 3 · deeplink 3 · session 3 · settings 3 · toolkit 3 · (包根槽位) 2 · resource 2 · theme 2 · credentials 1 · event 1 · lifecycle 1 · permission 1 · provider 1 · provider-call 1 · scheduler 1 · search 1 · skill 1 · usage 1 | 61(值 49 / 类型 12) | 71 |
| plugin-contract | 插件与宿主约定的词汇:作用域 / 表面 / 严重度策略、熔断阈值、健康账、凭证策略与检索供给方的登记契约;health 带进程态与宿主端口,所以不是 L1。 | logging 1 | 137(值 109 / 类型 28) | 14 |
| project-dir | 项目目录的名册、持久化与提示词片段。 | logging 3 · space 3 · session 1 · storage 1 | 19(值 13 / 类型 6) | 8 |
| provider-call | 去调用服务商:把设置与凭证变成一只可用的服务商实例,跑一次对话 / 生成标题,以及辅助模型要的鉴权解析(2026-10-04 从 engine 搬出,D122)。 | provider 6 · auth 3 · logging 3 · settings 3 · credentials 2 · acp 1 · external-agent 1 · media 1 · session 1 | 15(值 12 / 类型 3) | 9 |
| quota | 各家订阅额度的查询服务。 | logging 2 · provider 2 · (包根槽位) 1 · auth 1 · credentials 1 · event 1 · session 1 · settings 1 · space 1 | 6(值 6 / 类型 0) | 3 |
| resource | 有地址的资源与读 / 做 / 看三动词的内核,以及各 scheme 的提供者。 | (shared) 19 · toolkit 13 · logging 4 · file 3 · session 3 · (包根槽位) 2 · ambient 2 · mcp 2 · todo-plan 2 · agent 1 · event 1 · music 1 · permission 1 · pet 1 · space 1 · toc 1 · tool 1 · variable 1 | 100(值 70 / 类型 30) | 31 |
| scheduler | 定时任务:cron、用户任务与运行记录。 | logging 3 · storage 3 · (shared) 1 · (包根槽位) 1 · agent 1 · event 1 · session 1 | 18(值 8 / 类型 10) | 12 |
| scratchpad | 草稿纸:存储、监听与 AI 的静默感知。 | logging 1 · storage 1 | 15(值 12 / 类型 3) | 4 |
| search | 跨会话检索:派生索引、检索器、能力登记表与查询服务。 | logging 14 · (shared) 5 · session 4 · note 3 · file 2 · storage 2 · agent-loop 1 · event 1 · network 1 · plugin-contract 1 · prompt 1 · settings 1 · toolkit 1 | 18(值 11 / 类型 7) | 86 |
| session | 会话:账本 events.jsonl、投影、仓储、命令面与读面、按会话取空间设置。 | (shared) 42 · logging 30 · (包根槽位) 17 · storage 13 · agent-loop 5 · space 4 · event 2 · settings 2 · provider 1 · tool 1 | 451(值 318 / 类型 133) | 110 |
| settings | 用户设置的读写缓存、出厂默认值与保存校验。 | provider 5 · (shared) 4 · logging 4 · space 4 · storage 3 · network 1 | 35(值 30 / 类型 5) | 15 |
| skill | 技能的发现、加载与启用,以及对话后的技能复盘(复盘触发器的判定、状态与实现,2026-10-04 从 trigger/ 并入)。 | logging 4 · storage 3 · (shared) 2 · note 2 · settings 2 · agent 1 · agent-loop 1 · file 1 · music 1 · provider-call 1 · toolkit 1 · usage 1 | 13(值 10 / 类型 3) | 18 |
| space | 空间是谁:空间身份、名册、每个空间的服务商设置与覆盖层;名册与设置读写用户 store,所以是能力(L2)而不是纯事实。 | logging 5 · storage 1 | 23(值 16 / 类型 7) | 8 |
| task | 派工:把一件事派给另一条会话去做。 | session 2 · (shared) 1 · (包根槽位) 1 · agent-loop 1 · logging 1 | 19(值 13 / 类型 6) | 4 |
| terminal | 真终端:PTY、输出分批、回放与流控。 | event 1 · logging 1 | 8(值 6 / 类型 2) | 5 |
| toc | 会话目录:切段、决定、渲染与存储。 | logging 2 · session 2 · agent-loop 1 · goal 1 · provider-call 1 · settings 1 · storage 1 · usage 1 | 39(值 23 / 类型 16) | 10 |
| todo-plan | 待办计划的存储、监听与资源描述。 | (包根槽位) 1 · logging 1 · session 1 · settings 1 · storage 1 | 17(值 13 / 类型 4) | 6 |
| toolkit | 工具系统:契约、各族基类、内置工具、按场景决定每轮工具面与执行管线。 | (shared) 21 · tool 19 · storage 12 · session 6 · settings 5 · logging 4 · (包根槽位) 3 · feature-registry 3 · file 3 · permission 3 · variable 2 · agent-loop 1 · interaction 1 · lifecycle 1 · mcp 1 · task 1 | 229(值 134 / 类型 95) | 68 |
| usage | token 用量的账本、汇总与记账。 | credentials 2 · provider 2 · logging 1 · session 1 · settings 1 · space 1 | 18(值 13 / 类型 5) | 6 |
| variable | 变量系统:登记表、存储、格式化与给模型的变量板。 | logging 5 · (shared) 2 · event 2 · goal 2 · permission 2 · project-dir 2 · session 2 · (包根槽位) 1 · agent 1 · music 1 · note 1 · space 1 · storage 1 · tool 1 | 27(值 16 / 类型 11) | 30 |
| voice | 语音识别、语音合成与唤醒词。 | (shared) 2 · settings 2 · (包根槽位) 1 · agent 1 · event 1 · session 1 | 15(值 12 / 类型 3) | 16 |

## L1 领域事实

纯事实与纯逻辑,不读用户的存储、不起服务。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| agent-loop | 一轮对话怎么跑的内核:调服务商、跑工具、重试与调度、历史重建与上下文压缩(2026-10 起含前 core/engine 内核),以及执行器表(本地 / 外部执行体的能力面,2026-10-04 从 agent 并入),不认识具体服务商。 | (shared) 21 · logging 8 · tool 3 | 311(值 150 / 类型 161) | 77 |
| event | 事件总线与流通道的工厂,以及读当前实例的访问器。 | logging 5 · (shared) 1 · (包根槽位) 1 | 29(值 22 / 类型 7) | 17 |
| practice | 练习系统的题目、账本与汇总。 | — | 6(值 5 / 类型 1) | 8 |
| prompt | 系统提示词的拼装:片段、来源与「目录在上、正文在下」的生成器。 | agent-loop 3 · logging 2 · (shared) 1 · provider 1 · reference 1 · storage 1 | 36(值 26 / 类型 10) | 13 |
| provider | 各家服务商是谁、怎么说话:清单、名册、线协议与方言、模型目录的事实与纯逻辑、纯工厂。 | agent-loop 13 · (shared) 12 · logging 10 · network 5 · storage 1 | 189(值 118 / 类型 71) | 192 |
| theme | 主题的加载、解析与生成 CSS 变量。 | logging 4 · storage 2 | 31(值 22 / 类型 9) | 20 |
| tool | 工具用到的纯逻辑模块:沙箱、bash 执行、编辑引擎、差异块、输出截断等。 | (shared) 3 · storage 3 | 89(值 62 / 类型 27) | 35 |

## L0 基础件

不认识任何产品概念:存储、日志、网络、生命周期、事件原语。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| context | 按条数与长度裁剪对话消息列表的上下文管理器。 | — | 2(值 1 / 类型 1) | 2 |
| http | 发 HTTP 请求时共用的小工具:检查应答、逐条读 SSE 事件。 | — | 5(值 3 / 类型 2) | 2 |
| lifecycle | 关机流程里反复要用的入场闸这类小状态机。 | — | 6(值 3 / 类型 3) | 2 |
| logging | 日志门面 getLogger、JSONL 日志文件、日志目录管家与崩溃钩子。 | — | 34(值 23 / 类型 11) | 21 |
| memory | 进程内存的登记表、探针与按预算释放缓存的调度器。 | logging 1 | 7(值 4 / 类型 3) | 2 |
| network | 代理设置的校验与绕行规则,以及按代理选通道、带超时重试中止的受管 fetch。 | — | 13(值 9 / 类型 4) | 5 |
| perf | 启动耗时的打点记录。 | — | 6(值 5 / 类型 1) | 2 |
| reference | 消息里「引用」的类型登记表(文件、链接等各种引用怎么认、怎么写进提示词)。 | (shared) 1 | 5(值 3 / 类型 2) | 10 |
| storage | store 目录在哪、文件怎么原子地读写,以及打包资源目录的注入口。 | logging 1 | 102(值 93 / 类型 9) | 18 |
| (shared) | server 与 client 之间的契约,以及两边必须算得一样的纯逻辑。 | — | — | 119 |
| (包根槽位) | 包根的进程槽位与小件:当前实例槽 backend-current.ts,以及 http-server 目录里按路径归到这里的六只:来访者 principal、本机信任、RPC 沙箱、租户目录(纯路径计算)与发现文件的读写两只(包根归位 B 之后来源判定进了 agent-loop、`utils/` 归了使用者、兼容桶 store.ts 删掉) —— 它们被 sessions / notes / resource / files / markdown / media / toolkit / acp 这些 L2 功能当判据或地址簿用,自己只引 shared、storage 与包根槽位,所以站 L0,不随目录站 L4。 | (shared) 3 · logging 1 · storage 1 | — | 7 |
