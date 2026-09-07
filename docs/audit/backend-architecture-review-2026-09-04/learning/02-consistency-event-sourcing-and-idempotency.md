# 学习 02：一致性、事件溯源与幂等

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## 三个容易混淆的时刻

一次“发送消息”至少可能有三个完成时刻：

1. **Accepted**：进程接受了命令；
2. **Visible**：内存投影已经能读到结果；
3. **Committed**：重启后仍能恢复，数据已经安全持久化。

它们可以是同一时刻，也可以不同。问题不在于必须同步写盘，而在于 API 必须准确告诉调用方现在到了哪一步。

```text
收到命令 → 校验 → 改内存 → 排队写盘 → 磁盘确认
 accepted        visible             committed
```

如果 API 在 accepted 时返回“成功”，客户端却把它理解成 committed，崩溃窗口里就会出现“界面显示成功，重启后消息消失”。

## Event Sourcing

事件溯源把发生过的事实顺序记录下来：

```text
MessageAppended
MessagePatched
RunStarted
RunEnded
```

当前状态由事件依次折叠得到，这个过程叫 projection/reducer。事件日志是事实，投影是计算结果。

它的优势是可重放、可审计、容易恢复历史；代价是必须非常认真地处理：

- 事件顺序和唯一 sequence；
- 追加成功的定义；
- projection 与日志一致性；
- schema 升级；
- 重复事件的幂等处理。

## Source of Truth 与 Read Model

一个字段必须明确由谁说了算：

- Source of truth：丢了就无法恢复的业务事实；
- Read model：为了查询快而生成，可从事实重建；
- Cache：可以随时丢弃并重新计算。

如果 `events.jsonl`、`meta.json`、`index.json` 都各自被当成业务真相，又分别异步保存，就会需要跨文件事务。更简单的办法往往是：让事件或明确的 meta record 做真相，index 只做可重建读模型。

## 幂等是什么

幂等表示同一个命令执行一次或重复执行多次，最终效果相同。常见做法是给 mutation 一个稳定的 `commandId`：

```text
第一次 command-123 → 提交并记录结果
重试 command-123   → 返回原结果，不再追加第二次
```

没有幂等键时，“服务端提交成功但响应在网络中丢失”会让客户端陷入两难：重试可能重复，不重试可能丢操作。

## 是否必须上数据库

不必须。文件事件日志也可以可靠，前提是：

- 单写者；
- 追加顺序明确；
- 关键边界等待持久化确认；
- 尾部损坏可检测和恢复；
- 派生索引可重建；
- shutdown 会排空队列。

数据库只能提供工具，不会自动解决错误的 ownership 或确认语义。

## 在本项目中对应什么

- 事件写入：`packages/backend/session/event-log.ts`
- 命令编排：`packages/backend/session/commands.ts`
- 投影：`packages/core/session/projection`
- meta/index 保存：`packages/onething-runtime/src/sessions/session-repository.ts`

读主文档第 02 篇时，重点判断每个 API 返回的是 accepted、visible 还是 committed。
