# 事件驱动源码阅读 Resources

## Knowledge

- [OneThing 中文 README：这是什么](README.zh-CN.md)
  2026-09-16 阅读。第 7 课产品一句话：桌面 AI 助手、本地工具、目录级权限、会话本地保存。
- [OneThing：Architecture Overview](CLAUDE.md)
  2026-09-16 对照当前 apps/ 与 packages/ 目录。第 7 课分层依据：core / runtime / backend / apps 单向依赖。第一遍只取分层，不读完整法令。
- [Electron 官方：Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
  2026-09-16 再核。第 7 课外部首选：只读主进程与渲染进程两节；preload 留到启动课。
- [第 7 课分层速查](reference/project-map.html)
  2026-09-16 整理。四层目录对照、依赖禁令、按路径判断层。

- [OneThing：桌面启动入口](apps/desktop-react/electron/main.ts)
  2026-09-11 核对。第 6 课首选原始资料：从 app.whenReady 跟踪 core 发现、后端装配、窗口创建和 HTTP 服务启动；以执行语句优先于遗留注释。
- [OneThing：后端统一装配](packages/backend/backend.ts)
  2026-09-11 核对。createOnethingBackend → OnethingBackend.assemble → assembleSteps，包含宿主能力、store lease、数据与设置、引擎、工具及 RPC 注册的顺序。
- [OneThing：页面启动连接](apps/desktop-react/src/platform/connection.ts)
  2026-09-11 核对。getConnection、HTTP 客户端、首次事件订阅与 sessions.list 探测；与 src/main.tsx 的 finally / 数据源启动 / React 挂载配对阅读。
- [Electron 官方：Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
  2026-09-11 阅读。第 6 课外部首选：主进程、渲染进程和 preload 的职责，说明两份 main 为什么不在同一个运行环境中。
- [Electron 官方：app.whenReady](https://www.electronjs.org/docs/latest/api/app#appwhenready)
  2026-09-11 查阅。Electron 初始化完成后执行启动回调；用于区分运行时就绪与项目业务数据就绪。

- [MDN：Property accessors](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Property_accessors#bracket_notation)
  2026-09-11 阅读。第 5 课首选：解释 api[method] 如何按变量值找到对象属性，与 api.method 的区别；方法是可调用的对象属性。
- [OneThing：通用客户端方法生成](packages/client/rpc/router-client.ts)
  2026-09-11 核对。createRouterClient 循环 router.methods，创建 api[method]，调用 invoke 并解除 RPC 响应包装。用于说明客户端 emit 为何不是单独手写的函数。
- [OneThing：后端注册与分发](packages/backend/rpc/registry.ts)
  2026-09-11 核对。registerRouterHandlers 保存处理函数；dispatchRpc 按 domain 与 method 找到函数，再传入 request.payload。与客户端生成机制配对阅读。

- [Sentence Transformers 官方：Semantic Search](https://www.sbert.net/examples/sentence_transformer/applications/semantic-search/README.html)
  2026-09-11 阅读。Embedding 课首选：同一向量空间的资料与问题编码、top-k 检索、查询与文档的不同编码入口、向量索引与近似搜索。先读 Background。
- [Sentence Transformers 官方：Semantic Textual Similarity](https://www.sbert.net/docs/sentence_transformer/usage/semantic_textual_similarity.html)
  2026-09-11 阅读。用于解释 embedding 比较与余弦相似度，避免把相似度误解为答案正确概率。
- [Sentence Transformers 官方：Retrieve & Re-Rank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)
  2026-09-11 阅读。段落编码、候选检索与精细重排序；用于说明首轮检索可能返回无关内容。
- [原始论文：Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
  2026-09-11 阅读摘要。用于区分资料检索与生成，以及 RAG 将二者结合的思路；不要求初学者读完整论文。
- [Sentence Transformers 官方：Clustering](https://www.sbert.net/examples/sentence_transformer/applications/clustering/README.html)
  2026-09-11 查阅。Embedding 的其他应用：相近内容分组、近重复发现；作为后续主题入口。

- [MDN：Functions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Functions)
  2026-09-10 阅读。补充课首选资料：函数定义与调用、参数、把函数作为实参、方法。先读 Defining functions 和 Calling functions，不把整章作为前置任务。
- [MDN：Callback function](https://developer.mozilla.org/en-US/docs/Glossary/Callback_function)
  用于解释回调是交给另一个函数调用的函数，调用时机可以同步也可以异步。
- [Node.js 官方：Introduction to Node.js](https://nodejs.org/learn/getting-started/introduction-to-nodejs)
  用于区分 JavaScript 语言与 Node.js 运行环境；不把 Node.js 描述成另一门语言。
- [MDN：const](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/const)
  用于解释 const 限制重新赋值，不意味着它指向的数组不能增添元素。
- [MDN：Array.prototype.push](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/push)
  对照前一课的 output.push(text)：向数组末尾添加内容。
- [TypeScript 官方：Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)
  用于遇到源码中的 text: string、返回类型等写法时就地解释，第一遍分开阅读类型说明与执行动作。

- [Node.js 官方文档：Events](https://nodejs.org/api/events.html#events)
  已于 2026-09-10 阅读。定义 EventEmitter 的具名事件、监听器及 on/emit 的配合。第一课的同步发布订阅示例以此为语义参照；浏览器演示使用明确标注的最小教学实现，并非加载 Node.js。
- [Node.js 官方文档：Asynchronous vs. synchronous](https://nodejs.org/api/events.html#asynchronous-vs-synchronous)
  用于核对 EventEmitter 同步调用监听器的规则；不能由“事件驱动”三个字推断必定异步。此结论不自动推广到 OneThing 的跨进程传输或所有事件系统。
- [MDN：EventTarget.dispatchEvent](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/dispatchEvent)
  已于 2026-09-10 阅读。浏览器主动 dispatchEvent 也同步执行监听器；用于区分事件机制与调度时机，后续浏览器课程再展开。
- [OneThing 源码：chat-port.ts](apps/desktop-react/src/data/chat-port.ts)
  真实项目的 onSessionStream 包装了 client.events.on(IPC_CHANNELS.SESSION_STREAM, callback)，用于查找订阅频道。
- [OneThing 源码：chat-source.ts](apps/desktop-react/src/data/chat-source.ts)
  ensureSubscribed 登记 dispatchSessionStream；dispatchSessionStream 按 sessionId 转交 handleStream。第一课的迁移练习来自这里。
- [OneThing 源码：event-only-emitter.ts](packages/core/engine/event-only-emitter.ts)
  用于区分正文增量走 StreamChannel.push 与其他事件走 eventBus.emit，避免把所有传递机制混成一个事件总线。
- [源码线性导读](docs/learning/ai-call-linear-walkthrough.md)
  本工作区上一轮整理的阅读辅助材料；不是独立权威来源。原代码与 Node.js 官方文档优先，行号变化时按函数名重新定位。

- [第 2 课源码索引：消息生命周期](reference/message-lifecycle.html)
  2026-09-10 对照当前 React 发送、HTTP/SSE 传输、Agent Loop、ToolRunner、MCP Bridge 和 UI 投影源码整理；用于建立整体认识。它是导读，项目源码本身才是实现依据。
- [OpenAI 官方：Function calling](https://developers.openai.com/api/docs/guides/function-calling#the-tool-calling-flow)
  已于 2026-09-10 阅读。用于解释提供工具说明、模型输出调用、应用执行、结果回传、模型继续回答的通用循环；不拿其 API 字段替代本项目的内部格式。
- [MCP 官方：Tools（2025-06-18 固定规范）](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  已于 2026-09-10 阅读。用于区分 tools/list 发现与 tools/call 调用，以及名称、参数和结果的含义；连接实现仍以项目源码为准。
- [MDN：Callback function](https://developer.mozilla.org/en-US/docs/Glossary/Callback_function)
  已于 2026-09-10 阅读。函数作为参数传递、再被调用；回调可以同步或异步。适合在按钮和事件订阅前补齐概念。
- [MDN：await](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await)
  已于 2026-09-10 阅读。用于区分暂停当前 async 函数和阻塞整个应用，解释为什么发送函数可以等待请求而事件通道仍继续工作。
- [Node.js 官方：Introduction to Node.js](https://nodejs.org/learn/getting-started/introduction-to-nodejs)
  已于 2026-09-10 阅读。说明 JS 语言与 Node.js 运行环境的区别，以及服务器端网络和异步 I/O 的位置。
- [React 官方：Render and Commit](https://react.dev/learn/render-and-commit)
  已于 2026-09-10 阅读。用于解释数据状态变化后触发渲染与界面更新，而非将模型响应直接等同于页面。

## Wisdom (Communities)

本课目标是追踪本地源码，尚不需要加入社区。没有给用户设置社区参与要求，也尚未确认其社区偏好。

## Gaps

- 尚无用户独立完成预测或源码追踪的证据；不能据授课完成宣称已掌握。
- 第一课折叠宿主和客户端传输层；后续若用户需要，再为真实进程边界制作独立课程。
