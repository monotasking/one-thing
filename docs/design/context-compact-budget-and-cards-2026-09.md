# compact 预算闭环 + 壳上两张卡(2026-09-08)

事故:一条 deepseek-v4-pro 会话触发自动压缩,provider 当场拒单:

```
This model's maximum context length is 1048576 tokens. However, you requested
1085297 tokens (701297 in the messages, 384000 in the completion).
```

壳上看到的是一条 system 消息的**原始 JSON**(`{"type":"context-compact","status":"failed",…}`)。
两件事各一个根因,各一段方案。

## 1. 为什么压不动

| 量 | 值 | 来源 |
| --- | ---: | --- |
| 模型窗口 | 1,048,576 | 注册表 `getModelContextLength` |
| 摘要请求 `max_tokens` | 384,000 | `resolveSummaryMaxTokens` = 模型物理输出上限 |
| 块预算(估算 token) | 528,461 | (窗口 − 384,000 − 4,000) × 0.8 |
| 实际送出的输入 | 701,297 | provider 自报 |
| 估算器低估倍数 | 1.33× | 701,297 / 528,461 |

两条错叠在一起:

1. **摘要输出预留成了物理上限**。08-15 裁定「compact 链上不许藏 4096」,实施把「不编数」做成了「拿模型物理上限」。
   对 deepseek-v4-pro 那是 384k,吃掉窗口 37%;摘要从来用不到这个数,却每次都按它占位。
   08-23 留账的「请求侧 `max_tokens = min(原值, 窗口 − 输入)` 防 provider 拒单」就是这一格,一直没拍。
2. **块大小信的是估算器,估算器对这份转录低估三成**。`resolveCompactChunkChars` 用
   `estimateTextTokens`(中文 1.8 字/token、其余 4 字/token)自算 chars/token,0.8 的安全系数不够盖 1.33 的误差。
   而这一刻 session 手里有 provider 刚报的真数(`tokenUsage.lastInputTokens`,正是触发压缩的那次读数),没用。

只修 ①:701k + 合理输出 < 1,048k,今天这条会话立刻能压。只修 ②:块变小,但下一个估算失准的会话还会撞。两条都要。

## 2. 方案 A:预算闭环(引擎侧,三步)

设计原则:**不新增任何常数,不新增设置项**。三个数全部来自窗口、provider 自报、和已有的 0.8。

### A1 摘要 `max_tokens` 夹到「窗口里剩下的地方」

`resolveSummaryMaxTokens` 改成 `min(注册上限, 窗口 − 这一块的输入估算 − 4,000)`,注册上限查不到照旧不传。
这不是藏数:它是「窗口减去已经占掉的」,错误信息里照旧写清是谁夹的
(`truncated by max_tokens (N = window 1048576 − input 701297 − overhead)`)。
同一条夹法同时落到聊天请求侧(08-23 待拍那一格),两处共用一个纯函数。

### A2 chars/token 改信 provider 的上一次真数

`resolveCompactChunkChars` 多收一个 `calibration?: { chars: number; tokens: number }`:
session 上一轮送出的历史字符数与 provider 自报的输入 token。有真数就用真数的比值,没有才退回估算器。
0.8 的安全系数保留,它盖的从此只是「压缩转录 ≠ 上一轮请求」这点差,不再替估算器背锅。

### A3 拒单不是终局,是缩块再来

provider 回 context-length 类 400(deepseek / OpenAI 兼容 / Anthropic 各自文案,C2 的 `AgentProviderError` 类型化正好接这一格)→
本次压缩把块预算折半、重切、重跑,最多两次;两次都不行才走 failed 路,错误里带上三次的块大小。
这是 08-14 归位方案 C3「海口兜底」在 compact 这条河上的落点。

### 面向对象落法

三个数今天散在 `summarizeInChunks` 的局部变量里。收成一个值对象 `CompactBudget`(core,纯):
`window` / `outputCap` / `ratio` / `fill` 四个字段,三个方法 `chunkChars()`、`maxTokensFor(inputTokens)`、`shrink()`(A3 用)。
`summarizeInChunks` 只拿它问,不再自己算。以后换估算器、换安全系数、换缩块策略,都只动这一个类。

### 今天这条会话

不改代码没有解法:阈值已越过,每次发送都会再撞同一堵墙(400 在 provider 侧拒,不计费)。
A1 是十几行的改动,先单独出一笔,当天可用。

## 3. 方案 B:壳上两张卡

### B1 压缩卡(system 消息 `type:'context-compact'`)

今天 `MessageRow` 把 system 与 assistant 一起丢进 `assembleMessage` 装配管线,JSON 当 markdown 排出来。
改法不在 `MessageRow` 加分支:**装配管线按内容自述分类**——正文解析出 `type:'context-compact'` 的 system 消息产出一段 `compact` 段,
由段渲染表映射到 `CompactCard`。这样 system 消息的其他种类(将来的)各自加一行表,骨架不动。

三态,状态直接读账本(`status` 字段 + `context:compact-progress` 事件):

| 态 | 卡上写什么 |
| --- | --- |
| compacting | 「正在压缩上下文」+ 多块时 `k / N` 进度条;单块只转圈 |
| completed | 「压缩了 N 条消息」+ 窗口占用 前 → 后(两格读数来自 `sessions.getTokenUsage`,`meter-source` 已在 `session/compacted` 时重拉)+ 可展开的摘要正文 |
| failed | provider 那句话原样(不改写)+ 「重试」钮(骑 `/compact` 同一条 `commandsPort.compactContext`) |

样式复用 `ChatStream` 里错误卡那一套物件档(`data-prose="object"`),不新造第二种卡。
`timeline.ts` 已有「卡在 compacting 超时改判 failed」的纯函数,卡上 failed 态自然接住。

### B2 上下文更新(`<context-update>` 尾块)

用户消息上的 `turnContext { set, removed }` 今天壳上零消费。
在用户气泡下挂一枚折叠 chip「上下文更新 · 变量 2 · todo 1」,展开列出每块的键与内容;没有 delta 的消息不出 chip。
数据全在 `ChatMessage.turnContext`,零后端改动。

### B3 环上转圈

压缩进行中,顶部 context 环(`meter-source`)订阅 `context:compact-started/completed`,环上转圈、tooltip 写「正在压缩 k/N」;
完成后本来就会重拉。这是从前 Vue 壳 `BackgroundJobsStatusBar` 那一格在 React 壳的落点,不另立状态条。

## 4. 分期与门

| 期 | 内容 | 门 |
| --- | --- | --- |
| A1 | 摘要 max_tokens 夹窗口(+聊天侧同一函数) | `context-compact-append.test` +3;真机:这条 deepseek 会话压得动 |
| A2+A3 | `CompactBudget` 值对象 / 真数校准 / 拒单缩块 | core 单测;fake provider 先拒后收的 gate |
| B1+B3 | 压缩卡三态 + 环上转圈 | `chat-stream` jsdom 三态;`gate:a11y` 加一屏 |
| B2 | 上下文更新 chip | jsdom;无后端改动 |

留账:估算器本身(中文 1.8 字/token)不动,A2 之后它只在没有真数时出场;`keepRecentTurns` 与阈值判定一字不碰。
