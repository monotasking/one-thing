# Grok 回答重复调查（2026-09-16）

## 结论

用户贴出的 `connection.promise` 解释确实重复了，但本次重复已经存在于两次模型请求对应的正文事件中。用当前代码重建消息后，渲染输入与原始正文逐字相等，没有额外复制段落。

具体过程是：第一轮输出前言并读文件；第二轮输出一版完整解释，并再次读文件；第三轮输出措辞略有修改的第二版解释。同一条 assistant 消息保留了这些轮次的正文，所以用户看到了连续的两版解释。

第二次请求的历史记录完整保留了第一版解释。当前 Grok 请求编码也会保留同时带有思考数据、工具调用的 assistant 正文。没有发现本次重复是历史正文丢失、流结束事件重放或渲染拼接造成的证据。

## 定位依据

- 会话：`d11de48d-95db-4889-b6a2-aea3014b85be`
- 目标消息：`d78e8cb9-749e-4009-8d48-19f484d78d0f`
- Run：`25686ed9-6a5e-42b8-ae78-e6865082aa53`
- Provider / 模型：`grok-oauth` / `grok-4.6`
- 事件文件：`~/.onething/sessions/d11de48d-95db-4889-b6a2-aea3014b85be/events.jsonl`
- 目标区间：事件序号 `1310`–`1372`。调查时会话已经产生后续消息，以上身份用于固定用户贴出的那一条。

以下时间均为北京时间；长度采用 JavaScript `string.length`。

| 请求 | 正文 part | 长度 | 正文记录时间 | 同轮工具与结束状态 |
| --- | --- | ---: | --- | --- |
| 75 | 2 | 93 | 23:19:44.269 | 读取 `electron/host-connection.ts`，请求以 `tool_calls` 结束 |
| 76 | 6 | 1347 | 23:19:50.716–23:20:02.968 | 读取 `electron/main.ts`，请求以 `tool_calls` 结束 |
| 77 | 10 | 1302 | 23:20:09.156–23:20:15.160 | 请求以 `stop` 结束，随后 run 完成 |

这三次请求没有 `request/error` 事件。两版解释不是失败重试后直接接在一起的残留。

重复段落的起点均为：

> 它不是空的。`connection.promise` 是一张**还没填答案的欠条**……

第一版含有构造 Promise 的伪代码；第二版将其改成文字说明，还调整了末尾措辞。两版文本不是同一字符串被原样复制。

## 三层核对

### 1. 原始正文事件

只提取目标消息的 `assistant/chunks`、`kind: text`，依照事件顺序拼接 `data.text`，得到：

```text
请求 75 的 93 字 + 请求 76 的 1347 字 + 请求 77 的 1302 字 = 2742 字
```

两次“还没填答案的欠条”已经在这份正文中出现，分别属于请求 76 和请求 77。

### 2. 渲染重建

使用真实事件调用当前代码：

```text
reduceSessionProjection
→ materializeChatMessagesCached（includePartIndex: true，空 StreamWater）
→ anchorMessage
```

结果：

- 消息 `content`：2742 字，与原始正文逐字相等。
- text parts：恰好三个，part 2 / 6 / 10 各一份；拼接后与原始正文逐字相等。
- `anchorMessage` 后提取的正文：2742 字，与原始正文逐字相等。

因此当前消息物化、正文补齐和工具锚点处理链没有为这条消息增加重复文本。此核对是实际函数重放，并非仅凭界面外观判断。

相关代码：

- `apps/desktop-react/src/data/chat-materialize.ts`
- `apps/desktop-react/src/data/missing-assistant-text.ts`
- `apps/desktop-react/src/content/assemble/anchor.ts`
- `packages/core/session/render-anchors.ts`

### 3. 下一轮历史与 Grok 编码

`request/recipe` 记录的消息指纹算法为：

```text
SHA256("assistant\n" + content).slice(0, 16)
```

| 请求配方 | 目标 assistant 指纹 | 用原始正文重新计算 |
| --- | --- | --- |
| 请求 76，seq 1326 | `9dfa8a2a5d138cfe` | 前言 93 字，完全匹配 |
| 请求 77，seq 1353 | `cc856faad513bf43` | 前言 93 字 + 第一版解释 1347 字，完全匹配 |

这证明请求 77 记录的历史输入仍包含第一版完整解释。

另用真实 Grok `buildBody()` 构造同时含正文、思考数据和工具调用的 assistant 消息，确认生成的请求中包含完整 `output_text`，顺序为 reasoning → assistant 正文 → function_call → function_call_output。思考数据或工具调用不会覆盖正文。

同时重放了正常顺序的“正文 delta → 改写后的 done 文本 → output_item.done → response.completed”：当前 wire 只输出 delta 正文，后续完成事件不会再追加一版完整正文。

相关代码：

- `packages/backend/wiring/engine/stream/session-event-recorder.ts`：`writeRecipe`
- `packages/onething-runtime/src/agent-loop/providers/wires/openai-responses-messages.ts`：`assistant`
- `packages/onething-runtime/src/agent-loop/providers/wires/openai-responses-wire.ts`：正文 delta、item done 与 completed 处理

## 证据边界与处理

已证实的是：重复属于两个请求中分别记录的相近正文，且当前渲染链忠实保留了它们。证据更符合“工具返回后，模型再次组织了一版完整回答”。

当时没有保存实际 HTTP 请求体和原始 SSE，因此尚不能进一步判定服务端为何重述，也不能把某个服务端机制写成已证实根因。配方指纹记录的是编码前历史，不能冒充实际发送报文。

这次调查没有依据给界面增加自动删段规则。两版存在内容差异，按相似度隐藏或删除其中一版可能丢掉修正内容。本轮完成真实事件重建、历史指纹核验和 Grok 编码/流处理验证，未修改产品代码或用户会话数据。

另在独立合成场景中发现：缺少 `partIndex` 的导入 text part 若再与同一段实时水位合并，可能重复。目标消息的三个 text part 身份完整，不满足该条件；该合成场景的真实可达性尚未证实，不能用于解释本次反馈。
