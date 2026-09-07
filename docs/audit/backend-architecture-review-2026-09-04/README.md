# 后端架构审查：从这里开始

> 审查日期：2026-09-04  
> 审查对象：当前工作树中的 Electron、standalone server、CLI、`packages/backend`、`packages/onething-runtime`、`packages/core`、`packages/client` 与 `packages/shared`  
> 本目录只记录现状、问题和建议，没有修改业务代码。

## 这套后端现在是什么样

它不是传统的“Controller → Service → Repository”三层架构，而是一套混合架构：

- Electron、server、CLI 是不同的宿主进程；
- `packages/backend` 是组合根和适配层；
- `packages/onething-runtime` 承担大量应用用例与基础设施；
- `packages/core` 放核心引擎、事件、投影和策略；
- `packages/client` 通过 HTTP RPC 与 SSE 使用后端；
- `events.jsonl` 是会话历史的主要事实来源。

```text
Electron / standalone server / CLI
                  │
                  ▼
        Backend composition root
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  RPC / HTTP adapters   Host capabilities
        │
        ▼
  Application/runtime services
        │
        ▼
  Core engine / domain policies
        │
        ▼
  Event log / metadata / projections
```

这套方向总体是成立的，不需要推倒重写。真正需要做的是把现在依靠约定、全局变量和调用顺序维持的规则，逐步变成明确的对象边界、提交语义和自动门禁。

## 精力有限时怎么读

如果遇到陌生术语，不需要在主文档里硬啃。先打开 [架构学习区](./learning/README.md)，按主题补一篇基础知识，再回到对应问题即可。

如果你只有 15 分钟，只读前三篇：

1. [单 Core、进程所有权与单写者](./01-process-ownership-and-single-writer.md)
2. [命令确认、提交语义与 Session 一致性](./02-command-commit-and-session-consistency.md)
3. [事件投递、SSE 断线续播与游标](./03-event-delivery-and-sse-replay.md)

这三篇直接关系到“数据会不会丢、重复或写乱”。

如果还可以继续，再按顺序阅读：

4. [身份、Principal 与 Owner 隔离](./04-principal-and-owner-isolation.md)
5. [实例所有权、依赖注入与全局状态](./05-instance-ownership-and-global-state.md)
6. [Session 模块边界与运行时循环依赖](./06-session-boundaries-and-import-cycles.md)
7. [Server Runtime 与 Engine 分层](./07-server-runtime-and-engine-boundaries.md)
8. [RPC 契约、错误模型与流量控制](./08-rpc-contracts-errors-and-flow-control.md)
9. [Wire、Domain、Persistence 模型边界](./09-wire-domain-persistence-models.md)
10. [整体目标架构与分阶段迁移路线](./10-migration-roadmap.md)

## 优先级一览

| 顺序 | 主题 | 为什么排在这里 | 类型 |
| --- | --- | --- | --- |
| 01 | 单 Core / 单写者 | 多进程可同时写同一 store，可能直接损坏事件序列 | 数据正确性 |
| 02 | 命令提交 / Session 一致性 | “返回成功”、内存可见和真正落盘不是同一个时刻 | 数据正确性 |
| 03 | SSE 续播 | wildcard 连接与 per-session sequence 不匹配，重连可能漏事件 | 用户可见正确性 |
| 04 | Principal / Owner | 当前 owner 更接近自报命名空间；是否安全取决于部署模型 | 安全与产品边界 |
| 05 | 实例级 DI | 大量模块级状态隐藏依赖，限制测试与多实例能力 | 可维护性基础 |
| 06 | Session 循环依赖 | store、command、writer、surface 的所有权互相反转 | 可维护性与初始化风险 |
| 07 | Runtime / Engine 分层 | 超大文件与三层引擎重叠扩大改动影响面 | 演进成本 |
| 08 | RPC 契约 / 流控 | 校验、错误、幂等、body limit、backpressure 不统一 | 可靠性与可观测性 |
| 09 | 三种数据模型 | API 字段、领域状态和磁盘格式相互牵连 | 长期兼容性 |
| 10 | 迁移路线 | 把前九项串成可分批交付、可回滚的执行顺序 | 实施计划 |

## 如何理解文档里的风险标签

- **P0**：可能影响数据正确性或安全边界，应先止血。
- **P1**：已有明确可靠性或结构风险，应在近期治理。
- **P2**：主要增加未来改动成本，可以在边界稳定后处理。
- **已静态确认**：从当前代码调用链可以确定存在，不需要运行破坏性实验。
- **条件成立时严重**：例如 owner 隔离；如果系统只在本机单用户使用，风险较低，如果对互不信任用户开放则很严重。
- **结构债务**：当前未必产生故障，但会让下一次改动更容易出错。
- **待动态验证**：静态代码显示风险窗口，但应在隔离 store 中通过故障注入或并发测试验证后再修改语义。

## 应该保留的部分

本轮调整不应该误伤这些已经做对的结构：

- `OnethingBackend` 组合根、失败回滚和逆序 `dispose()`；
- 聚合的 `OnethingHostPorts`；
- `@onething/client` 的 Transport 抽象；
- 单一 `events.jsonl` 加 reducer/projection 的总体方向；
- RPC registry、Feature registry；
- 现有 boundary、assembly、transport、session 等门禁。

关键证据位于：

- `packages/backend/backend.ts:247-350`
- `packages/backend/host-ports.ts:127-295`
- `packages/client/transport/types.ts:81-96`
- `packages/onething-runtime/src/sessions/storage-driver.ts:8-27`
- `packages/core/session/projection/reducer.ts:375`

## 建议先确认的两个产品决策

在实施前，只需要先拍板两件事：

1. 一个 store 是否永远只允许一个 core writer？本目录按“是”设计。
2. standalone server 是本机单用户服务，还是要支持互不信任的多租户？这会决定认证与 owner 模型，详见第 04 篇。

其余问题都可以用兼容迁移处理，不需要一次做完。

## 完全不了解架构时的路线

建议采用“问题驱动学习”，不必先读完一本架构书：

```text
主文档 01 → 学习 03（进程/锁）
主文档 02 → 学习 02（一致性/事件溯源）
主文档 03 → 学习 04（RPC/SSE）
主文档 05/06 → 学习 05（DI/循环依赖）
主文档 07 → 学习 01（分层/端口）
主文档 09 → 学习 06（三种数据模型）
准备实施     → 学习 07（如何评审重构）
```
