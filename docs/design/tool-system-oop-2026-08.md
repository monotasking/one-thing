# 工具系统重建方案(2026-08-18,v2:推翻式)

> 状态:**方案**,未实施。v1(同日上午)是"在现有 `Tool.define` 上盖一层类"的就地优化,已被否决 —— 它保留了字段袋、`permissionGuard` 字符串、ctx 回调、static/async 双轨的影子。本版**不继承任何现有形状**,从"一次工具调用的一生"重新推导,新建 `toolkit`,并行建成后整体切换、删除旧树。

## 0. 判断一个工具系统设计好不好的标准(先立尺子)

不看它像不像 OOP,看它能不能做到下面六条 —— 每条今天都做不到:

1. **写一个新工具 ≤ 100 行,且不出现** abort / 校验 / 权限 / 截断 / 沙箱 / 进度上报 **任何一个词** —— 这些是系统的事,不是工具的事。
2. **任何工具的任何一次调用,在执行前都能被预览、被审批、被审计**(不只是 edit/write 有 diff 预览),而工具作者不需要为此写一行权限代码。
3. **取消是一个语义,不是四种写法**:任何工具、任何阶段,信号一响,结果恒为 `aborted`。
4. **一个工具的进度/元数据/部分结果是事件流,不是回调字段**:桌面 IPC、server SSE、事件日志、评估轨迹从同一条流投影,不需要工具知道任何一个消费者。
5. **可以用一个假的 RunContext 单测任何工具**,不起引擎、不起 store、不起 Electron。
6. **注册表里只有一种"工具"**:内置、插件、MCP、`feature_*`、将来的远程工具,对注册表/执行器/权限/场景面/渲染都是同一个类型;没有 `if (isAsync)` `if (category === 'mcp')`。

## 1. 第一性原理:一次调用的一生

```
 模型                 系统                                          用户 / 宿主
  │                    │                                              │
  │  ① 暴露 expose     │  这一回合能看见哪些工具、以什么 schema         │
  │◄───────────────────│  = Surface(Catalog × 场景 × agent 白名单 × 设置)│
  │  ② 调用 invoke     │                                              │
  │───────────────────►│  Invocation{ toolId, input, principal, turn } │
  │                    │  ③ 校验 validate   input 对不对契约            │
  │                    │  ④ 计划 plan       工具说"我将要做什么"→ Intent │
  │                    │                     (效果清单 + 预览,还没动手) │
  │                    │  ⑤ 授权 authorize  Authorizer 看 Intent 决定 ─►│ allow / ask → 用户答 / deny
  │                    │  ⑥ 施行 apply      工具按 Intent 动手           │
  │                    │     ├ 全程:AbortScope 一个信号                 │
  │                    │     ├ 全程:emit(ToolEvent) 进度/部分结果/步骤   │─► 观察者(IPC/SSE/日志/轨迹)
  │                    │     └ 收尾:OutputBudget 截断/落盘              │
  │◄───────────────────│  ⑦ 结果 outcome    ok | invalid | denied | aborted | failed
  │                    │     → 投影成模型文本 / 渲染器载荷 / 审计记录     │
```

**从这张图直接得出的四个决定**(它们就是重建与优化的分界线):

| 决定 | 今天 | 重建 |
| --- | --- | --- |
| A. 工具协议是 **两阶段 plan/apply** | `execute` 一把梭;`analyze` 可选;`beforeSideEffect`/`approvedAnalysis` 两个回调把审批缝在 execute 里 | 每个工具都是 `plan(input) → Intent`、`apply(intent) → Result`。审批天然发生在两阶段之间;没有副作用的工具 `plan` 返回空效果,`apply` 就是全部 |
| B. 权限**只认效果**,不认工具 | `permissionGuard: 'safe' \| 'sandboxed' \| 'internal-check' \| 'permission-gated' \| 'external'` 五个字符串 + `autoExecute` 布尔 + effects 分析三套并存 | `Intent.effects: Effect[]` 是唯一输入;`Authorizer` 端口决定 allow/ask/deny。"safe" = 无效果;"sandboxed" = `fs.read` 落在根内自动放行;"internal-check" = `ProcessTool.plan` 把命令分类成带风险等级的 `process.spawn` 效果 |
| C. 观察是**事件流**,不是回调 | `ctx.metadata()` / `onStepStart` / `updateResult` / `onPartialResult` 四个回调字段,由三层适配器层层转发 | `ctx.emit(ToolEvent)`;`Runner` 把事件交给 `Observer` 端口。渲染器/SSE/事件日志各自是一个投影 |
| D. **一个类型** | core `ToolDefinition` / runtime `ToolInfo` + `ToolInfoAsync` / 插件 MCP 各包一层 | `Tool` 抽象类唯一;懒初始化是 `prepare()` 生命周期方法,由 `Catalog` 统一管 |

## 2. 概念模型(领域对象,与实现无关)

| 概念 | 是什么 | 不是什么 |
| --- | --- | --- |
| **ToolSpec** | 不可变值:`id`、`title`、`description`、`input`(契约)、`effects: EffectClass[]`(它**可能**产生的效果上界,静态声明)、`presentation`、`scenes` | 不含行为 |
| **Tool** | `ToolSpec` + 行为 `plan` / `apply` / `prepare` / `visibleIn` | 不含 registry 逻辑、不含权限逻辑 |
| **Invocation** | 一次调用:`callId`、`toolId`、`input`、`principal`、`session/turn` 坐标 | |
| **Intent** | 工具对这次调用的**计划**:`effects: Effect[]`(具体到资源)、`preview?`(diff / 命令 / URL …)、`payload`(apply 需要的中间产物,对系统不透明) | 不是结果 |
| **Effect** | 一条效果:`{ kind: 'fs.read' \| 'fs.write' \| 'process.spawn' \| 'net.fetch' \| 'user.ask' \| 'session.message' \| 'capability.change' \| …, resources: string[], risk?, barrier? }` —— 复用 core 现有 `ToolEffect` 的语义 | |
| **Decision** | 授权结果:`allow` / `ask(prompt) → 用户答` / `deny(reason)` | |
| **Outcome** | 判别联合:`ok(result)` / `invalid(message)` / `denied(reason)` / `aborted` / `failed(error)` | 不是字符串 `success: boolean` |
| **Result** | `content: Part[]`(text/image/file)+ `details`(渲染器/审计用的结构化载荷)+ `terminate?` | 不含 `title`/`metadata` 这类"渲染器私货" —— 那些是 `ToolEvent` |
| **ToolEvent** | `progress` / `partial(result)` / `step(start\|end)` / `annotate(title, details)` / `spawned(job)` | |
| **RunContext** | apply 期间工具能拿到的一切:`abort: AbortScope`、`budget: OutputBudget`、`emit()`、`jobs: JobRegistry`、`principal`、`cwd`、`sandbox: SandboxResolver`、`session` 只读快照 | 不含回调字段 |
| **Job** | 一个**分离**的执行体(后台命令、后台会话):`id`、`owner{sessionId,toolCallId}`、`status: running/exited/killed`、`events(): AsyncIterable<output/ports/exit>`、`kill()`、`log`(落盘位置)。由 `ctx.jobs.spawn()` 产生,生命周期归 `JobRegistry` 端口(归属、清理策略、exit 回投所属会话) | 不是 apply 的返回值本身 —— apply 返回一个含 job 句柄的 Result 后就结束 |
| **Catalog** | 全体已注册工具(目录);管 `prepare()`;不可变快照 | 不答"这一回合看得见谁" |
| **Surface** | 一回合的工具面:`Catalog × Scene × 白名单 × 设置` 解析出的**对象**,提供 `schemas()`、`get(id)`、`names()` | 不是 hidden id 列表 |
| **Runner** | **唯一**跑生命周期的地方:validate → plan → authorize → apply → normalize → outcome,全程 emit | |
| **端口 Ports** | `Authorizer`、`Observer`、`SandboxPolicy`、`Clock`、`Store(可选)` —— 宿主注入 | |

## 3. 内核(`packages/core/toolkit/`,零依赖)

core 禁 zod,所以内核对"契约"只认 **JSON Schema + 一个 `Validator` 端口**;runtime 里的工具用 zod 写契约,经一次转换交给内核。内核约 1.2k 行,全部纯函数/纯类,可单测。

```ts
// core/toolkit/spec.ts
export interface ToolSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: JsonSchema
  readonly effects: readonly EffectClass[]          // 静态上界;plan 产出的具体效果不得超出
  readonly presentation: { kind: 'text' | 'bash' | 'diff' | 'file' | 'search' | 'image' | 'custom'; shell: 'default' | 'self' }
  readonly concurrency: 'parallel' | 'sequential'   // N3 单读者不变
  readonly prompt?: ToolPromptContribution
}

// core/toolkit/tool.ts
export abstract class Tool<In = unknown, Payload = unknown> {
  abstract readonly spec: ToolSpec
  /** 懒初始化(MCP 连接、异步 schema)。Catalog 保证只跑一次、并发安全。默认 noop。 */
  async prepare(env: PrepareEnv): Promise<void> {}
  /** 场景面。默认到处成立。 */
  visibleIn(scene: Scene): boolean { return true }
  /** 计划:说清楚将要做什么。无副作用工具返回 Intent.none(payload)。 */
  abstract plan(input: In, ctx: PlanContext): Promise<Intent<Payload>>
  /** 施行:按计划动手。 */
  abstract apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result>
}

// core/toolkit/runner.ts —— 生命周期的唯一实现
export class ToolRunner {
  constructor(private readonly ports: { authorizer: Authorizer; observer: Observer; validator: Validator; sandbox: SandboxPolicy; clock: Clock }) {}
  async run(tool: Tool, invocation: Invocation, signal: AbortSignal): Promise<Outcome> {
    const scope = new AbortScope(signal)
    const ctx = new RunContext({ invocation, scope, budget: OutputBudget.for(tool.spec), emit: e => this.ports.observer.on(invocation, e), sandbox: this.ports.sandbox })
    try {
      const input = this.ports.validator.parse(tool.spec.input, invocation.input)
      if (!input.ok) return Outcome.invalid(input.message)
      scope.throwIfAborted()
      const intent = await scope.race(tool.plan(input.value, ctx.forPlan()))
      assertWithinDeclaredEffects(tool.spec, intent)          // 工具不能做它没声明过的事
      const decision = await this.ports.authorizer.decide(intent, invocation, scope)   // allow / ask→answer / deny
      if (decision.kind === 'deny') return Outcome.denied(decision.reason)
      scope.throwIfAborted()
      const result = await scope.race(tool.apply(intent.approved(decision), ctx))
      return Outcome.ok(ctx.budget.finalize(result))
    } catch (error) {
      return Outcome.fromError(error, scope)                    // AbortError/scope.aborted → aborted;其余 failed
    } finally {
      scope.dispose(); ctx.dispose()
    }
  }
}
```

**三种执行形态一张表**(流式 / 长时 / 后台不再散在各工具里):

| 形态 | apply 怎么写 | 模型拿到 | 用户看到 |
| --- | --- | --- | --- |
| 同步流式 | await 完成,中途 `emit(partial)` | 最终 Result | 实时刷新 |
| 长时阻塞 | 同上;`scope.race` 随时可掐,`scope.child({timeoutMs})` 给子进程/fetch | Result 或 aborted | 实时刷新 + 停止 |
| 后台分离 | `const job = ctx.jobs.spawn(spec)`;立即返回含 job id / log 路径 / pid 的 Result | 句柄;之后 tail,或 `JobRegistry` 在 exit 时向所属会话回投一条系统消息(与 task 工具同一条唤醒路) | 状态栏里的 job |

其余内核对象:`Job` / `JobRegistry` 端口(见 §2)、`AbortScope`(`throwIfAborted / race / onAbort / child({timeoutMs}) / dispose`)、`OutputBudget`(行/字节阈值 + 溢出落盘端口 + `<truncation>` 尾注,`finalize(result)` 对每个 text part 生效)、`Intent`(`none(payload)` / `of(effects, preview, payload)` / `approved(decision)`)、`Outcome`(判别联合 + `toModelText()` 投影 + `toAudit()`)、`Catalog`(`register / get / all / ensurePrepared`)、`Surface`(`resolve({ catalog, scene, allowlist, settings }) → Surface`,`schemas()` 用 `Projector`)、`ports.ts`。

**内核不 import 任何 `@shared/ipc`、provider、renderer 类型**;和它们的关系全部走 §5 的投影器。

## 4. 类型层次(`packages/onething-runtime/src/toolkit/`)

```
Tool (core 抽象类)
├─ ReadOnlyTool                 plan = Intent.none;apply 抽象。            time / variable(读) / practice / goal / history / notebook / feature_inspect
├─ FileTool                     持 SandboxResolver;plan 里解析路径 → fs.read/fs.write 效果
│   ├─ ReadTool                 apply:读 + OutputBudget(图片走 part.image)
│   └─ MutatingFileTool         模板:plan = buildPlan → diff 预览 + fs.write 效果;apply = 队列 + 落盘 + 审计 + annotate(diff)
│       ├─ EditTool             只写 buildPlan(替换匹配)  ≈ 80 行
│       └─ WriteTool            只写 buildPlan(整文件)    ≈ 60 行
├─ ProcessTool                  plan:classifyCommand → process.spawn{risk};apply:前台 = spawn + emit(partial) + budget + 三态退出;后台 = ctx.jobs.spawn → 返回句柄
│   └─ BashTool
├─ NetworkTool                  plan:net.fetch{urls};apply:fetch(scope.child({timeoutMs}))+ 响应截断
│   ├─ WebSearchTool
│   └─ WebOpenTool
├─ CollabTool                   visibleIn = 场子表;plan 里解析 actor(principal 优先)+ session.message/board.write 效果
│   ├─ SendMessageTool / BoardTool / HistoryTool / NotebookTool
├─ InteractiveTool              plan:user.ask 效果(不需授权,但要预览问题);apply:登记 pending,`scope.onAbort(撤回)`,三态翻结果
│   └─ AskUserTool
├─ SessionTool                  效果 session.spawn / session.message
│   ├─ TaskTool
│   └─ GoalTool(写路径)
├─ CapabilityTool               效果 capability.change(永不可记忆);visibleIn 读 skill 场景
│   └─ FeatureMountTool / FeatureUnmountTool
└─ ExternalTool                 把外部定义包成 Tool;失败隔离(超时/断路)在这里一处
    ├─ PluginTool               插件 `api.registerTool(def)` 的对外契约**不变**,内部映射到 plan/apply(默认:全部效果为 `plugin.exec`,恒 ask)
    └─ McpTool                  prepare = 连接 + 拉 schema;plan = `mcp.call{server, tool}`
```

规则:**两层封顶**;家族基类只放"这一族每个成员都做"的事;横切一律是内核对象,不做 mixin。

四项各在何处(用尺子对照 §0):

| 四项 | 落点 | 换来的能力 |
| --- | --- | --- |
| 抽象 | `Tool { spec, prepare, visibleIn, plan, apply }` 是**唯一**的工具类型;`Runner` 是唯一的生命周期 | 尺子 ①⑥ |
| 封装 | `AbortScope` / `OutputBudget` / `RunContext` / `Intent` / `Outcome` 各自拥有一个横切关注点的**全部**状态与规则,工具只调用 | 尺子 ①③④⑤ |
| 继承 | 八个家族基类拥有家族协议(文件的 plan/diff、进程的分类、协作的场子门、交互的撤回) | 尺子 ①(edit/write 各剩几十行) |
| 多态 | Runner/Catalog/Surface/Authorizer/投影器只调 `plan/apply/visibleIn/spec` | 尺子 ②⑥ |

## 5. 边缘投影(内核不认识任何消费者)

| 投影器 | 从 → 到 | 替代今天的 |
| --- | --- | --- |
| `ProviderSchemaProjector` | `Surface` → provider tool schemas | `getToolsForAI` / `collectCoreProviderToolSchemasWithAdapters` |
| `IpcProjector` | `ToolEvent` / `Outcome` → `@shared/ipc` 的 `ToolPartialResult` / `Step` / `ToolResult` | `coreToolContextFromHost` + 三层回调转发 |
| `AuditProjector` | `Intent` + `Outcome` → 事件日志(events.jsonl)与评估轨迹 | 分散在 tool-execution.ts / trace-store |
| `PermissionAuthorizer implements Authorizer` | `Intent.effects` → 现有 core `Permission.ask` / grants / channel affinity | `permissionGuard` 字符串 + `beforeSideEffect` + `approvedAnalysis` |
| `SceneResolver` | `session + enabledSkills` → `Scene` | 今天 `scene-surface.ts` 的输入侧(表本身消失,由 `visibleIn` 取代;保留一张只读汇总供测试) |

**core 现有 `Permission` 与 `ToolEffect` 语义原样复用**(那是这套里唯一已经"按效果"思考的部分);变化在于它从"某些工具的可选 analyze"升格为"每一次调用的必经之路"。

## 6. 目录布局 + 删除清单(这才是"推翻")

新增:
```
packages/core/toolkit/                 内核(≈1.2k 行)
  spec.ts tool.ts intent.ts outcome.ts events.ts run-context.ts abort-scope.ts
  output-budget.ts job.ts catalog.ts surface.ts runner.ts ports.ts index.ts
packages/onething-runtime/src/toolkit/ 工具(≈4k 行,含 8 个家族基类)
  families/{read-only,file,mutating-file,process,network,collab,interactive,session,capability,external}.ts
  builtin/{read,write,edit,bash,time,variable,goal,practice,radio,task,ask-user,web-search,web-open,
           send-message,board,history,notebook,feature-mount,feature-unmount,feature-inspect}.ts
  contract.ts                          zod → JsonSchema + Validator 实现
  scene.ts                             SceneResolver
packages/onething-runtime/src/app/toolkit/  装配:catalog 三档、端口实现(PermissionAuthorizer / IpcObserver / …)、投影器
```

**切换完成时删除**(不是"逐步废弃",是删):
- `packages/core/tools/{registry,executor,tool-loop,permission-guards,policy}.ts` 的 adapters 族(`*WithAdapters`)、`types.ts` 的 `ToolDefinition`;保留 `tool-effect.ts`、`abort.ts`(内核复用其错误类型)、`diff-hunks.ts`、`tool-result.ts` 的 canonical 形状
- `packages/onething-runtime/src/tools/{tool,registry,tool-execution,tool-execution-context,direct-tool-execution,tool-call-state,tool-refresh,tool-list-presentation,ipc-operations}.ts` 及 `builtin/` 全部(≈ 5.5k + 6k 行)
- `packages/onething-runtime/src/app/tools/`(1.2k)→ 只剩装配壳挪到 `app/toolkit/`
- `Tool.define`、`ToolInfo/ToolInfoAsync/ToolInfoUnion`、`isAsyncTool`、`permissionGuard`、`autoExecute` 概念本身
- `app/engine/stream/tool-execution.ts` / `tool-orchestrator.ts` 里"把 ctx 回调翻成 IPC"的那部分(≈ 350 行)

保留并复用:core `Permission`、`ToolEffect`/`ToolPreview`、agent-loop runner 与 `ToolExecutionScheduler`(它只需要一个 `run(call) → outcome` 的函数)、`@shared/ipc` 契约、渲染器、插件 `api.registerTool` 对外形状、MCP client。

## 7. 切换策略:并行建、整体切、一次删

不是逐工具就地改(那会退化回 v1)。三条纪律:

1. **旧树冻结**:切换期间 `tools/`、`core/tools` 只修 bug 不加功能;新功能进 toolkit。
2. **一个缝**:引擎侧只改三处 —— `agent-loop` 的工具面输入(`Surface.schemas()`)、`ToolExecutionScheduler` 的执行函数(`runner.run`)、IPC/SSE 的事件源(`IpcObserver`)。这三处各有一个开关 `ONETHING_TOOLKIT=1`(内部 flag,不进设置页),开关只存在于切换期。
3. **对拍后删**:每个内置工具改写时,先用旧实现录快照(输入 → 模型文本 / 渲染载荷 / 权限询问 / 事件序列),新实现零 diff 才算移植完;20 个全零 diff + 全量测试绿 + 三处开关翻到新路跑满一个自举周期后,**一个 commit 删旧树并去掉开关**。

## 8. 分期总览

| 期 | 交付 | 行为变化 | 退出判据 |
| --- | --- | --- | --- |
| **R0 内核** | `core/toolkit` 全部对象 + 单测;`runtime/toolkit/contract.ts`;`app/toolkit` 的四个端口实现(空壳可跑) | 无(未接线) | 内核 100% 单测;尺子③⑤在内核层成立 |
| **R1 家族 + 首批工具** | 八个家族基类;移植 read/write/edit/bash/time/variable(覆盖文件、进程、只读三族)+ 快照对拍 | 无(开关关) | 六个工具零 diff;edit+write 合计 ≤ 300 行 |
| **R2 接线** | 三处缝 + 开关;`PermissionAuthorizer` 接 core Permission;`IpcObserver`/`AuditProjector` | 开关开时:所有工具可取消、可预览、统一截断 | 开关开跑全量测试绿;真机自举一轮 |
| **R3 全量移植** | 其余 14 个内置 + `PluginTool` + `McpTool` + `feature_*`;`SceneResolver` 取代 scene-surface 表 | 无 | 20/20 零 diff;插件/MCP 现有测试绿 |
| **R4 删旧** | 删除清单执行;文档;CLAUDE.md;boundary checker 新规则(`core/toolkit` 零依赖、runtime/toolkit 不认 `@shared/ipc`) | 无 | 仓库里 grep 不到 `Tool.define` / `permissionGuard` / `ToolInfoAsync` |

R0+R1 是可独立验证的最小闭环(内核 + 三个家族 + 六个工具全部离线可测),建议先做这两期再拍板 R2 之后。

## 9. 不做 / 风险

- **不改插件对外契约**:`api.registerTool` 的 def 形状不变,`PluginTool` 内部映射;插件不需要理解 plan/apply。
- **不改 IPC 契约与渲染器**:投影器保证 `@shared/ipc` 形状不变;渲染器一行不改是 R2 的验收之一。
- **不动 core `Permission`**:它是被复用的端口实现,不是被重写的对象。
- **风险 1:plan/apply 对"边跑边决定"的工具不自然**(bash 一条命令跑到一半才知道要写哪些文件)。处理:`ProcessTool.plan` 声明的是**命令级**效果(分类 + cwd + 风险),与今天 classifier 一样粗;运行中新增效果不再二次授权 —— 与现状持平,不退步。
- **风险 2:效果分类表要一次定全**。处理:`EffectClass` 从 core 现有 `ToolEffect.kind` 出发,R0 只允许新增不允许改名;不认识的效果类 = 恒 ask。
- **风险 3:切换期两套并存**。处理:§7 三条纪律 + 冻结期不超过一个迭代;R2 后新功能只许进 toolkit。
- **成本**:约为 v1 的 2–3 倍(R0–R4 合计新写 ≈ 6k 行、删 ≈ 13k 行)。换来的是 §0 六条尺子全部成立,以及一棵可以删干净的旧树。

## 10. 可行性审查(2026-08-18,对照真实代码逐条核实)

**结论:可行。** 技术上没有拦路石 —— 生命周期的骨架今天已经在核心里,只是没被立成协议;真正的风险是**量**(测试面比生产代码大)和**并行期纪律**。审查中发现 §1–§9 有六处必须修正或补充,已列为 R0 的前置与 Runner 的补件。

### 10.1 核实过的假设(成立)

| 假设 | 证据 | 影响 |
| --- | --- | --- |
| "两阶段 + 按效果授权"能接上现有权限核 | `core/engine/direct-tool-execution.ts:385-410` 今天就是 `analyzeTool → enforcePermission({effects, preview, principal}) → approvedAnalysis → executeTool`;`enforcePermissionPolicy` 按 unattended / collab / system-driven 三种回合挑权限桥,再交 `permissionRuntime.enforce` | 决定 A/B **不是发明**,是把可选的 analyze 强制成 plan、把 permissionGuard 这条平行轴并掉。`Authorizer` 端口 = `enforcePermissionPolicy` 原样后置,三座桥不动 |
| 引擎侧只改一条缝 | agent-loop 只认 `AgentTool { name, description, parameters, executionMode, execute(args, ctx) }`(`core/agent-loop/types.ts:176`);`executeToolDirectly` 只有 4 个内部调用点 | `Surface.toAgentTools(runner)` 就是投影,`execute = runner.run`;`ToolExecutionScheduler` 的 barrier 语义靠 `spec.concurrency` 喂,不动 |
| Job 能包现有基础设施 | `tools/background-jobs.ts` 已有 register / list / read / stop / log 落盘;IPC `tools:background-jobs:{list,stop}`;变量板 `background_jobs` provider;渲染器状态栏 | `JobRegistry` 端口直接包它;exit 回投复用 `tasks/dispatch` 已有的"投回所属会话"路径 |
| MCP 能变成 `McpTool` | 今天 MCP 在 direct-tool-execution 里是独立分支(`isMCPTool → buildMCPPermissionPlan → executeMCPTool(onPartialResult)`);`core/mcp` bridge 提供 definitions + execute | 分支删除,权限计划变成 `McpTool.plan`,partial 变成 `emit(partial)`;core/mcp 不动 |
| 渲染器/IPC 可以零改 | 渲染器只消费 `@shared/ipc` 的 `Step` / `ToolPartialResult` / `ToolResult` 形状,由 `IpcProjector` 从 `ToolEvent`/`Outcome` 投影 | 成立,但见 10.2-③ |

### 10.2 必须修正 / 补充的六处

1. **Runner 漏了插件拦截钩子。** 今天的管线在 validate 之后、analyze 之前跑 `interceptToolCall`(可改参、可阻断),在结果返回前跑 `interceptToolResult`(`app/plugins/tool-call-intercept.ts` / `tool-result-intercept.ts`)。→ 内核加 `Interceptor` 端口,两个固定挂点:`beforePlan(invocation) → {input | block}`、`afterApply(outcome) → outcome`。
2. **Effect 类目与默认策略是 R0 的前置,不是"复用"就完了。** core 现有 9 个 kind(`read / file_edit / file_write / file_destructive_edit / bash / mcp / external_directory / sensitive_file_read / capability_change`),`core/permission/permission-policy.ts` **逐 kind** 判定放行/询问/文案。§2 里写的 `net.fetch / user.ask / session.message / process.spawn` 是新名字 —— 若按 §9"未知 = 恒 ask",web_search 与 ask_user 会开始弹权限卡,这是错的。→ 决议:**沿用现有 kind 名**(`bash` 不改叫 `process.spawn`),新增 kind 必须**同一 commit** 给 policy 行(静默放行 / ask / never-grantable)+ ledger 文案 + 渲染器 preview 文案;R0 第一件事是写这张 `EffectClass` 目录 + 默认策略表,并用测试钉"每个 kind 都有策略行"。
3. **`permissionGuard` / `autoExecute` 已泄漏进契约层。** `shared/ipc/tools.ts:48`、`shared/ipc/chat.ts:858`、`prompts/system-prompt-snapshot.ts`、`renderer/…/SystemPromptPanel.vue`、`core/mcp/tool-definition.ts`、`core/plugins/types.ts` 都带这个字段;设置页还有 per-tool `toolSettings[id].{enabled, autoExecute}`。"概念消失"与"IPC 不变"矛盾。→ 决议:字段在 IPC/快照里**保留为投影派生值**(由 `spec.effects` 推出 `safe / sandboxed / internal-check / permission-gated / external` 五值之一,规则一处),渲染器与契约零改;用户的 `toolSettings` 作为 `Authorizer` 的输入保留(`autoExecute:false` = 该工具恒 ask,`enabled:false` = 不进 Surface)。工具作者仍然一个字都不写。
4. **外部消费方比 §7 估的多。** 生产代码里 import 工具模块的文件 ≈ 40 个(不含 tools/ 自身):external-agents host-tools(Claude Code 连接器把宿主工具做成 MCP server 给 SDK)、`tasks/dispatch`、`variables/gateways`、`triggers/skill-review`、features/self-evolution、collab 五个 app 装配壳、`apps/electron/src/main/ipc/{tools,files}.ts`、`apps/server/src/runtime.ts`、prompt snapshot、ACP permission-bridge。→ §7"三处缝"改为"三处**引擎**缝 + 一张 40 行的消费方改口清单",R3 工作量上修;"一个 commit 删旧"的前提是这 40 处全部改口。
5. **测试面是主要工时。** 24 个测试文件用 `Tool.define` / `create*Tool`,23 个引用 `ToolContext / ToolInfo / ToolResult` 类型 → ≈ 50 个测试文件要重写(比生产代码多)。→ 估算从"新写 6k / 删 13k"改为"新写 6k 生产 + ≈ 8k 测试 / 删 13k 生产 + 旧测试";R1–R3 各期的退出判据都以"对应测试已迁移"为准,不许留旧测试吊着旧路。
6. **两条绕过 Runner 的权限调用要保留端口。** ACP permission-bridge、external-agents `permission-effects.ts` 直接构造 effects 调 `enforcePermissionPolicy` —— 它们不是工具调用,不该硬塞进 Runner。→ `Authorizer.decide()` 对外也开放,这两处改成调端口即可;Codex 原生工具(provider 侧的工具名集合)只与 Surface 的 `names()` 有关,`Surface` 需接受一组"provider 追加名"。

### 10.3 修正后的分期与成本

| 期 | 变化 |
| --- | --- |
| **R0 内核** | **前置**:EffectClass 目录 + 默认策略表(10.2-②);内核加 `Interceptor` 端口(①);`Surface` 接 provider 追加名(⑥) |
| **R1 家族 + 首批** | 不变;新增"guard 派生投影"的单测(③) |
| **R2 接线** | 三处引擎缝 + `PermissionAuthorizer`(包 enforcePermissionPolicy)+ `IpcProjector`(含 guard 派生)+ `Interceptor` 实现(包两个插件拦截) |
| **R3 全量移植** | 加 40 处消费方改口清单(④);ACP / external-agents 改调 `Authorizer`(⑥);测试迁移是本期主体(⑤) |
| **R4 删旧** | 不变 |

成本:约 3–4 个迭代;R0(含前置策略表)可独立在一个迭代内做完并单独验收。**建议先做 R0**,用策略表和内核单测把 §0 的尺子③⑤先立起来,再决定 R1 之后的节奏。

## 11. R1 记录(2026-08-18):家族基类 + 首批六个工具

R1 交付 `packages/onething-runtime/src/toolkit/`:四个家族基类
(`read-only` / `file` / `mutating-file` / `process`)、六只工具
(read / write / edit / bash / time / variable)、zod → 内核的契约层,以及
60 条对拍(旧实现 vs `ToolRunner.run`,同一组夹具)。**一处未接线**;§7 的三条纪律
原样成立。

以下四条是 R1 被要求拍板的问题,每条给结论 + 依据。

### 11.1 `OutputBudget` 的默认阈值与溢出落盘目录

**依据(真实阈值,不是拍的)**

| 出处 | 行 | 字节 | 方向 | 尾注 | 溢出去哪 |
| --- | --- | --- | --- | --- | --- |
| `builtin/read.ts` `DEFAULT_LIMIT / DEFAULT_MAX_BYTES` | 2000 | 50 KB | 头部 | `[Showing lines a-b of N. Use offset=… to continue.]` | 丢弃(靠 offset 续读) |
| `output-accumulator.ts` `DEFAULT_OUTPUT_MAX_LINES / _BYTES`(bash) | 2000 | 30 000 | 尾部 | `<bash_metadata>Output truncated (…)</bash_metadata>` | `getToolOutputsDir()` 下的临时文件 |
| R0 `DEFAULT_OUTPUT_BUDGET` | 2000 | 256 KB | 头部 | `<truncation …>` | `SpillPort` |

**发现**:内核默认的 2000 行与两只工具**自己**的 2000 行是同一个数,于是内核这把尺子
恰好会剪掉工具自己加的那一行尾注 —— 而那一行正是告诉模型"怎么把剩下的拿回来"的
那句话。R1 只能逐工具开天窗(`spec.budget = { maxLines: 2000 + 48, maxBytes: 128 KB }`)。

**建议**

1. 内核默认改成**兜底**而不是同侪:`{ maxLines: 4000, maxBytes: 256 * 1024 }`。判据是
   "任何自截断的工具都必须还能加上自己的尾注",取现有最大工具级上限的 2 倍;它对
   行为良好的工具永不触发,但仍然拦得住失控的工具。字节侧 256 KB 已是最大工具级
   上限(50 KB)的 5 倍,不动。
2. `SpillPort` 在装配层接 `getToolOutputsDir()` —— 就是 bash 的累积器今天用的那个目录。
   一个目录意味着**一条清扫路径**(复用 `cleanupBackgroundJobLogs` 旁边那套),而不是
   每个工具一个。内核照旧不认识 fs。
3. 长期:等自截断的工具全部移植完,删掉工具里的截断,让 `OutputBudget` 独占这件事,
   默认值才真正变成"限制"而不是"兜底",`spec.budget` 覆盖随之变稀有。**R1 有意没做**
   —— 那会立刻破坏零 diff。

### 11.2 `spec.effects` 上界的粒度:移植 bash 时有没有被逼着声明过宽

**结论:没有。** bash 的 `plan` 只报 `bash`(资源是分类器给的命令模式)与越界时的
`external_directory`,与 §9 风险 1 的预判一致 —— 命令级,不比今天粗也不比今天细。
六只工具的静态上界分别是:read `read / external_directory / sensitive_file_read`、
write `file_write / external_directory`、edit `file_edit / file_destructive_edit /
external_directory`、bash `bash / external_directory`、time `[]`、variable
`capability_change`。每一条都是这只工具**确实**可能报出来的,没有一条是为了过检查
才写上去的。

**但要记一笔**:`spec.effects` 是一组 **kind**,表达不了资源级的上界("只碰一个文件"、
"只在工作区根内")。授权层不受影响(它读的是具体 Effect),受影响的是两个读静态列表
的地方:场景面,以及 §10.2-③ 那个 `permissionGuard` 派生投影。read 因此在目录里
"看起来"永远可能读敏感文件,尽管 99% 的调用只报 `read`。

派生表的建议(R2 落地时逐字钉住):`[]` → `safe`;只含
`read/external_directory/sensitive_file_read` → `sandboxed`;含 `bash` → `internal-check`;
含 `file_*` → `permission-gated`。**这张表有一个不能自动推的格子**:variable 今天的
`permissionGuard` 是 `safe`,但它的 `analyze` 对能力变量报 `capability_change` ——
旧值本来就与它的分析口径不一致。R2 应显式写 `capability_change` 独一份 → `safe`
以保住现状,并单独记一条待纠。

### 11.3 `Surface` 的 allowlist 与用户 `enabled:false` 的优先级

**今天的顺序**(`agent-loop/stream-runtime.ts:777` → `core/engine/agent-loop-runtime.ts:686`):
`getEnabledTools(toolSettings)`(丢掉 `enabled:false`)→ 场景隐藏表 → `planAgentLoopTools`
的 `allowedToolIds`。MCP 工具在 `planAgentLoopTools` 里同时过 `enabled !== false` 与
allowlist。

**结论:三道门是"与"关系,顺序不影响结果。** 用户在设置页关掉的工具**不会**因为某个
agent 的白名单列了它就回来。内核 `Surface.resolve` 的 allowlist → `enabled === false`
→ `visibleIn` 同样是"与",结果一致 —— 那里的先后只是求值次序,不是策略。**按旧行为定,
不改。**

**一处必须在 R2 之前拍板的分歧**:今天 `allowedToolIds` 为**空数组**等于"不限制"
(`input.allowedToolIds && input.allowedToolIds.length > 0 ? new Set(...) : null`),而内核
`Surface` 把空数组读成"一个都不给"(surface.ts 的注释就是这么写的)。两者对同一个值
给出相反的工具面。建议按内核语义收敛(空数组 = 明确的"没有工具",`undefined` = 不限制),
并在接线那一处把旧的空数组显式归一成 `undefined`。

### 11.4 `Interceptor.beforePlan` 要不要支持改 `toolId`

**结论:不要。**

依据:`core/plugins/tool-call-intercept.ts` 的裁决是三态 —— `{action:'allow'}` /
`{action:'block', reason?}` / `{action:'rewrite', input}`,其中 `input` 必须是 JSON 对象;
上下文 `PluginToolCallInterceptContext` 里的 `toolName` 是只读的,**没有任何字段能换工具**。
`tool-result-intercept.ts` 同构。装配层 `app/plugins/tool-call-intercept.ts` 只在 rewrite
之后补一次 zod 校验。所以内核现有的
`InterceptVerdict = { block?: false; input? } | { block: true; reason }` 与现状**逐字对得上**,
不缺东西。

不该开的理由(不只是"用不上"):可改的 toolId 会让审计里"到底跑了哪个工具"与场景面
"这一回合这个工具可不可见"各说各话,而且插件可以把一次调用路由到一个**不在面上**的
工具 —— 那是一次伪装成便利的提权。

两处内核裁决**丢了而现状有**的东西,R2 实现拦截器时要补回来(都不动内核协议):

1. `rewrittenBy: string[]` / `blockedBy`(是哪个插件干的)在 `InterceptVerdict` 里无处安放。
   R2 的实现应把它写进 `lifecycle:decided` 之外的审计投影,而不是塞进 verdict。
2. **语义差**:今天"改写后的参数过不了 zod"当作 **block**(fail-closed,理由里说清是校验
   失败);内核把 `beforePlan` 放在 validate 之前,同样的输入会落成 `Outcome.invalid`
   ("模型的错,重发一次可能就对了")。这两句话对模型和对事故统计都不是一回事。建议 R2
   的 Interceptor 在自己内部先校验改写结果,不合格直接返回 `{block:true, reason}`,把
   fail-closed 的措辞留在原地。

### 11.5 R1 里有意保留的偏差(不是回归,但 R2 接线前要各拍一次)

| # | 偏差 | 为什么 |
| --- | --- | --- |
| 1 | `Invocation` 没有 `workingDirectoryRoots`(只有 `cwd`/`workspaceRoot`),沙箱要的是**根列表**。R1 从 `SessionSnapshot.metadata.workingDirectoryRoots` 取 | 不改内核。R2 应升成 `Invocation` 的一等字段 |
| 2 | 六只工具都**没有**填 `spec.prompt` | 内核的 `ToolPromptContribution` 是 `{ section?, text }` 一条,表达不了 `guidelines[] / workspaceRules[] / sections[]` 三类(variable 三类都用了)。硬映射 = 静默丢信息;R1 把旧常量原样导出 |
| 3 | 模型文本的比较用"纯文本 part",不是 `Outcome.toModelText()` | canonical `Result` 把附件折进 `content`,`resultToText` 会给 file/image 补一行 `[File: …]` 占位,旧 `output` 里没有。R2 的 `IpcProjector` 必须把 content 拆回 `output` + `attachments` |
| 4 | `Outcome.invalid` 投影出的文本多一句 `Invalid tool input: ` 前缀 | 旧管线把 `formatValidationError` 的文本原样给模型。R2 决定:投影时剥掉前缀,还是接受这句话 |
| 5 | bash 取消时,已收到的部分输出**不再**塞进取消结局的文本 | 旧 bash 抛的取消错误里带着 `finalOutput`。新的走 `partial` 事件流,取消结局只说"取消了"。要核渲染器/历史重建有没有依赖那段文本 |
| 6 | bash 后台仍走 `ops.execBackground`,没走 `ctx.jobs.spawn` | 真正的 JobRegistry 是 `tools/background-jobs.ts`(注册表 + 日志 + IPC + 变量板),包成端口是 R2(§10.1)。R1 用内存假端口会造出一个和真表对不上的 job;只额外发了一条 `spawned` 事件 |
| 7 | write/edit 的头两条 `partial`/`annotate` 现在发生在文件互斥队列**内部**(旧的在外部) | 事件顺序差,内容不差。若渲染器依赖"排队前就出现卡片",R2 要把它提到 `apply()` 里、进队列之前 |
| 8 | `contract.ts` import 了 `tools/tool.ts` 的 `zodToJsonSchema` | 那是全仓唯一一处 zod → JSON Schema 转换;但 `tools/tool.ts` 在 §6 的删除清单上,R4 前要搬家 |

## 12. R2a 记录(2026-08-18):内核九个决定 + 端口实现 + 投影器

R2a 交付两样东西:内核九处拍板(改 `packages/core/toolkit/**`,同步改测试),以及
装配层 `packages/onething-runtime/src/app/toolkit/`(七个文件 + 六份测试)。
**一处未接线** —— 引擎、agent-loop、旧 registry、IPC bridge、渲染器一个字都没动;
§7 的三条纪律原样成立。R2b 是接线。

### 12.1 内核九个决定的落法

| # | 决定 | 落点 | 备注 |
| --- | --- | --- | --- |
| ① | `workingDirectoryRoots` 升为一等字段 | `core/toolkit/run-context.ts` `Invocation`;`runtime/toolkit/families/file.ts` 的 `rootsOf()` 改读它 | 空数组与 `undefined` 同义;单根回退(会话 workspaceRoot → 调用 workspaceRoot)保留。`WORKING_DIRECTORY_ROOTS_KEY` 与那条 metadata 读法**已删** |
| ② | `ToolSpec.prompt` = `CoreToolPromptContribution` | `core/toolkit/spec.ts`(`import type` 自 `core/engine/prompt-fragments.ts`);`WRITE_/EDIT_/VARIABLE_TOOL_PROMPT` 挂回各自 `spec.prompt` | 三类(guidelines / workspaceRules / sections)俱全,不再有"硬映射丢信息"的理由。类型别名 `ToolPromptContribution` 保留 |
| ③ | `invalid` 不加前缀 | `core/toolkit/outcome.ts` `toModelText` | 六份对拍改成比 `Outcome.toModelText(outcome)` 而不是 `outcome.message` |
| ④ | `aborted.partial` | `Outcome` 判别联合加 `partial?: Result`;`Outcome.aborted(reason, partial)` / `Outcome.withPartial()`;Runner 在 emit sink 里记最后一条 `partial`,`run()` 收尾时贴上 | 尾部格式 `\n\n<partial_output>\n…\n</partial_output>`(常量 `PARTIAL_OUTPUT_OPEN_TAG` / `_CLOSE_TAG`)。bash 取消对拍改成断言 `aborted.partial` |
| ⑤ | 空 allowlist 的两种读法 | 内核语义**不变**(空数组 = 零工具);新增导出 `normalizeLegacyAllowlist(list)`(`[]`/`null`/`undefined` → `undefined`)给 R2b 接线用 | 内核自己不调它。两者各一条测试 |
| ⑥ | `zodToJsonSchema` 进新树 | 复制进 `runtime/toolkit/contract.ts`(含 `jsonSchemaProperties` / `jsonSchemaRequired` 两个私有助手),并从 `runtime/toolkit` 导出 | 新树不再 import `tools/tool.ts`。**旧文件一个字未动** |
| ⑦ | `OutputBudget` 默认改兜底 | `DEFAULT_OUTPUT_BUDGET = { maxLines: 4000, maxBytes: 256 * 1024 }` | 注释写明工具自己的头/尾截断暂留(§11.1 第 3 条);新增两条测试(阈值本身、2048 行不触发) |
| ⑧ | `Interceptor` 归因 | `InterceptVerdict` 加 `rewrittenBy?` / `blockedBy?`;Runner 发**一条独立的** `lifecycle:intercepted { action, by?, reason? }` | **选独立事件而不是塞进 planned**:被 `block` 的调用根本没有 planned,把归因挂在 planned 上等于恰好在最需要它的那一次丢掉它;而且"改写"因此有了独立证据行,审计不必去 diff 两条别的事件。什么都没做的拦截器不发这条 |
| ⑨ | `Surface` 持解析时快照 | 行为本来就对(`catalog.all()` 在 `resolve` 里求值一次);补注释 + 一条测试(解析后 unregister/register,面不变) | 目录可变、面不可变 |

**九条之外还动了内核两处**,都是为了让 §12.2 的投影器不必嗅字符串,逐条列在这里:

- `Decision` 的 deny 变体加了 `byUser?: boolean` + `rejectionReason?: string`。
  旧 IPC 契约把"人按了拒绝"(`rejected: true` + `rejectionReason`)与"策略/插件挡下"
  (一条普通 error)画成两张不同的卡。没有这一位,`IpcProjector` 只能去嗅
  `reason` 的开头 —— 那正是 `core/tools/abort.ts` 头注释里禁掉的判据。
- `Job` / `JobSnapshot` 加了 `metadata?: JsonObject`(`JobSpec` 本来就有)。
  bash 的句柄文本要报 pid,而 pid 是"这台机器上的执行体"的属性,不该让内核长出一个
  认识 POSIX 的字段。

### 12.2 装配层:七个文件

| 文件 | 行 | 是什么 |
| --- | --- | --- |
| `authorizer.ts` | 197 | `PermissionAuthorizer implements Authorizer` —— 包 `enforcePermissionPolicy`(三座桥一个字不动),`PermissionRejectedError → Decision.deny`,`alwaysAsk` 的落地 |
| `guard-projection.ts` | 94 | `deriveLegacyPermissionGuard(spec, { external? })` —— `spec.effects` → 五个字符串之一 |
| `ipc-observer.ts` | 273 | 纯函数集(`metadataUpdateFromAnnotate` / `partialResultFromEvent` / `stepFromEvent` / `splitResultContent` / `executionResultFromOutcome`)+ `IpcProjector implements Observer` |
| `audit-observer.ts` | 138 | `AuditProjector implements Observer` + `combineObservers` |
| `jobs.ts` | 195 | `BackgroundJobRegistry implements JobRegistry` —— 包 `tools/background-jobs.ts` + `execBackground` |
| `catalog.ts` | 151 | 三档目录 + 四组成品适配器 |
| `runner.ts` | 111 | `createAppToolRunner()` + spill / sandbox / session 三个默认端口 |
| `index.ts` | 57 | 装配面 |

测试 6 份 / 1165 行:`guard-projection`(12)、`authorizer`(10)、`audit-observer`(6)、
`ipc-observer`(18)、`jobs`(7,真 spawn)、`runner`(6,三档目录 + 六只工具冒烟)。

### 12.3 `permissionGuard` 派生表(§10.2-③ 的那一处规则)

判定顺序自上而下,先命中先返回:

| 条件 | 派生值 | 六只工具里谁 |
| --- | --- | --- |
| 显式 `{ external: true }` | `external` | 无(远程工具,R3 的 `ExternalTool`) |
| `effects` 为空 | `safe` | time |
| 含内核不认识的 kind | `permission-gated` | 无(保守兜底) |
| 含 `file_edit` / `file_write` / `file_destructive_edit` | `permission-gated` | write、edit |
| 含 `mcp` | `permission-gated` | 无(R3) |
| 含 `session_spawn` | `permission-gated` | 无(R3) |
| 含 `capability_change` | `permission-gated` | variable、feature_mount —— 见下 |
| 含 `bash` | `internal-check` | bash |
| 含 `read` / `external_directory` / `sensitive_file_read` | `sandboxed` | read |
| 其余(`net_fetch` / `user_ask` / `session_message`) | `safe` | 无(R3 的 web_search / ask_user) |

五格逐字等于旧工具身上的那个字符串,有测试钉住;第六格(variable)在 R3a 复盘
之后**有意不同** —— 见 §12.4 第 1 条的更新。

> **R3a 复盘裁定(2026-08-18)**:`capability_change` 那一格从"为 variable 写死的
> `safe`"改成按真相派生 `permission-gated`。一个 never-grantable 的效果不可能同时
> 是 `safe`,那两句话直接互斥。

### 12.4 发现的问题 / 有意的偏离

1. **variable 那一格本来就自相矛盾。** 旧 `permissionGuard: 'safe'`,而它的
   `analyze` 对能力变量报 `capability_change`(一条 never-grantable 的效果)。R2a 在
   派生表里显式写死成 `safe` 是为了保住现状,不是因为它对。

   **R3a 复盘已结清(2026-08-18)**:派生表改成按真相给 `permission-gated`,写死的
   那一格删掉。这是**修复,不是回归** —— 判据有三条:(a) never-grantable 与 safe
   互斥;(b) 这个字符串的两个读者(`isInjectablePermissionGuard` /
   `isAutoExecutePermissionGuard`)对 `safe / sandboxed / internal-check /
   permission-gated` 四个值一视同仁(`core/tools/permission-guards.ts` 的两张 Set
   逐字相同);(c) `canAutoExecute` 今天**没有任何调用方**。执行期因此一个字不变
   (能力变量照旧走 never-grantable 的权限卡),变的只是目录里那个从来没人据以做过
   判定的标签。附带结清 feature_mount:它旧值本来就是 `permission-gated`。
2. **旧 `tools/registry.ts` 把拒绝理由拼了两遍。** `toolFailureText({ error: error.message,
   rejected: true, rejectionReason })` 里 `error.message` 已经是
   `formatPermissionRejectedMessage(reason)`,再拼一次得到
   `"… Reason: X Reason: X"`。`IpcProjector` **不复制**这个重复,只出一次
   (`authorizer.test.ts` 有一条断言钉着"Reason: 只出现一次")。
3. **取消结局的文案换人说了算。** 旧路是 `Execution cancelled by user`(信号查点)或
   工具抛出的原文;新路统一成 `Outcome.toModelText`(`Tool execution was cancelled.`
   + 决定④ 的 `<partial_output>` 尾巴)。措辞由内核一处说了算,已收到的输出不丢。
4. **core `Permission` 没有"强制询问"的入口。** `decidePermission` 的放行判据是
   「kind 是 read / 被 capability 覆盖 / 命中 grant」,没有一条能被外部一票否决。
   `alwaysAsk` 因此落成一条合成效果 `tool_manual_approval`,**资源是
   `<toolId>#<callId>`**(每次调用都不一样,所以永远匹配不到已存 grant;用户即使选
   "总是允许",记下的 grant 也绑在一次性资源上,下次照样问)。它只在预判"这一组效果
   本来不会问人"时才追加,否则一次 bash 调用会弹两张卡。
   `dangerously-allow-all` 下这条效果照样被放行 —— 用户的两句话冲突时更宽的那句赢,
   与旧行为一致。
5. **`progress` / `spawned` 在旧 IPC 契约里没有出口。** `IpcProjector` 静默略过它们,
   不硬塞进 `metadata`:塞进去等于给渲染器发明一个它没约定过的字段。它们由别的投影器
   (状态栏、后台 job 表)消费。
6. **`AuditProjector` 必须按 callId 攒。** 一个 Observer 实例会被同一回合里并行跑着的
   多个工具共用(`ToolExecutionScheduler` 的 parallel 档),单字段会让两次调用的证词
   互相覆盖。
7. **`BackgroundJobRegistry` 要自己存一份 owner。** `BackgroundJob` 只有 `sessionId`,
   没有 `toolCallId`(它诞生时还没有"工具调用"这个概念),而归属是内核 `Job` 协议的
   一部分。进程里别处起的后台任务(旧 bash 路径、CLI)被 `get`/`list` 领养时,
   `toolCallId` 如实填空串而不是编一个。
8. **`JobEvent` 分不出 stdout / stderr。** `execBackground` 把两条管子 pipe 进同一个
   日志文件,所以 `events()` 一律报 `stdout`,不编一个分不出来的区分。
9. **R1 的 bash 后台改走 `ctx.jobs.spawn`**(§11.5 偏差 6 结清)。返回文本与旧 bash
   逐字一致;pid 走 `job.metadata.pid`。产品层的对拍用一个包着同一个假执行器的
   `JobRegistry`(比的仍是工具壳),真注册表 + 真 spawn 的测试住在装配层。
10. **`SandboxPolicy` 端口在 R1 六只工具上是空转的。** `FileTool` 持有自己那组按会话
    解析的 adapters(沙箱根是 per-space 的,而端口签名里没有会话)。端口仍然装上,给
    R3 那批没有会话语境的工具用,判据是同一批函数。

### 12.5 R2b 的准确改动点(读出来,本期未改)

三处引擎缝 + 一个开关(`ONETHING_TOOLKIT=1`,内部 flag,不进设置页):

**缝 1 —— 工具面(`Surface.schemas()` 取代三处口径拼装)**
- `packages/onething-runtime/src/agent-loop/stream-runtime.ts:773-799` ——
  `resolveSceneHiddenToolIds` → `getEnabledTools(toolSettings.tools)` → `planAgentLoopTools({ allowedToolIds })`。
  开关打开时整段换成 `Surface.resolve({ catalog, scene, allowlist: normalizeLegacyAllowlist(agentToolAllowlist), settings })`。
- `packages/core/engine/agent-loop-runtime.ts:686-715`(`planAgentLoopTools`)——
  **:703-704 就是空数组歧义的那一行**(`allowedToolIds.length > 0 ? new Set(...) : null`)。
  R2b 在调用侧过 `normalizeLegacyAllowlist`,这一行本身不动。
- `packages/core/engine/agent-loop-runtime.ts:740-762`
  (`buildAgentLoopDirectToolsWithAdapters` → `agentToolsFromToolDefinitions`)——
  `Surface.toAgentTools(runner)` 的对位点;`AgentTool.executionMode` 由 `spec.concurrency` 喂。

**缝 2 —— 执行函数(`runner.run` 取代 `executeToolDirectly`)**
- `packages/core/agent-loop/runner.ts:326-341` —— `tool.execute(args, ctx)` 与那两个回调
  (`onMetadata` / `onPartialResult`)的构造点。
- `packages/core/agent-loop/runner.ts:397-407` —— `ToolExecutionScheduler` 的 barrier
  (`toolsByName.get(name)?.executionMode !== 'parallel'`)。**这一处不动**:`spec.concurrency`
  投影成 `executionMode` 即可。
- `packages/onething-runtime/src/app/engine/stream/agent-loop-runtime.ts:205-210` ——
  装配层把 `executeToolDirectly` 递进 core 的那一处,开关在这里最省事。
- 其余三个 `executeToolDirectly` 内部调用点(§10.1 说的"只有 4 个"):
  `packages/core/engine/agent-loop-runtime.ts:745`、
  `packages/core/engine/tool-orchestration.ts:966`、
  `packages/onething-runtime/src/agent-loop/stream-runtime.ts:929`
  (`executeToolDirectlyWithFreshSession`,:914-935)。

**缝 3 —— 事件源(`IpcObserver` 取代三层回调转发)**
- `packages/onething-runtime/src/app/engine/stream/tool-execution.ts:42-102` ——
  `executeToolDirectly` 的四个回调字段(:54-58)与两条插件拦截链(:84-98)。
  R2b:回调集 → `new IpcProjector(callbacks)`;两条拦截链 → 一个 `Interceptor` 实现
  (§11.4 第 2 条:改写结果的 zod 校验放在拦截器**内部**,不合格返回
  `{ block: true, reason }`,把 fail-closed 的措辞留在原地)。
- `packages/onething-runtime/src/app/engine/stream/tool-execution.ts:161-162` ——
  第二个 `executeToolDirectly` 递归入口(sub-agent)。
- `apps/electron/src/main/bridges/ipc-bridge.ts` / `apps/server/src/http.ts` ——
  **不动**:它们消费的是 EventBus 上的 `session:event` / `session:stream`,
  `IpcProjector` 的产出与今天逐字同形。

R2b 还需要的两件小事:`AuditProjector` 的 sink 接 `app/session/events`(events.jsonl),
以及 `deriveLegacyPermissionGuard` 接到目录投影(`shared/ipc/tools.ts` 的
`ToolDefinition.permissionGuard`、提示词快照、设置页)。

## 13. R3a 记录(2026-08-18):其余全部内置工具 + 插件/MCP 适配 + 场景解析

R3a 交付三样东西,**一处未接线** —— 引擎、agent-loop、旧 registry、IPC bridge、
渲染器一个字都没动,§7 的三条纪律原样成立(R2b 才是接线):

1. **五个家族基类补齐**(`runtime/toolkit/families/`):`network` / `collab` /
   `interactive` / `session` / `capability` / `external`(§4 的表因此十族全到);
2. **十四只内置工具移植完**(产品层十一只 + 装配层三只 `feature_*`),加上
   `PluginTool` / `McpTool` —— 注册表里从此只有一种工具(尺子⑥);
3. **场景解析** `runtime/toolkit/scene.ts`:`resolveScene(session, skills) → Scene`,
   与旧 `tools/scene-surface.ts` 的减法表**逐组等价**(12 组夹具,有测试)。

### 13.1 家族表的最终形态

| 家族 | 行 | 这一族每个成员都做的事 | 成员 |
| --- | --- | --- | --- |
| `ReadOnlyTool` | 29 | plan = `Intent.none` | time / practice / radio |
| `FileTool` | 218 | 路径解析 + 定性 → 效果 | read |
| `MutatingFileTool` | 178 | diff 预览 + 互斥队列 + 审计 | write / edit |
| `ProcessTool` | 281 | 命令级分类 / 前台流 / 后台分离 | bash |
| `NetworkTool` | 64 | plan 报 `net_fetch`;fetch 走 `abort.child({timeoutMs})` | web_search / web_open |
| `CollabTool` | 143 | 场子门(两个面)+ actor 解析(principal 优先) | send_message / board / history / notebook |
| `InteractiveTool` | 86 | `user_ask` 效果 + 题面预览 + `onAbort` 撤回 + 四态不 throw | ask_user |
| `SessionTool` | 47 | plan 的形状 + 场景面接口 | task / goal |
| `CapabilityTool` | 59 | `requiredSkill` 场景门;`capability_change` 口径 | feature_mount / unmount / inspect |
| `ExternalTool` | 363 | 超时子作用域 + 成败上报(断路器的输入) | PluginTool / McpTool |

`variable` 仍然直接继承 `Tool`(R1 的判断不变:它跨 `ReadOnlyTool` 与
`CapabilityTool` 两族,给它单开一族只会长成它自己的形状)。

**两层封顶**这条规则在 R3a 没有被破:十族全部是 `Tool` 的直接子类,
`MutatingFileTool` 是唯一一处三层(`Tool → FileTool → MutatingFileTool`),那是 R1
就定下的、文件族内部的模板方法。

### 13.2 二十只工具的 `spec.effects` 上界

| 工具 | 家族 | `spec.effects` | 旧 `permissionGuard` | 派生值 | 行 |
| --- | --- | --- | --- | --- | --- |
| read | File | `read / external_directory / sensitive_file_read` | sandboxed | sandboxed | 166 |
| write | MutatingFile | `file_write / external_directory` | permission-gated | permission-gated | 201 |
| edit | MutatingFile | `file_edit / file_destructive_edit / external_directory` | permission-gated | permission-gated | 229 |
| bash | Process | `bash / external_directory` | internal-check | internal-check | 197 |
| time | ReadOnly | `[]` | safe | safe | 88 |
| variable | (Tool) | `capability_change` | safe | **permission-gated** | 221 |
| web_search | Network | `net_fetch` | safe | safe | 411 |
| web_open | Network | `net_fetch` | safe | safe | 210 |
| goal | Session | `[]` | safe | safe | 196 |
| practice | ReadOnly | `[]` | safe | safe | 165 |
| radio | ReadOnly | `[]` | safe | safe | 152 |
| task | Session | `session_spawn`(策略 `silent`) | safe | permission-gated | 167 |
| ask_user | Interactive | `user_ask` | safe | safe | 244 |
| send_message | Collab | `session_message` | safe | safe | 209 |
| board | Collab | `[]` | safe | safe | 222 |
| history | Collab | `[]` | safe | safe | 201 |
| notebook | Collab | `[]` | safe | safe | 108 |
| feature_mount | Capability | `capability_change` | permission-gated | permission-gated | 219 |
| feature_unmount | Capability | `[]` | safe | safe | 126 |
| feature_inspect | Capability | `[]` | safe | safe | 121 |
| PluginTool | External | `plugin_exec` | permission-gated(写死) | permission-gated | (363 共用) |
| McpTool | External | `mcp` | permission-gated | permission-gated | (363 共用) |

**没有一条上界是为了过检查才写上去的。** 四个协作工具里只有 `send_message` 报效果
(只有它真的把东西送出去);board / history / notebook / goal / practice / radio 的
旧实现根本没有 `analyze`,权限层今天看到的就是空的,所以新树也报空 —— 给它们发明一个
`collab_board_write` 会是 D3 第一条禁止的「功能形状的洞」。

**「报效果」≠「弹卡」。** `session_spawn`(task)与 `net_fetch` / `user_ask` /
`session_message` 在策略表里都是 `silent`:它们进审计、进屏障判定,但不惊动人。
派生 guard 那一列答的是另一个问题(旧目录里的档位),两列不同档不是矛盾 ——
`task` 就是这样:`silent` 的策略 + `permission-gated` 的标签,而那个标签的两个读者
对四个值一视同仁,所以行为与旧路逐字相同。

### 13.3 新增的 effect kind:一条

| kind | policy | barrier | 权限卡文案 | 派生 guard | 为什么必须新增 |
| --- | --- | --- | --- | --- | --- |
| `plugin_exec` | ask | true | `Run plugin tool` | permission-gated | 旧路把「插件工具恒 permission-gated」写死在 `app/plugins/api.ts` 的一行里(插件不能给自己发免检通行证)。新树里 guard 是**派生值**,所以那句话必须由一条效果说出来。不复用 `mcp`:那会在权限账本与卡片文案里把一个插件写成一台 MCP 服务器,而账本是要被人读的 |

同一批改动里给全了 §10.2-② 要求的三样:策略行(`core/toolkit/effects.ts`)、
派生表那一格(`app/toolkit/guard-projection.ts`)、以及钉住两者的测试。
`session_spawn` / `net_fetch` / `user_ask` / `session_message` 是 R0 就定下的,
R3a 只是第一次真的有工具报它们。

`core/toolkit/spec.ts` 的 `Scene` 加了三格:`venue` / `goalActive` / `taskSession`
—— 都是**已经归一化过的结论**,内核仍然不枚举产品有哪些形态。

### 13.4 对拍:数量与差异

新增对拍 **9 个文件 / 1835 行 / 188 条**(R1 的 6 份 60 条之外):

| 文件 | 条 | 覆盖 |
| --- | --- | --- |
| `parity/web.test.ts` | 14 | web_search / web_open |
| `parity/session-tools.test.ts` | 24 | goal / task |
| `parity/life.test.ts` | 19 | practice / radio |
| `parity/ask-user.test.ts` | 9 | ask_user |
| `parity/collab.test.ts` | 56 | send_message / board / history / notebook + 场子门 4×4 |
| `parity/external.test.ts` | 22 | PluginTool / McpTool |
| `scene.test.ts` | 15 | 场景解析等价 |
| `app/toolkit/catalog-tiers.test.ts` | 8 | 三档目录等价 + feature 门 |
| `app/toolkit/feature-tools.test.ts` | 21 | feature_mount / unmount / inspect |

每只工具至少四组(正常 / 边界 / 错误 / 取消或场景门拒绝),比的是:模型文本、
权限输入(effects + preview)、错误文案、渲染信息(annotate 的 title/details vs 旧
`ToolResult.title` + `metadata`)。

**差异,逐条**(R3a 复盘裁定之后,**没有一条是用户可见的行为变化**):

| # | 差异 | 影响面 | 裁定 |
| --- | --- | --- | --- |
| 1 | **task 报 `session_spawn`**(旧路无效果) | 无 —— 那条 kind 的策略是 `silent`,不弹卡 | **已定**:派工的本义就是"派出去继续干",风险由并发上限与子会话自己的权限卡兜住;效果保留(且仍是屏障)是为了审计里那条证词 |
| 2 | **variable 的派生 guard 从 `safe` 变成 `permission-gated`**(§12.4 第 1 条) | 无 —— 旧值是旧树 bug;两个读者对四个值一视同仁,`canAutoExecute` 无调用方 | **已定**:按真相派生,这是修复不是回归。feature_mount 因此与旧值 `permission-gated` 重新对齐,不再有偏差 |
| 3 | **ask_user 的「回合被中止」从一条正常工具结果变成 `Outcome.aborted`** | 无实际差别 —— 取消信号即整回合中止,那条工具结果不会再进入任何一次模型请求 | **已定**:维持内核统一措辞,**不加 partial**。为一条模型看不到的文本再造一条 partial 通路,只会让"取消"这件事又多一种写法(正是尺子③ 要消灭的) |
| 4 | `details` 过一次 `toJsonObject`,`undefined` 值的键被丢掉 | 无(IPC 序列化后逐字相同) | 归一化,不需要拍板 |
| 5 | 抓页的 `fetchMs` 是墙钟的函数,两次调用本来就不等 | 无 | 不需要 |
| 6 | 协作四工具的 actor 解析从「四份手写的 `session.agentId` 反查」收成一处,且 **principal 优先** | 无(principal 不是 agent 时逐字回退到旧判据) | 不需要 |
| 7 | board 的场子门从适配层的 `resolveContext` 提到 `CollabTool`,适配层只剩「这条会话挂着哪间房」 | 无(等价重构,九组夹具钉住) | 不需要 |

**没有差异**的地方也记一笔:send_message / history / notebook 的拒绝文案仍然由各自的
执行器给(那几句话是精心写过的可操作措辞,合并成一句通用的"场子不对"会让模型不知道
下一步能做什么);`plan` 阶段只判 `allowed` 这一位,文案不动。

### 13.5 三档目录

`app/toolkit/catalog.ts` 的三档与旧三个 barrel **id 集合逐一相等**
(`catalog-tiers.test.ts` 把旧 barrel 的 `registerTool` mock 成收集器直接比):

- full = 17(bash / edit / read / write / variable / radio / practice / task /
  ask_user / time / web_search / web_open / goal / board / history / notebook /
  send_message)
- headless = 11(去掉 radio / practice / task / ask_user / goal / notebook)
- readonly = 4(read / time / web_search / web_open)

`feature_*` **不在任何一档里** —— 旧树里它们也不在那三个 barrel 里(由
self-evolution feature 自己注册,吃自己狗粮)。新树给它们一个独立入口
`registerFeatureTools(catalog, runtime)`,宿主档门保留且**默认拒绝**:目录里没有
`bash` 就一个字都不注册(判据同旧 `hasTool('bash')`,readonly 档因此天然拿不到)。

### 13.6 发现的旧 bug / 值得记的事

1. **`buildMCPPermissionPlan` 那一族住在 §6 的删除清单里。** R3a 按 R2a 决定⑥ 的
   同一条理由把 30 行纯函数复制进新树(`families/external.ts`),并写了一条**逐组
   比对**的测试(`external.test.ts`)保证两份不分家。旧文件一个字未动。
2. **`PluginToolAdapters.execute` 的签名**第一版把 args 折进了 ctx,与
   `executeCorePluginTool(tool, args, hostContext)` 不同形 —— 对拍当场把它照出来了。
   这是"对拍比测试更早发现设计问题"的一个真实样本。
3. **今天插件工具与 MCP 工具都没有工具级超时,也没有断路器。** `ExternalTool` 把
   端口装上了(`isolation.timeoutMs` / `reporter`),但**默认不设超时** —— 凭空加一个
   会让一批本来跑得完的调用开始失败。裁定见 §13.7 第 4 条:R2b 注入**既有**的两套
   (`core/plugins/policy.ts` 的 scope 家族 + MCP client 自己的超时),不发明数字。
4. **`radio` 会让音响响起来,而本仓的权限系统认不出这类效果。** R3a 按"不过宽"的
   原则报空,记在这里:如果将来要给"改变外部世界状态但不碰文件/进程/网络"的动作
   一个 kind,radio 是第一个候选。
5. **`app/collab/actors/notebook-tool.ts` 的 `appendNote` 没有导出**,所以新树的
   适配器重建了那 15 行(两句拒绝文案 import 自原处,不复制)。R4 删旧树时这一处会
   自然收敛。

### 13.7 R3a 复盘的六条裁定 + 唯一剩下的一件事

前三条已经落进代码(§13.4 差异表同步更新),后三条是 R2b 接线的口径,写死在这里
免得那一天再论一次:

| # | 事项 | 裁定 |
| --- | --- | --- |
| 1 | task 的 `session_spawn` 要不要弹卡 | **不弹**。`session_spawn` 策略改 `silent`,barrier 保持 true。派工的本义是"派出去继续干",风险由并发上限与子会话自身的权限卡兜住;效果保留是为了审计可见 |
| 2 | `capability_change` → guard 的那一格 | **按真相派生 `permission-gated`**,删掉为 variable 写死的那格。variable 旧的 `safe` 是旧树 bug;修复不是回归,无行为影响(§12.4 第 1 条的三条判据) |
| 3 | ask_user 的取消措辞 | **维持内核统一措辞,不加 partial**。取消信号即整回合中止,那条工具结果不会再进入任何一次模型请求 —— 模型看不到差别,而多一条 partial 通路就是给"取消"又添一种写法 |
| 4 | `ExternalTool` 的超时与断路器 | ~~R2b 注入既有的两套~~ → **R3b 改口(2026-08-18):插件工具执行不进断路器**,与旧路逐字相同;`ExternalTool` 的 `reporter` 端口留在原地但**无人注入**,`isolation.timeoutMs` 保持"不给就不设";MCP 侧沿用 MCP client 自己的超时。改口的两条理由见 §15.2 |
| 5 | `McpTool` 的目录生命周期 | **连接建立时 `catalog.register` + `ensurePrepared`,断开时 `unregister`**,挂点在 `app/mcp/capabilities-changed.ts`(它已经是"服务器工具面变了"的唯一通知点)。R3a 的 `Catalog.unregister` 会一并清掉 prepare 记录,所以重连拿到的是新实例、新 schema |
| 6 | `say` / `dm` 的退役名 | **沿用 core agent-loop runner 的 `registerRetiredAgentToolName`,`Surface` 不加别名面**。别名是"模型叫错了名字"的兜底,不是工具面的一部分;把它搬进 `Surface` 等于让退役名重新变成一个可见的工具身份,而当初留别名的全部意义就是模型看不见它 |

**唯一剩下的一件事:40 处消费方改口清单**(§10.2-④)—— R3b 的主体。R3a 一处未动。

## 14. R2b 记录(2026-08-18):三处引擎缝 + 内部开关

R2b 把 R0–R3a 建好的新树**接上**。纪律照 §7:开关(`ONETHING_TOOLKIT=1`)默认关,
旧路一行不删不改格式,每处缝都是一段 `if (isToolkitEnabled()) { … }` 的最小插入。
渲染器 / `@shared` / `apps/electron` / `apps/server` 的 HTTP 面**一个字都没动**。

### 14.1 开关

`packages/onething-runtime/src/toolkit/flag.ts` —— `isToolkitEnabled()` 读
`process.env.ONETHING_TOOLKIT === '1'`,每次现读不缓存(测试要能在一个进程里翻它)。
所有接线点只认这一个函数。

它有一条**窄别名** `@onething/runtime/toolkit/flag`(`onething.aliases.ts`,按规矩放在
`@onething/runtime/toolkit` 之上 —— 前缀匹配先命中先用):引擎缝只想读一个环境变量,
不该为此把整棵新工具树拖进一条开关关着的执行路。

### 14.2 每处缝的精确落点

| 缝 | 文件 | 插入 | 形状 |
| --- | --- | --- | --- |
| 1 工具面 | `packages/onething-runtime/src/agent-loop/stream-runtime.ts` | import +7 行(:73-79);`planAgentLoopTools` 之前 +30 行(:801-830);**改 1 行**(`allEnabledTools:` 那一格的表达式) | `resolveToolkitSurface(...)` → `toolkitAgentSourceTools(...)` → 原样喂给 `planAgentLoopTools` |
| 2 执行函数 | `packages/onething-runtime/src/app/engine/stream/tool-execution.ts` | import +2 行(:30-31);函数体最前 +17 行(:64-80) | `if (isToolkitEnabled()) { const {runToolkitToolDirectly} = await import(...); const r = await runToolkitToolDirectly(...); if (r) return r }` |
| 3 事件源 | 同上(那 17 行内) | 0 额外行 | 四个回调 → `new IpcProjector(callbacks)`;两条插件拦截链 → 一个 `Interceptor` |
| 4 目录 | `packages/onething-runtime/src/app/backend.ts` | import +16 行(:59-73,含一条**静态排序边**,见 14.2.1);三档 if/else 之后 +12 行 | 开关开时 `buildToolkitCatalog(tier)` + 挂 MCP 通知点 |

#### 14.2.1 缝 4 的静态排序边(真机抓到的必修 bug)

第一版把缝 4 写成 `await import('./toolkit/wiring.js')`。**apps/server 的单文件包
(vite SSR `inlineDynamicImports`)下 `ONETHING_TOOLKIT=1` 启动即崩**:

```
const { buildToolkitCatalog, refreshToolkitMcpTools } = await Promise.resolve().then(() => wiring);
ReferenceError: Cannot access 'wiring' before initialization
```

内联之后动态 import 变成一个对模块常量 `wiring` 的引用,而打包器按**静态**图排序 ——
只被动态引用的 wiring 被排在了 `createOnethingBackend` 的顶层 await **之后**。

这与 CLAUDE.md「createOnethingBackend」一节记的是**同一个坑**:`backend.ts` 为
`./tools/builtin/{index,headless,readonly}.js` 保留静态 import 边,正是为了让单文件
打包器把它们排在工厂的 top-level await 之前。

修法照那条先例:`backend.ts` 顶部改成**具名静态 import**
`import { buildToolkitCatalog, refreshToolkitMcpTools } from './toolkit/wiring.js'`,
函数体里的动态 import 删掉。

**为什么是具名 import 而不是一条裸的 `import './toolkit/wiring.js'`**:wiring 的
import 是无副作用的(`import-side-effect-free` 那道栅栏对它同样成立),而一条无副作用
的裸 import **会被 Rollup 直接摇掉**,排序边也就跟着没了。具名绑定被真正用到,摇不掉。
代价:新树在单文件包里恒定被打进去 —— 但它本来就在(动态 import 也是同一张图),
真正的"开关关就零开销"是**一个函数都不会被调到**,不是模块不进包。

`app/engine/stream/tool-execution.ts` 那条 `await import('../../toolkit/wiring.js')`
**保留**,实测安全:修好之后的包里 `const wiring = …` 落在 84055 行,而那条引用
(`() => wiring`)在 `executeToolDirectly` 的**函数体内**(64046 行,函数声明在 64044),
只有请求进来才求值 —— 那时整张模块图早已求值完(入口的顶层 await 在 93425 行)。
`mcp-catalog.ts` / `audit-sink.ts` 由 wiring 静态引入,顺序随之解决。

**Electron 包不受这条影响**(核实过,不是推测):`out/main/chunks/backend-*.js` 里
`buildToolkitCatalog` 是一条**函数声明**(64447 行,会提升),`createOnethingBackend`
在 65793 行;`const wiring` 在 64598 行,而唯一引用它的那行在
`executeToolDirectly` 的函数体内(48073,函数从 48071 起)。两处都不构成 TDZ。
单文件包会犯而分块包不会,原因就是前者把整张图压成一条线性求值序列。

**缝 2 为什么只有一处插入。** §12.5 列了四个 `executeToolDirectly` 内部调用点
(`core/engine/agent-loop-runtime.ts:745`、`core/engine/tool-orchestration.ts:966`、
`agent-loop/stream-runtime.ts` 的 `executeToolDirectlyWithFreshSession`、
`app/engine/stream/tool-execution.ts` 的 sub-agent 递归)。**核实结果:四处全部经由
装配层那一个 `executeToolDirectly`**(core 侧收的是 `options.executeToolDirectly`,
装配层在 `app/engine/stream/agent-loop-runtime.ts:205-210` 把同一个函数递进去;
`tool-execution.ts:161-162` 的递归入口也是它)。所以 core 的 `agent-loop/runner.ts`、
`engine/tool-orchestration.ts`、`engine/agent-loop-runtime.ts` **一个字都不用动** ——
`ToolExecutionScheduler` 的 barrier 也不用动,`spec.concurrency` 经
`AgentSourceToolDefinition.executionMode` 投影过去就是它要的那一位。

其余四处小接线:

- `app/toolkit/wiring.ts`(新,~230 行)—— 目录 / 拦截器 / `runToolkitToolDirectly` 三件事。
- `app/toolkit/mcp-catalog.ts`(新,~110 行)—— `McpTool` 进目录,幂等 diff 同步;
  `app/mcp/capabilities-changed.ts` 加了**第二个** handler 槽(不顶掉宿主那个,+15 行)。
- `app/toolkit/audit-sink.ts`(新)—— `AuditProjector` → `events.jsonl`。
- `app/tools/toolkit-guard.ts`(新)+ `app/tools/registry.ts`(+3 行)——
  `getAllTools*` 的 `permissionGuard` 改读派生表。**读点一个字未动**
  (`tools/tool-list-presentation.ts` / `prompts/system-prompt-snapshot.ts` / 设置页)。
  投影住在单独文件里,因为 boundary checker 盯着 registry 门面的行数(≤180)。

### 14.3 测试结果

| 场景 | 结果 |
| --- | --- |
| 开关**关**,全量 `npx vitest run` | 1132 passed / 1 failed / 3 skipped。唯一失败 = `packages/renderer/styles/__tests__/ui-token-vars.test.ts`,**接线前的基线里就是它**(基线 1131 passed / 同一个文件失败),与本期无关 |
| 开关**开**,全量 `ONETHING_TOOLKIT=1 npx vitest run` | 同上,逐字相同 |
| 开关**开**,验收范围(app/engine、agent-loop、app/agent-loop、app/tools、tools、两棵 toolkit、core/toolkit、apps/server) | 185 files / 全绿 |
| `npx tsc --noEmit -p tsconfig.node.json` | 无新增错误(既有两处与本期无关:`spaces/__tests__/provider-dials.test.ts`、`electron.vite.config.ts` 的 TS6307) |
| `node scripts/boundary-gate.mjs` | ok —— 13 known,none new |
| `bun run server:build` + 单文件包真跑(开关开 / 关两次) | 都能起,`/api/sessions` 200,日志 `ReferenceError` 计数 0(修好 14.2.1 之后) |
| `bun run build:check` | 通过 |
| `app/__tests__/import-side-effect-free.test.ts` | 绿 |
| 新增 `app/toolkit/__tests__/wiring.test.ts` | 13 条全绿 |

**一条要记的观察**:既有的引擎/agent-loop 测试在开关开时**全绿,但大多没有真的走进
新树** —— 它们要么 mock 掉 `tool-execution.js`,要么没配目录(`configureToolkitCatalog`
没被调过且 `buildToolkitCatalog` 没跑)。所以"开关开全绿"证明的是**没有回归**,不是
"新路被覆盖了"。真正的接线证据是 `wiring.test.ts`:它调的是未 mock 的
`executeToolDirectly`,覆盖 write/read/bash 的结果与回调同形、权限批准/拒绝两路、
bash 取消(`aborted` + `<partial_output>`)、插件 block/rewrite 两路、假 bridge 的 MCP
一条、审计落进 `events.jsonl`、以及缝 1 的 `Surface → planAgentLoopTools` 名字一致。

### 14.4 有意的差异 / 本期发现的问题

1. **审计是一行,不是三行。** 任务书要求 lifecycle 三态各写一条;`AuditProjector` 的
   形状是"按 callId 攒,在 `finished` 吐一条扁平记录"。保留一行的理由:三行要给 E0
   那张**被明确关起来的**事件表撑开三格,而三行说的是同样三件事。代价说清楚:
   **planned / decided 各自的时刻拿不回来**(只剩 finished 的时刻)。新增的事件类型
   只有一个:`tool/audit`(`sessions/session-events.ts`),开关关时一行都不写。
2. **`beforeSideEffect` 的触发面按旧路逐字保留。** 旧路里它由**工具自己**在动手前调
   (只有 edit / write / bash 三只),外加 MCP 分支在权限通过后调一次。新路里它落成
   授权者的一个装饰器(plan/apply 之间那道缝天然就是"权限通过之后"),但**只对这三只
   + 报了效果的 MCP 调用**触发 —— 一视同仁地调会给渲染器凭空多发几条状态更新
   (read / time / variable 旧路从不调它)。
3. **插件 `replace` 成功态的 `data` 换了包装。** 旧路 `{...result, data: verdict.content}`
   把 `data` 顶成一个**裸字符串**;canonical `Result` 里没有"裸值"这个形状,所以新路
   投影出来的是 `{ title, output: content, metadata: {} }`。给模型看的文本一模一样。
   不为它在内核里开特例:那等于让一条插件改写路径长出自己的结果形状。
4. **目录里没有的工具原样退回旧路。** R2b 的目录 = 内置 17 只 + `feature_*` +
   同步进来的 MCP。**插件工具仍走旧路** —— 它们由 `app/plugins/api.ts` 注册进旧
   registry,而那个文件不在本期的可改清单里。这是 R3b「40 处消费方改口」要收的口子。
5. **MCP 的模型面没有改口径。** `McpTool` 只进目录(答"谁来跑它"),模型看到的 MCP
   工具面仍由 `planAgentLoopTools` 的 `mcpTools` 那一支算(flat/router 互斥、enabled
   过滤都在那里),MCP 名字只作为 `extraNames` 进 `Surface.names()`。于是开关翻开时
   模型看到的 MCP 面逐字不变。目录同步是**幂等 diff**,两个触发点(每次执行前现同步、
   `capabilities-changed` 通知)进同一个函数。
6. **`resolveSceneHiddenToolIds` 与 `getEnabledTools` 在开关开时仍会跑一遍**(结果被
   丢弃)。留着是因为不改旧行;R4 删旧树时它们自然消失。
7. **工具面的次序可能变。** 旧路的 `allEnabledTools` 来自旧 registry 的注册次序,新路
   来自目录的注册次序。id 集合相同(`catalog-tiers.test.ts` 逐一比过),模型工具名
   逐字相同,变的只是提示词里那张工具清单的排列次序。
8. **单文件包的模块排序是一条真闸,不是理论风险。** 见 14.2.1:动态 import 在
   `inlineDynamicImports` 下会退化成一个受静态排序支配的模块常量引用,而
   `createOnethingBackend` 的顶层 await 恰好在那之前。**判据不是"我用的是动态
   import 所以不影响启动",而是"这一条边在静态图里排在工厂之前没有"。** 顺带一条:
   无副作用模块的裸 import 会被摇掉,排序边必须由**被用到的具名绑定**扛。
9. **`app/tools/registry.ts` 有一条 180 行的硬约束**(boundary checker 的
   "tool registry facade must stay thin")。第一版把派生投影写进 registry 直接把它顶到
   220 行、gate 报了一条 NEW —— 这是那条棘轮**第一次真的拦下东西**,记一笔。

### 14.5 R3b / R4 之前必须定的事

1. **插件工具进不进目录。** 进 = 改 `app/plugins/api.ts` 让它注册 `PluginTool`,插件
   工具从此也吃两阶段 + 统一取消 + 统一截断;不进 = R4 删不掉旧 registry。R3b 的第一
   件事。
2. **旧路的三处口径什么时候删。** `resolveSceneHiddenToolIds`(减法表)、
   `getEnabledTools` 的 enabled 过滤、`planAgentLoopTools` 的 allowlist —— 开关翻死之前
   它们必须还在,翻死之后它们是三处死码。
3. **`tool/audit` 要不要拆成三行。** 见 14.4-1:拆了才有 planned / decided 的时刻。
4. **`permissionGuard` 派生值的两个读者要不要一起退役**
   (`isInjectablePermissionGuard` / `isAutoExecutePermissionGuard`,后者的
   `canAutoExecute` 至今无调用方)。
5. **`ONETHING_TOOLKIT_TIER` 这个兜底环境变量**(目录没被 backend 建过时的懒建档位)
   在 R4 一起删 —— 它只为切换期存在。

### 14.6 真机自举(交给用户;本期未做)

```bash
# 桌面(full 档):
ONETHING_TOOLKIT=1 bun run dev:electron

# 无头服务端 —— **这条是打包回归的门**(14.2.1 那个 TDZ 只在打出来的单文件包里犯):
bun run server:build \
  && STORE=$(mktemp -d) \
  && ONETHING_TOOLKIT=1 ONETHING_STORE_PATH=$STORE ONETHING_SERVER_PORT=18788 node dist/server/main.js
# 起来后另开一个终端:curl -s http://127.0.0.1:18788/api/sessions  → {"success":true,...}
#   (注意没有 /api/health 这条路由,它恒 404 —— 用 /api/sessions 判活)
# 日志里 grep -c ReferenceError 必须是 0;再用 ONETHING_TOOLKIT=0 跑一遍对照。
# 降级档再加 ONETHING_SERVER_TOOLS=readonly。

# Electron 包(electron-vite 也可能内联,同样要过):
bun run build:check
```

检查清单(逐条都能在界面上看见,不需要读日志):

1. **工具面**:随便问一句需要工具的话,模型调得到 `read` / `bash`;设置页关掉某只
   工具后它当回合就消失;配了 allowlist 的 agent 只看得见白名单里的。
2. **卡片与流**:`bash` 的输出实时刷新(partial),`write` / `edit` 的卡片有标题与
   diff(annotate → metadata),`read` 的结果正常渲染。
3. **权限**:`edit` 一个新文件弹卡;点"允许"后卡片翻成执行中并写盘;点"拒绝"并填
   理由,模型收到的那句话里理由**只出现一次**(旧路会拼两遍)。
4. **取消**:跑一条 `sleep 30`,按停止 —— 结果是取消而不是失败,且已经收到的输出
   出现在 `<partial_output>` 里。
5. **MCP**:接一台 MCP 服务器,调一次它的工具;断开再连,工具面跟着变。
6. **审计**:`~/.onething/sessions/<会话 id>/events.jsonl` 里出现 `tool/audit` 行,
   每次工具调用一条,`effects` / `decision` / `outcome` 三格都有值。
7. **设置页**:工具列表里 `read` 显示 `sandboxed`、`write` / `edit` 显示
   `permission-gated`、`bash` 显示 `internal-check`、`variable` 显示
   **`permission-gated`**(§13.7 裁定 2 的那一格,与开关关时不同,是有意的)。
8. **插件**:装一个带工具的插件,确认它照旧能跑(本期插件工具仍走旧路,见 14.4-4)。
9. **对照**:把开关去掉再走一遍 1–8,除了第 7 条的 `variable` 那一格,其余应当一致。

## 15. R3b 记录(2026-08-18):插件工具进目录 + 消费方改口

R3b 收的是 §14.5 第 1 条与 §10.2-④ 那张清单 —— 开关开时,**没有任何一条生产链路
再去问旧 registry**「有哪些工具 / 跑一个工具 / 它的 schema、描述、guard 是什么」。
开关(`ONETHING_TOOLKIT=1`)**本期仍默认关**,关时旧路一行不删不改格式;渲染器 /
`@shared` 一个字未动。

### 15.1 改口点表(file → 改法)

| # | 文件 | 它原本怎么答 | R3b 开关开时怎么答 |
| --- | --- | --- | --- |
| 1 | `app/plugins/api.ts`(`host.registerTool`) | `registerToolInRegistry(Tool.define(...))` 一处 | **同时**把同一份 def 包成 `PluginTool` 注册进 Catalog(旧行一个字不改)。`permissionGuard: 'permission-gated'` 那句话在新树里由 `plugin_exec` 这条效果说出来 |
| 2 | `app/plugins/api.ts`(`disposePlugin`) | `disposeCorePluginState(state, { unregisterTool })` 只摘旧 registry | 那**一个**口包成"两边都摘" —— 注册表足迹与目录足迹不可能漂开 |
| 3 | `app/toolkit/plugin-tools.ts`(新,78 行) | — | `PluginTool` 的装配:进目录 / 摘目录两个函数,外加一个**不设默认值**的超时端口(见 §15.2) |
| 4 | `app/features/builtin/self-evolution.ts` | `hasTool('bash')` 门 + 三次 `registerTool` + 三个 disposer + 清扫 disposer | `catalog.has('bash')` 门 + `registerFeatureTools(catalog, new FeatureToolRuntime())` + `handle.unregister()` + `handle.runtime.sweep()`。**注册顺序 = 解绕逆序**这条纪律原样保留 |
| 5 | `app/toolkit/wiring.ts` | `buildToolkitCatalog` 里代注册 `feature_*` | **删掉那一句**。R2b 图省事代注册,让 feature 的寿命与它注册的工具的寿命分了家(卸载 feature 摘不掉工具) |
| 6 | `app/toolkit/catalog-projection.ts`(新,73 行) | — | 目录 → `@shared/ipc` 的 `ToolDefinition`(`parameters`/`parameterSchema` 过**同一个** `coreToolDefinitionFromJsonSchema`,`permissionGuard` 走派生表,`executionMode`/`renderKind`/`renderShell` 来自 `spec`) |
| 7 | `apps/electron/src/main/ipc/tools.ts` | `getAllToolsAsync` / `executeTool` | 列表 → `toolkitCatalogToolDefinitions()` 喂进**同一个** `listOnethingSettingsToolsForIpc`;执行 → `runToolkitToolDirectly`,目录里没有就退回旧路 |
| 8 | `apps/server/src/runtime.ts`(`tools.getTools` / `tools.executeTool`) | 恒走 `createServerReadOnlyToolRegistry()` 那份**本地**只读注册表 | 开关开**且真引擎在跑**(`useAppSubsystems`)时:列表 → 目录(这台服务器真的装了 full/readonly 档,报四只是在说谎);执行 → runner。**两道安全闸(`serverReadOnlyToolIds` 白名单 + `validateServerReadOnlyToolAccess`)一个字不动**;只读注册表本身按任务书保持不变 |
| 9 | `app/headless/backend.ts`(`listTools`) | `getAllToolsAsync()` | 目录投影,呈现函数不变 |
| 10 | `app/engine/prompt/system-prompt-snapshot.ts` | `getEnabledToolsAsync(toolSettings)` | `resolveToolkitSurface(...)` + `toolDefinitionFromToolkitTool`。**比旧路多算一道场景面** —— 真回合本来就有那一道,旧快照没有,于是它会把这条会话里根本调不到的工具报成"已装配"(见 §15.5-2) |
| 11 | `app/external-agents/host-tools.ts` + `external-agents/host-mcp/{tools,server,index}.ts` | `getTool(id)` 取旧 `ToolInfo`,handler 里直调 `tool.execute` | 产品层的入参从 `ToolInfo` 放宽成结构表 `HostMcpHostTool`(那个文件因此**不再 import 任何一棵注册表**);装配层开关开时从目录取工具、zod 从契约表反查(`contractForSchema(spec.input)`)、执行走 `runToolkitToolDirectly`(动态 import,开关关时不加载) |
| 12 | `app/engine/triggers/skill-review.ts` | 直接 import `ReadTool`/`WriteTool`/`EditTool` 三个旧对象,调 `.execute` | 从目录取三只,执行走 `createAppToolRunner({ authorizer: 恒 allow })`。三只缺一整组退回旧路(readonly 档就该退) |
| 13 | `agent-loop/stream-runtime.ts` | 开关开时 `resolveSceneHiddenToolIds` + `getEnabledTools` 仍会跑一遍再丢弃(§14.4-6) | 判据是 `toolkitSourceTools !== null`(不是开关本身)—— 目录没配上时它们仍是唯一答案 |
| 14 | `app/backend.ts` | 注释说 `feature_*` 走独立入口 | 注释更新:`feature_*` 与插件工具都不在这里,它们的寿命不是"一档目录"的寿命 |

**核实过、有意不动的**(每条都给了理由,不是漏了):

| 文件 | 为什么不动 |
| --- | --- |
| `app/collab/{say,board,history,dm}-tool.ts`、`app/collab/actors/notebook-tool.ts` | 它们是**执行器**,不是注册表读者。`app/toolkit/adapters.ts` 逐个 import 的正是同一批函数(`speakIntoCollabRoom` / `applyBoardAction` / `searchCollabHistory` …),两边同源已核实。壳本身随 R4 删旧 barrel 时自然收敛 |
| `app/mcp/bridge.ts` | `getAllTools()` 在这里是**旧 registry 对旧 registry 的维护读**(算出哪些陈旧 MCP 条目要摘),不是回答消费方。目录那一侧由 R2b 的 `mcp-catalog.ts` 幂等 diff 管着。随 R4 一起死 |
| `app/tasks/dispatch.ts` | 只 import 两个**类型**(`TaskDispatchOutcome` / `TaskDispatchRequest`) |
| `app/variables/{gateways,index}.ts` | `expandPath`(沙箱)与 `enforcePermissionPolicy`(权限核)—— 两个都在 §6 的**保留**清单上 |
| `apps/electron/src/main/ipc/files.ts` | `applyFileMutationUndo` / `getDownloadsDirectory`,纯模块 |
| `triggers/skill-review.ts`(产品层) | 它 import 的是 `Tool` 类型与 `zodToJsonSchema`(建适配器用),不读注册表。R2a 决定⑥ 已把 `zodToJsonSchema` 复制进新树,R4 断这条边时这里换成新树那份即可 |
| `app/plugins/{types,tool-call-intercept,tool-result-intercept}.ts` | 拦截链在 R2b 已包成 `Interceptor`,核实过没有第二条路:两条链各自只有一个 export,分别被旧管线与 wiring 的 `PluginInterceptor` 调用 |
| `app/acp/permission-bridge.ts`、`external-agents/permission-effects.ts`、`app/external-agents/index.ts` 的 `askExternalAgentPermission` | §10.2-⑥ 的诉求是"`Authorizer.decide` 对外开放",那个端口已经在。**真的改调它需要先把 `external-agent` 变成一个 `EffectClass`**(内核 `Effect.kind` 是封闭联合,而这条 kind 今天不在表里),那是一次带策略行 + 派生表 + 卡片文案的内核改动。它们**不是注册表读者**(读的是 `enforcePermissionPolicy` / `Permission.ask`,两者都在保留清单上),所以不挡 R4 |
| `app/agent-loop/{tools,runtime}.ts`(`agentToolsFromRegistry`) | **没有生产调用方**(只有测试与 barrel 再导出);`buildAgentLoopRuntime` 那一条真路走的是 core 的同名函数。R4 直接删,不值得为它加一条分支 |
| `apps/server` 的 `createServerReadOnlyToolRegistry` | 任务书指定保持不变 —— 它服务的是 echo/test 那条非真引擎的假路 |

**一条统一的兜底判据**:每一处改口的条件都是 `isToolkitEnabled() && 目录真的装上了`
(`getToolkitCatalog()` 非空 / `runToolkitToolDirectly` 返回非 undefined),不是开关本身。
判开关而不判目录会让一次装配顺序问题静悄悄地变成"这一轮没有工具" —— R3b 第一版在
提示词快照与宿主 MCP 两处正是这么写的,开关开时的既有测试当场把它照了出来。

### 15.2 插件工具的失败处置:不进断路器(§13.7 裁定 4 的改口)

**结论:一次插件工具执行抛异常,只毁掉这一次调用 —— 与旧路逐字相同。** 错误文本
回给模型,工具照旧在工具面上,插件健康账本一个字不记。`ExternalTool` 在 R3a 留好的
两个端口(`isolation.timeoutMs` / `reporter`)**都不注入**:超时保持"不给就不设"
(今天 `executeCorePluginTool` 没有工具级超时表,凭空加一个会让一批本来跑得完的
调用开始失败);`reporter` 无人注入即无行为。MCP 侧沿用 MCP client 自己的超时。

**R3b 第一版做错了什么、为什么回滚。** 第一版按 §13.7 裁定 4 的字面("注入现有插件
策略表")给插件工具接了健康断路器:新开一个 `plugin-tool` scope 家族、罚则
degrade-surface、闸落在 `PluginTool.visibleIn`(连败三次把这只工具从模型的工具面上
摘掉)。整段已删。两条理由:

1. **裁定 4 的前提是错的** —— 现有 `pluginScope` 里根本没有"工具执行"这一档失败车道,
   所谓"注入现有表"实际上是**新增**一族、新增一条罚则,也就是一次没有被批准的行为
   变更。旧路的插件工具执行不进断路器,这是现状。
2. **罚则本身与"谁在重试"这件事冲突。** 现有 degrade-surface 那几族的重试主体都是
   人(面板动作、深链、搜索供给方),人看见错误会停手,所以"停掉这一个界面"是止损。
   插件工具的重试主体是**模型**,而模型撞上的失败里有一大类是它自己能纠的
   (参数语义不对、路径写错、前置条件没满足)—— 把工具从工具面上摘掉恰好剥夺了它
   自纠的那条路:它不再有"换个参数再试一次"的选项,只能绕。用一条为"人会停手"设计的
   罚则去罚一个"模型会改进"的失败面,是把尺子用错了地方。

**将来真要做,前提写在这里**:(a) 必须是用户在设置页显式开启的开关,不能是默认行为;
(b) 计数门槛只能计**插件代码异常**这一类(entry 抛错、依赖缺失),不能把模型可纠的
失败算进去 —— 而这两类今天在 `execute` 的抛出面上分不开,所以先得有一个能分开它们的
判据,才谈得上罚则。

### 15.3 插件工具的两侧拆除

拆除只有**一个**口:`disposeCorePluginState(state, { unregisterTool })`。core 按注册过的
工具 id 逐个调它,装配层把那个口包成"旧 registry + 目录都摘"。于是
`app/plugins/__tests__/builtin-teardown.test.ts` 钉的那条语义(停用之后注册表里一个字
都不剩)在新树上是同一条 —— 不需要第二处清扫,也就不存在"两侧漂开"这种失败模式。
`Catalog.unregister` 会一并清掉 prepare 记录,所以一个插件禁用再启用拿到的是新实例。

### 15.4 `no-legacy-registry-readers` 覆盖清单

`app/toolkit/__tests__/no-legacy-registry-readers.test.ts` —— 把旧 registry 的
**十一个读函数**(`getTool` / `getToolAsync` / `getAllTools` / `getAllToolsAsync` /
`getEnabledTools` / `getEnabledToolsAsync` / `getAllStaticTools` / `getAllAsyncTools` /
`executeTool` / `getToolsForAI` / `analyzeTool`)换成「被调用即抛」,再跑真链路:

| 问题面 | 跑的是什么 | 断言 |
| --- | --- | --- |
| 闸本身活着 | 逐个直调那十一个函数 | 全部抛 —— 这条在前面,免得后面三条是"因为没跑到"而绿的 |
| 跑一个工具 | `executeToolDirectly` × write / read / edit / bash / 一只插件工具 / `task`(参数错的那一路) | 结果对且**没有任何一次**触发那道闸 |
| 有哪些工具 | `listOnethingSettingsTools`,`getAllToolsAsync` 喂目录投影(与 electron IPC 处理器同一条装配) | 列表里有 read / bash / 插件工具,`source` 推导正确 |
| schema / 描述 / guard | `resolveToolkitSurface` + `toolDefinitionFromToolkitTool`(提示词快照那一支用的**同两个**函数) | 五格派生 guard 逐字对(read=sandboxed / write=edit=permission-gated / bash=internal-check / time=safe),插件工具 = permission-gated |

**这条测试没覆盖到的两格,说清楚**:(a) `buildSystemPromptSnapshot` 的整条集成路
(要一条真会话 + 真 provider 配置),测的是它那一支用的两个函数而不是它本身;
(b) `apps/electron` / `apps/server` 的两个 IPC/HTTP 处理器(测的是同一条装配的产品层
函数,不是处理器本体)。两处都是"同函数不同壳",但严格说不是端到端。

另一条新增:`app/toolkit/__tests__/plugin-tools.test.ts`(5 条)—— 进目录走新路(判据
是旧 `executeTool` 零调用)、契约不合当场 invalid、卸载摘除、**连抛五次也不进断路器**
(工具仍在面上、健康账本无记录、每次都把错误如实回给模型)、超时端口(给了
`timeoutMs` 会被掐 / 缺省不设)。

### 15.5 有意的差异 / 本期发现的问题

1. **`registerFeatureTools` 从 wiring 挪到 feature 自己。** R2b 让 `buildToolkitCatalog`
   代注册,那是一处真错:feature 卸载时目录里的三只工具摘不掉(disposer 在 feature
   这边,注册在目录那边)。挪回去之后宿主档门的判据从 `hasTool('bash')` 变成
   `catalog.has('bash')` —— 问的是同一件事(这台宿主给不给跑 shell)。
2. **提示词快照的工具面变严了。** 开关开时它多过一道场景面,于是协作四件套在普通
   对话里、`goal` 在没有 active goal 的回合里、`task` 在派工出来的子会话里**不再出现在
   快照上**。这是**修复**:真回合本来就看不见它们(`agent-loop/stream-runtime.ts` 的
   减法表),旧快照少算那一道,把这条会话里根本调不到的工具报成了"已装配"。
3. **skill review 的"不过权限门"从隐含变显式。** 旧路直调 `ReadTool.execute(...)`,
   注册表那层的 `enforcePermission` 根本没经过 —— 一次后台触发、写的是用户自己的
   skills 目录、根由 `mutableRoots` 夹死,弹一张没人点的卡等于把这个功能变成
   "120 秒后自动失败"。新路显式装一个恒 `allow` 的授权者:同一个行为,但现在它是
   一句看得见的话,而不是"调的是工具对象不是注册表"这种偶然成立。
4. **`apps/server` 的工具列表在真引擎档下会变长。** 旧行为恒报只读注册表那四只,而
   这台服务器默认装的是 **full 档**(CLAUDE.md:desktop parity by default)。开关开时它
   报的是目录的真实内容。**执行面没有变宽**:`serverReadOnlyToolIds` 白名单与路径
   校验两道闸一个字没动,列表里多出来的那些工具调用会照旧被拒。
5. **`external-agents/host-mcp/tools.ts` 的入参放宽是一次净减依赖。** 它原本 import
   `ToolInfo`(§6 删除清单上的文件);换成本地结构表之后,这个产品层文件对两棵树
   都不认识了,R4 时它一个字都不用改。
6. **`app/agent-loop/tools.ts` 是死码。** `agentToolsFromRegistry` 没有生产调用方 ——
   `buildAgentLoopRuntime` 那条真路走的是 core 的同名函数,装配层这一份只被 barrel
   再导出和它自己的测试引用。R4 删。
7. **`external-agent` 不是一个 `EffectClass`。** §10.2-⑥ 想让 ACP / 外部 agent 那两处
   改调 `Authorizer.decide`,但内核 `Effect.kind` 是封闭联合,而这两处构造的效果
   `kind: 'external-agent'` 不在表里。要改就得给它一行策略 + 一格派生表 + 一句卡片
   文案 —— 那是 R4 的活,不是 R3b 顺手能带的。它们不挡 R4(不读注册表)。

### 15.6 R4 删除清单(最终版)+ 删除顺序建议

**前提**(缺一不可):开关翻成默认开并跑满一个自举周期;§14.6 的真机走查九条过;
`no-legacy-registry-readers` 常绿。

删除顺序按"从叶子往根",每一步都能单独跑全量测试:

| 步 | 删什么 | 为什么排在这 |
| --- | --- | --- |
| ① | `app/agent-loop/tools.ts`(`agentToolsFromRegistry`)+ 它的 barrel 再导出与测试 | 死码,没有任何调用方,先删掉免得后面几步还要考虑它 |
| ② | 各消费方的 `if (isToolkitEnabled())` 分支里的**旧那一半**(表 §15.1 的 16 行)+ `flag.ts` + `ONETHING_TOOLKIT_TIER`(§14.5-5) | 开关本身只在切换期存在。这一步之后旧树没有生产读者 |
| ③ | `agent-loop/stream-runtime.ts` 的 `resolveSceneHiddenToolIds` / `getEnabledTools` 两处口径与 `tools/scene-surface.ts` 整张减法表(§14.5-2) | ② 之后它们是三处死码;`planAgentLoopTools` 的 allowlist 那一格留着(MCP 那一支还在用) |
| ④ | `app/plugins/api.ts` 的 `Tool.define` 那一段、`app/features/builtin/self-evolution.ts` 的旧三件套、`app/mcp/bridge.ts` 的 `registerMCPTools` 对旧 registry 的注册与清扫 | 三处**写**面。它们是旧 registry 最后的填充者,删完之后那棵树是空的 |
| ⑤ | `app/tools/`(registry 门面 / builtin 三个 barrel / toolkit-guard.ts)与 `runtime/src/tools/{tool,registry,tool-execution,tool-execution-context,direct-tool-execution,tool-call-state,tool-refresh,tool-list-presentation,ipc-operations}.ts` + `builtin/` 全部 | 空树 |
| ⑥ | `core/tools/` 的 `*WithAdapters` 族与 `types.ts` 的 `ToolDefinition`;`Tool.define` / `ToolInfo` / `ToolInfoAsync` / `isAsyncTool` 概念;`canAutoExecute`(§14.5-4:至今无调用方) | 内核侧的残留 |
| ⑦ | `app/engine/stream/tool-execution.ts` / `tool-orchestrator.ts` 里"把 ctx 回调翻成 IPC"的那 ≈350 行 | 最后,因为它是每一次工具直调的必经点,留到所有旧路都没人走了再动 |
| ⑧ | `apps/server` 的 `createServerReadOnlyToolRegistry`(它 import 的 `createOnethingToolRegistry` 死于⑤)→ 换成 `createReadonlyCatalog` | 它是假路,但 ⑤ 会把它的实现删掉,所以必须同一步换掉 |
| ⑨ | `triggers/skill-review.ts` 的 `zodToJsonSchema` import 换成新树那份(R2a 决定⑥ 已复制);`external-agents/host-mcp` 一个字不用改(§15.5-5) | 收尾 |

**同一批必须一起做的三件**(不然会留半截):`external-agent` 升成 `EffectClass`
(§15.5-7)、`permissionGuard` 派生值的两个读者退役判断(§14.5-4)、`tool/audit`
要不要拆成三行(§14.5-3)。

### 15.7 门(全部跑过)

| 门 | 结果 |
| --- | --- |
| 开关**关**全量 `npx vitest run` | 1134 passed / 1 failed / 3 skipped(文件);10653 passed / 2 failed / 8 skipped(条)。唯一失败 = `packages/renderer/styles/__tests__/ui-token-vars.test.ts`,**本期开工前的基线里就是它**(基线 1132 passed / 同一个文件失败;+2 = 本期新增的两个测试文件) |
| 开关**开**全量 `ONETHING_TOOLKIT=1 npx vitest run` | **与关时逐字相同**(1134 / 1 / 3;10653 / 2 / 8) |
| `npx tsc --noEmit -p tsconfig.node.json` | 无新增错误(既有两处与本期无关:`spaces/__tests__/provider-dials.test.ts`、`electron.vite.config.ts` 的 TS6307) |
| `npm run typecheck:web` | 通过 |
| `node scripts/boundary-gate.mjs` | ok —— 13 known,none new |
| `app/__tests__/import-side-effect-free.test.ts` | 绿 |
| eslint `--max-warnings 0`(本期改动的 22 个文件) | **0 error**。33 条 warning 全部落在 `apps/server/src/runtime.ts` 与 `app/headless/backend.ts` 的既有未用符号上(那两个文件本来就带着别处的在途改动) |
| `bun run server:build` + 单文件包真跑 | 开关开:`/api/sessions` 200、`/api/tools` 200 报 **20 只**(17 内置 + 3 个 `feature_*`,证明 self-evolution feature 在服务端也把三件套装进了目录)、`ReferenceError` 计数 **0**;开关关:`/api/sessions` 200、`/api/tools` 报 **1 只**(`read` —— 那份只读假路),`ReferenceError` 0 |
| `bun run build` | EXIT 0 |
