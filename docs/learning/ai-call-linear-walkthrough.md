# 顺着一条文字回复读 AI 源码

你觉得难懂，是因为源码的摆放顺序和程序的执行顺序不同。请求在一个类里组装，网络发送藏在父类里，响应通过 `yield`、回调、队列一路传递，界面在另一个地方订阅。只看函数列表，仍然需要自己补上这些连接。

这份导读把相关代码按数据经过的顺序放在一起。先读通一个场景：**对话已经准备好，发给模型，模型直接回复文字。** 本文选择 OpenAI Chat 兼容的 HTTP 路径；其他协议和外部执行器有自己的实现。文中的“你好”等数据都是教学示例，不是真实请求记录。

## 先看展开后的一条线

下面是**教学伪代码**，把多个文件的工作合到一个位置，省略外围配置和传递层。它不是从仓库复制出的完整函数，也不能直接当作项目实现运行。随后各步会给出对应的原代码。

```ts
// 0. 上游已经准备好规则、历史和本次提问，放在 messages 里。

// 1. 装好请求材料。
const body = { model, messages, tools, stream: true };

// 2. 发给 AI 服务。拿到 response 时，答案正文可能还没收完。
const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

if (!response.ok) throw new Error("请求失败");

let answer = "";

// 3. 一边等待网络，一边接收完整的 JSON 事件。
for await (const chunk of readJsonSseData(response, options)) {
  // 4. 从服务的响应结构里拿出这次新增的文字。
  const text = chunk.choices?.[0]?.delta?.content;
  if (!text) continue;

  // 5. 原项目在这里经过 yield、回调、队列和事件转换。
  //    为了先看清主线，这里把消费者的工作直接展开。
  answer += text;
  store.updateMessageContent(sessionId, messageId, answer);
  emitter.sendTextChunk(text, turnIndex);

  // 6. 前端收到片段后合入消息，并安排下一帧刷新。
  //    这是另一端的工作，不是这里直接调用一个界面函数。
}

// 7. 流结束后，外层处理结束原因、用量和消息状态等收尾。
```

先把上面读成：**装材料 → 发送 → 等一段 → 取文字 → 保存并推送 → 再等一段 → 结束。**

下面沿同一条线，把教学代码换回项目里的原代码。代码块是节选；省略处会注明。原文件链接用于需要时回查，不必一开始就跳走。

## 1. 把对话放进请求

此时 `request.messages` 已经包含上游准备的对话。`builder` 是暂存请求字段的对象。

原代码节选：

```ts
builder.set("model", request.model);
builder.set("messages", this.serializeMessages(messages, turn));
builder.set("stream", true);
```

稍后还会把可用工具说明等字段放进去。

此刻的数据可以想成：

```text
builder 里的材料
  model: 选择的模型
  messages: 规则 + 历史 + 本次提问
  stream: true
```

这里还没有发网络请求，只是在准备材料。序列化消息是把项目自己的消息结构转换成服务要求的结构。

原位置：[openai-chat-wire.ts → buildBody](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/agent-loop/providers/wires/openai-chat-wire.ts:223)。

**接下来：材料准备好，回到 `streamTurn`，准备地址和认证信息。**

## 2. 带着地址和认证信息，调用发送函数

`streamTurn` 中的原代码节选，两段之间省略了日志等代码：

```ts
const url = this.endpointUrl(turn);
const headers = await this.dialect.auth.headers(turn);

// ……省略日志等代码……
response = await this.send(url, headers, turn);
```

- `url`：请求发往哪里。
- `headers`：包括所需认证等请求头信息。
- `turn`：带着第 1 步准备好的请求材料。

`await` 的意思是：当前这段异步函数等发送函数给出结果，再往下走。等待期间不会因此把整个应用界面卡住。

原位置：[http-agent-provider.ts → streamTurn](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/agent-loop/providers/base/http-agent-provider.ts:77)。

**接下来：进入 `send`，再进入 `fetchOnce`。**

## 3. 真正发出网络请求

`send` 先做这两行：

```ts
const body = JSON.stringify(turn.builder.build<TBody>());
const first = await this.fetchOnce(url, headers, body, turn);
```

第 1 步是一个对象，现在变成了可以发送的 JSON 文本。`<TBody>` 是 TypeScript 类型标记，第一遍可以跳过。

`fetchOnce` 的无首字节超时配置分支如下；配置了超时时仍然发送同样的 POST 请求，只是额外接入取消和超时控制：

```ts
return this.ctx.fetchImpl(url, {
  method: "POST",
  headers,
  body,
  signal: turn.request.abortSignal,
});
```

**真正把请求交给网络发送的是 `fetchImpl(...)`。** `signal` 用于取消。

原位置：[http-agent-provider.ts → send / fetchOnce](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/agent-loop/providers/base/http-agent-provider.ts:303)。

**接下来：拿到 `response`，回到第 2 步的 `streamTurn`。这个 `response` 包含状态、响应头和可继续读取的正文流，并不代表完整答案已经到齐。**

## 4. 打开响应流，等服务传来下一段

`streamTurn` 中，检查 HTTP 状态成功后，执行：

```ts
const raw = yield* this.parseStream(this.watchIdle(response), turn);
yield this.finishEvent(raw, turn);
```

第一行先进入 `parseStream`。第二行要等解析流结束才会执行，届时发出结束事件。

`parseStream` 内部的原代码节选：

```ts
for await (const chunk of readJsonSseData<OpenAIChatStreamChunk>(response, {
  sourceName: errors.sourceName,
  invalidMessage: "invalid stream chunk",
})) {
  // ……处理流错误、用量等……
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  // ……继续处理本段……
}
```

`for await` 可以读成：**有下一段就处理；还没来就等；流结束就退出循环。**

这里的 `readJsonSseData` 已经帮忙完成：读网络字节 → 拼接 SSE 事件 → 解析 JSON。因此循环拿到的 `chunk` 是对象，不是任意一截网络字节。

假设这次得到：

```json
{"choices":[{"delta":{"content":"你好"}}]}
```

那么 `delta.content` 就是 `"你好"`。

原位置：[openai-chat-wire.ts → parseStream](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/agent-loop/providers/wires/openai-chat-wire.ts:267)；[sse.ts → SSE 解析](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/agent-loop/providers/sse.ts:31)。

**接下来：拿到“你好”，把它交给外层。**

## 5. `yield` 把“你好”交出去，程序还会回来继续接收

在 `parseStream` 的正文分支中，省略日志后，原代码是：

```ts
if (delta?.content) {
  // ……省略日志……
  yield { type: "text-delta", turn: turnIndex, delta: delta.content };
}
```

现在交出去的数据变成：

```text
{ type: "text-delta", turn: 1, delta: "你好" }
```

这是最容易读断的地方：

- `return` 通常是交出结果并结束本次函数调用。
- `yield` 是交出当前一项并暂停，消费者继续取下一项时，函数从暂停处继续。
- `yield*` 是把内部生成器产出的每一项继续向外交。第 4 步就是这样转交的。

所以 `yield` 后面的“下一步”，可能在另一个文件的 `for await` 里。处理了这一项之后，消费者继续取下一项，生产者才继续跑。生产和消费在执行中交替发生。

**接下来：外层接住这个事件，把它传向界面的处理链。**

## 6. 穿过回调和队列：“你好”没有变，只是换了包装

这一小段传递链可按下面读。这里是路径说明，不是一个文件里的连续代码：

```text
parseStream 产出文字事件
  → streamTurn 用 yield* 转交
  → streamAgentProviderTurnEvents 转交
  → runner 的 executeProviderTurn 消费事件
  → request.onEvent(event) 调用事先传入的回调
  → bridge 中的回调把事件放入 queue
  → agentEventsToProviderStreamChunks 取出事件并转换
  → 引擎收到 { type: "text", text: "你好" }
```

回调不是凭空出现的。`bridge.ts` 在启动循环前，准备了这个函数，作为 `onEvent` 传给循环：

```ts
onEvent(event) {
  onEvent?.(event)
  queue.push(event)
},
```

因此，后面 `runner` 调用 `request.onEvent?.(event)`，就会进入这里，把事件放进队列。队列让生产方和消费方按事件顺序交接。

转换器处理文字事件时，原代码是：

```ts
case 'text-delta':
  if (event.delta) yield { type: 'text', text: event.delta }
  break
```

记住这次变化就够了：

```text
之前：{ type: "text-delta", delta: "你好", turn: 1 }
之后：{ type: "text", text: "你好" }
```

原位置：[runner.ts → 消费模型事件](/Users/yitiansong/data/code/start-electron/packages/core/agent-loop/runner.ts:357)、[bridge.ts → 回调与队列](/Users/yitiansong/data/code/start-electron/packages/core/agent-loop/bridge.ts:10)、[provider-stream.ts → 转换文字事件](/Users/yitiansong/data/code/start-electron/packages/core/agent-loop/provider-stream.ts:148)。

**接下来：引擎看到 `type: "text"`，调用文字处理函数。**

## 7. 累加正文，更新消息，再推送片段

引擎在文字分支中调用 `applyAgentLoopTextChunkWithAdapters`，它再调用传入的 `handleTextChunk`。这里又是一次“函数作为参数传进去，后面才调用”。最终到达下面这段原代码：

```ts
handleTextChunk(text: string, turnContent?: { value: string }, turnIndex?: number): string {
  if (!text) return ''

  accumulatedContent += text
  if (turnContent) turnContent.value += text
  store.updateMessageContent(ctx.sessionId, ctx.assistantMessageId, accumulatedContent)
  emitter.sendTextChunk(text, turnIndex)
  return text
},
```

假设第一次收到 `"你好"`，第二次收到 `"！"`：

| 时刻 | 新片段 `text` | 完整正文 `accumulatedContent` | 推给前端的片段 |
|---|---|---|---|
| 开始 | — | `""` | — |
| 第一次 | `"你好"` | `"你好"` | `"你好"` |
| 第二次 | `"！"` | `"你好！"` | `"！"` |

`store.updateMessageContent` 更新消息存储；`emitter.sendTextChunk` 把新增片段交给前端传递链。它们承担不同的工作：保存会话状态，以及让正在看的界面及时更新。

原位置：[agent-loop-executor.ts → 文字分支](/Users/yitiansong/data/code/start-electron/packages/core/engine/agent-loop-executor.ts:2193)、[stream-processor.ts → handleTextChunk](/Users/yitiansong/data/code/start-electron/packages/core/engine/stream-processor.ts:444)。

**接下来：片段经过应用的事件传输层，到前端。**

## 8. 前端合入片段，安排刷新

前端收到的是应用自己的流消息，正文类型叫 `text-delta`，文字放在 `chunk.text` 中。它不是直接消费模型服务返回的 `choices[0].delta.content`。

当前源码有两条由 `STREAM_R2` 开关选择的合并路径。开启时会按片段标记合入 `water`，关闭时通过 `feedTail` 合入临时正文；两条路径都会安排刷新。

开启路径的关键原代码节选：

```ts
const result = water.feed(stamp, text, chunk.placement)
if (result.outcome === 'gap') reportWaterGap(messageId, stamp.kind)
// ……退出上述分支后……
schedulePush()
```

`schedulePush` 按帧合并刷新工作，因此“收到一个片段”不一定等于“立刻单独重画一次界面”。

原位置：[chat-source.ts → 合入流片段](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-source.ts:1251)、[chat-source.ts → schedulePush](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-source.ts:615)。

**此刻，示例里的“你好”已经进入界面的消息数据。接着重复第 4—8 步，直到流结束，再由外层完成收尾。**

## 把事件驱动藏起来的连接展开

事件驱动确实会增加阅读成本。直接调用时，下一站写在调用处；事件驱动时，发送方写的是“发生了什么”，接收方则在别处提前声明“这件事发生时找我”。因此必须把**订阅注册的顺序**和**消息实际流动的顺序**拼起来。

这个项目还有不同的传递机制，先分清它们：

| 机制 | 本文里的例子 | 接收方是怎么接上的 |
|---|---|---|
| 直接调用 | `this.send(...)` | 调用处直接指定函数 |
| 回调 | `request.onEvent?.(event)` | 先把函数作为参数传入，之后调用它 |
| 异步生成器 | `yield` / `for await` | 消费者取生成器产出的下一项 |
| 队列 | `queue.push(event)` | 放入队列，由消费者依次取出 |
| 事件订阅 | `client.events.on(channel, callback)` | 提前把频道和接收函数登记在一起 |

这些机制会组合使用，但不是每一处 `onEvent` 都是事件总线，也不能从“事件驱动”推断所有处理都在另一个线程或异步执行。

### 先发生：登记谁来接收

前端建立订阅时，会执行这行原代码：

```ts
unsubStream = port.onSessionStream(dispatchSessionStream)
```

这里**还没有处理任何文字**。它是在登记：“将来有会话流消息，请调用 `dispatchSessionStream`。”返回的取消订阅函数保存在 `unsubStream`。

`port.onSessionStream` 展开后，是这行原代码：

```ts
onSessionStream: (callback) => client.events.on(IPC_CHANNELS.SESSION_STREAM, callback),
```

这里订阅的频道常量 `SESSION_STREAM` 对应 `"session:stream"`。

原位置：[chat-source.ts → ensureSubscribed](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-source.ts:1895)、[chat-port.ts → onSessionStream](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-port.ts:149)、[channels.ts → 频道名](/Users/yitiansong/data/code/start-electron/packages/shared/ipc/channels.ts:132)。

### 后发生：后端真的收到“你好”，发出片段

第 7 步的 `emitter.sendTextChunk` 在事件发射器中把正文包装成 `type: 'text-delta'`，然后调用 `pushSafe`。`pushSafe` 最终执行：

```ts
streamChannel.push(sessionId, chunk)
```

注意这里走的是 **StreamChannel**。同一个发射器文件也有 `eventBus.emit(...)`，但文字增量这一条实际用的是流通道，不能因为文件里有事件总线就跟错路线。

经过宿主和客户端的事件传输层后，前端在 `SESSION_STREAM` 频道收到带有 `sessionId` 的消息。宿主传输层在本导读中折叠为一个步骤；它不是 `streamChannel.push` 直接调用 React。

原位置：[event-only-emitter.ts → sendTextChunk](/Users/yitiansong/data/code/start-electron/packages/core/engine/event-only-emitter.ts:270)、[event-only-emitter.ts → pushSafe](/Users/yitiansong/data/code/start-electron/packages/core/engine/event-only-emitter.ts:257)。

### 因为之前登记过，现在才进入接收函数

接收函数的原代码只有两行：

```ts
function dispatchSessionStream(payload: SessionStreamPayload): void {
  find(payload.sessionId)?.handleStream(payload)
}
```

意思是：根据会话 ID 找到对应会话的数据对象，然后交给它的 `handleStream`。这就接上了第 8 步的文字合并和刷新。

原位置：[chat-source.ts → dispatchSessionStream](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-source.ts:1926)。

把“提前登记”和“后来触发”叠在一起，才是完整路线：

```text
提前登记：
  session:stream 频道 → dispatchSessionStream 函数

后来文字到达：
  后端 sendTextChunk("你好")
    → StreamChannel.push(sessionId, { type: "text-delta", text: "你好", … })
    → 宿主和客户端的事件传输层〔这里暂时折叠〕
    → 前端 session:stream 频道收到消息
    → 调用之前登记的 dispatchSessionStream(payload)
    → find(payload.sessionId).handleStream(payload)
    → 合入“你好”
    → schedulePush() 安排界面刷新
```

这里还有两个名字，层次不同：`session:stream` 是投递频道，`text-delta` 是频道内这一条消息的类型。前者决定哪个订阅入口接收，后者决定处理函数走哪个分支。

### 阅读时如何补上这条隐藏的边

碰到事件发送处，不要只“跳转到定义”一路进入通用事件框架。先记下**频道名或事件类型**，全局搜索它，找到谁使用 `on`、`subscribe` 等方法登记了处理函数，再进入那个处理函数。

这条源码可以在纸上只记一行：

```text
sendTextChunk → session:stream / text-delta → dispatchSessionStream → handleStream → schedulePush
```

中间的传输步骤已经在上面标出。以后想研究跨进程通信时，再展开那一格。这样可以一次补上一条连接，而不用同时理解整个事件框架。

## 再往这条线上接工具调用

先把正文路径读通，再看这一处分岔：第 4 步收到的也可能是工具调用信息，而不是正文。程序会收集完整工具名和参数，交给执行器执行，再把结果追加进对话，发起下一次模型请求。

```text
本次收到的是正文 → 第 5—8 步，更新显示
本次收到的是工具调用 → 执行工具 → 结果加入 messages → 下一轮从请求模型开始
```

这一条 HTTP 工具循环的执行入口在 [runner.ts → executeAgentToolCall](/Users/yitiansong/data/code/start-electron/packages/core/agent-loop/runner.ts:310)，追加模型回复与工具结果在 [runner.ts](/Users/yitiansong/data/code/start-electron/packages/core/agent-loop/runner.ts:787)。不同片段可以出现在同一次模型响应里，并不一定整次只返回其中一种。

## 回到源码时，怎么继续沿线读

每次只追问三个问题：**此刻数据是什么？这行把它交给谁？谁接着处理？**

遇到 `await foo()`，先进入 `foo`，看它最后交回什么，再回到调用处。遇到 `yield`，去找消费它的 `for await`。遇到 `onEvent(...)` 或 `options.handleTextChunk(...)`，去找调用之前是谁把这个函数传进来的。

这也是原项目看起来“不像一条线”的原因：一部分连接写在调用处，一部分连接写在更早的装配处。先沿数据走完一次，再看各层为何拆开，会更容易理解。
