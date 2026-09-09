/**
 * K1 —— 一份自述 → 一个工具的入参契约与描述(`docs/design/atom-2026-09.md` §4
 * 「所有出口都是投影」的第一行:「AI 工具 —— 每个在场的 scheme 一个工具
 * `{ op, ref?, …params }`」)。
 *
 * 纯函数,零状态:进去一份 `ResourceSpec`,出来一坨 JSON Schema、一句描述、一份
 * 效果并集。K1 只有 AI 工具这一个出口用它;K2 的 RPC、K4 的 MCP 服务端出口都会
 * 读同一份自述,各自另投一次 —— **投影器可以有很多个,自述只有一份**,这正是
 * §4 那张表成立的方式。
 *
 * ── 为什么是 `oneOf` 可辨识联合,而不是 `{ op, params }` 两层 ────────────────
 * §7 盲点 8 已经量过一次同类的事:「纯 `read/do/watch` 三个工具给模型,效果会差
 * (要先发现再调用)」。同一条道理在一个 scheme 之内还成立一次 —— 把参数塞进一个
 * 自由形状的 `params` 对象里,模型看到的是「一个叫 params 的东西,里面写什么自己
 * 猜」;摊平成一支一支的可辨识分支之后,每一支的必填项、类型、说明都在 schema 上
 * 写着,而 `op` 的 `const` 让模型选哪一支这件事本身也被契约挡住。
 *
 * 代价说清楚:两条做法的同名参数会长在**不同的分支**里,所以它们的类型可以不同 ——
 * 这是对的(它们本来就是两件事),但读 schema 的人会看到重复的属性名。接受。
 *
 * ── 顺序为什么排序 ─────────────────────────────────────────────────────────
 * 与 `registry.ts` 的 `list()` 同一个理由,而且是同一条法的两半:生成物会进
 * system 前缀,而 system 前缀跨会话逐字相同是提示词双通道那条法的前提。让分支顺序
 * 取决于自述字面量里的书写顺序,等于「有人把 ops 里两条对调了一下」就换一份
 * system 前缀。所以**先做法后读法,每一族内按名字字典序**。
 */

import type { EffectClass } from '../toolkit/effects.js'
import { EFFECT_CLASSES } from '../toolkit/effects.js'
import type { JsonObject } from '../json.js'
import { isJsonObject } from '../json.js'
import type { JsonSchema, ResourceSpec } from './spec.js'

/** 做法分支的判别字段。 */
export const RESOURCE_OP_KEY = 'op'
/** 读法分支的判别字段。 */
export const RESOURCE_READ_KEY = 'read'
/** 两族分支共有的可选地址字段。 */
export const RESOURCE_REF_KEY = 'ref'

const REF_PROPERTY: JsonObject = {
  type: 'string',
  description: 'Resource address, `<scheme>:<path>`. Omit it to address the namespace itself.',
}

function sortedKeys(table: object): string[] {
  return Object.keys(table).sort()
}

/**
 * 一坨 JSON Schema 里的 `properties`。不是对象就当没有 —— 契约门
 * (`contract.ts`)已经保证过 `params` / `query` 本身是对象,但它**不看对象内部**
 * (schema 的解释权归 `Validator` 端口),所以这里遇到形状不合的内部一律当空,
 * 而不是抛:一条属性写歪了不该让整个 scheme 的工具建不出来。
 */
function propertiesOf(schema: JsonSchema): Record<string, JsonObject> {
  const properties = schema.properties
  if (!isJsonObject(properties)) return {}
  const out: Record<string, JsonObject> = {}
  for (const key of sortedKeys(properties)) {
    const value = properties[key]
    if (isJsonObject(value)) out[key] = value
  }
  return out
}

function requiredOf(schema: JsonSchema): string[] {
  const required = schema.required
  if (!Array.isArray(required)) return []
  return required.filter((item): item is string => typeof item === 'string')
}

function branch(discriminator: string, name: string, title: string, schema: JsonSchema): JsonObject {
  return {
    type: 'object',
    description: title,
    properties: {
      [discriminator]: { type: 'string', const: name },
      [RESOURCE_REF_KEY]: REF_PROPERTY,
      ...propertiesOf(schema),
    },
    required: [discriminator, ...requiredOf(schema)],
  }
}

/**
 * 一份自述 → 这个 scheme 那只工具的 `ToolSpec.input`。
 *
 * 空自述(零做法零读法)出来的是一个 `oneOf: []` —— 合法的 JSON Schema,含义是
 * 「什么都不接受」。这比省掉 `oneOf` 诚实:一个连读法都没有的资源,它的工具本来
 * 就没有任何合法调用。
 */
export function toolInputSchemaOf(spec: ResourceSpec): JsonSchema {
  const branches: JsonObject[] = []
  for (const name of sortedKeys(spec.ops)) {
    const op = spec.ops[name]
    branches.push(branch(RESOURCE_OP_KEY, name, op.title, op.params))
  }
  for (const name of sortedKeys(spec.reads)) {
    const read = spec.reads[name]
    branches.push(branch(RESOURCE_READ_KEY, name, read.title, read.query))
  }
  return { type: 'object', oneOf: branches }
}

/**
 * 全部做法的效果并集 —— 这只工具的**静态上界**(`ToolSpec.effects`)。
 *
 * 它比任何单条做法都松,所以 `runner.ts` 的 `assertWithinDeclaredEffects` 在这一
 * 层只挡得住「这个 scheme 从没声明过的效果」。每条做法自己的上界由 `tool.ts` 在
 * plan 之后再查一次 —— 两道检查缺一不可,少了后一道,一条声明 `[]` 的重命名做法
 * 就能安静地报出一条 `bash`,只要同一个 scheme 里有**别的**做法声明过 `bash`。
 *
 * 顺序取 `EFFECT_CLASSES` 的规范次序:与哪条做法先声明它无关,同上一条理由。
 */
export function toolEffectsOf(spec: ResourceSpec): readonly EffectClass[] {
  const declared = new Set<EffectClass>()
  for (const name of sortedKeys(spec.ops)) {
    for (const effect of spec.ops[name].effects) declared.add(effect)
  }
  return EFFECT_CLASSES.filter(kind => declared.has(kind))
}

/**
 * 这只工具的描述:标题一行,然后**一条做法一行**。
 *
 * 读法不在这里各占一行,不是漏了:每一支分支自己带 `description`(见 `branch`),
 * 而模型读的是同一份 schema。描述这一格要回答的是「这个命名空间能做什么」——
 * 那正是做法清单。
 */
export function toolDescriptionOf(spec: ResourceSpec): string {
  const lines = sortedKeys(spec.ops).map(name => `- ${name} — ${spec.ops[name].title}`)
  return lines.length > 0 ? `${spec.title}\n${lines.join('\n')}` : spec.title
}
