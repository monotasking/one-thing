/**
 * K2c-1 / K2c-2 —— `foldOutcomeToEnvelope` 的五支与 `foldReadOutcomeToEnvelope`
 * 的四支(`rpc/resource-envelope.ts`)。
 *
 * 一只纯函数值得一组用例,是因为它是**每个退成投影的域共用的那一步**:哪一支折成
 * `success:false`、哪一句话交出去,写错一处就是一个域的契约变了,而域自己的用例
 * 只看得见最终信封,看不见是这里折错的。
 */
import { describe, expect, it } from 'vitest'
import { Outcome, TOOL_CANCELLED_MESSAGE, textResult } from '@onething/core/toolkit'
import { ReadOutcome } from '@onething/core/resource'
import { foldOutcomeToEnvelope, foldReadOutcomeToEnvelope } from '../resource-envelope.js'

class DomainSpecificError extends Error {
  constructor() {
    super('the raw words from the pipeline')
    this.name = 'DomainSpecificError'
  }
}

describe('foldOutcomeToEnvelope(K2c-1)', () => {
  it('ok → success:true,不带载荷(要带的域自己 spread)', () => {
    expect(foldOutcomeToEnvelope(Outcome.ok(textResult('Renamed session to X')))).toEqual({ success: true })
  })

  it('invalid → 校验者写的那句话,不加前缀', () => {
    expect(foldOutcomeToEnvelope(Outcome.invalid('session has no op named "nope"'))).toEqual({
      success: false,
      error: 'session has no op named "nope"',
    })
  })

  it('denied → 授权者写的那句话', () => {
    expect(foldOutcomeToEnvelope(Outcome.denied('User rejected this tool call'))).toEqual({
      success: false,
      error: 'User rejected this tool call',
    })
  })

  it('aborted → 失败,不是成功;没给理由就用取消那句话', () => {
    // 一次被掐断的写**没有发生**。折成 success:true 会让界面把没写下去的东西
    // 当成写下去了 —— 那正是「乐观更新之后不对账」那一类病的源头。
    expect(foldOutcomeToEnvelope(Outcome.aborted())).toEqual({
      success: false,
      error: TOOL_CANCELLED_MESSAGE,
    })
    expect(foldOutcomeToEnvelope(Outcome.aborted('the caller went away'))).toEqual({
      success: false,
      error: 'the caller went away',
    })
  })

  it('failed → 管线那句话;域给了说法就用域的(判据是类,不是消息串)', () => {
    const failure = Outcome.failed(new DomainSpecificError())

    expect(foldOutcomeToEnvelope(failure)).toEqual({
      success: false,
      error: 'the raw words from the pipeline',
    })

    expect(foldOutcomeToEnvelope(failure, {
      describeError: error => (error instanceof DomainSpecificError ? 'Session not found' : undefined),
    })).toEqual({ success: false, error: 'Session not found' })

    // 回 undefined = 「本域对这个类没有专属说法」,于是照旧用管线那句话。
    expect(foldOutcomeToEnvelope(failure, { describeError: () => undefined })).toEqual({
      success: false,
      error: 'the raw words from the pipeline',
    })
  })

  it('describeError 只管 failed —— invalid / denied 的文案各有产地,域改不动', () => {
    const rewrite = { describeError: () => 'REWRITTEN' }
    expect(foldOutcomeToEnvelope(Outcome.invalid('as written'), rewrite)).toEqual({
      success: false,
      error: 'as written',
    })
    expect(foldOutcomeToEnvelope(Outcome.denied('as decided'), rewrite)).toEqual({
      success: false,
      error: 'as decided',
    })
  })
})

/**
 * K2c-2 —— `foldReadOutcomeToEnvelope` 的四支。
 *
 * 与上面那一组的差别只有成功那一支,而那一支正是读与做的分界:写面的 `ok` 折成
 * 一个空回执(回执没有载荷),读面的 `ok` 带着**读到的那个值**,而「这个值在我的
 * 契约里叫什么」只有域知道 —— 所以它是一个回调,不是这只函数的知识。
 */
describe('foldReadOutcomeToEnvelope(K2c-2)', () => {
  const project = { project: (value: unknown) => ({ messages: value }) }

  it('ok → success:true + 域自己给那个值起的名字', () => {
    expect(foldReadOutcomeToEnvelope(ReadOutcome.ok([{ id: 'a' }]), project)).toEqual({
      success: true,
      messages: [{ id: 'a' }],
    })
  })

  it('值原样交出去:`undefined` 不消失、数组不被包一层', () => {
    // K1 那条路上读的结果要 `JSON.stringify` 再 `JSON.parse` 回来,`undefined` 在
    // 往返里会消失 —— 这一条钉的就是那次往返没有了。
    expect(foldReadOutcomeToEnvelope(ReadOutcome.ok(undefined), project)).toEqual({
      success: true,
      messages: undefined,
    })
  })

  it('三支失败的口径与写面逐字相同(同一次失败,两条路一句话)', () => {
    expect(foldReadOutcomeToEnvelope(ReadOutcome.invalid('session has no read "nope"'), project)).toEqual({
      success: false,
      error: 'session has no read "nope"',
    })
    expect(foldReadOutcomeToEnvelope(ReadOutcome.denied('not yours'), project)).toEqual({
      success: false,
      error: 'not yours',
    })
    expect(foldReadOutcomeToEnvelope(ReadOutcome.failed(new DomainSpecificError()), {
      ...project,
      describeError: error => (error instanceof DomainSpecificError ? 'Session not found' : undefined),
    })).toEqual({ success: false, error: 'Session not found' })
  })

  it('失败时 project 一次都不被调用(没有值可投影)', () => {
    let calls = 0
    foldReadOutcomeToEnvelope(ReadOutcome.invalid('nope'), {
      project: value => {
        calls += 1
        return { messages: value }
      },
    })
    expect(calls).toBe(0)
  })
})
