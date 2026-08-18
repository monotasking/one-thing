# 提示词组合式架构:片段(fragment)即插即拔(2026-08-18)

> 结论先行:system prompt 从「builder 里一张手排的元组表」改成「一种形状(片段)、
> 一个接口(来源)、一个对象(组合器)」。工具的提示词写在工具上,随**回合工具面**进出;
> 插件与运行时特性用同一种形状注入并带 disposer;组合器只做过滤 → 排序 → 渲染,
> 不认识任何具体来源,更不点名任何工具。

## 0. 病根

改前 `prompts/builder.ts` 的 `buildRuntimeSystemPrompt` 是一张 `[name, content]` 元组表:

- 工具知识写死在表里:`context-variables` 段用 `toolNames.includes("variable")` 判;
  `skills` 段用 `includes("read")` 判;`self-evolution` 段用 `includes("feature_mount")` 判
  (后者本轮已被另一批工作搬进 skill)。每接一个新工具都要**改 builder**。
- 工具守则是两份**全局常量**(`tool-guidelines.md`:「使用 edit 改文件…」;
  `tool-workspace-rules.md`:「read/edit/write/bash 用当前工作目录…」「改工作目录调
  variable…」),**与工具面无关**地每轮拼进去:没有 edit 的面照样念 edit 的守则,
  没有 variable 的面照样叫模型去调 variable,`hasTools=false` 时 system 段仍带
  `Tool Guidelines:`。
- 插件只有 `registerPromptContextProvider`(每回合现算的函数)一条路;插件注册的
  工具**没有任何办法**带一段自己的说明进 prompt。运行时特性(`app/features`)同样没有。
- 房间回合要屏蔽守则,靠传 `toolGuidelines: []` 这种"把常量清空"的旁路。

一句话:提示词与工具面是两套账,靠人手对齐;对不齐时模型读到的是谎话。

## 1. 形状:`CorePromptFragment`

`packages/core/engine/prompt-fragments.ts`(core,零依赖):

```ts
interface CorePromptFragment {
  id: string                       // section 名(disabledSections / 快照 / evals 的键);bullet 只需唯一
  slot: 'guidelines' | 'workspace-rules' | 'section'
  channel?: 'system' | 'turn'      // 投递通道(缺省 system);见 §1.5 与 prompt-channels-2026-08.md
  group?: string                   // disabledSections 认的组名(插件 provider 共用 'plugins')
  source: string                   // 'builtin' | 'tool:<id>' | 'plugin:<id>' | 'feature:<id>' …(诊断用)
  order?: number                   // 槽内排序;缺省 = 2000(产品段之后,永远不是最前)
  requiresTools?: string[]         // 全部在回合工具面上
  requiresAnyTools?: string[]      // 至少一个在面上
  when?(ctx): boolean              // 工具闸之后的额外谓词
  content: string | (ctx) => string | undefined
}
```

三个槽对应 prompt 里三个落点:

| slot | 落点 | 渲染 |
| --- | --- | --- |
| `guidelines` | system 段 `Tool Guidelines:` 列表 | 一条一个 bullet,同文只说一次;没有 bullet 就没有这个列表 |
| `workspace-rules` | 独立的 `## Tool Workspace Rules` 段(2026-08-18 前是 `# Work Directory` 段末) | 同上;一条 bullet 都没有就没有这一段 |
| `section` | 独立 developer 段 | 每条一段;同 id 的段在 `sections`(快照)里合并成一条,developer 消息仍各自独立(插件段沿用历史形状) |

**工具面**(`corePromptToolSurface`)= `hasTools ? toolNames : ∅`。`requires*` 只对它检查,
不看注册表 —— 注册表是目录,回合面才是事实(与 08-18 的 `scene-surface.ts` 同一条哲学)。

## 1.5 对象:`PromptSource` 与 `PromptComposer`

`packages/onething-runtime/src/prompts/composer.ts`:

```ts
interface PromptSource { readonly name: string; collect(ctx): fragment[] | Promise<fragment[]> }

class PromptComposer {
  constructor(sources: readonly PromptSource[])
  with(...sources): PromptComposer            // 新对象,原对象不动
  compose(ctx): Promise<{ system, developer, sections, turn }>
  build(options): Promise<CoreBuildPromptResult>   // 合并 system / codex 的 system+developer 拆分
}
class StaticPromptSource implements PromptSource   // 固定列表:测试、evals、一次性宿主
```

谁是来源(都 `implements PromptSource`,组合器对它们一视同仁):

| 来源 | 类 / 实例 | 说什么 |
| --- | --- | --- |
| 产品段 | `builtinPromptSource`(`builder.ts`,`StaticPromptSource` 包 `BUILTIN_PROMPT_FRAGMENTS`) | agent / voice / runtime-context / … / agents-md 与文件工具规则 |
| 工具 | `OnethingToolRegistry`(`tools/registry.ts`)本身就是来源:`collect(ctx)` = `hasTools ? toolNames→id 排序 → getPromptFragments(ids) : []` | 面上工具的 `ToolInfo.prompt` |
| 运行时 / 宿主 | `PromptFragmentRegistry`(`fragments.ts`,单例 `promptFragments`) | `registerPromptFragment` 注册进来的,带 disposer |
| 插件 | `PluginPromptContextSource`(`plugin-context.ts`,构造时注入超时/熔断回调) | provider 结果,落成 turn 块 `plugin:<id>/<providerId>`(组名 `plugins`) |
| 变量板 | `VariableBoardSource`(`variable-board.ts`,桌面组合器注入 `buildStateVariablesPromptText`) | 会话的上下文变量板,一块 turn |

两个现成的组合器:

- `defaultOnethingPromptComposer`(product,`builder.ts`)= builtin + registry + 裸 plugins,**没有工具来源**——
  给 `backend.ts` 算 promptVersion、evals、单测用;`buildOnethingSystemPrompt(ctx, composer?)` /
  `buildOnethingPrompt(options, composer?)` 的第二参数缺省就是它。
- `desktopPromptComposer`(app,`app/engine/prompt/system-prompt.ts`)= builtin + `toolPromptSource`
  (app 注册表实例)+ `promptFragments` + `pluginPromptSource`(带 `reportPluginRuntimeFailure/Success`
  回调)。**顺带修了一个既有 bug**:改前 builder 直接调裸的 runtime `collectPluginPromptContext`,
  app 层那份带熔断回调的包装从来不在构建路径上 —— promptContext 这条车道的熔断从未被喂过。

**`channel`:片段的第三个维度(2026-08-18,`prompt-channels-2026-08.md`)。**
每条片段除了"落在哪个槽"(slot)还要答"走哪条通道"(`channel`):`system`(缺省)
进静态前缀,`turn` 进最新一条 user 消息尾部的 `<context-update>` 块。规则一条:
**content 读了会话/回合级事实的片段必须是 `turn`** —— 前缀的字节必须对同一 agent 的
所有会话逐字相同,否则每换一条会话就打穿一次 KV 缓存。只有 `slot: 'section'` 能是
`turn`(guidelines / workspace-rules 是静态守则)。通道只决定**投递位置**,不改变
"要不要说":`requiresTools` / `when` / `disabledSections` 在两条通道上行为完全一致。
组合器把 turn 片段渲染成 `ComposedPrompt.turn: TurnBlock[]`(同 id 合并),之后由
`TurnContextLedger`(core,纯)逐块去重、`SessionTurnContext`(app)持久化并挂到消息上。
`disabledSections` 另外认 `group`:插件 provider 的块 id 是 `plugin:<id>/<providerId>`
(各自去重),但共用组名 `plugins`,所以房间回合那份禁用名单一字不改仍然生效。

上下文预处理(宿主适配器:persona 查找、home、platform、docs 路径、todo 目录)抽成纯函数
`resolveOnethingPromptContext(ctx)`,宿主先算它、再交给自己的组合器。测试不再需要"从 ctx 塞片段"
的后门(`ctx.fragments` 已删):要工具段就 `composer.with(new StaticPromptSource('tools', …))`
(`__tests__/fixtures/tool-prompts.ts` 的 `testPromptComposer`)。

## 2. 三条入口

### 2.1 工具:`ToolInfo.prompt`(声明式,随面进出)

```ts
Tool.define('variable', {
  …,
  prompt: VARIABLE_TOOL_PROMPT,   // { guidelines?, workspaceRules?, sections?: [{ id?, content, order? }] }
})
```

`promptFragmentsFromToolContribution(toolId, prompt)` 把声明展开成片段,**每一条都
`requiresTools: [toolId]`**。注册表作为来源(`OnethingToolRegistry.collect`)每次构建把回合的
`toolNames`(模型面名字)经 `resolveAIToolName` 换回工具 id、按 id 排序(字节不随注册顺序变,
保 prompt cache 前缀),再取自己的 `getPromptFragments(ids)`。于是:

- 设置里禁用 / agent 白名单没给 / 场景摘掉 / 档位没有 / 插件被禁用卸载 —— 五种"不在"
  在 prompt 里**同一种结果**:一字不留;
- 注册一个带 `prompt` 的工具,下一回合它的段落就在;`unregisterTool` 即消失;
- 声明是**静态**的(与回合无关)—— 会变的事实走 `<context-update>` / 工具结果。

本轮迁移的三个内置工具(文本一字不改,只是搬家):

| 原位置 | 现归属 |
| --- | --- |
| `content/tool-guidelines.md`「使用edit来修改文件，禁止使用bash工具来修改文件」 | `edit` → `EDIT_TOOL_PROMPT.guidelines` |
| 同上「使用write来重写或创建文件」 | `write` → `WRITE_TOOL_PROMPT.guidelines` |
| `content/tool-workspace-rules.md` 第 2 行(改 workdir 调 `variable`) | `variable` → `VARIABLE_TOOL_PROMPT.workspaceRules` |
| `content/context-variables-intro.md` → `<context-variables>` 段 | `variable` → `VARIABLE_TOOL_PROMPT.sections[{ id: 'context-variables' }]`(md 挪到 `tools/builtin/prompts/variable-context.md`) |
| `content/tool-workspace-rules.md` 第 1 行(四个文件工具用当前目录) | 内置片段 `workdir-file-tools`(`requiresAnyTools: read/edit/write/bash`,**按在场的工具动态点名**:全在时字节与旧文本相同,只有 read+write 时是「read and write use …」) |

`todo` 段加了 `requiresAnyTools: ['read','edit','write']`(说明书写的就是用这三个操作它),
`skills` 段的 `read` 判据改成 `requiresTools: ['read']`。`context-update-convention`
保持无条件(块与工具无关,模型都该知道它是什么)。

### 2.2 插件:两条路,分工明确

- **`api.registerTool({ …, prompt })`**:与内置工具同一字段、同一条链。core 注册闸做结构
  校验(`describeToolPromptContributionProblem`),非法形状**只拒这一个工具**、日志点名
  (与 `executionMode` 同规)。随插件工具的启停/卸载进出,不另记账。
- **`api.registerPromptContextProvider`**:保留,语义不变(每回合现算、超时 + 熔断)。
  组合器把它的返回当作 **turn 块**(id `plugin:<pluginId>/<providerId>`,组名 `plugins`,
  order 3000)—— 每回合现算的东西按定义不属于静态前缀。分工:「工具的说明书」写在工具上;
  「每回合现算的上下文」用 provider。

作者指南:`docs/guides/plugin-authoring.md`「`prompt`:工具自带的提示词」。

### 2.3 运行时特性 / 宿主:`promptFragments` 注册表

`packages/onething-runtime/src/prompts/fragments.ts`:`PromptFragmentRegistry implements PromptSource`
(`register → disposer`,同 source+id 覆盖,`clearSource` 一扫,`import` 零副作用),
进程级单例 `promptFragments`,便捷函数 `registerPromptFragment`。桌面组合器把它列为来源,每次构建读它。
`FeatureContext.registerDisposer(registerPromptFragment({...}))` 就是一个 feature 的接法
(K0 规则:专用 register 面不预雕,差距清单驱动)。片段可带 `requiresTools`,让一段只在
自己的工具在场时才说话。

## 3. 组合器(`prompts/composer.ts`)

```
sources[] ── collect(ctx) 逐个(顺序 = 同 order 时的平局规则)
        │
        ▼
PromptComposer.resolve: disabled? → requires*/when → render → 按 slot 归位(order 稳定排序)
        │
        ├─ guidelines      → coreSystemBlock(ctx, bullets)  → system 段
        ├─ workspace-rules → 合成一段 `tool-workspace-rules`(order 500)插进 section 序列
        └─ section         → channel === 'turn' ? turn[](同 id 合并)
                                                : developer[] + sections[](同名合并)
```

- 内置表按历史顺序 100 步排(agent 100 … agents-md 1100),工具段缺省 2000,插件 3000。
- `disabledSections` 匹配片段 id,外加两个复合块名 `tool-guidelines` / `tool-workspace-rules`
  (`PROMPT_BLOCK_*` 常量)。房间回合的 `toolGuidelines: []` 旁路改为
  `disabledSections: [PROMPT_BLOCK_TOOL_GUIDELINES, …]`;`context-variables` 是工具段,
  不在禁用名单里,所以房里照留(与改前一致)。
- `core/engine/system-prompt.ts` 的 `CoreBuildPromptContextOptions` **删掉**
  `toolGuidelines` / `toolWorkspaceRules`;片段不走 ctx,走来源。
  `evals/fixture.ts` 的骨架版本随之只哈希 default-system + known-projects
  (工具守则已属工具面,section 级版本 `versionFromSections` 本来就能看见)。

## 4. 字节层面的变化(golden 已更新并逐条核对)

| 场景 | 变化 |
| --- | --- |
| desktop-full(read/write/edit/bash/…/variable 全在) | 仅守则从一条拆成两条 bullet(edit、write 各一);Workspace Rules / context-variables 字节相同 |
| 无工具(minimal / voice / windows / linux) | system 段不再有 `Tool Guidelines:`(改前是无条件的) |
| agents-md(read+write) | 守则只剩 write 那条;文件工具规则「read and write use …」;不再叫模型去调不存在的 variable |
| 房间回合 | 不变(守则本就禁,context-variables 本就留) |

## 5. 验收(全自证,无人肉)

- `packages/core/engine/__tests__/prompt-fragments.test.ts`:展开 / 闸 / 校验 / 插件注册闸只拒一个。
- `packages/onething-runtime/src/tools/__tests__/tool-prompt-fragments.test.ts`:注册表按面取、
  卸载即空、async 工具不初始化就能读声明、三内置工具的声明文本。
- `packages/onething-runtime/src/prompts/__tests__/fragments.test.ts`:组合规则(顺序 / 闸 /
  三槽落点 / 去重 / disabled 复合块 / 插件段形状)+ `PromptComposer`(`with` 不可变、逐来源
  collect、平局按来源顺序)+ 注册表 disposer 语义。
- `packages/onething-runtime/src/app/engine/prompt/__tests__/prompt-fragments-wiring.test.ts`:
  桌面组合器真读注册表 —— 注册工具即说话、离面即静音、卸载即消失;注册表片段随 disposer 进出。
- 既有 golden / baseline 快照按 §4 更新;golden 场景与 `builder.test.ts` 走 `testPromptComposer`
  (默认组合器 + 内置工具提示词来源),与桌面同一份声明。

## 6. 没做的(有意)

- `FeatureContext` 不加专用 `registerPromptFragment` 面(K0:等真实 feature 提需求)。
- 插件 manifest 里不加静态 `contributes.prompt`:provider + 工具 `prompt` 已覆盖两种形状,
  第三条路只会分裂来源。
- MCP 工具不带提示词(外部定义,只有 description)。
- 不给片段做 token 预算/裁剪 —— 那是另一个问题(`prompt-evaluation.md`),片段化只是让它
  可度量:每条片段有 source,谁花了多少字从此有账可查。
