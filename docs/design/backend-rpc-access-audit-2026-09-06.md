# 后端 RPC 资源授权核查（2026-09-06）

范围：`packages/backend/rpc/index.ts` 的内置注册表，共 42 个域；`session-events` 经 `trajectoryFeature` 注册。检查处理函数及其当前实际调用，不以请求中是否出现 `sessionId` 代替资源判断。本文是实现核查证据，不替代主方案或完成台账。

信任边界：HTTP token 对应服务端配置的固定运营者；请求头不能改选运营者，租户 workspace 必须位于服务端允许集合。产品空间 `ChatSession.workspaceId` 不是租户身份。既有无 owner 会话固定映射到 `local-user/default`。本轮保留机器级设置、连接器、插件安装和设备控制的既有运营者能力，不把这些能力声称为按会话隔离的多账号平台。

表中“已接”表示源码已有授权落点，不代表全部平台或任意第三方扩展均验收完成。“待收尾”明确保留给并行实现者；不能据此宣布 B5 全量完成。

| 域（对应 `rpc/domains/*.ts`） | 实际资源 / 既有全局能力依据 | 授权落点与核查结果 |
| --- | --- | --- |
| sessions | 会话详情、消息、当前选择、创建/分支/删除、缓存 | 已接 SessionAccess；列表过滤；initialOwner 首次可靠保存；删除级联全目标先授权，删除协调器排空并提交。缓存统计是机器运维信息，不返回内容。 |
| session-command | 会话命令及命令内部路由目标 | 已接；外层/内层 ID 一致；可信 executionContext 经独立 bus metadata 传递，不从命令字段取身份。 |
| session-events | 事件、blob、工具调用、trace、响应正文 | 六个入口已接 SessionAccess；同一 ID 不构成读取别人的授权。 |
| chat | 历史、提示词快照、thinking、活流、停止 | 已接；abort-all 固定可见活流，并在第一个副作用前展开全部协作执行目标预检。标题生成输入为调用者提供的内容。 |
| permission | 会话待批准项、清理 | 已接；批准响应还经过 command/HTTP 会话授权。 |
| permission-grants | 会话/工作区授权事实 | 已接可信 owner；历史无归属授权固定默认操作者，不能按当前请求归属。 |
| interaction | 会话提问与回答 | 已接；拒绝先于 pending 修改和回投。 |
| variables | 会话变量 | 已接；不能借变量作用域读取其他会话。 |
| scratchpad | 未物化草稿及会话草稿 | 已接 owner+content 原子认领；get 不认领；同 ID create 与 adopt 两端检查；固定迁移 intent，正常 RPC 可在冷重装后恢复。 |
| goal | 会话目标、变更 | 已接 SessionAccess。 |
| todo-plan | 全局目录配置，以及显式/当前会话关联计划 | 根实现者已接目标解析与授权；全局目录是设置能力，计划内容不是。 |
| scheduler | 任务、关联会话、运行历史、执行 | 已接任务 owner、会话资源和内部可信执行上下文；历史任务固定默认归属。 |
| collab | 房间看板、工作会话、成员 DM、日志、文件夹、费用、Agent 活动 | 已接 13 个房间入口和 DM 可信创建；停止/冻结/清历史由内部固定完整目标集合。Agent 活动在 RPC 与每个实时目标房间分别过滤；无法按房间归属的 inbox/dead-letter 计数在非全库可见时不下发。费用只累计可读会话。 |
| acp | 机器级 Agent 连接配置；会话取消 | 连接管理保留全局运营者能力；cancelSession 已接会话授权。 |
| tools | 工具目录、会话工具执行/更新、后台任务 | 会话与任务目标已接；独立执行上下文进入工具。`cancelTool` 通过 Backend 持有的执行注册表查找同身份的实际调用，取消只影响该工具并等待真实清理；未知、跨身份、歧义及已结束 ID 均返回 false。真实 bash 子进程与 Backend 退出/重装已验证。独立 server 的执行/后台任务能力仍按宿主限制。 |
| plugins | 插件安装/配置/请求是机器扩展能力；命令可能写会话 | 会话命令已接独立 context，并在读取和实际发命令时再查目标；无会话的纯插件命令保留。插件管理依赖真实 manager/镜像端口，不能把桌面内嵌 HTTP 宣称为不可调用。第三方任意插件能力不是本轮租户沙箱。 |
| usage | 会话费用与全库账本 | 已接；聚合前过滤可见会话，无 session 行仅默认操作者可见。已删除且无法恢复 owner 证明的历史行不返回。 |
| evals | 会话快照/反馈与机器级评测语料、批量运行 | 会话入口已接；全局评测运营入口明确默认操作者门禁。 |
| evals-workbench | 事故会话、文件、回放、诊断、语料提升 | 已接事故实际 session 与全局评测边界；不能仅信任 incident ID。 |
| channel-identity | 机器配置的身份映射/链接；会话交付记录 | 映射管理保留运营者语义；listDeliveries 已按真实 session owner 过滤，失去会话归属证明的历史交付不返回。resolve 返回可计算的身份会话键，不读取对应正文。 |
| app-state | 页签树、会话读取标记、当前选择 | 根实现者已接按 owner 的 UI 文件及当前会话过滤；旧共享 app-state 不是所有人的 UI 内容。 |
| search | 全库索引及预览中含会话派生正文 | 已接 query/preview/invoke 与 tool search/expand 的可信 context；进入索引前交集会话 allowlist，混批预览/动作先完整授权；文件 canonical 根范围含 symlink 检查。24 文件 291 例通过。不可信 server 保留原 per-owner query 能力，未新增原本不提供的预览/动作。 |
| media | 会话附件派生库、预览/画廊、文件读取和重建 | 已按真实来源会话预检列表/预览/bytes；混合来源全部可见，未知/已删来源不降级；写批次完整预检。独立导入首个记录含可信owner，去重保留来源边界；固定媒体实例归Backend拥有，关闭等待真实下载。16文件131例及bytes补充15例通过。 |
| project-dirs | 产品空间项目目录名册，包含其他租户路径 | list 在读取详情前检查主目录及全部附加根；get 同样检查附加根；add/update/remove 保留 sandbox 约束。8 例通过。产品 workspace 不等于 tenant。 |
| files | 路径读写/回滚/watch；list 可带会话 | 会话 list 已授权，HTTP 使用可信 sandbox；本机文件能力仍属于已配置运营者。watch 绑定宿主调用者，不能声称所有路径操作都是 SessionAccess。 |
| markdown | 文档路径、附件保存、资产解析 | 使用可信 sandbox，准备与结果都夹路径；不按任意会话 ID 扩大根目录。 |
| voice | 单一麦克风/播放服务，以及显式/当前/上次语音会话 | 已明确设备状态只属于 local-user/default；触发前仍检查实际会话集合。原生转录、唤醒和音频回调也检查，不靠 RPC 独占路径；发命令带固定 context。无 voice host 时真实不可用；ASR/TTS 模型配置不是会话读取。 |
| music | 播放器配置；DJ 电台复用的持久会话及权限 | 14方法限定固定本机运营者；tool传独立context。DJ brief真实目标先授权，再读正文/改persona/授目录权限；候选先过滤，创建owner原子保存，异步后复核并携带固定context起流。5文件68例通过。 |
| agents | 机器级 Agent 定义、工具权限、退休/恢复 | 既有全局运营者配置；delete 扫会话引用决定退休而非硬删，不删除会话。引用存在与配置变更影响全机器，不能承诺为租户 Agent 平台。 |
| spaces | 产品空间定义、模型覆盖、凭证 | 既有全局运营者配置；remove 用全库会话计数拒绝非空删除，不级联删会话；产品空间列表不是租户名册。 |
| prompts | 显式维护的提示词库 | 全局运营者内容库；不是从聊天转录聚合的搜索结果。 |
| skills | 技能文件、安装目录、启用与 Agent 分配 | 既有全局扩展/文件能力；任意 workingDirectory 的技能发现不等于会话内容授权。打开目录还依赖真实 shell host。 |
| providers | 已配置供应商、供应商用量/环境状态 | 机器级凭证和账户运营能力，不是 SessionUsage 的替代接口。 |
| models | 模型目录/能力、供应商模型刷新 | 全局供应商配置与目录能力，无会话内容目标。 |
| settings | 机器设置、代理、连接器/语音配置联动 | 全局运营者配置；HTTP secrets 投影/合并保留。修改语音设置不会赋予其他会话的权限。 |
| oauth | 供应商登录/回调/刷新/退出 | 产品空间凭证运营能力；由宿主配置身份访问，不解释为会话授权。开浏览器依赖 shell host。 |
| mcp | 连接器配置、外部工具/资源/提示词 | 全局运营者连接器能力，HTTP 凭证脱敏；stdio/配置文件能力按实际宿主策略。外部 MCP 工具不是由本轮 SessionAccess 自动隔离的租户工具。 |
| gateway | 网关启停与账号管理 | 已配置宿主连接器运营能力；任务进入会话后的归属由内部执行链检查。 |
| terminal | PTY 创建、读写、进程终止 | 真实 terminal host 才可用；支持该宿主的内嵌 HTTP 同样可达，是机器控制能力，不是会话终端隔离。 |
| practice | 练习计时、配置和练习记录 | 单机全局产品数据；其 record session 概念不是 ChatSession，不触发聊天读写。 |
| themes | 主题与 CSS、主题目录 | 全局显示/扩展配置；openFolder 依赖 shell host。 |
| logs | 客户端日志上报、日志等级 | 单向 append，不查询会话日志；身份字段由可信 context 覆盖。 |

已跑证据（实际机器为 macOS）：上述 collab、voice、channel identity、plugins、chat 与真实 HTTP 联合 10 文件 190 例通过；`typecheck:node` 通过。持久化另有实际 Backend 子进程 create/branch/delete 崩溃及冷启动 3 例；该文件已加入 macOS/Ubuntu/Windows CI 矩阵。其他平台尚需真实 runner 结果，进程崩溃测试不等于断电证明。

本轮已关闭此前明确的 media/music 与内部工具遗漏：history 正文、候选与统计同范围；notebook 按 owner/workspace/agent 隔离并保留默认历史文件；board 传独立 context 且排队执行前重核；provider→connector→MCP→tool 补齐身份，旧 MCP 定义经 binding token 拒绝借用新回合身份。相关72通过文件1038例通过；真实CLI条件下5例跳过。当前完整 Node 回归915文件9229例通过，3文件8例沿既有条件跳过。新增域仍须声明实际资源与局部授权口；本表不将机器管理能力等同会话隔离，不构成互不信任用户的完整部署隔离证明。
