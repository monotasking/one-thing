# 后端功能地图

> 由 `scripts/feature-map.mjs` 生成,**不要手改**。改了层次表(`docs/audit/feature-layers-2026-10.json`)或功能之间的引用之后跑 `bun run feature-map`;
> `bun run feature-map:check` 在 CI 里判这份文件与代码一致。

怎么读:

- 从上往下是从高层到低层;规矩是**只许高层引低层**(决策 D23),同层之间经入口且不成环(D19)。
- 「依赖的功能」是运行期值引用(只引类型的不算),数字是从这个功能的文件指向那个功能的文件的引用条数(同一对文件只算一条);标「越层」的是低层引高层,即 `bun run layer:gate` 记账的违例。
- 「入口交出」是入口 `runtime/<功能>/index.ts` 交出的名字数(含再导出),越少越好(R6)。
- 「文件」是这个功能的非测试源文件数。括号里的行不是功能,是包根与 shared 按路径分的槽位。

## L4 对外接口

界面连进来的那台 HTTP 服务器、装配配方、各功能开给界面的操作。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| (包根) | 包根其余文件:装配配方 backend.ts、HTTP 服务器与 RPC 分发表、各功能开给界面的操作。 | (shared) 97 · (包根槽位) 49 · logging 35 · sessions 33 · plugins 19 · mcp 18 · settings 17 · engine 13 · evals 13 · acp 11 · permissions 10 · storage 10 · toolkit 10 · tools 10 · collab 9 · media 9 · skills 9 · auth 8 · events 8 · voice 8 · spaces 7 · todo-plan 7 · agents 6 · notes 6 · shell 6 · goals 5 · music 5 · project-dirs 5 · prompts 5 · providers 5 · scheduler 5 · terminal 5 · files 4 · usage 4 · variables 4 · gateway 3 · interaction 3 · markdown 3 · pets 3 · scratchpad 3 · search 3 · credentials 2 · dialog 2 · practice 2 · resource 2 · agent-loop 1 · external-agents 1 · memory 1 · network 1 · quota 1 · tasks 1 · themes 1 | — | 93 |
| (总桶) | runtime/index.ts 总桶,把各功能的名字一起再导出(待删)。 | engine 5 · agent-loop 1 · agents 1 · auth 1 · evals 1 · files 1 · gateway 1 · headless 1 · markdown 1 · mcp 1 · media 1 · permissions 1 · plugins 1 · project-dirs 1 · prompts 1 · providers 1 · scheduler 1 · search 1 · sessions 1 · settings 1 · skills 1 · storage 1 · todo-plan 1 · tools 1 · triggers 1 · variables 1 · voice 1 | 2534(值 1420 / 类型 1114) | 1 |

## L3 编排

把多个能力接成一台机器跑。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| collab | 多 agent 协作:房间、成员、发言调度与裁判。 | (shared) 29 · (包根槽位) 26 · agents 24 · engine 24 · sessions 24 · logging 20 · events 15 · storage 15 · usage 3 · agent-loop 1 · interaction 1 · permissions 1 | 327(值 243 / 类型 84) | 109 |
| engine | 对话引擎:收命令、跑一轮、持久化、发事件,是发对话的那台机器。 | (shared) 29 · logging 27 · agent-loop 16 · sessions 16 · (包根槽位) 15 · providers 13 · events 10 · settings 10 · agents 9 · collab 8 · media 7 · skills 7 · toolkit 7 · goals 5 · prompts 5 · auth 4 · credentials 4 · plugins 4 · usage 4 · mcp 3 · tools 3 · (包根) 2(越层) · external-agents 2 · project-dirs 2 · quota 2 · (总桶) 1(越层) · acp 1 · gateway 1 · interaction 1 · permissions 1 · scratchpad 1 · storage 1 · toc 1 · todo-plan 1 · triggers 1 · variables 1 | 31(值 15 / 类型 16) | 80 |
| gateway | 微信 / Telegram 渠道网关:收发消息与远程审批。 | (shared) 5 · engine 1 · logging 1 | 38(值 16 / 类型 22) | 23 |
| headless | 不带界面的后端(CLI 守护进程用的那一份装配)。 | (shared) 3 · (包根) 2(越层) · (包根槽位) 1 · acp 1 · collab 1 · engine 1 · events 1 · permissions 1 · sessions 1 · settings 1 · toolkit 1 | 21(值 11 / 类型 10) | 3 |

## L2 能力

有自己的存储或服务,靠事实与基础件干活。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| acp | ACP 外部 agent 的客户端、名册、桥接与权限。 | logging 16 · external-agents 7 · toolkit 5 · (shared) 3 · tools 3 · interaction 2 · permissions 2 · terminal 2 · (包根) 1(越层) · (包根槽位) 1 · engine 1(越层) · events 1 · sessions 1 · settings 1 · shell 1 · storage 1 · todo-plan 1 | 80(值 48 / 类型 32) | 30 |
| agents | agent 档案:身份、模型、执行器与在场状态。 | tools 3 · collab 2(越层) · events 2 · logging 2 · sessions 2 · storage 2 · (shared) 1 · context 1 · engine 1(越层) · settings 1 | 100(值 59 / 类型 41) | 17 |
| ambient | 环境信息来源:时钟、天气等。 | settings 1 | 17(值 11 / 类型 6) | 6 |
| auth | 登录流程:OAuth 授权、刷新 token 与登录状态。 | logging 2 · network 2 · agent-loop 1 · events 1 · providers 1 · settings 1 · spaces 1 · storage 1 | 62(值 26 / 类型 36) | 14 |
| credentials | 凭证:每个空间的凭证池与解析规则、这条会话用哪把钥匙、失败换哪把、插件凭证策略、订阅额度路由、每把钥匙用了多少、OAuth 令牌写回与老凭证迁移(D25)。 | spaces 9 · auth 6 · providers 4 · (包根槽位) 2 · agent-loop 2 · logging 2 · plugins 2 · sessions 2 · settings 2 · (shared) 1 · agents 1 · lifecycle 1 · storage 1 | 35(值 30 / 类型 5) | 11 |
| deeplink | 深链:这条链要给用户看什么、确认之后做什么。 | plugins 4 · agents 1 | 15(值 8 / 类型 7) | 3 |
| evals | 评估:现场捕获、案卷、评判与校准。 | storage 7 · logging 4 · prompts 3 · (包根槽位) 2 · credentials 1 · lifecycle 1 · providers 1 · sessions 1 · settings 1 · skills 1 · spaces 1 · usage 1 | 161(值 98 / 类型 63) | 30 |
| external-agents | 外部 agent 的连接器登记、宿主工具与改动收集。 | acp 5 · tools 5 · agents 4 · collab 3(越层) · logging 3 · toolkit 3 · interaction 2 · (包根槽位) 1 · engine 1(越层) · permissions 1 · sessions 1 · storage 1 | 49(值 21 / 类型 28) | 12 |
| files | 文件:接入目录、目录列表、读写与回滚、文件搜索与工作区监听。 | (包根槽位) 1 · logging 1 · sessions 1 · settings 1 · spaces 1 | 86(值 38 / 类型 48) | 13 |
| goals | 会话目标:状态、续推、记录与改动收集。 | (包根槽位) 4 · (shared) 3 · events 3 · logging 3 · engine 1(越层) · sessions 1 · storage 1 | 46(值 39 / 类型 7) | 11 |
| interaction | 向用户提问(ask_user 一类交互)的登记表。 | (shared) 2 · logging 2 · (包根槽位) 1 · collab 1(越层) | 9(值 5 / 类型 4) | 4 |
| markdown | Markdown 附件资源的沙箱与服务。 | notes 2 · (包根槽位) 1 · settings 1 | 19(值 7 / 类型 12) | 4 |
| mcp | MCP 客户端、管理器、OAuth 与身份。 | logging 7 · (shared) 5 · storage 3 · auth 1 · engine 1(越层) | 67(值 40 / 类型 27) | 28 |
| media | 媒体库:图片与文件的入库、导出与生图结果。 | storage 4 · sessions 2 · (shared) 1 · (包根槽位) 1 · logging 1 | 92(值 34 / 类型 58) | 11 |
| music | 音乐与电台。 | (shared) 5 · logging 5 · settings 5 · voice 5 · (包根槽位) 4 · permissions 2 · sessions 2 · storage 2 · agents 1 · collab 1(越层) · lifecycle 1 | 89(值 38 / 类型 51) | 32 |
| notes | 笔记领域:笔记库、Obsidian 与普通目录两种驱动、笔记根目录。 | settings 3 · (包根槽位) 2 · logging 2 · storage 2 | 70(值 37 / 类型 33) | 20 |
| permissions | 权限:询问、授权记录与策略。 | (shared) 9 · logging 1 · sessions 1 · storage 1 · todo-plan 1 | 74(值 38 / 类型 36) | 13 |
| pets | 宠物系统:自述、名册、时刻与账本。 | logging 4 · (shared) 2 · settings 2 · agent-loop 1 · engine 1(越层) · music 1 · usage 1 · voice 1 | 57(值 30 / 类型 27) | 17 |
| plugins | 插件系统:契约、加载、管理器、注入给插件的 api 与安装分发。 | logging 27 · (shared) 11 · storage 7 · (包根槽位) 5 · engine 3(越层) · settings 3 · themes 3 · toolkit 3 · (包根) 2(越层) · resource 2 · sessions 2 · collab 1(越层) · credentials 1 · deeplink 1 · events 1 · lifecycle 1 · permissions 1 · prompts 1 · providers 1 · scheduler 1 · search 1 · skills 1 · usage 1 | 92(值 39 / 类型 53) | 75 |
| project-dirs | 项目目录的名册、持久化与提示词片段。 | logging 3 · spaces 3 · sessions 1 · storage 1 | 41(值 24 / 类型 17) | 8 |
| quota | 各家订阅额度的查询服务。 | logging 2 · providers 2 · spaces 2 · (包根槽位) 1 · auth 1 · credentials 1 · events 1 · sessions 1 · settings 1 | 14(值 9 / 类型 5) | 3 |
| resource | 有地址的资源与读 / 做 / 看三动词的内核,以及各 scheme 的提供者。 | toolkit 19 · (shared) 18 · files 5 · (包根槽位) 4 · logging 4 · mcp 4 · music 4 · todo-plan 3 · ambient 2 · events 2 · pets 2 · agents 1 · engine 1(越层) · permissions 1 · sessions 1 · shell 1 · spaces 1 · toc 1 · tools 1 · variables 1 | 78(值 55 / 类型 23) | 30 |
| scheduler | 定时任务:cron、用户任务与运行记录。 | logging 3 · storage 3 · engine 2(越层) · (shared) 1 · (包根槽位) 1 · agents 1 · events 1 · sessions 1 | 106(值 42 / 类型 64) | 12 |
| scratchpad | 草稿纸:存储、监听与 AI 的静默感知。 | logging 1 · storage 1 | 4(值 2 / 类型 2) | 4 |
| search | 跨会话检索:派生索引、检索器、能力登记表与查询服务。 | logging 16 · (shared) 4 · sessions 4 · notes 3 · (包根槽位) 2 · engine 2(越层) · files 2 · plugins 2 · settings 2 · storage 2 · collab 1(越层) · events 1 · network 1 · prompts 1 · toolkit 1 | 109(值 71 / 类型 38) | 86 |
| sessions | 会话:账本 events.jsonl、投影、仓储、命令面与读面、按会话取空间设置。 | (shared) 39 · logging 29 · (包根槽位) 16 · storage 13 · agent-loop 3 · engine 3(越层) · spaces 3 · events 2 · settings 2 · collab 1(越层) · interaction 1 · permissions 1 · providers 1 · tools 1 | 543(值 338 / 类型 205) | 96 |
| settings | 用户设置的读写缓存、出厂默认值与保存校验。 | spaces 9 · logging 5 · providers 5 · (shared) 4 · storage 3 · network 1 | 43(值 35 / 类型 8) | 16 |
| skills | 技能的发现、加载与启用。 | logging 3 · notes 2 · settings 2 · storage 2 · agents 1 · files 1 · music 1 | 73(值 34 / 类型 39) | 12 |
| tasks | 派工:把一件事派给另一条会话去做。 | (包根槽位) 2 · engine 2(越层) · (shared) 1 · logging 1 · plugins 1 · sessions 1 | 14(值 9 / 类型 5) | 2 |
| terminal | 真终端:PTY、输出分批、回放与流控。 | events 1 · logging 1 | 1(值 1 / 类型 0) | 5 |
| toc | 会话目录:切段、决定、渲染与存储。 | engine 2(越层) · agent-loop 1 · logging 1 · settings 1 · storage 1 · usage 1 | 37(值 21 / 类型 16) | 9 |
| todo-plan | 待办计划的存储、监听与资源描述。 | (包根槽位) 1 · logging 1 · sessions 1 · settings 1 · storage 1 | 24(值 11 / 类型 13) | 6 |
| toolkit | 工具系统:契约、各族基类、内置工具、按场景决定每轮工具面与执行管线。 | tools 39 · (shared) 21 · collab 12(越层) · storage 12 · (包根槽位) 6 · settings 5 · logging 4 · (包根) 3(越层) · engine 3(越层) · files 3 · sessions 3 · tasks 3 · goals 2 · interaction 2 · plugins 2 · variables 2 · agent-loop 1 · agents 1 · lifecycle 1 · mcp 1 · music 1 · permissions 1 · practice 1 · resource 1 | 208(值 120 / 类型 88) | 73 |
| usage | token 用量的账本、汇总与记账。 | credentials 2 · providers 2 · (包根槽位) 1 · logging 1 · sessions 1 · settings 1 · spaces 1 | 24(值 9 / 类型 15) | 6 |
| variables | 变量系统:登记表、存储、格式化与给模型的变量板。 | logging 5 · (包根槽位) 3 · collab 3(越层) · project-dirs 3 · tools 3 · (shared) 2 · agents 2 · events 2 · goals 2 · music 2 · sessions 2 · notes 1 · spaces 1 · storage 1 | 87(值 49 / 类型 38) | 29 |
| voice | 语音识别、语音合成与唤醒词。 | (shared) 2 · settings 2 · agents 1 · engine 1(越层) · events 1 · sessions 1 | 54(值 25 / 类型 29) | 16 |

## L1 领域事实

纯事实与纯逻辑,不读用户的存储、不起服务。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| agent-loop | 一轮对话怎么跑的内核:调服务商、跑工具、重试与调度,不认识具体服务商。 | (shared) 2 · engine 2(越层) · providers 2 · agents 1(越层) · evals 1(越层) · toolkit 1(越层) | 24(值 8 / 类型 16) | 25 |
| events | 事件总线与流通道的工厂,以及读当前实例的访问器。 | logging 6 · (包根槽位) 2 · (shared) 1 · engine 1(越层) · sessions 1(越层) | 7(值 7 / 类型 0) | 17 |
| practice | 练习系统的题目、账本与汇总。 | — | 32(值 8 / 类型 24) | 7 |
| prompts | 系统提示词的拼装:片段、来源与「目录在上、正文在下」的生成器。 | engine 4(越层) · logging 3 · plugins 3(越层) · (shared) 1 · providers 1 · references 1 · storage 1 | 107(值 51 / 类型 56) | 15 |
| providers | 各家服务商是谁、怎么说话:清单、名册、线协议与方言、模型目录的事实与纯逻辑、纯工厂。 | (shared) 12 · logging 11 · agent-loop 10 · network 5 · engine 3(越层) · agents 2(越层) · storage 1 | 197(值 116 / 类型 81) | 191 |
| spaces | 空间是谁:空间身份、名册、每个空间的服务商设置与覆盖层。 | logging 5 · project-dirs 1(越层) · storage 1 | 91(值 61 / 类型 30) | 8 |
| themes | 主题的加载、解析与生成 CSS 变量。 | logging 4 · storage 2 | 27(值 12 / 类型 15) | 13 |
| tools | 工具用到的纯逻辑模块:沙箱、bash 执行、编辑引擎、差异块、输出截断等。 | permissions 4(越层) · storage 4 · (shared) 3 · (包根槽位) 2 · files 1(越层) · logging 1 · music 1(越层) · notes 1(越层) · sessions 1(越层) · settings 1(越层) | 215(值 133 / 类型 82) | 37 |

## L0 基础件

不认识任何产品概念:存储、日志、网络、生命周期、事件原语。

| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |
| --- | --- | --- | --- | --- |
| context | 按条数与长度裁剪对话消息列表的上下文管理器。 | — | 无入口 | 1 |
| dialog | 原生「选目录 / 选文件」对话框的宿主注入口。 | — | 无入口 | 1 |
| http | 发 HTTP 请求时共用的小工具:检查应答、逐条读 SSE 事件。 | — | 5(值 3 / 类型 2) | 2 |
| lifecycle | 关机流程里反复要用的入场闸这类小状态机。 | — | 6(值 3 / 类型 3) | 2 |
| logging | 日志门面 getLogger、JSONL 日志文件、日志目录管家与崩溃钩子。 | storage 1 | 12(值 7 / 类型 5) | 19 |
| memory | 进程内存的登记表、探针与按预算释放缓存的调度器。 | logging 1 | 5(值 4 / 类型 1) | 2 |
| network | 代理设置的校验与绕行规则,以及按代理选通道、带超时重试中止的受管 fetch。 | — | 13(值 9 / 类型 4) | 5 |
| perf | 启动耗时的打点记录。 | — | 6(值 5 / 类型 1) | 2 |
| references | 消息里「引用」的类型登记表(文件、链接等各种引用怎么认、怎么写进提示词)。 | (shared) 1 | 5(值 3 / 类型 2) | 10 |
| shell | 打开路径、打开外链、在文件管理器里定位:能力由宿主注入,这里只有注入口。 | — | 8(值 5 / 类型 3) | 2 |
| storage | store 目录在哪、文件怎么原子地读写,以及打包资源目录的注入口。 | logging 1 | 117(值 95 / 类型 22) | 18 |
| triggers | 技能复盘这个对话后触发器的判定与状态。 | (shared) 1 · agent-loop 1(越层) · storage 1 | 117(值 62 / 类型 55) | 6 |
| (shared) | server 与 client 之间的契约,以及两边必须算得一样的纯逻辑。 | — | — | 118 |
| (包根槽位) | 包根的进程槽位与小件:当前实例槽、主机信任、来源判定、几只工具函数(store.ts 兼容桶待删)。 | settings 2(越层) · (包根) 1(越层) · engine 1(越层) · files 1(越层) · logging 1 · sessions 1(越层) | — | 9 |
