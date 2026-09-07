# 架构学习区

这里解释审查文档中用到的基础概念，不讨论具体改动排期。你不需要一次学完；读主文档遇到陌生词时，再打开对应章节即可。

## 建议顺序

| 顺序 | 学习文档 | 建议时间 | 学完应该能回答 |
| --- | --- | --- | --- |
| 01 | [分层、端口适配器与组合根](./01-layering-ports-and-composition-root.md) | 15 分钟 | 为什么依赖方向比目录名字重要？ |
| 02 | [一致性、事件溯源与幂等](./02-consistency-event-sourcing-and-idempotency.md) | 20 分钟 | “内存更新了”和“数据安全了”有什么区别？ |
| 03 | [进程所有权、锁与生命周期](./03-process-ownership-and-lifecycle.md) | 15 分钟 | discovery 为什么不能代替锁？ |
| 04 | [RPC、SSE、续播与背压](./04-rpc-sse-replay-and-backpressure.md) | 20 分钟 | 断线后怎样判断有没有漏事件？ |
| 05 | [依赖注入、模块与循环依赖](./05-dependency-injection-modules-and-cycles.md) | 15 分钟 | 全局 `getXxx()` 为什么会让系统难改？ |
| 06 | [Wire、Domain 与 Persistence 模型](./06-wire-domain-and-persistence-models.md) | 15 分钟 | 为什么一个 TypeScript 类型不应贯穿前端和磁盘？ |
| 07 | [如何安全评审和推进一次架构重构](./07-how-to-review-an-architecture-refactor.md) | 15 分钟 | 如何判断一次重构真的更安全，而不只是文件变漂亮？ |

## 学习方法

每篇只要求掌握三件事：

1. 这个概念解决什么问题；
2. 忽略它时会出现什么症状；
3. 在本项目中它对应哪些文件和流程。

不用背设计模式名称。能用自己的话说明“谁拥有状态、谁可以写、什么时候算成功”，已经足够参与这轮架构调整。

