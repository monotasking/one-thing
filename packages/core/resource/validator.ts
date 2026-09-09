/**
 * K2a —— 认得**生成的** schema 的那位校验者
 * (`docs/design/atom-2026-09.md` §9 K2;兑现 K1 在 `errors.ts` 头注释里留下的账)。
 *
 * ## 它补的是哪一格
 *
 * K1 的取舍写在 `errors.ts` 的文件头:未知 op、形状不对这些**参数错**当时全部走
 * `Outcome.failed`,因为它们是从 `ResourceTool.plan` 抛出来的,而 `ToolRunner` 对
 * plan 期的抛出只有一条路。那一段同时写下了正路:「想让它成为 `invalid`,正确的
 * 做法是给这份生成 schema 配一个认得它的 `Validator`,而不是在内核里给 plan 开一个
 * 能返回 `Outcome` 的后门。」这只文件就是那位 Validator。
 *
 * 为什么原来认不出:`ZodValidator`(`runtime/src/toolkit/contract.ts`)靠一张
 * **以 schema 对象本身为键**的 WeakMap 反查回 zod,而资源工具的 `spec.input` 是
 * `toolInputSchemaOf()` 现造的一坨 JSON Schema —— 它从来没进过那张表,于是反查失败、
 * 走 `passthrough`(那对插件 / MCP 是对的:替远端把关不是本地校验者的事)。
 * 结论不是「把 zod 教会」,是**另一位校验者**:资源的契约由资源自己解释。
 *
 * ## 它只校验判别键,不碰 params 内部
 *
 * 判据三条,全部只读**自述**:
 *   · `op` / `read` 必须是这份自述里真有的名字(而且**恰好点一个**);
 *   · `ref` 若给,必须是一个合法地址,且属于**本 scheme**;
 *   · 除此之外一个字段都不看。
 *
 * 为什么不校验 `params` 内部:那要求内核解释 JSON Schema,而「schema 怎么校验」
 * 正是 `Validator` 端口存在的理由 —— core 里长出一台 JSON Schema 解释器,等于把
 * 那个端口作废掉一半。每条做法自己的参数由 provider 的 `plan` 判(它本来就要判,
 * 它才知道「这条路径越不越界」这种事)。留账在设计正本的 K4 行。
 *
 * ## 「不认识」必须说得出口
 *
 * 它实现的是 `PartialValidator` 而不是 `Validator`:一位只认自己那批契约的校验者,
 * 必须能回答第三种话「这不是我的」。合成一位靠 `combineValidators`
 * (`core/toolkit/ports.ts`),装配层把它排在 `ZodValidator` 前面。
 *
 * ## 表是实例的,不是模块的
 *
 * `specs` 是**实例字段**的 WeakMap:一个 `ResourceKernel` 一位校验者,同一个进程里
 * 两台内核互不串味(K0 `registry.ts` 头注释那条「core 里零模块级槽」的同一句话)。
 * 键是 schema 对象本身 —— 与 `ZodValidator` 同一个理由:端口签名是
 * `parse(schema, input)`,它拿不到 toolId,对象身份就是它唯一拿得到的精确主键。
 * WeakMap 让忘记注销的那一份自己回收。
 */

import type { JsonSchema } from '../toolkit/spec.js'
import type { PartialValidator, ValidationResult } from '../toolkit/ports.js'
import { parseRef } from './ref.js'
import { RESOURCE_OP_KEY, RESOURCE_READ_KEY, RESOURCE_REF_KEY } from './schema.js'
import type { ResourceSpec } from './spec.js'

function own(table: Readonly<Record<string, unknown>>, name: string): boolean {
  // 与 `tool.ts` / `registry.ts` 同一句:名字直接来自模型参数与 deeplink,裸下标会
  // 从 `Object.prototype` 上摸到 `toString` 并当成一条做法。
  return Object.prototype.hasOwnProperty.call(table, name)
}

function names(table: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(table).sort()
  return keys.length > 0 ? keys.join(', ') : '(none)'
}

function invalid<T>(message: string): ValidationResult<T> {
  return { ok: false, message }
}

/**
 * 「这份自述里有没有这条读法」—— **判据抽成纯函数,因为它有两个读者**(K2c-2)。
 *
 * 一个是下面这位校验者(模型那条路:参数先过 `Validator`),另一个是
 * `ResourceKernel.read`(界面 / 脚本那条路:读不进管线,所以也没有 `Validator` 替
 * 它把关)。两处各写一遍的代价不是重复几行,是**两条路对同一个问题给不同的答案**
 * —— 那正是原子要消灭的形状。
 *
 * 回 `undefined` = 没问题;回一句话 = 那句话就是 `invalid` 的措辞。
 */
export function describeUnknownResourceReadProblem(spec: ResourceSpec, name: unknown): string | undefined {
  if (typeof name !== 'string' || !own(spec.reads, name)) {
    return `${spec.scheme} has no read ${JSON.stringify(name)}. Reads: ${names(spec.reads)}.`
  }
  return undefined
}

/**
 * 地址那一格。缺席合法(「这一次说的是整个命名空间」,与 `ResourceTool` 同一口径),
 * 给了就必须是合法地址、而且是**本 scheme** 的 —— 拿别人的地址来调这只工具,
 * 得到的是一次按错误坐标系执行的做法,而它会安静地成功。
 *
 * 与上面那只同一个理由抽出来:校验者与内核的读路共用它(K2c-2)。
 */
export function describeResourceRefProblem(spec: ResourceSpec, raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') {
    return `${spec.scheme}: ${RESOURCE_REF_KEY} must be a string like "${spec.scheme}:<path>".`
  }
  const parsed = parseRef(raw)
  if (!parsed) return `${spec.scheme}: ${JSON.stringify(raw)} is not a resource address.`
  if (parsed.scheme !== spec.scheme) {
    return `${spec.scheme}: address ${JSON.stringify(raw)} belongs to another resource.`
  }
  return undefined
}

export class ResourceInputValidator implements PartialValidator {
  private readonly specs = new WeakMap<object, ResourceSpec>()

  /**
   * 认领一份生成的入参契约。返回**幂等**的撤销函数。
   *
   * 调用点只有一个:`ResourceKernel.mount`(它是唯一造 `ResourceTool` 的地方,
   * 所以也是唯一知道「这坨 schema 属于哪份自述」的地方)。身份判等的理由与内核
   * 注销那一句逐字相同:同一份 schema 对象只会被一只工具引用,而一个 scheme 可能
   * 已经被后来者换掉了。
   */
  register(schema: JsonSchema, spec: ResourceSpec): () => void {
    this.specs.set(schema, spec)
    return () => {
      if (this.specs.get(schema) === spec) this.specs.delete(schema)
    }
  }

  parse<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T> | undefined {
    const spec = this.specs.get(schema)
    // 不是我的 —— 这**不是**放行,是弃权。见文件头。
    if (!spec) return undefined

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return invalid(`${spec.scheme}: the call must be an object naming one op or one read.`)
    }
    const fields = input as Record<string, unknown>

    const read = fields[RESOURCE_READ_KEY]
    const op = fields[RESOURCE_OP_KEY]
    const namesRead = typeof read === 'string'
    const namesOp = typeof op === 'string'

    // 生成的 schema 是一个 `oneOf` 可辨识联合(`schema.ts`),所以「恰好一支」是它的
    // 字面意思。两支都点名过不了 oneOf,而 `plan` 那一侧会闷头取读法 —— 那是一次
    // 安静的猜测,校验者在这里把它变成一句话。
    if (namesRead && namesOp) {
      return invalid(
        `${spec.scheme}: the call names both a read (${read}) and an op (${op}); name exactly one.`,
      )
    }
    if (!namesRead && !namesOp) {
      return invalid(
        `${spec.scheme}: the call names neither a read nor an op.`
        + ` Ops: ${names(spec.ops)}. Reads: ${names(spec.reads)}.`,
      )
    }

    if (namesRead) {
      const readProblem = describeUnknownResourceReadProblem(spec, read)
      if (readProblem) return invalid(readProblem)
    }
    if (namesOp && !own(spec.ops, op)) {
      return invalid(`${spec.scheme} has no op ${JSON.stringify(op)}. Ops: ${names(spec.ops)}.`)
    }

    const refProblem = describeResourceRefProblem(spec, fields[RESOURCE_REF_KEY])
    if (refProblem) return invalid(refProblem)

    // 认领了,而且过了。载荷原样交出去 —— 这位校验者不改参数(改参数是拦截器的活,
    // 而拦截有自己的归因字段;一个悄悄改过参数的「校验」在审计里看不出是谁改的)。
    return { ok: true, value: input as T }
  }
}
