# 09｜拆开 Wire、Domain 与 Persistence 三种模型

> 顺序：09 / 10　风险级别：P2 结构债务　建议阅读时间：8 分钟  
> [返回总览](./README.md) · [补充学习：Wire、Domain 与 Persistence 模型](./learning/06-wire-domain-and-persistence-models.md)

## 为什么排在这里

这是重要的长期边界，但迁移面广、短期故障概率低于前八项。应先稳定命令提交和 Session ownership，再逐条边界迁移；否则会同时改业务语义和数据形状，难以判断错误来自哪里。

## 先讲人话

屏幕上显示的对象、业务内部思考的对象、磁盘长期保存的对象，现在有不少地方共用同一套类型。像把“快递面单、仓库货物、会计账本”印在同一张纸上：改 UI 字段也可能牵动历史文件和网络兼容。

## 相关概念

- **Wire DTO**：通过 RPC/SSE 传输的公开数据，只表达客户端需要的内容。
- **Domain Model**：业务内部状态和规则，不为某个 UI 或磁盘格式服务。
- **Persistence Record**：承诺长期可读取的落盘格式，必须有版本与兼容策略。
- **Mapper / Codec / Upcaster**：分别负责模型转换、编解码、把旧版本提升为当前版本。

入门说明见 [Wire、Domain 与 Persistence 模型](./learning/06-wire-domain-and-persistence-models.md)。

## 当前流程

```text
RPC/UI 的 ChatMessage、SessionMeta
              ↓ 同一形状继续流动
Store / Repository / Projection
              ↓ spread、dehydrate、JSON 编码
meta.json + events.jsonl
              ↓ 读取、rehydrate、物化
         再变回 ChatMessage
```

## 当前现状与代码证据

- [chat.ts:491](../../../packages/shared/ipc/chat.ts#L491) 的 `ChatMessage` 同时包含展示态、流式态、Provider、工具和持久标记；[chat.ts:593](../../../packages/shared/ipc/chat.ts#L593) 的 `SessionMeta` 同时承载归属、模型设置、归档状态和列表展示摘要。
- backend 直接以 `ChatSession / ChatMessage / SessionMeta` 实例化 repository 和 storage driver，[stores/sessions.ts:102](../../../packages/backend/stores/sessions.ts#L102)。
- [storage-driver.ts:195](../../../packages/onething-runtime/src/sessions/storage-driver.ts#L195) 从 session 去掉 messages 后把其余字段整体 spread 到 `meta.json`，再附加 formatVersion；字段进入磁盘的边界不够显式。
- 已有基础值得保留：事件类型是显式联合，[events/types.ts:877](../../../packages/core/session/events/types.ts#L877)；codec 会校验并兼容尾部半行和未知未来事件，[events/codec.ts:19](../../../packages/core/session/events/codec.ts#L19)；dehydrate/rehydrate 会清理重复与二进制内容，[session-dehydrate.ts:141](../../../packages/onething-runtime/src/sessions/session-dehydrate.ts#L141)。
- 包边界仍有反向引用，例如 shared 从 runtime 重导出 StoreLock，[store-lock.ts:1](../../../packages/shared/backend/store-lock.ts#L1)，而 runtime 又读取 shared 事件常量，[stream-runtime.ts:77](../../../packages/onething-runtime/src/agent-loop/stream-runtime.ts#L77)。

## 问题与实际后果

1. 新增 UI 临时字段可能被无意保存；调整网络字段也可能被旧磁盘格式绑住。
2. 客户端可能看到内部字段，存储也可能携带不必长期承诺的信息。
3. 旧记录的兼容主要依靠可选字段和宽松读取，版本升级规则分散，难证明多年后仍可恢复。
4. shared ↔ runtime 双向依赖让“公共契约层”不再独立，增加构建耦合和循环依赖机会。

## 推荐目标

```text
Wire: ChatMessageDtoV1 ──decode──> Domain: Message
                              │
                              ├─toDto──> 客户端
                              └─encode──> MessageEventRecordV2
旧 Record V1 ──upcast──> Record V2 ──reduce──> Domain/Projection
```

三层可以暂时字段相似，但必须通过显式函数跨界。磁盘 record 版本化、只单写最新版本；读取端接受旧版本并 upcast。`shared` 只保留纯传输契约，业务实现放 core/runtime，宿主兼容转发放 adapter。

## 分步迁移

1. 建字段清单，把现有字段标成 wire-only、domain、persistent 或 legacy；先不改行为。
2. 将当前磁盘形状冻结为命名明确的 V1 record，并补真实历史 fixture 与 round-trip 测试。
3. 在现有读取入口增加 decoder/upcaster，在写入口增加显式 encoder；先包住旧实现。
4. 选择一个只读、低风险 RPC，建立 DTO 与 `toDto` mapper，验证模式后逐域推进。
5. Session 事件采用“旧版可读、最新版单写”；需要迁移时惰性升级或离线工具处理，禁止双写两种真相。
6. 把 shared 对 runtime 的重导出移到中立 contracts/core 或宿主 adapter，最终消除包级双向依赖。

## 验收清单

- [ ] 历史 fixture 可读，当前 record 编解码可 round-trip。
- [ ] 未知未来 record 有明确降级策略，已知旧版本有确定 upcaster。
- [ ] Wire DTO 不含只供内部运行或磁盘维护的字段。
- [ ] 落盘字段由 encoder 白名单决定，不再依赖对象 spread。
- [ ] shared 不再导入 runtime，边界门禁能阻止回归。
- [ ] cold replay 与 live projection 仍得到相同业务结果。

## 明确不做

- 不一次性重命名全仓类型，也不要求立即重写所有历史日志。
- 不删除为旧数据保留的可选字段；先通过 upcaster 隔离它们。
- 不双写新旧 record，不用反射或对象 spread 代替显式 mapper。

## 术语表

- **Round-trip**：编码后再解码，得到等价数据。
- **Fixture**：用于兼容性测试的固定真实样本。
- **Single-write / dual-read**：只写一种新格式，同时能读新旧格式。
