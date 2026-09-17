# grok 流式 / 工具调用问题交接(2026-09-16)

> 后续实现已完成，最新状态、配置入口和验证边界见 [思考配置与流式修复](./grok-reasoning-stream-fixes-2026-09-16.md)。下文保留当时诊断记录；其中再次确认建议与“未改代码”仅描述交接时状态。

用户报障:用 grok-oauth / grok-4.6 时「工具调用、流式很不对劲」「思考不实时」「流式中工具卡跑到正文下面、结束后恢复」。
本文是一次只读诊断的全部结论,**没有改任何产品代码**。每条都标了证据等级:**已证实**(数据或真实函数复现)/ **未证实**(有迹象、缺一次抓包)。

证据来源:
- 会话账本 `~/.onething/sessions/<id>/events.jsonl`(`node bin/onething.mjs trace <id> [--last]` 可读)
- 桌面渲染层真机录制(CDP 9333 只读挂钩,见附录 A;录完已卸载)
- xAI 官方文档 `https://docs.x.ai/llms.txt` 下的 `.md` 页(沙箱 DNS 解析不了 docs.x.ai,要用 Browser pane 读)

主要样本会话:`d11de48d-95db-4889-b6a2-aea3014b85be`(run `5276d100…` 是工具卡掉底那一次,run `87ca9a86…` 是「说要搜就停」那一次)、`2cfeb976-261c-4d3a-804c-0ec50a7bac01`。

---

## 问题 1:流式中工具卡掉到正文下面(渲染层,**机制已证实,触发条件未证实**)

### 现象
run `5276d100` 最后两个请求:#58 执行 `sleep 1; tail …`(账本 turnIndex=6),#59 是纯正文(turnIndex=7)。流式中屏幕是「正文(截到一半)→ 工具卡」,run 结束后恢复为「工具卡 → 正文」。账本本身顺序正确。

### 机制(已用真实函数复现)
- 排布:`apps/desktop-react/src/content/assemble/anchor.ts` → core `packages/core/session/render-anchors.ts` 的 `synthesizeCoreToolAnchors` / `insertDataStepsByTurn`,**按 part 的 `turnIndex` 插工具锚点**。
- R2 实时合并:`apps/desktop-react/src/data/chat-materialize.ts` 的 `mergeWater`。水位表(`stream-water.ts`)有这一段时,cell 带流给的 turnIndex=7,顺序正确。
- **水位表没有这一段时**走 `apps/desktop-react/src/data/missing-assistant-text.ts`:从 `message.content` 补差额,turnIndex 取 `max(parts, steps, liveTurns)`。水位为空时 liveTurns 为空,只剩 steps 的最大值 6,于是补出来的正文被当成第 6 轮,`insertDataStepsByTurn` 把第 6 轮的工具锚点放在它**后面**。
- 复现脚本(bun 直跑,用仓库里的真函数):

```ts
import { synthesizeCoreToolAnchors } from '<repo>/packages/core/session/render-anchors.ts'
import { missingAssistantText } from '<repo>/apps/desktop-react/src/data/missing-assistant-text.ts'
const steps = [1,2,3,4,5,6].map(t => ({ turnIndex: t, toolCallId: 'c'+t }))
const settled = [{ type: 'text', content: 'A', turnIndex: 1, partIndex: 2 }]
const message = { role: 'assistant', content: 'A最终回复', steps, toolCalls: steps.map(s => ({ id: s.toolCallId })) }
// 水位在:… tools(t6) → text(t7)   正确
// 水位缺:missingAssistantText 猜 turnIndex=6 → … text(t6) → tools(t6)   与截图一致
```

同一条路径也解释了「卡顿」:水位缺席时正文只靠账本打包行补(grok 这次约每 1s 一批、每批 ~140 字),屏幕上一截一截跳,`lastDeltaAt` 不推进(截图「已 10.7s 没有新内容」)。

### 未证实:水位为什么缺
- 后端铸章 `packages/backend/wiring/engine/stream/session-event-recorder.ts:641-662` 带 `turnIndex` 与 `charOffset`,纸面没问题。
- 那次 run(22:36:28–22:37:37)渲染层 `window.__perf` 环里 `stream.water.gap` / `stream.water.divergence` **均为 0**。
- 仍无法排除的静默出口:`chat-source.ts` R2 分支里 `if (!water) return` 与 `if (!stamp) return`(不计数);以及 fold 重建(`chat-source.ts` ~1758 `water = new StreamWater()`)。线索:perf 环最早一条是 22:36:19,run 开始前 9 秒,**疑似那之前页面刷新过或会话切走又切回**。
- 第二次真机录制(同会话,约 110s、12 个工具、最后 1460 字正文)**未复现**:每 100ms 采样的段序全程正确,正文 ~100ms 一截平滑到达。

### 建议
1. 先用附录 A 的录制器守一次复现,重点记录:水位是否整条为空、fold/water 是否被重建、是否有无章 delta。在 `if (!water) return` / `if (!stamp) return` 加 `perfCount` 可让下一次不再静默。
2. 独立于根因可以先修的结构缺陷:`missingAssistantText` 不该用 steps 的最大轮次去猜一段**还没结算**的正文。候选:流式期(有活 run)补账时取「最大工具轮次 + 1」,或者取 activeRun 的当前请求轮次(需要一个真实产地,不要再猜)。注意冷加载(中止请求)也走这个函数,两种语境的正确答案不同,要分开判。

---

## 问题 2:grok 思考不实时(**已证实,上游行为**)

- 录制:每轮推理几乎都是**一个 delta 整块**到达(例如 11.46s 一次来 203 字),之前常有长空白(55s→77s 之间 21s 无任何东西,然后推理与工具调用同一毫秒到)。正文则是逐 token。
- 账本:grok-4.6 的 395 段推理里 **41 段恰好 203 字、以 `...` 结尾**(200 字 + 省略号)。我们的线协议 `packages/onething-runtime/src/agent-loop/providers/wires/openai-responses-wire.ts`(806-839、915-938)没有任何截断,是 xAI 给的摘要本身被截。
- 文档(`/developers/rest-api-reference/inference/responses.md`):`reasoning.summary` 「Only included for compatibility. The model shall always return `detailed`」。可调参数里没有能让摘要实时或变长的选项。
- 结论:前端改不了实时性;只能在界面上诚实表达(例如「grok 在思考,xAI 不提供实时过程」)。

## 问题 3:grok 工具参数整块到达(**已证实,文档明文**)

- 账本:大参数(write 8288 字)在请求结束前 0.04s 以**一个分片**到达;首 token 后 ~55s 屏幕无任何工具卡。录制里每个 `tool-input-delta` 都只有一条,与 `tool:input-start` / `tool:call` 同毫秒。
- 文档 `/developers/tools/function-calling.md`:「With streaming, the function call is returned in whole in a single chunk, not streamed across chunks.」
- 结论:不可修。可做的是 UI:在请求已首 token、尚无正文/工具时给明确状态,避免像卡死。

## 问题 4:reasoning 档位 —— 「思考:关」实际在用 `high`(**已证实,建议改,待用户拍板**)

- 文档 `/developers/model-capabilities/text/reasoning.md`:grok-4.6 「Reasoning cannot be disabled」,默认 `high`;`low` 标注为「Latency-sensitive agentic use and simple tool calling」。
- 我们:`thinking/grok-responses-reasoning.ts` 在 `thinking === 'disabled'` 时**一个字段都不发** → xAI 走默认 `high`。样本会话账本里 `"thinking":"disabled"`。
- 建议:对 grok 线,`disabled` 映射为 `reasoning: { effort: 'low' }`。**用户可感知的行为变化,改之前问用户**(memory:行为裁定须先问)。
- 注意同文件头记录的文档自相矛盾(REST 参考页说 effort 只给 grok-4.3、有 `none`),以能力页为准;改完用一次真机请求验证不 400。

## 问题 5:`parallel_tool_calls` 写死 false(**建议试,需先核执行层**)

- `wires/openai-responses-wire.ts:488` 对所有 Responses 通路写死 `false`,无注释说明原因。
- 文档:xAI 默认允许并行函数调用。grok 现在每个请求只调一个工具,每个来回首 token 2–4s(run `5276d100` 12 个工具 = 12 个来回)。
- 建议:只对 grok 方言放开(方言 spec 加一格,不要在 wire 里 `if (providerId)`),先确认 agent-loop 的 `ToolExecutionScheduler`(`packages/core/agent-loop/runner.ts`)对一轮多调用的处理与账本 `turnIndex`/锚点排布都正确,再真机跑。codex 线是否也关着有理由,先 `git log -S 'parallel_tool_calls'` 查来历。

## 问题 6:grok-4.6 「说要搜索然后 stop」(**强迹象,未证实**)

- 账本:grok-4.6 在全店 371 次请求里 **0 次**调用 `web_search` / `web_open`(grok-4.5 有 6 次);3 次出现「我先查/搜…」后 `finishReason: stop` 无工具调用(d11de48d req 47、2cfeb976 req 1 / req 10)。工具表里 `web_search` 都在。
- 文档 `/developers/tools/web-search.md` + `tool-usage-details.md`:xAI 有同名**服务端**工具 `web_search`,在 xAI 侧自动执行,Responses 里以 `web_search_call` 输出项出现。我们的 `web_search` 是同名的函数工具。
- 疑点:模型想调「web_search」时被当成服务端工具处理(未启用)或输出了我们不认的项。`openai-responses-wire.ts:957` 的 `default` 分支静默丢弃未知事件类型,所以看不到。
- 下一步:抓一次原始 SSE。开 trace 日志 `ONETHING_LOG=info,providers.grok-oauth=trace` 重启桌面(wire 在 trace 级逐事件打 `sse event` 类型),让 grok 执行「帮我搜一下 Electron hello world」。坐实后二选一交用户:给 grok 线改函数工具名,或挂 xAI 原生 `web_search`(按次计费,`dialects/grok.ts` 文件头写了当初不挂的理由)。

## 已核对、不需要改

- 提示词缓存:我们已发 `prompt_cache_key` 与加密推理回放;grok-4.6 403 次请求缓存读 / 输入 = **96%**,中途失配 7 次,不是瓶颈。
- `store: false`、`include: ['reasoning.encrypted_content']` 与文档一致。

## 建议顺序
1. 问题 4(改一处映射,见效最大,先问用户)
2. 问题 1 的结构缺陷 + 静默出口加计数;挂录制器等复现
3. 问题 6 抓一次 SSE
4. 问题 5 真机验证后放开
5. 问题 2/3 的 UI 状态表达(涉及界面,按 `apps/desktop-react/CLAUDE.md` 规范)

---

## 附录 A:渲染层只读录制器(CDP)

前提:桌面开着 CDP 9333(`~/.onething/run/cdp.json`);规矩见 memory「别抢用户的机器」—— 只用 CDP、不连 5175 以外的实例、不把窗口带到前台、先问用户时机。

驱动(`bun cdp.mjs <expr-file> [out.json]`):

```js
import fs from 'node:fs'
const expr = fs.readFileSync(process.argv[2], 'utf8')
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find(p => p.type === 'page' && /onething/i.test(p.title))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
const msg = await new Promise(r => (ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) r(m) }))
const v = msg.result?.result?.value
if (process.argv[3]) fs.writeFileSync(process.argv[3], typeof v === 'string' ? v : JSON.stringify(v))
console.log(String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 3000))
ws.close()
```

安装表达式要点(完整版按此重写即可):
- `await import('http://127.0.0.1:5175/src/data/chat-source.ts')` 拿 `chatSources.currentSource()`;先核 `getState().messages.length` 与屏幕一致,确认没拿到第二份模块实例(memory:探针 import 可能要带 `?t=`;这次 resource 表已满 250 条看不到,靠消息数核对)。
- 包 `source.handleStream`(payload 形 `{sessionId, chunk}`,记 `chunk.type / turnIndex / stamp[partIndex,turnIndex,charOffset,kind] / 文本长度`)与 `source.handleEvent`(形 `{sessionId, sequence, timestamp, event}`)。
- 每 100ms 采样活消息:`contentParts` 摘要(type、turnIndex、partIndex、长度)、`toolCalls` 状态、`steps` 轮次、`assembleMessage(msg)` 的段序(`import …/src/content/assemble/index.ts`,纯函数,拿第二份无妨);签名变了才记。
- 提供 `stop()` 还原两个方法并清定时器;用完必须卸载。
