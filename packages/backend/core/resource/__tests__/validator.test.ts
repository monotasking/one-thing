/**
 * K2a —— `ResourceInputValidator` + `combineValidators`。
 *
 * 两句话要钉住:
 *   ① 它**只**校验判别键(op / read / ref),params 内部一个字不看 —— 那是 plan 的活;
 *   ② 「不认识这份 schema」必须是**第三种答案**(`undefined`),不能是放行。第二条
 *      是组合能成立的全部前提:一位把「不认识」答成 `{ ok: true }` 的校验者排在前面,
 *      后面那位永远轮不上(`ZodValidator` 的 passthrough 正是这种,所以次序不能反)。
 */

import { describe, expect, it } from 'vitest'
import { combineValidators, type Validator } from '../../toolkit/ports.js'
import { toolInputSchemaOf } from '../schema.js'
import { ResourceInputValidator } from '../validator.js'
import { demoSpec, DEMO_SCHEME } from './fakes.js'

const spec = demoSpec()
const schema = toolInputSchemaOf(spec)

function claimed() {
  const validator = new ResourceInputValidator()
  validator.register(schema, spec)
  return validator
}

function messageOf(result: ReturnType<ResourceInputValidator['parse']>): string {
  return result && !result.ok ? result.message : ''
}

describe('认领与弃权', () => {
  it('没认领过的 schema → undefined(弃权),不是放行也不是拒绝', () => {
    const validator = new ResourceInputValidator()
    expect(validator.parse(schema, { op: 'nope' })).toBeUndefined()
  })

  it('认领之后判得动;撤销之后又弃权', () => {
    const validator = new ResourceInputValidator()
    const unclaim = validator.register(schema, spec)
    expect(validator.parse(schema, { op: 'nope' })?.ok).toBe(false)
    unclaim()
    expect(validator.parse(schema, { op: 'nope' })).toBeUndefined()
    // 幂等。
    expect(() => unclaim()).not.toThrow()
  })

  it('旧闭包不摘后来者:同一份 schema 被换了主人之后,旧撤销函数不动新的', () => {
    const validator = new ResourceInputValidator()
    const unclaim = validator.register(schema, spec)
    const second = { ...spec, title: 'Second owner' }
    validator.register(schema, second)
    unclaim()
    // 还判得动 —— 说明后来者的认领还在。
    expect(validator.parse(schema, { op: 'nope' })?.ok).toBe(false)
  })
})

describe('判别键', () => {
  it('自述里真有的做法 / 读法 → 放行,载荷原样交出去', () => {
    const input = { op: 'rename', ref: `${DEMO_SCHEME}:1`, title: 'x' }
    const parsed = claimed().parse(schema, input)
    expect(parsed).toEqual({ ok: true, value: input })
    expect(claimed().parse(schema, { read: 'list', limit: 3 })?.ok).toBe(true)
  })

  it('未知 op / 未知 read → 不过,而且话里带得出有哪些', () => {
    expect(messageOf(claimed().parse(schema, { op: 'nope' }))).toContain('has no op "nope"')
    expect(messageOf(claimed().parse(schema, { op: 'nope' }))).toContain('rename')
    expect(messageOf(claimed().parse(schema, { read: 'nope' }))).toContain('has no read "nope"')
  })

  it('原型链上的名字不算(名字直接来自模型参数与 deeplink)', () => {
    expect(claimed().parse(schema, { op: 'toString' })?.ok).toBe(false)
    expect(claimed().parse(schema, { read: 'constructor' })?.ok).toBe(false)
  })

  it('一支都不点 / 两支都点 → 两句不同的话', () => {
    expect(messageOf(claimed().parse(schema, {}))).toContain('names neither')
    expect(messageOf(claimed().parse(schema, { op: 'rename', read: 'get' }))).toContain('names both')
  })

  it('不是对象的调用 → 不过(null / 数组 / 标量)', () => {
    for (const input of [null, undefined, 42, 'rename', ['rename']]) {
      expect(claimed().parse(schema, input)?.ok).toBe(false)
    }
  })
})

describe('地址那一格', () => {
  it('缺席合法 —— 「这一次说的是整个命名空间」', () => {
    expect(claimed().parse(schema, { read: 'list' })?.ok).toBe(true)
  })

  it('不合语法 / 属于另一种资源 / 不是字符串 → 三句话都不过', () => {
    expect(messageOf(claimed().parse(schema, { op: 'rename', ref: 'nonsense' })))
      .toContain('is not a resource address')
    expect(messageOf(claimed().parse(schema, { op: 'rename', ref: 'other:1' })))
      .toContain('belongs to another resource')
    expect(messageOf(claimed().parse(schema, { op: 'rename', ref: 42 })))
      .toContain('must be a string')
  })
})

describe('params 内部不看', () => {
  it('必填参数缺了照样放行 —— 那是 plan 的活,不是判别键的活', () => {
    // `rename` 的 params 声明 `required: ['title']`,而这里一个 title 都没给。
    // 校验者放行是**对的**:内核不解释 JSON Schema(那正是 `Validator` 端口存在的
    // 理由),让它去解释等于在 core 里长一台 schema 解释器。
    expect(claimed().parse(schema, { op: 'rename', ref: `${DEMO_SCHEME}:1` })?.ok).toBe(true)
  })
})

describe('combineValidators', () => {
  const rejectAll: Validator = { parse: () => ({ ok: false, message: 'fallback said no' }) }
  const passthrough: Validator = { parse: <T,>(_s: unknown, input: unknown) => ({ ok: true as const, value: input as T }) }

  it('第一个认领的说了算', () => {
    const combined = combineValidators([claimed()], rejectAll)
    expect(combined.parse(schema, { op: 'nope' }).ok).toBe(false)
    expect(combined.parse(schema, { op: 'rename' }).ok).toBe(true)
  })

  it('都不认领就交给兜底', () => {
    const combined = combineValidators([new ResourceInputValidator()], rejectAll)
    const result = combined.parse({ type: 'object' }, {})
    expect(result).toEqual({ ok: false, message: 'fallback said no' })
  })

  it('次序不能反:passthrough 排在前面,后面那位永远轮不上', () => {
    // 这一条是**反证**:它证明的不是代码对,而是「为什么装配层把资源校验器排在
    // ZodValidator 前面」。把兜底当成第一位,未知 op 就又静默放行了。
    const wrong = combineValidators([{ parse: passthrough.parse }], rejectAll)
    expect(wrong.parse(schema, { op: 'nope' }).ok).toBe(true)
  })
})
