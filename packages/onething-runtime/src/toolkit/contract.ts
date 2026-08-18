/**
 * R1 —— zod 契约 → 内核(`docs/design/tool-system-oop-2026-08.md` §3/§8)。
 *
 * core 禁 zod,所以内核对"契约"只认 JSON Schema 加一个 `Validator` 端口。产品层
 * 的工具照旧用 zod 写(那是这棵树里唯一会写 schema 的地方),在这里过一次转换:
 *
 *   `defineInput(zodSchema, { formatError })` → `{ schema, zod, formatError }`
 *
 * 返回的 `schema` 就是塞进 `ToolSpec.input` 的那一坨 JSON Schema,同时被登记进一张
 * **以 schema 对象本身为键**的 WeakMap。`ZodValidator.parse(schema, input)` 靠这张
 * 表反查回 zod 再 `safeParse`。
 *
 * ## 为什么是 WeakMap 而不是 toolId 表
 *
 * 内核的端口签名是 `parse(schema, input)` —— 它**不递 toolId**(runner.ts:
 * `this.ports.validator.parse(tool.spec.input, raw)`)。递 toolId 会让 Validator
 * 变成"认识工具"的东西,而它只该认识契约。所以查表的键只能是它拿得到的那个值:
 * `spec.input` 这个对象本身。同一个 `defineInput` 的返回值只会被一个 spec 引用,
 * 对象身份就是精确的主键,而且工具被摘掉时表项自动回收。
 *
 * 认不出的 schema(插件、MCP —— 它们的契约不由这里生产)默认放行:替远端服务器
 * 把关不是本地 Validator 的职责,那份判据在对面。这与今天
 * `app/plugins/tool-call-intercept.ts` 的 `validateInput` 口径一致。
 */

import type { z } from 'zod'
import type { JsonObject, JsonValue } from '@onething/core'
import type { JsonSchema, ValidationResult, Validator } from '@onething/core/toolkit'

/**
 * R2a 决定⑥ —— `zodToJsonSchema` 搬进新树。
 *
 * R1 从旧 `tools/tool.ts` import 它(设计文档 §11.5 偏差 8)。那个文件在 §6 的
 * **删除清单**上,所以新树对它的每一条 import 都是一根会在 R4 断掉的绳子:一棵
 * 号称"并行建成、整体切换"的树,不该有任何一条边指向要被删的那棵。转换本身是
 * 二十行纯函数(zod v4 的 `toJSONSchema()` 外面包一层形状收敛),复制一份的代价
 * 远小于留一条跨树依赖。**旧文件一个字不动** —— 旧树在切换期照常用它自己那份。
 */
interface JsonSchemaObject extends JsonObject {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaObject>
  items?: JsonSchemaObject
  required?: string[]
  enum?: JsonValue[]
}

function jsonSchemaProperties(value: JsonValue | undefined): Record<string, JsonSchemaObject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const properties: Record<string, JsonSchemaObject> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      properties[key] = item as JsonSchemaObject
    }
  }
  return properties
}

function jsonSchemaRequired(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function zodToJsonSchema(schema: z.ZodType): {
  type: 'object'
  properties: Record<string, JsonSchemaObject>
  required: string[]
} {
  try {
    const schemaWithMethod = schema as z.ZodType & { toJSONSchema?: () => JsonObject }
    if (typeof schemaWithMethod.toJSONSchema === 'function') {
      const jsonSchema = schemaWithMethod.toJSONSchema() as JsonObject
      return {
        type: 'object',
        properties: jsonSchemaProperties(jsonSchema.properties),
        required: jsonSchemaRequired(jsonSchema.required),
      }
    }

    console.warn('[toolkit/contract] Schema does not have toJSONSchema method')
    return { type: 'object', properties: {}, required: [] }
  } catch (error) {
    console.error('[toolkit/contract] Error converting schema:', error)
    return { type: 'object', properties: {}, required: [] }
  }
}

/** 一份契约:模型看到的 JSON Schema、校验用的 zod、以及失败文案。 */
export interface ToolContract<T = unknown> {
  readonly schema: JsonSchema
  readonly zod: z.ZodType
  /** 工具自定义的校验失败文案(read/write/edit/bash 各有一份,逐字沿用旧的)。 */
  readonly formatError?: (error: z.ZodError) => string
  /** 只为类型推断存在,运行时永远是 undefined。 */
  readonly _output?: T
}

export interface DefineInputOptions {
  readonly formatError?: (error: z.ZodError) => string
}

const CONTRACTS = new WeakMap<object, ToolContract>()

export function defineInput<S extends z.ZodType>(
  zodSchema: S,
  options: DefineInputOptions = {},
): ToolContract<z.infer<S>> {
  const schema = zodToJsonSchema(zodSchema) as unknown as JsonSchema
  const contract: ToolContract<z.infer<S>> = {
    schema,
    zod: zodSchema,
    formatError: options.formatError,
  }
  CONTRACTS.set(schema, contract as ToolContract)
  return contract
}

export function contractForSchema(schema: JsonSchema): ToolContract | undefined {
  return CONTRACTS.get(schema)
}

/**
 * 与旧管线同一句兜底文案(`core/tools/registry.ts` 的
 * `coreToolValidationFailureMessage`:没有 `formatValidationError` 时是
 * `Invalid arguments: <error.message>`)。
 */
export function defaultValidationMessage(error: unknown): string {
  if (error instanceof Error && error.message) return `Invalid arguments: ${error.message}`
  return `Invalid arguments: ${String(error)}`
}

export interface ZodValidatorOptions {
  /**
   * 认不出的 schema 怎么办。`passthrough`(默认)= 原样放行,由对面的契约把关;
   * `reject` = 判 invalid。装配层可以在只装本地工具的宿主上收紧成 reject。
   */
  readonly onUnknownSchema?: 'passthrough' | 'reject'
}

export class ZodValidator implements Validator {
  private readonly onUnknownSchema: 'passthrough' | 'reject'

  constructor(options: ZodValidatorOptions = {}) {
    this.onUnknownSchema = options.onUnknownSchema ?? 'passthrough'
  }

  parse<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T> {
    const contract = contractForSchema(schema)
    if (!contract) {
      if (this.onUnknownSchema === 'reject') {
        return { ok: false, message: 'Invalid arguments: no contract is registered for this tool' }
      }
      return { ok: true, value: input as T }
    }

    const parsed = contract.zod.safeParse(input)
    if (parsed.success) return { ok: true, value: parsed.data as T }
    const message = contract.formatError
      ? contract.formatError(parsed.error)
      : defaultValidationMessage(parsed.error)
    return { ok: false, message }
  }
}

/** 旧树四个文件工具共用的"逐条列出 issue"格式,原样保留。 */
export function listZodIssues(error: z.ZodError): string {
  return error.issues.map(issue => `- ${issue.path.join('.')}: ${issue.message}`).join('\n')
}
