# S3w 落地记录暂存(2026-08-26)

> **状态:待并回 `docs/design/session-event-sourcing-2026-08.md` §15。**
> 批 6a 正停在工作树里(`read-mode.ts` / `reads.ts` / `agent-loop-executor.ts` /
> `scripts/session-verify.ts` / `scripts/shadow-battery.mjs` / §15 文档本体),
> 本批(6b)不碰那几个文件,所以落地记录先落在这里,等 6a 合并后整段搬进 §15。

---

## 批 6b —— 影子新类:用户中止工具后的失败结局口径差

### 现象

`~/.onething/log/session-shadow.jsonl` 恰好 4 行,全出自会话
`ef079fd7-d6ca-42a4-887b-499767593b7a`(2026-08-26 17:03–17:09 本地时间):

| # | 时刻(UTC) | kind | runId | 差异 |
| --- | --- | --- | --- | --- |
| 0 | 09:03:27.937 | messages | 3b4733dd | `1.steps.1.rejectionReason` / `1.steps.1.toolCall.rejectionReason` / `1.toolCalls.1.rejectionReason`,抄本侧 `(absent)`,投影侧 `"Session cleared"` |
| 1 | 09:03:31.373 | history | 1c25d390 | `276.content.1.result`,1012 → 1048 字符 |
| 2 | 09:06:42.089 | history | 2b6c7aac | 同上 |
| 3 | 09:09:01.257 | history | fe36f8ee | 同上 |

**四条是同一个根因**,不是两类:messages 那条是投影在消息上多写了一格
`rejectionReason`;history 那三条是同一格顺着 `failureResultForAI` 流进模型历史。

### 字段级定位

那 36 个字符就是 `,"rejectionReason":"Session cleared"`(1 + 17 + 1 + 17 = 36),
插在 `toolFailureResultForAI`(`packages/core/tools/tool-result.ts:176`)的键序里
`parameters` 与 `status` 之间。真机数据实算复核:抄本侧 1012、投影侧 1048,
delta 恰 36。

涉事调用 `call_01_ET_P8C7TyUxm0MWaXuQ6P9R9393`(bash,那条 `echo "=== jira cli? ==="`)。

**抄本侧**(`messages.jsonl`,那次调用的全部字段):

```
{"id":"call_01_ET_…","toolId":"bash","toolName":"bash","status":"cancelled",
 "timestamp":…,"receivedAt":…,"argsFinalizedBy":"parse","startTime":…,
 "endTime":…,"error":"User cancelled"}
```

没有 `rejected`,没有 `rejectionReason` —— 收尾修复(`sessions/stream-abort.ts`)
写的就是 `{status:'cancelled', error:'User cancelled'}` 那两格。

**事件侧**(`events.jsonl`,seq 3863–3869,时刻线一秒之内):

```
3863 tool/call          bash
3864 permission/asked   requestId ab1324cd  toolCallId call_01_…
3865 permission/answered approved:false  reason:"Session cleared"   ← 说谎的那一条
3866 tool/audit          outcome:"aborted"          ← 账本自己已经说对了
3868 tool/result         cancelled:true  resultPreview:""
3869 run/end             outcome:"aborted"
```

投影按 G6(`packages/core/session/projection/reducer.ts:691` `permission/answered`)
把 `reason` 接成 `tool.rejectionReason`,再由 `materializeToolCall`
(reducer.ts:1227)/ `materializeStep`(reducer.ts:1308)落到消息上,
最后由 `toolFailureResultForAI` 带进模型历史。

### 构造点

- 抄本侧:`packages/onething-runtime/src/sessions/stream-abort.ts` —— abort 收尾把
  未结束的调用判死成 `{status:'cancelled', error:'User cancelled'}`。
- 事件侧:`packages/core/permission/index.ts` `clearSession()` →
  `settlePendingReject` → `emitSettled(entry,'rejected',{reason})` →
  `Permission.Recorder.onAnswered` →
  `packages/backend/session/permission-events.ts:41` 写
  `permission/answered {approved:false, reason}`。
- 触发链:用户按停止 → `CoreStreamEngine.abort()`(core-stream-engine.ts:484)
  最后一行 `onSessionCleared()` → `clearPermissionSession` 端口
  (`backend/wiring/engine/stream-engine-runtime.ts:142`)→
  `Permission.clearSession` + `Interaction.clearSession`。

### 归责

**双侧独立构造的字面分歧**,且**事件侧是说错的那一侧** —— 不是采集缺口。

判据是账本自己给的:同一次调用的 `tool/audit` 写的是 `outcome:"aborted"`,
既没有 `decision:"deny"` 也没有 `asked:true`;而**真正被人拒**的两次
(seq 3370 / 3512)写的是 `{decision:"deny", asked:true, outcome:"denied"}`,
抄本侧同时有 `rejected:true` + `rejectionReason`,两侧一致、影子无失配。

也就是说:`Permission.clearSession` 的 `'Session cleared'` 是**拆除现场留给等待方
的一句内部话**,不是判决理由 —— 会话根本没被清,是流被 abort 了。把它记成
"被拒,理由 X" 之后,投影会凭空给模型多看一句 `rejectionReason: "Session cleared"`。

### 修复(单一构造点)

`packages/core/permission/index.ts`:给 `settlePendingReject` 加一个显式的收场
**方式** `SettleKind = 'answer' | 'teardown'`;`clearSession` 走 `'teardown'`。

- `teardown` 那一支**不向账本旁听席报理由** —— 因为没人答过。
- 等待方拿到的 `RejectedError`(`message` 与 `reason` 都含 `'Session cleared'`)
  **一个字节没变**,总线事件 `permission:settled` 本来就不带理由,也没变。
- 事件仍然照记 `permission/answered {approved:false}`:投影靠它清
  `awaitingPermission`(A12),丢了会造出新的失配。
- 没有在 canonical 加豁免,没有回填历史,没有改 reducer。

`packages/core/session/trace/assemble.ts:591` 早就是 `reason !== undefined` 条件
展开,拆除路少一格 `reason` 不影响轨迹面。

### 反证

`packages/backend/wiring/permission/__tests__/permission.test.ts` 新增两只:

1. `records a teardown without a rejection reason (the awaiting side still gets one)`
   —— 拆除路:等待方仍 `err.reason === 'Session cleared'`、`err.message` 仍含那句话,
   而旁听席只收到 `{approved:false}`。**回退 `'teardown'` 实参后此只必红**,实测:
   `expected [{approved:false, reason:"Session cleared"}] to deeply equal [{approved:false}]`。
2. `still records the reason when a human actually rejected` —— 防过度修复:
   真人 `respond({response:'reject', rejectReason})` 那一支照旧带理由。

### 验收

| 门 | 结果 |
| --- | --- |
| `bun run typecheck` | 0 |
| 定向测试(permission / shadow / event-log / event-translator-write-side-read / trace / projection-contract / stream-abort) | 9 文件 159 只全绿 |
| `bun run boundary:gate` | ok — 0 |
| `bun run session:gate` | ok — 0 known,none new |
| `bun run log:gate` | ok — 4 known,none new |
| `bun run sessions:shadow-battery` | **未跑** —— `scripts/shadow-battery.mjs` 属批 6a 在途文件,本批禁触;由主会话在 6a 合并后统一跑 |

### 待批 6a 合并后补(shadow-battery 新场景)

`scripts/shadow-battery.mjs` 加一个场景,覆盖本批这条失配类:

> **场景名建议:`abort-while-awaiting-permission`**
>
> 1. 让假 provider 吐一个需要审批的工具调用(bash 一类,`effects` 非空,
>    保证走 `Permission.ask` 而不是直接放行);
> 2. 等 `permission/asked` 落账(轮询 `events.jsonl` 或等 SSE 上的
>    `permission:request`)——**不要**答它;
> 3. 发 `command:abort`;
> 4. 断言:
>    - `events.jsonl` 里该 callId 的 `permission/answered` 是
>      `{approved:false}` 且**无 `reason`**;
>    - 同一 callId 的 `tool/audit.outcome === 'aborted'`;
>    - 该 run 的 messages 断言与下一次请求的 history 断言都 match
>      (即 `session-shadow.jsonl` 不长出新行)。
> 5. 配套的反向场景(**已被现有真人拒绝路覆盖,可选**):答 `reject` 带理由,
>    断言 `permission/answered.reason` 仍在、两侧仍相等。

### 一处未解、不影响根因的观察

同一格失配在真机上只被记了 3 个 run(1c25d390 / 2b6c7aac / fe36f8ee),
per-run 去重(`backend/session/shadow.ts` `rememberMismatch`)另折了 10 条重复;
但 09:12 之后的 5 个 run(277ae232 / 7d62998d / f0a08e3e / 1bab5390 / 1c884683)
**不再失配**,而那条消息在这 5 个 run 的每一次 `request/recipe` 里都还在
(`hasMsg276=true`,全程无 `session/compacted`)。events.jsonl 里在 09:09–09:12
之间没有任何触碰该 callId / 该消息的事件。

统计口径:`session-shadow-stats.json` 记 `mismatches:4`(`byKind` messages 1 /
history 3)、`duplicateMismatches:10`、`skipped:{history-steer-window:4}`、
`fallbackHits:79`。怀疑与 `getLiveSessionProjection` 的活投影生命周期或
`buildBudgetedToolResultContent`(history.ts:323,per-result 200k / total 600k
字符预算)在长历史下的落点有关,但没有直接证据 —— 记在这里,不当作根因的一部分。
**全量重放这段事件是确定性的:那格 `rejectionReason` 必然出现**,反证单测即按这条
时刻线复现。
