# Provider 面向对象重建(Wire × Dialect)—— 设计稿 v2.1

> 2026-08-22。状态:**设计,未开工**。v1 经两路独立评审(架构/扩展性、代码事实核对)与六路官方 API 研究(OpenAI、Anthropic、Gemini、DeepSeek、Kimi·Zhipu·Qwen、Grok·OpenRouter)修订为 v2;v2.1 加 §3.1 面向对象自检并把方言从“被解释的数据表”改为“类型化的组合配方”;采纳/拒绝记录在 §13,研究摘要在 §12。
> 上一篇《Provider 抽象收口》(`provider-abstraction.md`,08-07)把“差异被参数化而不是 if-else”定为原则;本篇不推翻它,而是把“参数化”从**扁平旋钮**升级为**可覆盖的对象 + 类型化的组合配方**,并补上它当时没有的两样:投递契约与能力/序列化同源。

## 0. 一句话

每个 provider 是一个对象:**Wire(线协议)类决定管线,Dialect(方言)是一份类型化的组合配方——每个字段都是策略对象,需要代码时才有薄子类**;附件投递、思考、工具、usage/缓存、错误、认证、缓存断点都是基类持有的契约;方言**物理上做不到**无声丢失、口径打架,或者把一个新参数做成散落各处的补丁。

## 1. 病根(不是症状)

| 症状(本周) | 病根 |
|---|---|
| DeepSeek vision 模型收不到图(`deepseek.ts` 把 user 内容压成纯文本) | `deepseek.ts` 是 `openai-compatible.ts` 的手抄副本(流解析去掉日志后只差 4 处,其中 1 处是语义差),副本落后,没有骨架逼它跟上 |
| Codex gpt-5.5 `does not support image output` | 能力判定(账本/overlay)与序列化(provider)分家,两侧读同一条目不同字段 |
| “选 gpt-5.5 每条消息都生图” | `supportsImageGeneration` 同时承担“能出图”与“换通路”两种语义 |
| DeepSeek 缓存命中在 OC 下会丢;**claude 的缓存回合输入少算**(Anthropic `input_tokens` 不含缓存,我们直接当总输入,计价再减一次 cacheRead);**gemini 输出少算**(`thoughtsTokenCount` 不在 `candidatesTokenCount` 内而计费按输出) | usage 字段语义方言化,每家各写一份映射,没有成文语义,也没有固定样本 |
| `reasoningStyle` 七分支 switch、effort clamp 各家硬编码、账本 `profile.efforts` 又一份 | 方言是旋钮不是对象,想改“某一步”只能加分支 |
| 全仓没有一个按 provider 参数化的测试套件;25 个测试文件 ≈150 用例各写各的 | 没有统一的 provider 构造面可被参数化 |

结构事实(管线摸底 + 核对):五家 HTTP provider **4094** 行;另有**第二套 codex**(`runtime/src/providers/codex.ts` 2210 行 + `backend/wiring/providers/builtin/codex.ts`):其模型列表 / ChatGPT 用量拉取 / 原生工具元数据是活的,其 `doStream/doGenerate` 请求路径(自带 SSE / usage / 错误 / effort)在生产**零调用方**。去重后可删 ≈1550 行(deepseek.ts 整文件 508 行可删);`runTurn` 五家 AST 相同(acp 多一句守卫);发送/抛错/dump 五家同构但有三处实质差(deepseek 读体无 `.catch`、codex dump 无 `turn` 且在 auth 之前)。真正的差异集中在**消息序列化、思考线型、tool_choice 拼法、usage 字段、错误形状、认证、缓存断点**七处 —— 这七处就是 hook。

## 2. 原则

1. **Wire 决定管线,Dialect 只覆盖 hook。** 线协议四条:`openai-chat`、`openai-responses`、`anthropic-messages`、`gemini-generateContent`。一条 wire 一个类,管线(步骤与顺序)写死在模板方法里,子类不可覆盖顺序(以架构测试守,TS 无 final)。
2. **能力与序列化同一个对象回答。** `ModelProfile`(账本薄壳,P0 就有)既喂 `getModelCapabilities()` 又喂序列化器;能力说“能看图”而序列化丢图,在类型上不可表达。
3. **投递契约:每个 part 要么进请求体,要么留可见文本。** `serialize*()` 返回 `Delivered | Undeliverable(reason)`;**单一 owner**:core 的 `degradeUnsupportedAgentContentParts` 负责“能力说不行”的模态降级(`[Image]` 一类),provider 的 `Undeliverable` **只**负责“能力说行、线协议做不到”(chat-completions 的 tool_result 图、PDF);两套文案词汇不重叠;P2 的架构测试把两者“不许打架”定为不变式。
4. **被丢弃的设置也要留痕。** 不只内容块:Kimi 固定 temperature、Zhipu 把 `required` 降成 `auto`、Grok 禁 penalty —— 统一走 `warnings: ProviderWarning[]`(随 finish 事件/provider-data 带出,写进 events.jsonl `request/*`),不再静默。
5. **一种 provider 错误形状。** 所有 wire 抛 `ProviderHttpError { providerId, status, code?, type?, message, responseBody, retryAfterAt?, requestId?, inStream?: boolean }`(runtime 层);**流中**的 SSE 错误事件(OpenRouter 带内错误、Anthropic `error` 事件、Zhipu `finish_reason: sensitive/network_error`)也走它。分类器对 provider 错误只读这一个对象;对 OAuth 刷新等**非 provider**错误保留前缀抠取(它们由 `auth-service.ts` 构造,永远不是 `ProviderHttpError`)。
6. **usage 用三个不交叠的桶做规范化中间表示。** `uncachedInput / cacheRead / cacheWrite`(+ `output / reasoning / audio? / providerCostUSD? / raw`),每个 wire **直译**到桶(Anthropic 零加减法;OpenAI `prompt − read − write`),再由**一个**投影函数产出现行 `AgentUsage`(`input = uncached + read`,`cacheWrite` 额外)—— 外部契约与落盘账本**不变**(usage 字段在全仓手抄 11 处、JSONL 账本 append-only 无版本号,不值得为改名而迁)。每行配固定样本。
7. **档位/取值/可否的唯一来源是能力账本。** effort 合法值、默认开关、可否关、温度是否允许、`required` 是否支持、`tool_stream`、`include_usage` 支不支持 —— per-model 的一律进 `model-capability.ts` 的 `profile`;方言表只放 per-provider 的东西。thinking 编码器按账本的 `OnethingReasoningWire` 值**建表**,Dialect 不持有线型。
8. **新字段不动 core 契约。** 请求侧 `providerOptions: { [providerId]: {...} }`、响应侧 `providerMetadata: { [providerId]: {...} }` 双向命名空间袋(AI SDK 的做法);`extraBody` 对内(方言)也对外(设置/宿主可注入,实验性参数不必发版)。只有跨家通用且引擎要消费的才升格为契约字段(本篇只升两项:`cacheKey`、`providerCostUSD`)。
9. **非 HTTP 的 provider 继承 `BaseAgentProvider`,不继承 `HttpAgentProvider`。** acp / external-agents 拿 runTurn / logger / warnings,保持自述能力(`capabilitiesAreSelfDeclared`)。
10. **运行期纪律写进基类**:实例无状态、auth 每次调用晚绑定(凭据轮换在 runner 层换 key,实例可跨回合跨凭据复用);`finally` 取消响应体;首字节 / 空闲超时;`AbortError` 不映射成 `ProviderHttpError`;dump 永不落 auth 头、截断 data-URI、URL 脱敏(gemini `key=`)。

## 3. 对象模型

```
@onething/core                  AgentProvider(接口,不变:id / capabilities(静态) / getModelCapabilities / streamTurn / runTurn)
                                AgentTurnRequest(+cacheKey?, +providerOptions?)  AgentUsage(+providerCostUSD?)  ProviderWarning
                                      ▲ implements
runtime/agent-loop/providers/base/
  BaseAgentProvider(抽象)      id / capabilities(静态=profile 投影) / getModelCapabilities(model) / runTurn=collect(streamTurn) / logger / warnings
      ├── HttpAgentProvider<TBody,TChunk>(抽象)   模板 streamTurn():
      │     1 profile  = await this.profiles.resolve(model)                     ← ModelProfile(账本薄壳)
      │     2 prepared = mergeAdjacent?(wire 级开关) + serialize(messages, profile) → {body parts, undeliverable 留痕, warnings}
      │     3 body     = this.buildBody(prepared, profile) + thinking.encode(profile.reasoningWire) + cache.annotate() + dialect.extraBody()
      │     4 auth     = await this.auth.headers(request)                      ← 晚绑定
      │     5 dump     = dumper({ url: redact(url), body: truncateDataUris(body) })
      │     6 response = send(url, headers, body, signal, timeouts) (+ onUnauthorized 重试)
      │     7 !ok / 流中 error → throw ProviderHttpError
      │     8 events   = parseStream(response) + dialect.parseDeltaExtras / parseFinishExtras  → provider-data
      │     9 finish   = { finishReason: normalize(raw), usage: project(usage.toBuckets(raw)), warnings }
      │     finally    = response.body?.cancel()
      │
      │     ├── OpenAIChatWire           chat/completions:内容块 / tool_calls index 累积 / reasoning_content|reasoning / usage
      │     │     方言 = 组合配方 Dialect(§3.1/§5):openai · deepseek · kimi · kimi-code · zhipu · qwen · grok · grok-oauth · openrouter · github-copilot · custom-openai
      │     ├── OpenAIResponsesWire      codex 今天;P1 必须带一个非 codex 的 responses 冒烟(openai 或 grok),否则改名 CodexResponsesWire
      │     ├── AnthropicMessagesWire    claude · claude-code · custom-anthropic
      │     └── GeminiWire
      ├── AcpAgentProvider              自述能力,继承 Base(拿 runTurn/logger/warnings)
      └── ExternalAgentProvider         同上

横切策略(按能力切,不按 wire 切;**每个都是对象**,wire 带默认实现,方言配方可替换;策略自己作用于请求体构建器并上报 warning —— 基类只排顺序,不做判断):
  ThinkingWire         interface { encode(turn, builder); decode(chunk, turn); replay(message, turn) } —— 同一线型的编码/解码/回传三件事在一个对象里;实现按账本 OnethingReasoningWire 注册(thinking-type / thinking-type+keep / thinking-type+clear / openai-effort / enable-thinking / grok-effort / openrouter-reasoning / anthropic-adaptive / anthropic-budget / gemini-level / gemini-budget / responses-reasoning / none)
  PartCodec            interface { system / user / assistant(含思维链回传、块序) / toolResult } → Delivered | Undeliverable(对象,带 toText())
  UsageNormalizer      interface { toBuckets(raw): UsageBuckets };UsageBuckets 是值对象(构造校验、toAgentUsage()、billable(prices)、cacheHitRatio())
  CachePolicy          interface { annotate(turn, builder) }:OpenAI prompt_cache_breakpoint / Anthropic cache_control / OpenRouter 互转 / Gemini cachedContent / 无
  AuthStrategy         interface { headers(turn); onUnauthorized(response, turn): Promise<Headers | undefined> } —— 401 刷新重试是它的事,wire 不知道 OAuth 的存在;实现:BearerApiKey / HeaderApiKey(x-api-key | x-goog-api-key) / OAuthRefreshing / ResolveAuth
  ToolChoicePolicy     interface { apply(turn, builder) }:拼法 + 按 profile 降级(required 不支持 → auto + warning)
  SamplingPolicy       interface { apply(turn, builder) }:temperature/top_p/penalty 发不发、范围(按 profile;Kimi 固定值不发,Anthropic 新模型不发,Gemini 3.6+ 不发)→ 不发时 warning
  ErrorMapper          interface { fromResponse(response); fromStreamEvent(event) } → ProviderHttpError(对象:status/code/type/retryAfterAt/requestId/inStream)
  FinishReasonMapper   interface { map(raw): NormalizedFinish }(含 context-overflow → 压缩层,替代 retry.ts 的文本正则)
  ModelProfile         值对象:allows(param) / supports(cap) / reasoningWire / inputModalities / toolResultModalities / imageOutput.servedBy / limits —— 能力投影与序列化器问**同一个对象**
  TurnContext          值对象:request / profile / builder / warnings / logger(child) —— **所有 hook 只接收它,不碰 this**;provider 实例无可写字段
  RequestBodyBuilder   构建器:set(path, value) / warn(kind, detail) / build() —— 请求体只在这里长出来,策略往里写
```

**Dialect = 类型化的组合配方(不是被解释的字符串表)**:

```ts
export interface Dialect {                   // 每个字段是一个策略对象或注册表里的对象,基类只调用接口
  id: string                                   // 'deepseek'
  wire: WireId                                 // 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini'
  endpoint: Endpoint                           // { defaultBaseUrl, path, decorateUrl?, redactForDump? }
  auth: AuthStrategy
  request: RequestShape                        // { maxTokensField, streamUsage: 'include_usage'|'always'|'none', mergeAdjacent }
  parts: PartCodec                             // wire 默认 codec 的参数化实例:imageDetail / imageSources / file 编码器对象 / toolResultMultimodal / video
  usage: UsageNormalizer                       // 默认路径表实例 或 自定义对象(Kimi 顶层 cached_tokens / DeepSeek hit_tokens / OpenRouter cost)
  reasoning: ThinkingWire[]                    // 该 provider 可能出现的线型(按模型由 profile 选其一)
  errors: ErrorMapper
  extraBody?: (turn: TurnContext) => Record<string, unknown>   // 逃生舱,也接受宿主/设置注入的 providerOptions
}
registerDialect(dialect)   // 注册表;settings 里 custom-* 可选 dialect: 'openrouter' 等
// 需要代码的 provider 允许薄子类:class KimiProvider extends OpenAIChatWire { constructor(ctx) { super(ctx, KIMI) } resolveThinkingIntent(...) {...} }
// —— 组合优先,必要时继承;不允许为了“每家一个类”而造空子类。
```

### 3.1 面向对象自检(v2.1)

| 原则 | 落地方式 | 守法 |
|---|---|---|
| 封装(行为跟数据走) | 方言配方的每个字段是**对象**;基类从不解释字符串枚举 | 架构测试:`base/` 下不得出现 `switch (dialect.` / `dialect.* === '` |
| 多态取代分支 | thinking / parts / usage / errors / auth 各是接口 + N 实现,按注册表取 | 同上 |
| 单一职责 | Http 基类只排序;每步一个策略;`AuthStrategy` 独占 401 重试 | 代码评审 |
| Tell, don't ask | 策略 `apply(turn, builder)` 自己写请求体并 `warn()`;基类不问“能不能” | 接口签名 |
| 值对象与不变量 | `UsageBuckets` / `ModelProfile` / `Undeliverable` / `ProviderWarning` / `ProviderHttpError` 都是带行为的对象;可见文案只在 `toText()` 一处 | 单元测试 |
| 实例无状态 | 每回合一个 `TurnContext`;provider 类无可写实例字段 | 架构测试扫类字段 |
| 模板方法 / 里氏替换 | `streamTurn` 顺序固定;子类只覆盖 hook | 架构测试:`HttpAgentProvider` 子类不得覆盖 `streamTurn` |
| 开闭 | 新方言 = 新配方 + fixture 目录;新能力 = 基类加一个 hook(唯一该改的地方) | §6 扩展性验证 |
| 接口隔离 | 配方按能力拆成小接口,各有默认实现 | 类型 |
| 依赖倒置 | 基类依赖策略接口;`ProviderContext` 由 backend provider-binding 注入 fetch/dump/logger/profiles | 边界 checker |
| 组合 vs 继承 | Base → Http → Wire 三层;方言靠组合;需要代码才薄子类 | 代码评审 |

## 4. 基类契约(草案)

```ts
export abstract class HttpAgentProvider<TBody, TChunk> extends BaseAgentProvider {
  protected constructor(protected readonly ctx: ProviderContext, protected readonly dialect: Dialect) { super(ctx) }
  // ProviderContext = { providerId, baseUrl, fetchImpl, dumper, logger, profiles: ModelProfileResolver, timeouts } —— 只读
  // —— 由 backend 的 provider-binding(bound-fetch / request-dump)组装注入;runtime 不反向依赖 backend。

  async *streamTurn(request: AgentTurnRequest): AsyncIterable<AgentTurnStreamEvent> {
    const turn = new TurnContext(request, await this.ctx.profiles.resolve(this.id, request.model), this.ctx.logger.child({ turn: request.turn }))
    // 1 prepare    this.parts.serialize(turn)                 → turn.builder.messages / turn.warnings(undeliverable 留痕)
    // 2 body       this.buildBody(turn);  this.thinkingFor(turn).encode(turn, turn.builder);  this.dialect.cache?.annotate(turn, turn.builder)
    //              this.toolChoice.apply(turn, turn.builder);  this.sampling.apply(turn, turn.builder);  this.dialect.extraBody?.(turn)
    // 3 auth       const headers = await this.dialect.auth.headers(turn)
    // 4 dump       await this.ctx.dumper.dump(turn, this.dialect.endpoint.redactForDump(url), turn.builder.forDump())
    // 5 send       response = await this.send(url, headers, turn)   // 内含 dialect.auth.onUnauthorized 重试、首字节/空闲超时
    // 6 errors     if (!response.ok) throw this.dialect.errors.fromResponse(response)
    // 7 stream     yield* this.parseStream(response, turn)          // wire 实现;方言缝:this.dialect.parts.decodeExtras(chunk, turn)
    // 8 finish     yield finish({ finishReason: this.finish.map(raw), usage: this.dialect.usage.toBuckets(raw).toAgentUsage(), warnings: turn.warnings })
    // finally      response?.body?.cancel()
  }

  // wire 必须实现
  protected abstract buildBody(turn: TurnContext): void                      // 往 turn.builder 写 wire 必有字段
  protected abstract parseStream(response: Response, turn: TurnContext): AsyncGenerator<AgentTurnStreamEvent, RawFinish>
  protected abstract get defaultParts(): PartCodec
  protected abstract get defaultUsage(): UsageNormalizer
  protected abstract get finish(): FinishReasonMapper
  // wire 默认,方言配方可替换(getter 只是 dialect.x ?? default)
  protected get parts(): PartCodec; protected get toolChoice(): ToolChoicePolicy; protected get sampling(): SamplingPolicy
  protected thinkingFor(turn: TurnContext): ThinkingWire   // 按 turn.profile.reasoningWire 从 dialect.reasoning 选
}
export class Undeliverable { constructor(readonly label: string, readonly reason: UndeliverableReason) {} toText(): string }
export type PartDelivery<W> = { kind: 'delivered'; part: W } | { kind: 'undeliverable'; note: Undeliverable }
export interface PartCodec<W = unknown> {
  system(text: string, turn: TurnContext): W
  user(part: AgentContentPart, turn: TurnContext): PartDelivery<W>
  assistant(message: AgentMessage, turn: TurnContext): W[]                // 思维链回传与块序(DeepSeek 带 tools 必回传 / Kimi keep=all / OpenRouter reasoning_details 原样 / Anthropic thinking 前置含 signature / codex encrypted)
  toolResult(part: AgentContentPart, turn: TurnContext): PartDelivery<W>
  decodeExtras?(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[] // 方言缝:reasoning_details / images[] / 顶层 citations / web_search
}
export class UsageBuckets {                                                  // 值对象;构造校验非负
  constructor(readonly uncachedInput: number, readonly cacheRead: number, readonly cacheWrite: number, readonly output: number,
              readonly reasoning?: number, readonly audio?: number, readonly providerCostUSD?: number, readonly raw?: unknown) {}
  get input(): number { return this.uncachedInput + this.cacheRead }
  toAgentUsage(): AgentUsage      // input / output / total=input+output / cacheRead / cacheWrite / reasoning / providerCostUSD —— 唯一投影
  billable(prices: OnethingUsageUnitPrice): number   // 与 computeOnethingUsageCostUSD 同一公式
  cacheHitRatio(): number
}
```
## 5. 逐家官方能力 × 设计落点(覆盖矩阵)

研究来源见 §12。“落点”列回答“这项能力在设计里由谁承接”;空格 = 本批不做(§9 P3 或明确不做)。

### 5.1 openai-chat wire 上的方言

| 能力 | OpenAI | DeepSeek | Kimi | Zhipu | Qwen | Grok | OpenRouter | 落点 |
|---|---|---|---|---|---|---|---|---|
| 图片输入 | `image_url{detail auto/low/high}` | 仅 vision-exp;`image_url{detail low/high/original/auto}` | data URI / `ms://` 只,无 detail | 无 detail | 无 detail | jpg/png ≤20MiB | detail 含 `original` | `DialectSpec.parts` + `ModelProfile.vision` |
| 文件/PDF | `file{file_id|file_data,filename}` | `file` 块仅图片 | 无块(Files API 取文本) | `file_url` | 未查到 | 仅 Responses | `file`+`plugins file-parser` | `parts.file` 种类(P3 功能批) |
| 音频/视频输入 | `input_audio` | — | `video_url` | `video_url` | `input_audio`(Omni)/ 帧 `video` | — | `input_audio`/`video_url` | 不做(能力不声明 → core 降级) |
| tool 结果多模态 | 只文本 | 只文本 | 未查到 | 未查到 | 未查到 | 未查到 | **可多模态** | `parts.toolResultMultimodal`(P3) |
| 思考开关/档位 | `reasoning_effort none|minimal|low|medium|high|xhigh|max`(按模型)、`verbosity` | `thinking.type` 默认 enabled;effort low/high/max | K3 顶层 effort low/high/max 常开;K2.6 `thinking.type/keep`;K2.7-code 固定开 | `thinking.type/clear_thinking`;5.3/4.7/4.5V 强制;effort 5.2+ | `enable_thinking/thinking_budget/preserve_thinking` | `reasoning_effort` 按模型(grok-4 不接受) | `reasoning{effort,max_tokens,exclude,enabled,context,mode}` | `ThinkingEncoder` 按账本 wire 建表;档位/默认/可否关 → `model-capability.ts` profile |
| 思维链字段/回传 | 无(官方) | `reasoning_content`;带 tools 必回传 | `reasoning_content`;K3/keep=all 必回传 | `reasoning_content`;clear_thinking:false 必回传 | `reasoning_content`;preserve_thinking | `reasoning_content` | `reasoning` + `reasoning_details[]` 必原样回传 | `reasoningFields` + `PartSerializer.assistant` 回传规则(按 profile) |
| tool_choice | none/auto/required/{function}/allowed_tools | 同 OpenAI | required 仅 K3 | **仅 auto** | 未文档化 | string/object | +server tools | `ToolChoicePolicy` + 账本 `supportsForcedToolUse` per-model |
| 工具其它 | `strict`、`parallel_tool_calls`、json_schema | 同 | json_schema strict | 无 json_schema;`tool_stream:true` 才流式 | parallel 示例显式 true;json_schema | strict 恒真;仅 function ≤128 | strict 因上游而异 | `extraBody`(tool_stream 按账本门控);structured output 不在本批 |
| 采样 | o/gpt-5 系拒收 | 思考时忽略 | **固定值,传错报错** | ≤1.0 | [0,2) | 推理模型禁 penalty/stop | 透传 | `SamplingPolicy` 按 profile |
| max tokens | `max_completion_tokens` | `max_tokens` | `max_completion_tokens` | `max_tokens` | `max_tokens` | `max_completion_tokens` | `max_tokens` | `maxTokensField` |
| usage | `prompt_tokens_details{cached,cache_write,audio,image}` / `completion_tokens_details{reasoning,audio,…}` | `prompt_cache_hit/miss_tokens` + reasoning | **顶层 `cached_tokens`** | `prompt_tokens_details.cached_tokens` | 同 + `cache_creation_input_tokens` | 同 + `cost_in_usd_ticks` | 同 + `cache_write_tokens` + `cost/cost_details/cache_discount`,usage 恒返回 | `UsageNormalizer` §7 |
| 缓存断点/键 | GPT-5.6+ `prompt_cache_breakpoint` + `prompt_cache_options{ttl}`;`prompt_cache_key` | 自动 | 自动;`prompt_cache_key`(Code Plan 必填) | 自动 | 隐式 + 显式 `cache_control` | 自动;`prompt_cache_key`/`x-grok-conv-id` | `cache_control`↔`prompt_cache_breakpoint` 互转;`prompt_cache_key` | `CachePolicy` + `cacheKey` 契约字段 |
| 流式 usage | `stream_options.include_usage` | 同 | 同 | 未文档化 | 同 | 同 | **已废弃,恒返回** | `streamUsage` |
| 错误体 | `{error:{message,type,param,code}}`;429 codes | 同 | `type` 为码;429 `exceeded_current_quota_error` | **`code` 数字串无 type**;finish `sensitive/network_error/…` | `type`+`code`;`insufficient_quota`/`Arrearage` | 无结构化定义 | `code`+`metadata.{error_type,provider_code,availability}`;402 | `ErrorMapper` + `FinishReasonMapper` |
| 图像输出 | 无(仅 Responses) | 无 | 无 | 无 | 无 | 独立端点 | `message.images[]`(`modalities`) | `parseDeltaExtras`(P3,与生图路由线合流) |
| 其它 | `service_tier`、`safety_identifier`、`store/metadata` | — | `partial:true` | `request_id`、`web_search` 工具结果顶层 | `enable_search` | `search_parameters` + 顶层 `citations[]` | `provider/models/plugins/session_id` | `extraBody` / `providerOptions` 袋 / `parseFinishExtras` |

### 5.2 其它三条 wire

| 能力 | Anthropic | Gemini | Responses(codex) | 落点 |
|---|---|---|---|---|
| 输入块 | text/image{base64|url|file}/document{pdf|text|content|url|file}/tool_result 可含图 | inlineData/fileData(Files API 2GB/48h)/视频帧/音频;functionResponse 可多模态 | input_text/input_image(detail 必填)/input_file(PDF) | `PartSerializer`(文档/PDF 已有,保留) |
| 思考 | `thinking{enabled budget|disabled|adaptive}` 按模型 400 表;`output_config.effort`;thinking 块必原样回传(含 signature/redacted,换模型剥离);新模型非默认 temperature/top_p/top_k 一律 400 | `thinkingConfig{thinkingBudget(2.5)|thinkingLevel(3.x), includeThoughts}`;3.1 Pro/3 Flash 关不掉;**thoughtSignature 函数调用必回传否则 400**;2026-07 起 temperature/topP/topK 弃用 | `reasoning{effort,summary}`;encrypted_content 回传 | `ThinkingEncoder` 表 + `SamplingPolicy` + 账本 per-model 400 表 |
| 工具 | tool_choice auto/any/tool/none + disable_parallel;`strict`;内置 server tools;structured `output_config.format` | functionCallingConfig AUTO/ANY/NONE/VALIDATED + allowedFunctionNames;googleSearch/codeExecution/urlContext/mcpServers;responseSchema | 内置 image_generation/web_search/…;`tool_choice` 扁平 | `ToolChoicePolicy`;内置工具只 codex 的 image_generation 走 `requestedOutputModalities` |
| usage | `input_tokens`(**不含缓存**)+ `cache_creation/cache_read` + `cache_creation{5m,1h}` + `output_tokens_details.thinking_tokens`;`message_delta.usage` 累计 | `promptTokenCount`(**含 cached**)/`cachedContentTokenCount`/`candidatesTokenCount`/`thoughtsTokenCount`(**不在 candidates 内**)/`totalTokenCount` | `input_tokens` + `input_tokens_details{cached,cache_write}` + `output_tokens_details.reasoning` | `UsageNormalizer` §7 |
| 缓存 | GA 无 beta 头;`cache_control{ephemeral, ttl 5m|1h}`;≤4 断点;最小 token 按模型 512–4096;thinking 块不可挂 | 隐式默认开(最小 2048/4096);显式 `cachedContents` | 同 OpenAI | `CachePolicy` |
| 错误/限流 | `{type:error,error:{type,message},request_id}`;402 billing_error/429/529;`anthropic-ratelimit-*`;流中 `error` 事件 | `{error:{code,message,status,details}}`;RetryInfo 现行文档未提 | 同 OpenAI | `ErrorMapper` |
| 弃用/迁移 | `prompt-caching-*`/`files-api-*`/`context-1m` beta 头已退役;`anthropic-version 2023-06-01` | generateContent 标 legacy(Interactions API GA)但完整支持;`?key=` → `x-goog-api-key` 头;1.5 系关停 | chat completions 未退役;Responses 推荐新项目 | `AuthStrategy` 改头;其余不动 |

## 6. 扩展性验证(“新参数是扩展还是修补”)

| 需求 | v2 要动的地方 | 判定 |
|---|---|---|
| (a) OpenAI `prompt_cache_options` / `prompt_cache_breakpoint` | `CachePolicy.openai` 一处(断点挂在内容块上)+ 账本一行“5.6+ 支持显式断点” | ✓ 加一处 |
| (b) OpenRouter `reasoning_details` 回传 | `DialectSpec.reasoningFields` 加 `'reasoning_details'`;`parseDeltaExtras` 投 provider-data;`PartSerializer.assistant` 的回传规则表加一行 | ✓ 三个既有缝,不碰其它家 |
| (c) 新家 MiniMax(OpenAI 兼容,自家 usage 字段) | `registerDialect({...})` 一个对象(usage 字段路径在表里)+ 账本模型行 + `__fixtures__/minimax/` | ✓ 零新类 |
| (d) Kimi K3 `tool_choice: required` 仅 K3 | 账本一行 `supportsForcedToolUse` | ✓ 零代码 |
| (e) Zhipu `tool_stream:true` | `extraBody` 一处 + 账本一行门控 | ✓ |
| (f) 某家新增 usage 字段(如 OpenAI `audio_tokens`) | `UsageNormalizer` 的字段路径表一处;若引擎要消费 → 先进 `providerMetadata` 袋,真跨家了再升契约 | ✓ |
| (g) 某家新增流式事件类型(如 Anthropic 新 block) | 对应 wire 的 `parseStream` 一处 + fixture | ✓(wire 内部) |
| (h) 新 provider 走**新线协议**(如 Interactions API) | 新 Wire 类(5 个抽象方法)+ 方言表 + fixture 目录 | △ 这是应该贵的那种 |

“加一处”成立的前提是 §13 采纳的四条:Dialect 组合配方化(字段为策略对象)、thinking 按账本 wire 建表、`assistant()` 与 `parseDeltaExtras` 两个缝、`CachePolicy` 独立策略。

## 7. usage 规范化:三桶直译表(每行一个固定样本)

| wire / dialect | uncachedInput | cacheRead | cacheWrite | output | reasoning | 备注 |
|---|---|---|---|---|---|---|
| openai-chat 默认 | `prompt − cached − cache_write` | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` | `completion_tokens` | `completion_tokens_details.reasoning_tokens` | 只认 `[DONE]` 前那块 |
| DeepSeek | `prompt_cache_miss_tokens`(或 prompt − hit) | `prompt_cache_hit_tokens` | 0 | `completion_tokens` | `completion_tokens_details.reasoning_tokens` | |
| Kimi | `prompt − cached_tokens`(疑:顶层 cached ⊂ prompt,样本证) | 顶层 `cached_tokens` | 0 | `completion_tokens` | — | |
| Zhipu / Grok / Copilot | 同默认 | 同默认 | 0 | 同 | 同 | Grok `cost_in_usd_ticks/1e10` → providerCostUSD |
| Qwen | `prompt − cached` | `prompt_tokens_details.cached_tokens`(或 `usage.cached_tokens`) | `cache_creation_input_tokens`(额外,不在 prompt 内) | 同 | 同 | |
| OpenRouter | `prompt − cached − cache_write` | `…cached_tokens` | `…cache_write_tokens` | 同 | 同 | `cost` → providerCostUSD;`cache_discount` 进 providerMetadata |
| Responses(codex) | `input − cached − cache_write` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` | `output_tokens` | `output_tokens_details.reasoning_tokens` | usage 在 `response.completed` |
| Anthropic | `input_tokens`(**直译**) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` | `output_tokens_details.thinking_tokens` | `message_delta.usage` 累计,取末值;**修正今天少算** |
| Gemini | `promptTokenCount − cachedContentTokenCount` | `cachedContentTokenCount` | 0 | **`candidatesTokenCount + thoughtsTokenCount`** | `thoughtsTokenCount` | **修正今天少算输出**;取最后一块 |
| 外部代理 claude-code-connector | 同 Anthropic 行(它自己也映射 usage,同 bug) | | | | | 不在继承树,但**必须同表修** |

投影:`input = uncachedInput + cacheRead`、`total = input + output`、`cacheWrite` 原样、`reasoning` 原样 —— 现行 `computeOnethingUsageCostUSD`(`input − cacheRead` 为计费输入)与账本字段零改动。

## 8. 契约层的最小增量(core)

| 项 | 变化 | 为什么 |
|---|---|---|
| `AgentUsage` | `+ providerCostUSD?` | 厂商报价(§10 决策 3);其它新字段走 `providerMetadata` 袋 |
| `AgentTurnRequest` | `+ cacheKey?: string`;`+ providerOptions?: Record<providerId, object>` | `prompt_cache_key`(Kimi Code Plan 必填;OpenAI/xAI/OpenRouter 提命中);逃生舱 |
| `AgentTurnStreamEvent.finish` | `+ warnings?: ProviderWarning[]`;`+ providerMetadata?` | §2.4 / §2.8 |
| `ProviderHttpError` | runtime 新类型(不进 core:core I2 断言与零依赖;分类器读鸭子形状) | §2.5 |
| 不动 | `AgentProvider`(静态 `capabilities` + `getModelCapabilities` 两个都给,回落链 `capabilities.ts:24` 不变);`AgentUsage` 其余字段;账本 `OnethingUsageTokens`;events.jsonl 的两种 usage 形状 | usage 字段手抄 11 处,不值得 |

## 9. 分期与门

| 期 | 内容 | 门(代理可自证) | 规模 |
|---|---|---|---|
| **P0a 纯搬运(✅ 2026-08-23 落地:骨架 450f4df2 + 快照基线 + 迁移提交)** | `base/`(Base / Http / 策略接口 / `ProviderContext` / `ProviderHttpError` / `DialectSpec` 注册表)+ `OpenAIChatWire`;11 个 openai-chat 方言从 `reasoningStyle` 枚举 + 注册旋钮迁成 `DialectSpec`;`deepseek.ts` 退役为 `DeepSeekDialect`(**保留**其错误前缀与 usage 字段,P0b 再改);`ModelProfile` = `resolveOnethingModelCapabilities` 薄壳;工厂函数名保留为构造门面(`createDeepSeekAgentProvider` 等,含 `runtime/src/providers/agent-turn.ts:16` 那条 utility 通路) | ① **请求体快照,白名单为空**:已落地 `__tests__/wire-snapshots/__fixtures__/openai-chat/<id>/`(11 家 × 5 请求用例 + events + error = 79 份,81 测试;JSON 按深度排序 key 比对,数组顺序逐字节;`sse.txt` 手写各家真实 usage 字段),`requestDumper` 注入 `vi.fn()` 拿完整 body(`cacheKey` 注入固定值);唯一已知语义差(deepseek 不读 `delta.reasoning`)在 P0a 用 `reasoningFields` 表保持原样;② 25 个既有测试文件(≈150 用例)零改动通过,包括 `capabilities` 静态字段/回落链、dumper `mode:'stream'`/`'codex-http'`、错误前缀;③ typecheck / boundary / architecture-boundaries 0;④ 元测试:每个已注册方言必须有 fixture 目录;⑤ 架构测试:`HttpAgentProvider` 子类不得覆盖 `streamTurn`、provider 类无可写实例字段、`base/` 下不得出现对方言字段的字符串分支 | 4–6 人日 |
| **P0b 行为修正(每项一个提交 + 一份“期望 diff”快照)** | usage 三桶 + 投影(含 DeepSeek/Kimi 字段、OpenAI `cache_write`)→ 修 DeepSeek/Kimi 缓存命中;DeepSeek vision(`parts` 按 profile 发 `image_url`)+ 账本 vision 行;`cacheKey` 透传;thinking effort 改读账本;`SamplingPolicy`(Kimi 不发 temperature)/ `ToolChoicePolicy`(Zhipu、Kimi-K2 `supportsForcedToolUse=false` 进账本);`warnings` 通道;基类日志/超时/finally/dump 截断;deepseek 读体 `.catch` 对齐;**快照基线实测补入**:copilot 无 thinking 线型却在 thinking 开时丢 temperature(SamplingPolicy 应以“本家是否真的会发 thinking 参数”为判据)、copilot 的 thinking/effort 静默丢弃 → warning;kimi 顶层 `cached_tokens`、deepseek `completion_tokens_details.reasoning_tokens`、openrouter `cost`/`cache_write_tokens`、qwen `cache_creation_input_tokens` 今天无人读取;工具调用 index 交错(idx0→idx1→idx0)时“index 切换即 done”会把 idx0 切成半截参数且不再发第二个 done(两份实现同源)—— 作为独立项拍板:是否改为“只在 finish_reason / 流末 done”,或保留早 done 但对后到的 delta 发补正;**迁移实测再补**:`totalTokens` 现为派生(UsageBuckets 无厂商 total 槽,拍板“一律派生”或加 `reportedTotal`)、DeepSeek `finish_reason:function_call` 现映射 `tool_calls`(旧为 unknown,官方不发此值)、空 apiKey 不再发空 `Bearer`、基类忽略 dumper 返回值故 deepseek 的 `requestDumpPath` debug 日志消失(给模板加落点)、dump 的 data-URI 截断(`forDump()` 已有,模板接线)、`ErrorMapper` 返回类型收窄回 `ProviderHttpError` 随 P1 | 每项:请求体 diff 快照(人审)+ usage 固定样本(§7)+ 投递契约 `describe.each(openaiChatDialects)`;真机一次性核对清单(vision-exp 发图走 `image_url`;Kimi Code Plan 请求带 `prompt_cache_key`)—— 不当门 | 2–3 人日 |
| **P1 其它三条 wire(✅ 全部落地:P1-a 12f2d68a anthropic / P1-b 04e3090a gemini / P1-c 9a426326 codex / P1-d1 c200ee66 ProviderHttpError 全线+分类器/retry 读对象+acp·external 继承 Base / P1-d2 usage 修正(Anthropic 输入 1200→2000、Gemini 输出 248→344)+ 第二套 codex 死路删净 2210→720)** | `AnthropicMessagesWire` / `GeminiWire` / `OpenAIResponsesWire` 上 `HttpAgentProvider`(send/runTurn/dump/抛错/日志/finally 共享,序列化/请求体/流解析留各家);`ProviderHttpError` 全线 + 分类器对 provider 错误改读对象(OAuth 刷新错误路径保留前缀抠取);`retry.ts:96` 全文状态码正则收紧为读对象;Anthropic / Gemini usage 修正(含 `claude-code-connector` 那份);acp / external 继承 Base;**第二套 codex**:删 `doStream/doGenerate` 请求路径(生产零调用方),留模型列表 / 用量拉取 / 元数据;Responses wire 带非 codex 冒烟或改名;**P1 门 ① 实测补入(2026-08-23 基线 49 份)**:claude 家族正则把老式带日期 id(`claude-3-7-sonnet-20250219`)的日期段当 major → 误判 adaptive/modern(thinking 线型与 temperature 都错),修正=行为变更需列期望 diff;gemini 孤儿 tool 结果退回 toolCallId 当函数名(保留,记入 warning);`isError` 只有 anthropic 有出口(codex/gemini 对模型不可见 → P3 功能项);codex dump 在 token 解析/401 重试之前且无 `turn`(统一后变,期望 diff);codex `include` 与 reasoning 同生共死、effort max 钳 high、指名工具扁平 `{type,name}`(迁移必须逐字复刻) | 快照扩到三家(已落地:anthropic 29 / gemini 11 / responses 9);分类器测试改形状;retry-after 五家套件改 `describe.each`;codex dump 时序与 metadata 变化列入期望 diff | 5–7 人日 |
| **P2 能力合一(P2-a 已落地:ModelProfile 唯一能力源、factory overlay 退役 −108 行、账本 +anthropic-always/+forcedToolUse/Claude 家族判定单函数、kimi 家规下沉 Dialect.thinkingIntent、custom-* 可点名 dialect(配置层,无 UI)、delivery-invariant 65 用例;P2-b 待:生图路由改读 servedBy、gemini 去 query key、CachePolicy、FinishReasonMapper)** | `ModelProfile` 并入远端元数据(OpenRouter `/models.reasoning`、Codex `nativeTools`);factory 的 `withPerModelCapabilities` / `runtimeCapabilityFlags` / `capabilitiesFromFlags` / `capabilityLimitsFromRuntimeConfig` 退役;`custom-*` 可选方言;思维链回传规则按 profile;`CachePolicy`;`FinishReasonMapper`(context-overflow → 压缩层);生图路由判据改读 `ModelProfile.imageOutput.servedBy`(同时改 `runtime/model-registry.ts` 与 `backend/wiring/providers/model-registry.ts`) | 架构测试:任何 provider 的 `getModelCapabilities(model).inputModalities` 声明的模态,其 `parts.user` 必须 `delivered`(枚举全矩阵);`model-registry.test` 的“换通路 ≠ 能出图”断言保持 | 4–6 人日 |
| **P3 功能批(各自独立;P0b-B 十一项已于 784536ac / c7a91d8b 全部落地;P3-1 77be9bb7 PDF 块:OpenAI `file` + OpenRouter `file`+file-parser(native),Zhipu `file_url` 需 http URL 未做;P3-2 OpenRouter 图像输出回普通流:账本 openrouter+imageOutput ⇒ servedBy in-loop、请求 `modalities`、`decodeExtras` 认 `delta.images[]`/`message.images[]`(流式形状 OpenAPI 未声明,按非流式项形状假定,**待真机核**)、provider-data 图像落点由 provider==codex 特判改按 type 判(http URL 只写 markdown 链接不落库);顺带修 OpenAIChatWire.parseStream 此前未调 decodeExtras 缝);P3-3 `reasoning_effort:'none'`(账本 openai gpt-5.1+ efforts 含 none 作线协议能力标记、不进 UI 档位,openai-effort 线型 disabled 时发 none)+ `providerOptions` 命名空间袋落地(core AgentTurnRequest.providerOptions,宿主从 settings `providerOptions.request` 子键注入、stored→runtime 原样带过,openai 白名单 verbosity/imageDetail,deepseek/grok/openrouter 收 imageDetail 写 image_url.detail,非白名单键/非法值丢弃+warning,无设置 UI)** | PDF 文件块(OpenAI `file` / OpenRouter `file`+plugins / Zhipu `file_url`);OpenRouter `message.images[]` 图像输出(与生图路由线合流);`reasoning_effort:'none'` / `detail` / `verbosity`;OpenRouter `reasoning_details` 回传;Grok `search_parameters`;tool 结果多模态(OpenRouter);Responses 通路给 openai/grok(可选) | 每项独立 fixture | 3–5 人日 |

合计 18–27 人日(opus 执行),审查另 ~5 人日。

不做(与 `provider-abstraction.md` §12 一致):Files API 上传型文件、音频输入输出、把 openai 默认切到 Responses、Interactions API、插件式 provider 加载。

## 10. 需要拍板的行为变更

> **2026-08-23 拍板结果**:1 改、2 codex 也合并、3 做(并存不覆盖)、4 五家(openai/kimi/kimi-code/grok/grok-oauth/openrouter)默认发 sessionId、5 两件都做、6 改、7 保留早 done 只加交错告警、8 挂、9 不拆(走 P3 PDF 块)、10 不做、11 修。执行排期:泳道甲 B(4/5a/8)→C(1/2/7);泳道乙 A(5b/6/11)→D(3);泳道间并行、泳道内顺序,`-u` 只许 `-t` 限定自己的用例。

1. **错误形状统一**(P1 形状已统一;P0b-B C 批前缀已改为小写 providerId,含 claude-code / custom-* 用自己的 id;分类器锚定抠取不看家名零改动;renderer error-humanizer 先 toLowerCase 再子串匹配不受影响)。
2. **codex 相邻同角色合并**:基类开关默认 true,codex 设 false 保持今天行为,还是跟大家一致?
3. **厂商报价进账本**:`providerCostUSD` 与本地价目**并存**(`pricingQuality: 'provider-reported'`),聚合时显式选口径,永不覆盖本地值 —— 这是建议,要不要做?
4. **`cacheKey = sessionId`**:对 OpenAI/xAI/Kimi/OpenRouter 默认发(不透明 id,但离开本机),还是设置项?
5. **Kimi 不再发 temperature;Zhipu / Kimi-K2 `supportsForcedToolUse=false`**(强制首调退成 auto;runner 对 false 的处理是“不发参数”,不抛)。
6. **账本 DeepSeek v4 `defaultOn:true`**(API 默认思考,账本写反,UI 显示“关”而线上在思考)。
7. **usage 修正的可见影响**:Anthropic 缓存回合的输入、Gemini 的输出会**变大**(变准),账本历史不迁。(P1-d2 已落地)
8. **kimi-code 是否挂 kimi 思考家规**:今天套餐通路走通用规则,对 k2.7-code 关思考会发出它拒收的 `thinking:{type:'disabled'}`;挂上即修(P2-a 已备好 `Dialect.thinkingIntent`,一行)。
9. **`file` 模态是否从 vision 里拆成独立能力行**:账本今天 `vision ⇒ inputModalities 含 file`,而 chat-completions 没有可移植 PDF 块 → 8 家 openai-chat 方言的 `user/file` 不变式今天违反(`it.fails` 钉住);要么 P3 按家做 PDF 块,要么账本拆行(行为变更:这些家的 `getModelCapabilities` 不再声明 file,core 会把 PDF 降级成可见占位)。
10. **静态 `capabilities` 是否改为“默认模型的账本投影”**:今天是纯传输声明;改了会动 provider-factory.test 的 custom-* 三条与 deepseek `maxInputTokens`。
12. **传输声明是否只在 codec 能投递时才声明 `file`**:P3-1 后 delivery-invariant 仍有 6 条 `it.fails`(custom-openai 能力未知;copilot/grok/deepseek/qwen/kimi 无可移植 PDF 块)。若改为“codec 不能投递就不声明 file”,core 会把这些家的 PDF 降级成可见占位 `[File: x.pdf]`(与今天的 provider 留痕文案不同、位置不同,但同样可见);不改则这 6 条永远 `it.fails`。
11. **Claude 家族正则的日期段 bug**(`claude-3-7-sonnet-20250219` 判成 adaptive/modern):现由账本单函数持有,修一处即全修;是行为变更(3.7 改回 budget 线型、允许 temperature)。

## 11. 与在途工作的关系

- “DeepSeek 图像输入”(方案三)= **P0b 的一项**,不单独做。
- 生图路由:P2 改判据为 `ModelProfile.imageOutput.servedBy`;P3 解析 OpenRouter `images[]` 后,能聊天的图像模型回普通流;纯生图端点(dall-e / gpt-image / grok-imagine)维持专用流(已拍:不做 generate_image 工具)。
- 08-21 的 codex 出图修复(`codexMetadataDeclaresImageOutput`)在 P2 并入 `ModelProfile`。
- `provider-data.ts` 的 `provider === 'codex'` 特判是**渲染落点**(消息上留 text 还是 provider-data),不随本篇消失;P3 图像输出通用化时再议。
- `backend/provider-binding/{bound-fetch,request-dump,ai-settings-compose}` 是 I1 判过的脊柱件:它们负责**组装** `ProviderContext`(fetch 策略、dump 落盘、设置合成),runtime 的基类只声明接口,不反向依赖 backend。

## 12. 研究摘要(2026-08-22,六路代理,官方来源)

**OpenAI**:usage 新增 `cache_write_tokens`(读 0.1× / 写 1.25× / 未缓存 1×;无“未命中”字段);缓存分两代(GPT-5.6+ 显式 `prompt_cache_breakpoint` + `prompt_cache_options{ttl:'30m'}`,旧模型自动前缀 + 已弃用的 `prompt_cache_retention`);`prompt_cache_key` ≤~15 rpm/key;`reasoning_effort` 七值随模型;`verbosity`;`max_tokens`/`user`/`seed` 弃用;内容块 `text|image_url{detail}|input_audio|file`,tool 消息只文本;chat completions **无图片输出**;Responses 推荐但 chat 未退役;Assistants 2026-08-26 关停;429 codes `credit_balance_exhausted` 等,头 `Retry-After`/`x-ratelimit-*`。文档 URL 加 `.md`。
**Anthropic**:**总输入 = `input_tokens` + `cache_creation` + `cache_read`(互斥)**;`cache_creation{5m,1h}`、`output_tokens_details.thinking_tokens`;缓存 GA 无 beta 头、≤4 断点、最小 token 按模型 512–4096、thinking 块不可挂;thinking `enabled|disabled|adaptive` 按模型 400 表(Fable 5 / Opus 5 / Sonnet 5 仅 adaptive;新模型非默认 temperature/top_p/top_k 一律 400);`output_config.effort` / `.format` GA;thinking 块必原样回传(含 signature),换模型剥离;`message_delta.usage` 累计;402 `billing_error`、529、`anthropic-ratelimit-*`;流中 `error` 事件;`files-api`/`prompt-caching`/`context-1m` beta 头已退役。
**Gemini**:`promptTokenCount` 含 cached;`totalTokenCount = prompt + thoughts + candidates`(思考不在 candidates 内);隐式缓存默认开(最小 2048/4096);`thinkingLevel`(3.x)/ `thinkingBudget`(2.5);3.1 Pro / 3 Flash 关不掉;**`thoughtSignature` 函数调用必回传**;2026-07 起 temperature/topP/topK 弃用;图像以 `inlineData` part 回;functionCallingConfig `AUTO|ANY|NONE|VALIDATED`;`x-goog-api-key` 头;generateContent 标 legacy(Interactions API GA)但完整支持;1.5 系关停。
**DeepSeek**:仅 vision-exp 收图(`image_url`/`file` 块,只在 user);v4 **默认思考**、effort `low|high|max`;思考下 temperature 忽略;usage `prompt_cache_hit/miss_tokens` + reasoning;带 tools 多轮必回传 `reasoning_content`。
**Kimi**:usage 顶层 `cached_tokens`;缓存全自动;`prompt_cache_key`(Code Plan 必填);图片只 data URI/`ms://`;K3 常开 + 顶层 effort;K2.6 `thinking.type/keep`;K2.7-code 固定开;**temperature 固定值传错报错**;`required` 仅 K3;`max_completion_tokens`;429 `exceeded_current_quota_error`。
**Zhipu**:`prompt_tokens_details.cached_tokens`;`thinking.type/clear_thinking`,5.3/4.7/4.5V 强制;effort 5.2+;`file_url`;**`tool_choice` 仅 auto**;无 json_schema;temperature ≤1;错误 `{error:{code:"1001"}}` 无 type;finish 多 `sensitive`。
**Qwen**:业务空间专属域名;`prompt_tokens_details.cached_tokens` + `cache_creation_input_tokens`(显式 `cache_control`);`enable_thinking/thinking_budget/preserve_thinking`;视频帧块、`input_audio`;`enable_search`;429 `insufficient_quota`、`Arrearage`。
**Grok**:chat completions 标 legacy;usage +`cost_in_usd_ticks`/`num_sources_used`;`reasoning_effort` 按模型(grok-4 不接受;4.6 xhigh);strict 恒真;图像输出独立端点;`search_parameters`。
**OpenRouter**:`usage:{include}`/`include_usage` 已废弃,usage 恒返回(+`cost`/`cost_details`/`cache_write_tokens`/`cache_discount`);统一 `reasoning{}` + `reasoning_details[]` 必原样回传;`message.images[]` 图像输出;`file`+plugins;tool 消息可多模态;`provider`/`models` 路由;402;`Retry-After`;`error.metadata.raw` 已不存在。

## 13. 评审记录(v1 → v2)

**采纳(架构评审)**:usage 三桶(作为规范化中间表示,外部契约不变);P0 拆 P0a/P0b;Dialect 配方化 + `custom-*` 可选方言(v2.1 进一步要求配方字段为策略对象而非被解释的字符串,见 §3.1);thinking 按账本 wire 建表;`PartSerializer.assistant()`;`parseDeltaExtras/parseFinishExtras`;`ModelProfile` P0 即落(薄壳);模态降级单一 owner;`warnings` + 双向命名空间袋;`CachePolicy`;`FinishReasonMapper`;运行期纪律(无状态 / 晚绑定 / finally / 超时 / 流中错误 / dump 截断);`streamUsage` 方言差;Responses wire 单租户风险;provider-binding 边界;fixture 目录 + 元测试。
**采纳(代码事实核对)**:第二套 codex(删请求路径留元数据);`capabilities` 静态字段 + `getModelCapabilities` 两个都给;deepseek/OC 的 `delta.reasoning` 语义差进 `reasoningFields` 表;`runTurn` acp 差一句守卫;行数 4094 / 可删 ≈1550;三段兜底对 OAuth 刷新错误保留;codex dump 时序与 metadata 变化列入期望 diff;测试受影响面 25 文件 ≈150 用例(非“9 个”);fixture ~60 非 768;usage 字段手抄 11 处 → 不改外部形状;`agent-turn.ts` / `agent-runtime-route.ts` / `utility-provider.ts` / `claude-code-connector.ts` / `retry.ts:96` 列入去留;`ProviderHttpError` 放 runtime;exports 只需 `base/index` 一条精确 key;acp/external 继承 Base。
**未采纳/另议**:“继承改组合”——用户要求 provider 类实现抽象 provider,保留继承,以架构测试守“模板方法顺序不可覆盖”;Gemini `thoughtsTokenCount ⊄ candidates` 已由研究证实,不再标疑;Kimi 顶层 `cached_tokens ⊂ prompt_tokens` 仍标疑,P0b 样本证。
