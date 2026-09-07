# 一事（onething）系统流程图与架构图

基于 2026-09-05 当前工作树整理。可编辑图表已通过 tldraw 界面绘制并保存至同目录的 `一事系统—流程图与架构图.tldraw`，包含“01 系统架构”和“02 任务流程”两页。本文保留更详细的 Mermaid 草稿与源码依据。

## 系统架构图

箭头表示主要调用或数据流；这是职责概览，不表示所有源码依赖都是单向分层。

```mermaid
flowchart TB
  subgraph clients[用户入口]
    UI[桌面 / Web / 移动端界面]
    Client[packages/client\n统一调用与事件订阅]
    UI --> Client
  end

  subgraph hosts[宿主：按运行方式装配后端]
    Electron[Electron 桌面宿主]
    Server[独立 Server 宿主]
    CLI[CLI / Headless 宿主]
    Ports[宿主能力端口\n文件 / 终端 / 系统集成]
  end

  subgraph backend[packages/backend：装配与适配]
    HTTP[HTTP RPC / SSE 接口]
    Root[Backend 组合根\n装配事件、会话、引擎与工具]
    Session[会话命令 / 事件写入 / 投影读取]
    Events[事件总线 / 流式广播]
  end

  Electron --> Root
  Server --> Root
  CLI --> Root
  Ports -->|注入能力| Root
  Client -->|操作请求| HTTP
  HTTP --> Root
  Events -->|SSE 更新| Client

  subgraph runtime[packages/onething-runtime：应用服务与基础设施]
    Services[会话 / 配置 / 项目 / 搜索\n技能 / 插件 / 协作等服务]
    Providers[模型提供商适配]
    Tools[工具执行 / 权限 / MCP]
  end

  subgraph core[packages/core：核心逻辑与契约]
    Engine[流式引擎 / Agent 循环\n上下文构建 / 工具编排]
    Projection[事件模型 / 投影规则 / 策略]
  end

  Root --> Services
  Root -->|通过 wiring 绑定 runtime 端口| Engine
  Root --> Session
  Engine --> Providers
  Engine --> Tools
  Engine -->|执行事件| Events
  Events --> Session
  Session --> Projection

  subgraph external[外部能力与本地数据]
    Models[模型 API / 外部 Agent]
    Resources[工作区文件 / Shell / MCP 服务]
    Log[(events.jsonl\n会话历史主要事实来源)]
    State[(配置 / 元数据 / 索引\n投影缓存 / 内容文件)]
  end
  Providers --> Models
  Tools --> Resources
  Session --> Log
  Session --> State
  Services --> State

  Gateway[packages/gateway\n消息渠道桥接] -->|渠道消息接入运行时| Root
```

宿主能力会影响可用功能。桌面内嵌 HTTP 服务复用已有后端；独立服务是另一种启动方式，不表示两者必须同时运行。部分桌面专有能力仍通过宿主适配或 IPC 提供。

## 一次任务的执行流程图

```mermaid
flowchart TD
  Start([用户发送消息 / 发起任务]) --> Request[客户端提交操作请求]
  Request --> Validate[服务端校验请求与会话访问范围]
  Validate --> Accept{请求可接受？}
  Accept -->|否| Reject[返回错误或忙碌状态]
  Accept -->|是| Session[建立或恢复会话\n记录用户输入并准备执行状态]
  Session --> Context[构建上下文\n历史消息 / 系统提示 / 技能 / 工具目录]
  Context --> Model[选择模型提供商\n发起流式生成]
  Model --> Kind{收到哪类输出？}
  Kind -->|文本 / 推理片段| Text[更新流式内容]
  Text --> Kind
  Kind -->|工具调用| Permission{权限策略允许？}
  Permission -->|需要确认| Ask[向用户发起权限请求]
  Ask --> Decision{用户是否允许？}
  Decision -->|允许| Execute[执行本地工具 / MCP 工具]
  Decision -->|拒绝| Denied[生成拒绝结果]
  Permission -->|允许| Execute
  Permission -->|拒绝| Denied
  Execute --> Result[收集工具结果或工具错误]
  Denied --> Result
  Result --> Next{继续 Agent 循环？}
  Next -->|是| Context
  Next -->|否| Finish[结束本轮并更新会话状态]
  Kind -->|生成结束| Finish
  Model -->|调用失败 / 用户取消| Interrupted[记录失败或中断状态]
  Interrupted --> Finish
  Finish --> End([用户查看结果 / 继续对话])

  Session -.-> Event[会话事件与流式更新]
  Text -.-> Event
  Ask -.-> Event
  Result -.-> Event
  Finish -.-> Event
  Event --> Persist[持久化会话事件\nevents.jsonl / 内容文件]
  Event --> Push[更新投影并向客户端推送\n界面展示内容、工具与权限状态]
```

虚线表示执行过程中产生的旁路更新。持久化与界面广播在现有实现中存在不同通路；图中没有假定“每条更新都先持久化成功，再广播”。工具返回错误通常可作为结果交回模型，不一定直接结束整个任务。

## 核对依据

- `packages/backend/backend.ts`：后端装配、宿主能力、会话与引擎生命周期。
- `packages/backend/server/embed.ts`、`apps/server/src/main.ts`：桌面内嵌服务与独立服务入口。
- `packages/backend/server/runtime.ts`：RPC 运行时与后端服务适配。
- `packages/client/client.ts`：统一调用、事件订阅和能力查询。
- `packages/backend/wiring/engine/index.ts`：核心引擎与运行时绑定。
- `packages/core/engine/`：流式处理、Agent 循环、上下文与工具编排。
- `packages/backend/session/event-writer.ts`：会话事件写入与观察者通路。
- `docs/audit/backend-architecture-review-2026-09-04/README.md`：架构现状说明。
