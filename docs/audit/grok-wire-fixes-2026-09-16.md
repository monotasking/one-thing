# Grok Responses 流修复与剩余诊断

2026-09-16。基于交接文档与当前实现核对；没有重启桌面、发送真实模型请求或启用 xAI 付费原生工具。

## 已修复的客户端问题

- `packages/onething-runtime/src/agent-loop/providers/wires/openai-responses-wire.ts` 之前只识别 `response.reasoning_summary_text.delta`。现在同时识别 xAI 官方示例中的 `response.reasoning_text.delta`，立即向下游发出思考增量。
- 完成事件之前只在该 item 完全没有思考文本时补发摘要。现在按 item 与 summary part 记录已发内容，`reasoning_text.done`、`reasoning_summary_text.done`、`reasoning_summary_part.done` 和 `output_item.done` 补齐未收到的后缀；完整快照不会重复追加。多个 part 中只有后面的 part 缺 delta 也能恢复。
- 不相容的完成快照不能直接替换已发出的增量，因此保留已发文本，记录 `reasoningSnapshotMismatches`，避免复制整段文本。没有制作人工打字效果，也没有把整块上游摘要伪装成逐 token 到达。
- 新增 `responses stream summary` info 日志，包含思考原始 delta 事件数、总字符数、最大 delta 字符数、输出字符数、首段正文/思考到达时间、完成工具数、结束原因及不支持的事件/item 类型计数。时间从开始解析响应体计，不含获取响应头之前的网络等待。
- 旧 trace 的正文/思考预览已移除。新增诊断不包含提示词、正文、工具参数、标识符或加密思考内容。类型名称和不同类型数量均有上限；未知事件不再完全无迹可查。

## 流式结论与边界

SSE 解码器按帧逐个 yield，HTTP 模板直接委托解析响应流，没有先读取成功响应的完整正文。可控流测试在连接保持打开时确认思考与正文已产出，并覆盖 UTF-8 字符、CRLF 边界分块和流尾无空行的帧。

交接中观察到 Grok 摘要整段到达和 200 字左右省略，是已有录制的观察，不能据此断言所有 Grok 请求永远不提供思考 delta。xAI 的 [Reasoning 官方文档](https://docs.x.ai/developers/model-capabilities/text/reasoning) 明确展示两个 reasoning delta 事件名；本次修复保证客户端能够接收它们。上游实际一次发送整块内容时，客户端仍只能在它到达后展示。

xAI 的 [Function Calling 官方文档](https://docs.x.ai/developers/tools/function-calling) 明确说明流式请求中的函数调用整块返回。因此工具参数无法由客户端变成真正更早到达的小块。

## 并行工具调用评估

xAI 文档说明默认允许同一响应请求多个工具，本项目 Responses wire 显式发送 `parallel_tool_calls: false`。历史 `9a4263262` 是从旧 Codex 实现逐字迁移，旧实现已有同样设置，未发现该提交提供关闭理由。

执行层具备基础保护：`packages/core/agent-loop/runner.ts` 仅允许声明 `executionMode: 'parallel'` 的工具重叠，其余工具作为 barrier；`ToolExecutionScheduler` 等待此前任务完成后独占执行 barrier，后续任务也等待 barrier。runner 在继续下一轮之前等待所有工具执行收敛。已有 3 项调度器测试通过，本次新增两工具交错参数流测试也通过。

本次保留并行默认值。以上证明解析器与调度器支持多调用，尚未真机验证 Grok 多调用、工具审批和渲染锚点整体组合。后续若开放，应作为 provider 配方或配置能力引入，不在 wire 写 provider 名称判断。

## 仍未证实的搜索停止问题

Grok 4.6 说要搜索却以 stop 结束，以及本地 `web_search` 与 xAI 原生同名工具发生冲突，仍是待验证假设。[xAI Web Search](https://docs.x.ai/developers/tools/web-search) 与 [Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details) 区分服务端自动执行工具与本地函数工具，但名称相同本身不能证明冲突。

本次只增加元数据诊断；没有给函数改名，没有挂原生搜索，没有自动重试或强制执行模型没有实际请求的工具。复现后检查日志中的 `unhandledEvents` / `unhandledOutputItems`（例如 `web_search_call`），可判断是否真的存在当前解析器未处理的服务器工具输出；若只有正常 stop 且无未知项，还需结合原始响应或受控对照实验继续定位。

## 验证记录

- 新增 `wires/__tests__/responses-stream.test.ts`：13 项通过，涵盖增量时机、UTF-8 分包、双事件名、部分 delta 补尾、多 part 补齐、跨 item 去重范围、未知服务器工具诊断、日志无内容、交错多工具。
- `packages/backend/wiring/engine/__tests__/tool-execution-scheduler.test.ts`：3 项通过。
- `providers/__tests__/tool-call-loss.test.ts`：5 项通过。
- wire 修改后最初运行 Responses 35 项旧快照全部通过（包含所有 SSE 输出快照）；后续并发开发加入 Grok disabled → low 行为后，只有 grok / grok-oauth 的两项 thinking-off 请求快照出现预期差异。此文件不负责修改这些配置期望。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` 通过。
