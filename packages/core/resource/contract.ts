/**
 * K0 —— 契约校验(`docs/design/atom-2026-09.md` §7 盲点 7「投影的一致性测试」)。
 *
 * 「每个出口都是生成的,所以每个 scheme 自动得到契约测试(ops 的 schema 合法、
 * effects 在上界内、`home` 合法……)。**这是『加功能不许改骨架』的门。**」
 * 那道门的判定函数就是这只文件 —— 一份自述交上来,它回答「这份自述本身合不合
 * 规矩」,而且只回答这一句:它不认识任何 scheme,不知道某一种资源该有哪些读法,
 * 也不校验 JSON Schema 的内部(那是 `Validator` 端口的解释权,内核对 schema 的全部
 * 认识就是「一坨 JSON 对象」,见 `../toolkit/spec.ts`)。
 *
 * ── 为什么是结构化问题而不是一句字符串 ─────────────────────────────────────
 * 与 `../plugins/` 里那批 `describeXxxProblem` 同一个套路,理由也同一个:错误要能
 * 被**读**——安装确认页要按 kind 分档显示、目录投影要把非法条目摘掉并说明、测试要
 * 断言「报的是这一条」而不是去 match 一句会被改的中文。所以返回值是可辨识联合,
 * 每一支带够定位字段(`scheme` / `member` / `name` / 出错的原值),人话另交给
 * `formatResourceSpecProblem`。
 *
 * ── 一次只报第一条,而且顺序稳定 ───────────────────────────────────────────
 * 一次只报一条:自述是人写的,第一条错往往让后面的检查全是噪音(scheme 拼错 ⇒
 * 每一条做法的定位字段都在说一个不存在的命名空间)。
 * 顺序稳定的做法是**键排序后遍历**,不是按字面量里的书写顺序:同一份自述换个书写
 * 顺序就换一条报错,会让测试与人的记忆同时失效。检查次序是
 * spec 本体(含 `exposure`)→ reads → ops → events → state,每张表内按键的字典序。
 */

import { isJsonObject } from '../json.js'
import { isKnownEffectClass } from '../toolkit/effects.js'
import { isRefScheme } from './ref.js'
import type { ResourceSpec } from './spec.js'

/**
 * 成员名语法:小写开头的 lowerCamelCase。
 *
 * 它比 scheme 的语法紧(没有连字符):这些名字会被当成标识符用 —— 生成的 AI 工具名
 * (`demo.archive` 那一半)、RPC 方法名、斜杠命令名、MCP 出口的 tool name。连字符
 * 在其中几个出口里要转义,而「同一个名字在不同出口长得不一样」正是 §4「所有出口
 * 都是投影」要消灭的东西。
 */
const MEMBER_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/

/** 出问题的是哪一格。`spec` 表示 spec 本体而不是某张表里的某一条。 */
export type ResourceSpecMember = 'read' | 'op' | 'event' | 'state'

export type ResourceSpecProblem =
  /** 该是对象的地方不是对象。`where` 说是哪儿:`spec` / `reads` / `op:send` … */
  | { readonly kind: 'not-object'; readonly where: string }
  /** scheme 缺失或不合 `isRefScheme`。 */
  | { readonly kind: 'scheme-grammar'; readonly scheme: unknown }
  /** `title` 不是非空字符串。`where` 同 `not-object`。 */
  | { readonly kind: 'bad-title'; readonly scheme: string; readonly where: string }
  /** 成员名不合 `MEMBER_NAME_PATTERN`。 */
  | {
      readonly kind: 'name-grammar'
      readonly scheme: string
      readonly member: ResourceSpecMember
      readonly name: string
    }
  /** 该是 JSON Schema 的格子不是一个 JSON 对象。`field` = `query` / `params` / … */
  | {
      readonly kind: 'bad-schema'
      readonly scheme: string
      readonly member: ResourceSpecMember
      readonly name: string
      readonly field: string
    }
  /** `effects` 不是数组。 */
  | { readonly kind: 'bad-effects'; readonly scheme: string; readonly name: string }
  /** `effects` 里有一个不在 `EFFECT_POLICY` 表里的效果类。 */
  | { readonly kind: 'unknown-effect'; readonly scheme: string; readonly name: string; readonly effect: string }
  /** `home` 不是 `core` / `shell`。 */
  | { readonly kind: 'bad-home'; readonly scheme: string; readonly name: string; readonly home: unknown }
  /** `volatility` 不是 `stable` / `turn` / `live`。 */
  | {
      readonly kind: 'bad-volatility'
      readonly scheme: string
      readonly name: string
      readonly volatility: unknown
    }
  /** `when` / `describe` 给了但不是函数。 */
  | {
      readonly kind: 'bad-hook'
      readonly scheme: string
      readonly name: string
      readonly field: 'when' | 'describe'
    }
  /** `state.read` 不是字符串,或者指着一条这份自述里没有的读法。 */
  | { readonly kind: 'bad-state-read'; readonly scheme: string; readonly name: string; readonly read: unknown }
  /** `state.scope` 不是 `singleton` / `turn-origin`。 */
  | { readonly kind: 'bad-state-scope'; readonly scheme: string; readonly name: string; readonly scope: unknown }
  /** `exposure` 里某一格不是布尔(K5-a)。 */
  | { readonly kind: 'bad-exposure'; readonly scheme: string; readonly field: string; readonly value: unknown }

export class ResourceSpecError extends Error {
  readonly problem: ResourceSpecProblem

  constructor(problem: ResourceSpecProblem) {
    super(formatResourceSpecProblem(problem))
    this.name = 'ResourceSpecError'
    this.problem = problem
  }
}

/**
 * 一条问题的人话。**只给人看** —— 分支判定一律读 `problem.kind`,别去 match 这里的
 * 字符串(见文件头「为什么是结构化问题」)。
 */
export function formatResourceSpecProblem(problem: ResourceSpecProblem): string {
  switch (problem.kind) {
    case 'not-object':
      return `resource spec: ${problem.where} is not an object`
    case 'scheme-grammar':
      return `resource spec: invalid scheme ${JSON.stringify(problem.scheme)}`
    case 'bad-title':
      return `resource spec ${problem.scheme}: ${problem.where} needs a non-empty title`
    case 'name-grammar':
      return `resource spec ${problem.scheme}: invalid ${problem.member} name ${JSON.stringify(problem.name)}`
    case 'bad-schema':
      return `resource spec ${problem.scheme}: ${problem.member} ${problem.name}.${problem.field} is not a JSON schema object`
    case 'bad-effects':
      return `resource spec ${problem.scheme}: op ${problem.name}.effects must be an array`
    case 'unknown-effect':
      return `resource spec ${problem.scheme}: op ${problem.name} declares unknown effect ${JSON.stringify(problem.effect)}`
    case 'bad-home':
      return `resource spec ${problem.scheme}: op ${problem.name}.home must be 'core' or 'shell'`
    case 'bad-volatility':
      return `resource spec ${problem.scheme}: state ${problem.name}.volatility must be 'stable', 'turn' or 'live'`
    case 'bad-hook':
      return `resource spec ${problem.scheme}: op ${problem.name}.${problem.field} must be a function`
    case 'bad-state-read':
      return `resource spec ${problem.scheme}: state ${problem.name}.read ${JSON.stringify(problem.read)} names no read of this resource`
    case 'bad-state-scope':
      return `resource spec ${problem.scheme}: state ${problem.name}.scope must be 'singleton' or 'turn-origin'`
    case 'bad-exposure':
      return `resource spec ${problem.scheme}: exposure.${problem.field} must be a boolean`
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 排序后的键。顺序稳定靠它,理由见文件头。 */
function sortedKeys(table: object): string[] {
  return Object.keys(table).sort()
}

/**
 * 一份自述哪里不合规矩。合规矩回 `null`。
 *
 * 空表合法:一种资源可以只有读法没有做法(§8 演练二里的 `shell` 侧 scheme 就只有
 * 一条做法、零读法零事件)。缺表不合法 —— 三张表是必填,理由写在 `spec.ts` 的
 * `ResourceSpec` 上。
 */
export function describeResourceSpecProblem(spec: unknown): ResourceSpecProblem | null {
  if (!isJsonObject(spec)) return { kind: 'not-object', where: 'spec' }
  const candidate = spec as Record<string, unknown>

  const scheme = candidate.scheme
  if (!isNonEmptyString(scheme) || !isRefScheme(scheme)) return { kind: 'scheme-grammar', scheme }

  if (!isNonEmptyString(candidate.title)) return { kind: 'bad-title', scheme, where: 'spec' }

  // K5-a —— 出口声明。只查**形状**(是个对象、那一格是布尔),不查语义:「不进模型
  // 面对不对」是写自述的人的判断,契约门只保证读表的人不会读到一个 `'no'` 字符串
  // 然后按真值算(那会让一次拼错静默地变成「照常投影」)。
  const exposure = candidate.exposure
  if (exposure !== undefined) {
    if (!isJsonObject(exposure)) return { kind: 'not-object', where: 'exposure' }
    const flags = exposure as Record<string, unknown>
    if (flags.aiTool !== undefined && typeof flags.aiTool !== 'boolean') {
      return { kind: 'bad-exposure', scheme, field: 'aiTool', value: flags.aiTool }
    }
  }

  const reads = candidate.reads
  if (!isJsonObject(reads)) return { kind: 'not-object', where: 'reads' }
  for (const name of sortedKeys(reads)) {
    const problem = checkEntry(scheme, 'read', name, reads[name], ['query', 'result'])
    if (problem) return problem
  }

  const ops = candidate.ops
  if (!isJsonObject(ops)) return { kind: 'not-object', where: 'ops' }
  for (const name of sortedKeys(ops)) {
    const problem = checkOp(scheme, name, ops[name])
    if (problem) return problem
  }

  const events = candidate.events
  if (!isJsonObject(events)) return { kind: 'not-object', where: 'events' }
  for (const name of sortedKeys(events)) {
    const problem = checkEntry(scheme, 'event', name, events[name], ['payload'])
    if (problem) return problem
  }

  const state = candidate.state
  if (state !== undefined) {
    if (!isJsonObject(state)) return { kind: 'not-object', where: 'state' }
    for (const name of sortedKeys(state)) {
      const problem = checkState(scheme, name, state[name], reads)
      if (problem) return problem
    }
  }

  return null
}

/** 每一格共有的三关:名字语法 → 条目是对象 → 标题;再逐个 schema 格子。 */
function checkEntry(
  scheme: string,
  member: ResourceSpecMember,
  name: string,
  entry: unknown,
  schemaFields: readonly string[],
): ResourceSpecProblem | null {
  if (!MEMBER_NAME_PATTERN.test(name)) return { kind: 'name-grammar', scheme, member, name }
  if (!isJsonObject(entry)) return { kind: 'not-object', where: `${member}:${name}` }
  const record = entry as Record<string, unknown>
  if (!isNonEmptyString(record.title)) return { kind: 'bad-title', scheme, where: `${member}:${name}` }
  for (const field of schemaFields) {
    if (!isJsonObject(record[field])) return { kind: 'bad-schema', scheme, member, name, field }
  }
  return null
}

function checkOp(scheme: string, name: string, entry: unknown): ResourceSpecProblem | null {
  const shared = checkEntry(scheme, 'op', name, entry, ['params'])
  if (shared) return shared
  const record = entry as Record<string, unknown>

  // 效果是权限的唯一依据(§2 不变量 1),所以「声明了一个不存在的效果类」必须是
  // 硬错而不是像 `effectPolicyFor` 那样兜底成 ask:兜底是给**运行时**一条拼错的
  // 效果留活路,登记时把它放进来则是让一份说谎的自述长期存在。
  const effects = record.effects
  if (!Array.isArray(effects)) return { kind: 'bad-effects', scheme, name }
  for (const effect of effects) {
    if (typeof effect !== 'string' || !isKnownEffectClass(effect)) {
      return { kind: 'unknown-effect', scheme, name, effect: String(effect) }
    }
  }

  const home = record.home
  if (home !== 'core' && home !== 'shell') return { kind: 'bad-home', scheme, name, home }

  for (const field of ['when', 'describe'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'function') {
      return { kind: 'bad-hook', scheme, name, field }
    }
  }

  return null
}

function checkState(
  scheme: string,
  name: string,
  entry: unknown,
  reads: Record<string, unknown>,
): ResourceSpecProblem | null {
  const shared = checkEntry(scheme, 'state', name, entry, ['schema'])
  if (shared) return shared
  const record = entry as Record<string, unknown>
  const volatility = record.volatility
  if (volatility !== 'stable' && volatility !== 'turn' && volatility !== 'live') {
    return { kind: 'bad-volatility', scheme, name, volatility }
  }

  // K4-a:`read` 缺席 = 与状态同名的那条读法,所以「缺席」与「写了个存在的名字」
  // 是同一件事的两种写法,两种都要真的指得到一条读法。一个指空的 `read` 在登记时
  // 是拼写错误,到了投影期就只剩一格安静消失的状态 —— 与 `unknown-effect` 那条
  // 「不许一份说谎的自述长期存在」同一条纪律。
  const read = record.read
  if (read !== undefined) {
    if (typeof read !== 'string' || !Object.prototype.hasOwnProperty.call(reads, read)) {
      return { kind: 'bad-state-read', scheme, name, read }
    }
  } else if (!Object.prototype.hasOwnProperty.call(reads, name)) {
    return { kind: 'bad-state-read', scheme, name, read: undefined }
  }

  const scope = record.scope
  if (scope !== undefined && scope !== 'singleton' && scope !== 'turn-origin') {
    return { kind: 'bad-state-scope', scheme, name, scope }
  }

  return null
}

/**
 * 不合规矩就抛。断言签名让调用方(`registry.register`)在这一行之后直接拿到
 * `ResourceSpec`,不必再 `as` 一次。
 */
export function assertResourceSpec(spec: unknown): asserts spec is ResourceSpec {
  const problem = describeResourceSpecProblem(spec)
  if (problem) throw new ResourceSpecError(problem)
}
