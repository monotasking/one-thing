/**
 * K4-a —— 资源自述的 `state` 进提示词,**经变量系统**
 * (`docs/design/atom-2026-09.md` §4「提示词」那一行:「`state` 里 `stable` 的进
 * system,`turn` 的进 `<context-update>` 尾块按块去重,`live` 的只在工具结果里」,
 * 后面跟着一句「= 变量系统,不另立」)。
 *
 * 这只 provider 就是那句「不另立」:它把注册表里已经声明过的状态摊成一批普通的
 * 只读 state 变量,剩下的路(排序 → `formatStateVariablesForPrompt` → 尾块按 section
 * 去重)一步都不新造。
 *
 * ── 这里一个 scheme 名都没有 ────────────────────────────────────────────────
 * 变量名、说明、值,三样全是 gateway 交来的事实里现读的。§8 陌生能力演练(接一个
 * 邮箱)要的答案是「能力自己的模块 + 一行注册」——如果提示词这一侧按 scheme 枚举,
 * 那次演练在这只文件上就当场失败。
 *
 * ── 三档 volatility 各自的下场 ──────────────────────────────────────────────
 *   · `turn`   —— **只有它进这块板**。它正是变量侧那一格布尔 `state` 的含义
 *                 (`../types.ts:38-51`:三档折成布尔时 `turn → true`),两边同一个词
 *                 同一个意思,不是巧合。
 *   · `live`   —— 一律不投。判据不是「变得太快」而是「已经有一份真相了」:
 *                 `music.nowPlaying` 那一格在变量板上早就有 `MusicRadioProvider`
 *                 交出来的 `music` 变量,再投一份 = 同一件事两个变量、两种写法、
 *                 两个会漂移的口径。而且 live 的读法未必是纯内存的,每回合读一次
 *                 就是 `music-radio.ts` 文件头那条硬约束(「provider 每回合跑,
 *                 绝不能花一次子进程」)的反面。
 *   · `stable` —— 今天**零个产地**。它该进的是 system 前缀而不是这块尾块板
 *                 (前缀跨会话逐字相同,那正是 `stable` 这个词的定义),所以把它
 *                 塞进这里等于把一件本来免费的事变成每回合都在尾块里重说一遍。
 *                 第一个 `stable` 状态出现时该开的是提示词那一侧的一条 `system`
 *                 通道片段,不是在这只文件里放行一档。留账,不是缺口。
 *
 * ── 留账:「逐字相同」是**这种资源自己**要保证的,这只文件只保证确定性 ─────────
 * 尾块的去重按 **section** 比字节,而整块变量板是**一个** section(`variables`),
 * 所以任何一格 state 的值一动,整块板就重发一次(它进的是尾块,不碰 system 缓存
 * 前缀,代价是每回合几百字节的重复,不是缓存失效)。这只文件能保证的是「同一个值
 * 序列化出同样的字节」;**同一格状态在两个回合之间值变不变,是那种资源自己的事**
 * ——`datetime` 把时间压到小时粒度、`music-radio` 不带进度与时长,都是那种资源
 * 各自付的账。今天已知的一笔:会话摘要带 `messageCount`,它每回合都在动,于是
 * 只要这一格在板上,`variables` 这个 section 就每回合重发。
 *
 * **K4-a' 把那笔账还了,办法是「自述说了算」**:`state` 的 schema 从此就是这格状态
 * 进提示词的**键集**,投影只取 `properties` 里声明过的键(`projectDeclaredState`)。
 * 会话那份自述因此给 `state.current` 自己列了一张表(不再引用 `get` 的那份),把
 * `messageCount` 与 `createdAt` 减掉。这只文件仍然不认识任何键名 —— 减法住在能力
 * 那一侧,投影方只读表。
 *
 * ── 值为什么一律走 JSON ────────────────────────────────────────────────────
 * `format.ts` 的渲染只取值的**第一行**(其余折成 `(+N more lines)`),所以一格会
 * 换行的值等于把自己的后半截扔了。稳定序列化因此有两条硬要求:**恒定一行**、
 * **同一个值恒定同样的字节**。键排序的紧凑 JSON 两条都满足(字符串里的换行被转义
 * 成 `\n`,键序不随对象构造顺序抖动),而 `k: v` 行两条都不满足。代价是标量会带上
 * 引号 —— 那是买这两条性质的价钱,不是疏忽。
 */

import { RESOURCE_STATE_VARIABLE_PREFIX } from '../types.js'
import type { ContextVariable, VariableContext, VariableProvider } from '../types.js'

/**
 * 一份 JSON Schema,**在这只文件里只有一格有意义**:`properties`。
 *
 * 写成结构类型而不是 `import type { JsonSchema }`,是因为这一层真的只需要那一格 ——
 * 投影方不校验、不解释、不认识任何键名,它只问「这份自述对键集表过态没有」。索引
 * 签名是那句「其余的格子照旧原样带过,不是我的事」。
 */
export type StateKeySchema = { readonly properties?: unknown; readonly [key: string]: unknown }

/**
 * 一格状态的事实。**带 `volatility`**:哪一档能进提示词是这只 provider 的判断
 * (它才认识提示词双通道),而 gateway 只负责把注册表上的话原样转述过来。
 */
export interface ResourceStateFact {
  readonly scheme: string
  /** 状态名(自述 `state` 那张表的键)。 */
  readonly name: string
  /** 自述里那句人话,直接当变量的 `description`。 */
  readonly title: string
  readonly volatility: 'stable' | 'turn' | 'live'
  /**
   * 这格状态的 schema(自述 `StateSpec.schema` 原样转述)。**它是键集**:投影只取
   * 这张 `properties` 里声明过的键 —— 见 `projectDeclaredState`。缺席 = 这台 gateway
   * 没有 schema 可交,值原样投。
   */
  readonly schema?: StateKeySchema
  /**
   * 读回来的值。`undefined` = 这一格这一回合**没有值**(没去读、读失败、或者
   * 这条会话上就没有它)—— 变量随之不出现,而不是出现一格 `undefined`。
   */
  readonly value?: unknown
}

/**
 * 宿主适配器。**读必须是 cache-backed 的**(`music-radio.ts` 那条硬约束的同一句
 * 话):`list()` 每回合跑一次,一次子进程就是每回合一次子进程。今天唯一的 turn 档
 * 状态是会话摘要,它走的是纯内存读面。
 */
export interface ResourceStateVariableGateway {
  /**
   * 这台宿主的注册表上,声明过 `state` 的每一格。同步或异步都行 —— 取值要过资源
   * 内核那条读路,而它是异步的。
   */
  listStates(sessionId: string): ResourceStateFact[] | Promise<ResourceStateFact[]>
  /**
   * 有状态变了就叫一声。带 sessionId = 只有那条会话的板要重算;不带 = 广播。
   */
  onChange?(emit: (sessionId?: string) => void): () => void
}

/**
 * 变量名 = 前缀 + 命名空间 + 状态名。
 *
 * 三处妥协各有理由:
 *   · 前缀 —— 见 `RESOURCE_STATE_VARIABLE_PREFIX`(保留名规则的落点);
 *   · 分隔符是 `_` 不是 `.` —— 变量名的语法是 `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`
 *     (`../validation.ts`),点号根本进不来。为一格提示词好看去改全仓变量名语法,
 *     换来的是 `variable` 工具的参数、存量 `variables.json` 的键、四种 scope 的
 *     store 全都要跟着重新定义合法性 —— 不成比例。
 *   · scheme 里的连字符折成下划线 —— scheme 语法(`[a-z][a-z0-9-]*`)允许连字符,
 *     变量名语法不允许。折叠不会撞车:scheme 里不可能出现下划线,所以 `a-b` 折出来
 *     的 `a_b` 只可能与一个叫 `a_b` 的 scheme 撞,而那种 scheme 登记不进来。
 */
export function resourceStateVariableName(scheme: string, state: string): string {
  return `${RESOURCE_STATE_VARIABLE_PREFIX}${scheme.replace(/-/g, '_')}_${state}`
}

/**
 * 按自述的 schema 过滤一个状态值:**只留 `properties` 里声明过的键**(K4-a')。
 *
 * 这是「能力自述、别人读表」在提示词这一侧的落点。`state` 的 schema 从此不只是
 * 一份文档,它**就是**这格状态进提示词的键集 —— 一种资源想少喂几格(会话那份自述
 * 减掉每回合都在动的 `messageCount`,理由写在它自己那张 schema 上),改的是它自己
 * 的自述;投影方这一侧一个键名都不认识,新接一种资源时这只函数一个字都不用改。
 *
 * 三条边界,都是「说不出话就别装作听懂了」:
 *   · schema 没有 `properties`(或者压根没 schema)—— 那份自述没有对键集表过态,
 *     整值原样投。空对象 `{}` 与「没说」不同,它是「一个键都不要」,照字面办。
 *   · 值不是对象(标量、数组、null)—— `properties` 对它无话可说,原样投。
 *   · 声明了但值里没有的键 —— 不补 `undefined`,缺席就是缺席(与 provider 那一侧
 *     「一格没值就不出现」同一条)。
 *
 * **只过一层**:嵌套要过滤就得认识 `items` / `oneOf` / `$ref` 那一整套,那是校验器
 * 的活。今天的状态 schema 都是一层平表,真出现要过滤嵌套的那一天,该长的是校验器
 * 的一次复用,不是在这里手抄半个 JSON Schema。
 */
export function projectDeclaredState(
  value: unknown,
  schema: StateKeySchema | undefined,
): unknown {
  const properties = schema?.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(properties as Record<string, unknown>)) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key]
  }
  return out
}

/**
 * 一个值的稳定序列化:**恒定一行、同一个值恒定同样的字节**(理由在文件头)。
 *
 * 键排序是这两条里更容易被忘掉的那一条:`JSON.stringify` 按对象的构造顺序写键,
 * 而同一份摘要在不同代码路径上可能以不同顺序拼出来 —— 那样尾块的逐字去重会每回合
 * 判「变了」,而值其实一模一样。
 *
 * `undefined`(以及函数、symbol)在对象里**整格省掉**,与 `JSON.stringify` 同义;
 * 数组里的这些位置照 JSON 的规矩变成 `null`。
 */
export function stableStateValue(value: unknown): string {
  return render(value)
}

function render(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(item => renderInArray(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(record).sort()) {
      const rendered = renderOrOmit(record[key])
      if (rendered !== undefined) parts.push(`${JSON.stringify(key)}:${rendered}`)
    }
    return `{${parts.join(',')}}`
  }
  const json = JSON.stringify(value)
  // `undefined` / 函数 / symbol 在顶层。JSON 里没有它们,而空串会被 `format.ts`
  // 当成「没有值」整行跳过 —— 那正是想要的下场。
  return json === undefined ? '' : json
}

function renderOrOmit(value: unknown): string | undefined {
  const rendered = render(value)
  return rendered === '' ? undefined : rendered
}

function renderInArray(value: unknown): string {
  const rendered = render(value)
  return rendered === '' ? 'null' : rendered
}

/**
 * 只读 state 变量,一格状态一条。写面一格都没有:状态是资源自己的事,改它要走
 * 那种资源的做法(`ResourceKernel.do`),不是从变量板上覆盖一个值。所以 `claims`
 * 认领整条前缀 —— 认领了才拿得到 `READONLY` 这句实话,不认领就是 `NO_PROVIDER`
 * (「没人管这个名字」),而那是假的。
 */
export class ResourceStateProvider implements VariableProvider {
  readonly id = 'resource-state'
  /** 紧跟 `music-radio`(23):都是「宿主子系统的当下状况」那一族。 */
  readonly priority = 24

  constructor(private readonly gateway: ResourceStateVariableGateway) {}

  async list(ctx: VariableContext): Promise<ContextVariable[]> {
    const facts = await this.gateway.listStates(ctx.sessionId)
    const out: ContextVariable[] = []
    for (const fact of facts) {
      if (fact.volatility !== 'turn') continue
      if (fact.value === undefined) continue
      out.push({
        name: resourceStateVariableName(fact.scheme, fact.name),
        // 先按自述的键集减,再序列化 —— 没声明的键一个字节都不进板。
        value: stableStateValue(projectDeclaredState(fact.value, fact.schema)),
        readonly: true,
        state: true,
        description: fact.title,
      })
    }
    return out
  }

  claims(name: string): boolean {
    return name.startsWith(RESOURCE_STATE_VARIABLE_PREFIX)
  }

  onExternalChange(emit: (ctx?: VariableContext) => void): () => void {
    // 在 gateway 上调,不把方法摘出来:摘出来就丢了 `this`,而 gateway 是宿主写的
    // 对象字面量,它有权在自己身上记状态。
    if (!this.gateway.onChange) return () => {}
    return this.gateway.onChange(sessionId => emit(sessionId ? { sessionId } : undefined))
  }
}
