/**
 * K3-a —— `resources`:元工具(`docs/design/atom-2026-09.md` §4「AI 工具」那一行的
 * 第二半句:「**一个元工具 `resources`(列 scheme、描述某个 scheme、查地址)**」)。
 *
 * ## 它存在的理由是提示词预算,不是好看
 *
 * §7 盲点 1 写得很直白:「提示词膨胀:必须靠回合面减法 + `apps` 元工具按需展开;
 * 否则 20 个应用就是 09-02 那种『工具结果占请求 80%』的翻版」。每个在场的命名空间
 * 一只工具,意味着模型每一回合都要读完全部命名空间的全部做法;而一次真实的对话里
 * 用得上的通常只有一两个。元工具把「有哪些」与「怎么用」拆成两步:清单便宜(一行
 * 一个命名空间),详情按需拉。
 *
 * ## 它不认识任何一个命名空间
 *
 * 它读的全部是注册表交出来的自述 —— 与 `tool.ts` 同一条纪律,由
 * `__tests__/stranger.test.ts` 的词边界扫描执法。所以「接一个邮箱」之后它自动会列
 * 那个邮箱,这只文件一个字都不改。
 *
 * ## 为什么它自己不是一只 `ResourceTool`
 *
 * `ResourceTool` 是**一份自述的投影**,而元工具答的是「有哪些自述」—— 那不是任何
 * 一种资源上的读法。给它造一份假自述(`meta:` 之类)会立刻自相矛盾:注册表里就会
 * 多出一个没有实现、也不该被 `describe` 列出来的命名空间。所以它是一只普通
 * `Tool`,只不过手里有那张表。
 *
 * ## 零效果,恒静默
 *
 * `plan` 造的是 `Intent.none` —— 读注册表不产生任何需要授权的效果。它仍然走完整条
 * 管线(拦截 / 预算 / 审计),与资源上的「读」那一支同一个位置。
 */

import { Intent } from '../toolkit/intent.js'
import { textResult, type Result } from '../toolkit/result.js'
import { Tool } from '../toolkit/tool.js'
import type { ToolSpec } from '../toolkit/spec.js'
import type { ResourceRegistry } from './registry.js'
import type { JsonSchema, OpSpec, ReadSpec, ResourceSpec } from './spec.js'
import { isJsonObject } from '../json.js'

/** 这只工具的 id。出口层(目录对账、投影排除)读它,不许各自写字面量。 */
export const RESOURCE_META_TOOL_ID = 'resources'

/** 一次调用的两支。`describe` 那支带命名空间名。 */
export type ResourceMetaCall =
  | { readonly kind: 'list' }
  | { readonly kind: 'describe'; readonly scheme: string }

/**
 * 调用形状不对(既没说 `list` 也没说 `describe`)。
 *
 * 与 `ResourceCallShapeError` 分开的理由和那一条自己的理由一样:两句不同的人话
 * 合成一句,模型只会去猜自己是不是把名字拼错了。这一条不带 scheme —— 元工具没有
 * 命名空间可报。
 */
export class ResourceMetaCallShapeError extends Error {
  constructor() {
    super(`${RESOURCE_META_TOOL_ID}: the call names neither \`list\` nor \`describe\``)
    this.name = 'ResourceMetaCallShapeError'
  }
}

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      description: 'List every namespace that is available right now.',
      properties: { list: { type: 'boolean', const: true } },
      required: ['list'],
    },
    {
      type: 'object',
      description: 'Describe one namespace: what it can do, what it can be asked, what it reports.',
      properties: {
        describe: { type: 'string', description: 'The namespace name, i.e. the left half of an address.' },
      },
      required: ['describe'],
    },
  ],
}

/**
 * 提示词贡献。**两句话,不是一份手册**:它进的是 system 前缀,而前缀里每一个字节
 * 都要跨会话逐字相同地付出去。具体命名空间有哪些、每条做法收什么参数,是
 * `describe` 与工具定义(schema)答的问题,不是这里。
 */
const META_TOOL_PROMPT = {
  guidelines: [
    `To operate something you have not been given a tool for, call \`${RESOURCE_META_TOOL_ID}\` with ` +
      `\`{"list": true}\` to see the available namespaces, then ` +
      `\`{"describe": "<namespace>"}\` to learn its actions, then call the tool named after that namespace.`,
  ],
} as const

function countOf(table: object): number {
  return Object.keys(table).length
}

/** 一坨入参 schema 的一行摘要:`a*: string, b: number`。必填打星号。 */
function summarizeSchema(schema: JsonSchema): string {
  const properties = schema.properties
  if (!isJsonObject(properties)) return '—'
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
  )
  const parts = Object.keys(properties)
    .sort()
    .map(key => {
      const value = properties[key]
      const type = isJsonObject(value) && typeof value.type === 'string' ? value.type : 'any'
      return `${key}${required.has(key) ? '*' : ''}: ${type}`
    })
  return parts.length > 0 ? parts.join(', ') : '—'
}

function describeOp(name: string, op: OpSpec): string {
  const effects = op.effects.length > 0 ? op.effects.join(', ') : 'none'
  return `- ${name} — ${op.title} [effects: ${effects}] (${summarizeSchema(op.params)})`
}

function describeRead(name: string, read: ReadSpec): string {
  return `- ${name} — ${read.title} (${summarizeSchema(read.query)})`
}

/** 一份自述 → 给人 / 给模型读的一段话。地址语法在第二行,因为那是调用的前提。 */
function renderSpec(spec: ResourceSpec): string {
  const lines: string[] = [`${spec.scheme} — ${spec.title}`, `Address: ${spec.scheme}:<path>`]
  const ops = Object.keys(spec.ops).sort()
  const reads = Object.keys(spec.reads).sort()
  const events = Object.keys(spec.events).sort()
  lines.push('', ops.length > 0 ? 'Ops:' : 'Ops: none')
  for (const name of ops) lines.push(describeOp(name, spec.ops[name]))
  lines.push('', reads.length > 0 ? 'Reads:' : 'Reads: none')
  for (const name of reads) lines.push(describeRead(name, spec.reads[name]))
  if (events.length > 0) {
    lines.push('', 'Events:')
    for (const name of events) lines.push(`- ${name} — ${spec.events[name].title}`)
  }
  return lines.join('\n')
}

export class ResourceMetaTool extends Tool<unknown, ResourceMetaCall> {
  readonly spec: ToolSpec
  private readonly registry: ResourceRegistry

  constructor(registry: ResourceRegistry) {
    super()
    this.registry = registry
    this.spec = {
      id: RESOURCE_META_TOOL_ID,
      title: 'Resources',
      description:
        'List the resource namespaces available right now, or describe one of them ' +
        '(its actions, its queries, the events it reports). Each namespace has a tool of its own, named after it.',
      input: INPUT_SCHEMA,
      effects: [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'parallel',
      prompt: META_TOOL_PROMPT,
      /*
       * 它与资源工具同族(见 `ToolSpec.projection` 的注释):设置页那份「这台宿主
       * 注册了哪些工具」的清单里不该多出一行 `resources`,理由与资源工具逐字相同。
       */
      projection: 'resource',
    }
  }

  async plan(input: unknown): Promise<Intent<ResourceMetaCall>> {
    const call = readCall(input)
    // 读注册表没有任何效果 —— 与 `ResourceTool` 的读那一支同一句话,而且同样是
    // **结构性**的:这一支永远造 `Intent.none`,不存在「某种情况下要授权」的分支。
    return Intent.none<ResourceMetaCall>(call)
  }

  async apply(intent: Intent<ResourceMetaCall>): Promise<Result> {
    const call = intent.payload
    if (call.kind === 'list') return textResult(this.renderList())
    const spec = this.registry.get(call.scheme)
    if (!spec) {
      return textResult(
        `There is no namespace named "${call.scheme}" right now. ` +
          `Call {"list": true} to see what is available.`,
      )
    }
    return textResult(renderSpec(spec))
  }

  private renderList(): string {
    const specs = this.registry.list()
    if (specs.length === 0) return 'No namespaces are available right now.'
    return specs
      .map(spec => `${spec.scheme} — ${spec.title} — ${countOf(spec.ops)} ops / ${countOf(spec.reads)} reads`)
      .join('\n')
  }
}

/**
 * 入参 → 两支之一。**自己判一次形状**:这份 schema 由内核生成,而生成 schema 的那位
 * 校验者只认领 `mount` 出来的资源契约(`validator.ts`),元工具不在其中,所以它落进
 * `ZodValidator` 的 passthrough。判据写在这里比让一个形状不合的调用走到 `apply` 里
 * 再散着判两次强。
 */
function readCall(input: unknown): ResourceMetaCall {
  if (!input || typeof input !== 'object') throw new ResourceMetaCallShapeError()
  const record = input as Record<string, unknown>
  const scheme = record.describe
  if (typeof scheme === 'string' && scheme.length > 0) return { kind: 'describe', scheme }
  if (record.list === true) return { kind: 'list' }
  throw new ResourceMetaCallShapeError()
}
