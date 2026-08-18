# 提示词双通道:静态进 system 前缀,动态走回合尾块(2026-08-18,**P0-P2 已实施**)

> 上一篇(`prompt-composition-2026-08.md`)解决的是「谁说、什么时候说」;这一篇解决
> 「说在哪」。结论:每条片段声明自己的**通道** —— `system`(静态前缀)或 `turn`
> (随最新一条 user 消息投递、按块去重、持久化回放)。todo、工作目录、项目、skills、
> AGENTS.md、语音模式、插件 provider、当前日期 —— 凡是随会话/回合变的,一律离开
> system;system 前缀从此对同一 agent 的所有会话逐字相同。

## 0. 病根:system 前缀里混着三种稳定性的东西

改后的 `BUILTIN_PROMPT_FRAGMENTS` 逐段的稳定性(什么时候字节会变):

| 段 | 变化时机 | 归类 |
| --- | --- | --- |
| 人格 `default-system.md`、tool guidelines/workspace rules、`context-update-convention`、`context-variables`、OS 说明 | 发版 | **静态**(全体会话共享前缀) |
| `# Agent:` persona | 换 agent | 静态(同 agent 的会话共享) |
| `# Runtime Context`(provider/model id) | 换模型 | 静态(缓存本来就按模型分) |
| `Current date: YYYY-MM-DD` | **每天** | 动态 —— 且 `datetime` 变量已在尾块里按小时给了,这一行是重复 |
| `## Voice Speak Mode` | **每回合**(这条是不是语音输入) | 动态 |
| `# Work Directory`(路径 + 额外根) | 切 workdir | 动态,且与 `workdir` 变量重复(formatter 特意跳过它) |
| `# Active Project` / `# Known Projects` | 切项目 / 登记项目 | 动态 |
| `# Skills` 列表 | 开关 skill、切 workdir(项目 skill) | 动态 |
| `# Todo`(含 sessionId 路径) | **每个会话都不同** | 动态 |
| `<project_context>`(AGENTS.md,≤64KB) | 切 workdir、改文件 | 动态,**最大** |
| `plugins`(provider 每回合现算) | 每回合 | 动态 |

任何一段动了,整个 system 前缀 + 全部历史的 KV 缓存作废。而仓里**已经有一条**为此设计
的通道:变量板的 `<context-update>` 尾块 —— 挂在最新一条 user 消息末尾、逐字去重、
持久化到消息上按字节回放(`core/engine/turn-context.ts`、`message-helpers.ts`)。
它今天只给变量用,而且是**整块**去重:板上任何一个值变(datetime 每小时变一次)整块重发。
把 40KB 的 AGENTS.md 塞进这一块,等于每小时重发 40KB。所以不能直接复用,要升级成
**按块去重**。

## 1. 对象模型

```
CorePromptFragment            (+ channel: 'system' | 'turn')      ← 片段自己声明去哪
      ▲ collect()
PromptSource ◁── builtinPromptSource / OnethingToolRegistry / PromptFragmentRegistry
                 / PluginPromptContextSource / VariableBoardSource(新)
      ▲
PromptComposer.compose(ctx) ──► ComposedPrompt { system, developer, sections, turn: TurnBlock[] }
                                                                     │
                                          TurnContextLedger(core,纯) │  diff(visibleHistory, turn) → delta | undefined
                                                                     │  render(content, delta) → "<context-update>…"
                                                                     ▼
                              SessionTurnContext(app) .attach(sessionId, history, turn)
                                     ├─ 最新 user 消息已带 turnContext → 原样回放(字节不变)
                                     └─ 否则 diff → store.updateMessage(id, { turnContext: delta }) → 改写本次请求里那条 user 内容
```

### 1.1 `channel`:片段的第三个维度(where)

```ts
interface CorePromptFragment {
  …
  /** 'system'(缺省):静态前缀。'turn':随最新 user 消息投递,按块去重、持久化回放。 */
  channel?: 'system' | 'turn'
}
```

规则只有一条:**content 读了会话/回合级事实(sessionId、workdir、项目、skills、语音标志、
文件系统、每回合现算)的片段必须是 `turn`**。三个槽里只有 `section` 能是 turn
(guidelines / workspace-rules 是静态守则,天然 system)。`turn` 片段的 `requiresTools` /
`when` / `disabledSections` 判定与 system 完全一样 —— 通道只决定投递位置,不改变
"要不要说"。

### 1.2 `TurnBlock` 与 `TurnContextLedger`(core,零依赖,纯函数对象)

```ts
interface TurnBlock { id: string; content: string }              // composer 渲染好的一块
type TurnContextDelta = { set?: Record<string, string>; removed?: string[] }   // 持久化在 user 消息上

class TurnContextLedger {
  /** 与"模型仍看得见"的历史比:每块各自比上一次投递的版本;新增/变了 → set;上次有这次没有 → removed;都没变 → undefined(不挂) */
  diff(visible: ReadonlyArray<{ contextUpdate?: string; turnContext?: TurnContextDelta }>, blocks: TurnBlock[]): TurnContextDelta | undefined
  /** 渲染成消息正文尾块。字节稳定:回放时逐字相同 */
  render(content: string, delta: TurnContextDelta): string
  /** 旧消息的 `contextUpdate: string` 视为 `{ set: { variables: string } }`,读法统一 */
  static fromLegacy(contextUpdate: string): TurnContextDelta
}
```

渲染形状(在既有 `<context-update>` 里分块,变量块的内部格式**一字不改**):

```
<context-update>
<section name="variables">
<var name="datetime" state="true">2026-08-18 17:00 +08:00</var>
…
</section>
<section name="todo">
# Todo
Your AI todo for this session: ~/.onething/todo-plan/sessions/<sid>/ai-todo.md
…
</section>
<section name="voice" removed="true"/>
</context-update>
```

`context-update-convention.md` 相应改写一句:块由若干具名 section 组成;同名 section
**以最新一次出现为准**;这一块里没出现的 section 维持上一次的内容;`removed` 表示该
section 已撤销。今天的"整块最新覆盖"是它的特例(只有 `variables` 一个 section)。
去重仍只看 `visibleMessagesAfterSummary` 之后的历史(压缩摘要掉的块不算已投递)。

**代价模型**:每个块只在自己变化时重发一次 → AGENTS.md 一个会话发一次(改文件再发一次),
todo 一次,skills 一次,voice 开/关各一次,datetime 每小时一次(与今天相同)。system 前缀
永远不因它们失效。

### 1.3 `SessionTurnContext`(app):投递与持久化

挂在**请求构建**时(app 的 `buildPrompt` 包装,`agent-loop-runtime.ts`),不是消息创建时:

- 理由:回合尾块的判定材料(工具面、workdir、skills、项目、AGENTS.md、语音标志)正是
  `planAgentLoopPromptBuildOptions` 已经算好的那一份 ctx;在 `handleSendMessage` 里再算一遍
  = 两处口径,迟早分叉。今天 core 引擎在 `handleSendMessage` 里 `resolveTurnContextUpdate`
  只给变量用,那一钩子**移除**,变量板作为 `VariableBoardSource` 走同一条路。
- 幂等:同一回合内多次 LLM 调用(工具循环)第一次 attach 写 `turnContext` 到那条 user 消息,
  之后 history 重建从消息字段回放,字节相同;steering / follow-up 注入的新 user 消息按同样
  规则各自 diff。
- 持久化字段:`ChatMessage.turnContext?: TurnContextDelta`(新增,与旧 `contextUpdate` 并存;
  写新读两种)。`message-helpers.appendContextUpdateForModel` 改为
  `TurnContextLedger.render(content, turnContext ?? fromLegacy(contextUpdate))`。

### 1.4 `VariableBoardSource`:变量板成为普通来源

```ts
class VariableBoardSource implements PromptSource {
  readonly name = 'variables'
  constructor(private readonly board: { render(sessionId): Promise<string> })   // = buildStateVariablesPromptText
  async collect(ctx) { const text = ctx.sessionId ? await this.board.render(ctx.sessionId) : ''
    return text ? [{ id: 'variables', slot: 'section', channel: 'turn', source: 'variables', order: 0, content: text }] : [] }
}
```

`workdir` 变量不再被 formatter 跳过 —— `# Work Directory` 段删除,工作目录以 `<var name="workdir">`
(state=true)的身份出现在板上,单一事实;`## Tool Workspace Rules` 从该段迁出,成为 system
里独立的静态块(它的每一条都是"用当前工作目录"这类不含路径的守则)。额外根(roots)本来
就是 workdir 变量值的一部分(`values[1..]`)。

## 2. 逐段去向

| 段 | 去向 | 说明 |
| --- | --- | --- |
| 人格、guidelines、workspace-rules(独立块)、context-update-convention、context-variables、os、agent、runtime-context | **system** | 不变 |
| `Current date:` | **删** | `datetime` 变量(小时粒度)已在板上;删掉后 system 不再每天失效 |
| voice | turn | 开一次发一次,关时 `removed` |
| workdir | **变量板** | 删 `# Work Directory` 段;formatter 不再跳过 workdir |
| active-project / known-projects | turn | id 不变 |
| skills | turn | 列表 + `<available_skills>` 整体一块 |
| todo | turn | 路径 + `todo-rules.md`,会话内发一次;`requiresAnyTools` 照旧 |
| agents-md | turn | ≤64KB,只在文件/目录变时重发 |
| plugins provider | turn | id `plugin:<pluginId>/<providerId>`;`disabledSections: ['plugins']` 仍按 id 前缀生效(composer 里 `plugins` 视为组名) |
| 变量板 | turn(`variables`) | 从引擎钩子搬进 composer,格式不变 |
| scratchpad 瞬态尾块 | **不动** | 那是"每次调用重发、不持久化"的另一种语义(`ephemeralTail`),与本通道并列 |

## 3. 分期

> **落地状态(2026-08-18)**:P0 / P1 / P2 全部实施,全绿。P3(遥测)未做。
> 逐条落点与偏差见 §5。

- **P0 通道底座**:`channel` 字段;`ComposedPrompt.turn`;`TurnContextLedger`(diff/render/legacy);
  `ChatMessage.turnContext`;`message-helpers` 回放;`SessionTurnContext.attach` 接进 app `buildPrompt`
  包装;`VariableBoardSource`;core 引擎删 `resolveTurnContextUpdate` 钩子(`runtime.variables.buildTurnContext` 退役)。
  验收:旧会话(只有 `contextUpdate` 字符串)回放字节不变;新会话变量块字节与今天完全相同;
  同一回合工具循环多次调用请求字节相同。
- **P1 段迁移**:§2 全表;`context-update-convention.md` 改写;删 `Current date`;`# Work Directory` 段删除、
  workspace-rules 独立块;golden 场景加 `--- turn ---` 附录,逐段核对字节。
- **P2 插件 + 文档**:provider → turn;`plugin-authoring.md` 增补("你的 provider 输出在 user 消息尾块,
  变了才重发");`prompt-composition-2026-08.md` §1.5 补 channel。
- **P3 遥测**:每块的重发次数/字节进 evals 的 section 账本(片段有 id 与 source,天然可记)。

## 4. 不做的

- 不给 turn 块做 token 预算裁剪(独立议题);先让每块可度量。
- 不改 provider 层的 `system/developer` 拆分(codex 仍是 system + developer,turn 走 user 尾块)。
- 不把 skills 段拆成"每个 skill 一块"——一块足够,列表整体变才重发。

## 5. 落地记录(2026-08-18)

### 5.1 P0 通道底座 —— 已实施

| 件 | 落点 |
| --- | --- |
| `channel` / `group` 字段 | `packages/core/engine/prompt-fragments.ts`(`CorePromptChannel`) |
| `TurnBlock` / `TurnContextDelta` / `TurnContextLedger`(diff / render / fromLegacy / deltaOf) | `packages/core/engine/turn-context.ts`(纯,零依赖) |
| `ComposedPrompt.turn` + 通道分桶 + `group` 禁用 | `packages/onething-runtime/src/prompts/composer.ts` |
| `CoreBuildPromptResult.turn` | `packages/core/engine/system-prompt.ts` |
| `ChatMessage.turnContext` | `packages/shared/ipc/chat.ts`(结构化写死在 shared,不引 core) |
| 持久化写口 `updateMessageTurnContext` | `sessions/session-message-runtime.ts` → `app/stores/sessions.ts` → `app/store.ts` |
| 回放 | `app/engine/stream/message-helpers.ts` `appendContextUpdateForModel` |
| `SessionTurnContext.attach` | `app/engine/prompt/session-turn-context.ts`,接在 `app/engine/stream/agent-loop-runtime.ts` 的 `buildPrompt` 包装上 |
| `VariableBoardSource` | `prompts/variable-board.ts`,桌面组合器注入 `buildStateVariablesPromptText` |
| 引擎钩子退役 | `core-stream-engine.resolveTurnContextUpdate`、`StreamEngineVariablesAdapter`、`buildTurnContextText` 全删;`resolveTurnContextUpdateText` 一并删除 |

**偏差 1(挂载点)**:`attach` 挂在 **app 的 `buildPrompt` 包装**(`stream/agent-loop-runtime.ts`)
而不是 `app/engine/prompt/system-prompt.ts` 的 `buildPrompt` 本体。理由:后者也被
**提示词快照**(`system-prompt-snapshot.ts`)调用,而一次诊断性快照绝不该往会话里写字段。
包装那一层恰好只有真回合走。

**偏差 2(`fromLegacy` 只管读,不管写)**:设计里写 `fromLegacy` 统一读法,实施时明确
**它只进 diff,不进 render** —— 旧消息的 `contextUpdate: string` 仍走
`renderContextUpdateBlock` 原样回放(不裹 `<section>`),否则老会话每一条历史消息的字节
都会在升级后的第一个回合整体位移。`fromLegacy` 的作用只是让老会话的板与新板对得上,
升级当天不会白发一次板。

**偏差 3(`group` 字段)**:设计说"composer 里 `plugins` 视为组名"。实施为片段上的一个
显式 `group?: string`,而不是在组合器里对 id 做前缀猜测 —— 猜前缀会把任何以 `plugin` 开头
的 id 误伤,而显式声明是同一件事的、可检查的写法。

### 5.2 P1 段迁移 —— 已实施

§2 全表照做。字节层面的实际变化(golden 与 app baseline 已逐条核对):

| 变化 | 说明 |
| --- | --- |
| `Current date: YYYY-MM-DD` 整行删除 | system 前缀从此不再每天失效 |
| `# Work Directory` 段删除 | 路径与额外根由 `workdir` 变量在板上给;formatter 的两处 `if (v.name === 'workdir') continue` 同时删掉(state 与名录两条渲染路都跳过过它) |
| `## Tool Workspace Rules` 成为独立 system 段 | id = `tool-workspace-rules`(与既有的 `PROMPT_BLOCK_*` 常量同名,所以 `disabledSections` 的写法不变),排在原 workdir 的位置(order 500) |
| voice / active-project / known-projects / skills / todo / agents-md | `channel: 'turn'` |

**偏差 4(工作目录守则不再要求有工作目录)**:改前 `## Tool Workspace Rules` 是
`# Work Directory` 段的尾巴,没有工作目录整段不出;改后它是独立静态块,只受工具面闸门管。
于是一条**没有 workingDirectory 但有 read** 的会话会新增看到
「read uses the current work directory by default.」。这是设计要的(守则本身不含路径,
永远成立),但它是一处真实的行为扩面,记在这里。

**连带修正 5(房间回合)**:`collabRoomOverrides` 的 `disabledSections` 里 `'workdir'` 换成
`PROMPT_BLOCK_TOOL_WORKSPACE_RULES`。不换的话,守则块会因为不再寄生在 workdir 段上而**新增**
出现在房间 persona 里 —— 那正是那份名单要挡的东西。

### 5.3 P2 插件 + 文档 —— 已实施

provider 结果落 turn,块 id `plugin:<pluginId>/<providerId>`,组名 `plugins`。
`pluginId` / `providerId` 由**收集器**盖章(`collectPluginPromptContext`),不由插件返回 ——
它是去重身份,不能被伪造。`disabledSections: ['plugins']` 照旧生效(走 `group`)。
文档:`plugin-authoring.md` 增补一节、`prompt-composition-2026-08.md` §1.5 补 channel、
`CLAUDE.md` 的「System prompt assembly」条目补两条通道。

### 5.4 顺带修的两处观测面(不在原设计里,但不修就会说谎)

- **evals**:`evals/runner.ts` 与 `evals/replay.ts` 只取 `built.systemPrompt`。段一旦换通道,
  重放出来的请求就少了半篇,而 D6 的**消融矩阵**会拿两份一模一样的请求去比 —— 结论必然是
  "复现不了"。新增无状态投递 `prompts/turn-delivery.ts`
  (`attachTurnBlocksToLastUserMessage`,空历史 = 每块都是新的),两处都接上。
- **提示词快照**:`system-prompt-snapshot.ts` 的 `systemPrompt` 现在是
  「前缀 + `--- turn ---` + 各 turn 块」的合成体,`skills.includedInPrompt` 也据此判定;
  否则那块面板会在 skills 搬家当天开始报 false。

### 5.5 未做

- **P3 遥测**:每块的重发次数 / 字节没有进 evals 的 section 账本。
- golden 的 `agents-md` 场景其实**从来没有加载到** AGENTS.md(`fixtures/scenarios.ts` 里
  `path.resolve(__dirname, "fixtures/fake-project")`,而 `__dirname` 已经是 `fixtures/`,
  拼成了 `fixtures/fixtures/fake-project`)。这是改前就存在的夹具 bug,本批没有动它 ——
  但它意味着 agents-md 这一块的 turn 投递没有 golden 覆盖。
- turn 块的 token 预算裁剪(§4 明确不做)。

### 5.5 审查修正(2026-08-18,主会话 review)

实现由 Opus 5 完成,主会话审查后修了两处 P0 的真 bug,其余项通过:

1. **多模态消息上的落点不一致(会破坏工具循环内的字节相同)**。首次构建的 attach 把块渲染进
   请求内容的**最后一个** text part,而下一次构建的回放路径是"先把块拼到 `message.content`、
   再造 parts",块落在**第一个** text part(附件路径行是它后面单独的 text part);附件-only 的
   消息(`content` 为空)更是回放会**新增**一个首 text part。同一回合的两次请求字节因此不同。
   修法:落点规则收成**一个**函数 `TurnContextLedger.applyTo(builtContent, delta)`(字符串 →
   追加;parts 首项是 text → 渲染进去;否则 → 新增首 text part),回放改为在 parts 造好之后
   调它(`history-messages.ts` 新增 `finalizeContent` 钩子,`message-helpers.ts` 接上),
   attach 也调它 —— 两条路按构造相同。旧的 `contextUpdate: string` 回放**仍走 parts 之前的
   老路**,字节不变。测试:`turn-channel.test.ts` 加 "text + 附件" 与 "附件-only" 两例,断言
   attach 结果 `toEqual(buildMessageContent(已持久化的消息))`。
2. **首次构建无增量时未记账**。第一次 diff 为空 → 消息上不落字段 → 同回合后续每次调用都重新
   diff;板上一个值中途变了(datetime 跨小时)就会在工具循环中途改写那条 user 消息。修法:
   `SessionTurnContext` 内存里记"已判定"的 `(sessionId, messageId)`(容量 4096,先进先出),
   同回合后续构建直接返回;不落盘(重启后重判无害:落过字段的仍以字段为准)。测试:
   "decides once per message"。

审查通过项:`TurnContextLedger` diff/render/legacy 语义与设计一致(`Object.entries` 顺序即插入
顺序,JSON 往返保序,回放字节稳定);`disabledSections` 经 `group` 对插件生效、房间回合的
名单改法正确;`Current date` / `# Work Directory` 删除与 workspace-rules 独立块位置(order 500)
符合 §2;golden 与 baseline 的字节变化逐条对得上 §2 表;core 零依赖、`boundary:gate` 无新红;
typecheck / 全部相关套件(2434 用例)全绿。
