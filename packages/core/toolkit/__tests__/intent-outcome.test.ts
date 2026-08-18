import { describe, expect, it } from 'vitest'

import { AbortScope } from '../abort-scope.js'
import { makeEffect } from '../effects.js'
import { Decision, Intent } from '../intent.js'
import { Outcome, TOOL_CANCELLED_MESSAGE } from '../outcome.js'
import { emptyResult, resultToText, textResult } from '../result.js'
import { createToolTimeoutError, isToolTimeoutError } from '../abort-scope.js'
import { createToolAbortError, isToolAbortError } from '../../tools/abort.js'

describe('Intent', () => {
  it('none 是零效果的计划,但仍然要过授权', () => {
    const intent = Intent.none({ path: 'a.ts' })
    expect(intent.effects).toEqual([])
    expect(intent.isSideEffectFree).toBe(true)
    expect(intent.requiresAuthorization).toBe(false)
    expect(intent.payload).toEqual({ path: 'a.ts' })
  })

  it('of 带上效果与预览', () => {
    const intent = Intent.of({
      effects: [makeEffect('file_write', ['/tmp/a.ts'])],
      preview: { title: 'Write file: a.ts', diff: '+1', additions: 1 },
      payload: { content: 'x' },
    })
    expect(intent.requiresAuthorization).toBe(true)
    expect(intent.preview?.title).toBe('Write file: a.ts')
  })

  it('effects 是冻结的:计划一旦说出口就不能改', () => {
    const intent = Intent.of({ effects: [makeEffect('read', ['a.ts'])], payload: null })
    expect(Object.isFrozen(intent.effects)).toBe(true)
  })

  it('approved 返回新对象,不改原计划', () => {
    const intent = Intent.none(1)
    const approved = intent.approved(Decision.allow({ grantId: 'g1' }))
    expect(approved).not.toBe(intent)
    expect(intent.decision).toBeUndefined()
    expect(approved.decision).toEqual({ kind: 'allow', grantId: 'g1' })
    expect(approved.payload).toBe(1)
  })

  it('forceAsk 让零效果的计划也必须惊动人(§10.2-③ 的用户设置)', () => {
    const intent = Intent.none(null)
    expect(intent.requiresAuthorization).toBe(false)
    const forced = intent.forceAsk()
    expect(forced.requiresAuthorization).toBe(true)
    expect(forced.alwaysAsk).toBe(true)
    expect(intent.alwaysAsk).toBe(false)
    expect(forced.forceAsk()).toBe(forced)
  })
})

describe('Outcome', () => {
  it('五种结局各自成立', () => {
    expect(Outcome.ok(emptyResult()).kind).toBe('ok')
    expect(Outcome.invalid('bad').kind).toBe('invalid')
    expect(Outcome.denied('nope').kind).toBe('denied')
    expect(Outcome.aborted().kind).toBe('aborted')
    expect(Outcome.failed(new Error('boom')).kind).toBe('failed')
  })

  it('fromError:结构化取消错误 → aborted', () => {
    const outcome = Outcome.fromError(createToolAbortError('stopped'))
    expect(outcome.kind).toBe('aborted')
  })

  it('fromError:信号已响时,别的错误也算 aborted', () => {
    const scope = new AbortScope()
    scope.abort('user stopped')
    const outcome = Outcome.fromError(new Error('spawn ENOENT'), scope)
    expect(outcome).toEqual({ kind: 'aborted', reason: 'user stopped' })
    scope.dispose()
  })

  it('fromError:子作用域超时抛出、父作用域没响 → failed(不是用户取消)', async () => {
    const scope = new AbortScope()
    const child = scope.child({ timeoutMs: 1 })
    // 一页 fetch 超时:抛的同样是 AbortError 家族的错误。
    const error = await child.race(new Promise(() => {})).then(() => undefined, (thrown: unknown) => thrown)
    expect(isToolAbortError(error)).toBe(true)
    expect(isToolTimeoutError(error)).toBe(true)
    expect(scope.aborted).toBe(false)

    const outcome = Outcome.fromError(error, scope)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('Timed out')
    scope.dispose()
  })

  it('fromError:同一个超时错误,但父作用域也响了 → aborted', () => {
    const scope = new AbortScope()
    scope.abort('user stopped')
    const outcome = Outcome.fromError(createToolTimeoutError('Timed out after 10ms'), scope)
    expect(outcome).toEqual({ kind: 'aborted', reason: 'user stopped' })
    scope.dispose()
  })

  it('fromError:消息里出现 abort 字样但对象不是取消错误 → 仍是 failed', () => {
    // core/tools/abort.ts 头注释里的那个坑:失败消息里可能嵌着文件内容。
    const outcome = Outcome.fromError(new Error('no match for "if (signal.aborted) return"'))
    expect(outcome.kind).toBe('failed')
  })

  it('非 Error 抛出物也被规整成 Error', () => {
    const outcome = Outcome.fromError('just a string')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error).toBeInstanceOf(Error)
  })

  it('toModelText 各结局的投影', () => {
    expect(Outcome.toModelText(Outcome.ok(textResult('hello')))).toBe('hello')
    // R2a 决定③:invalid 原样交出工具自己的文案,内核不加前缀。
    expect(Outcome.toModelText(Outcome.invalid('Invalid read parameters:\n- path: required')))
      .toBe('Invalid read parameters:\n- path: required')
    // denied 的文案由 Authorizer 给,内核不发明用户可见措辞。
    expect(Outcome.toModelText(Outcome.denied('The user rejected permission for this tool.')))
      .toBe('The user rejected permission for this tool.')
    expect(Outcome.toModelText(Outcome.aborted())).toBe(TOOL_CANCELLED_MESSAGE)
    expect(Outcome.toModelText(Outcome.failed(new Error('boom')))).toContain('boom')
  })

  it('R2a 决定④:取消结局可以带上最后一段部分输出,并投影成 <partial_output>', () => {
    const partial = textResult('line 1\nline 2\n')
    const outcome = Outcome.aborted(undefined, partial)
    expect(outcome.kind === 'aborted' && outcome.partial).toBe(partial)
    expect(Outcome.toModelText(outcome)).toBe(
      `${TOOL_CANCELLED_MESSAGE}\n\n<partial_output>\nline 1\nline 2\n</partial_output>`,
    )
  })

  it('R2a 决定④:没有部分输出时取消文本一个字不变', () => {
    expect(Outcome.toModelText(Outcome.aborted(undefined, textResult('   ')))).toBe(TOOL_CANCELLED_MESSAGE)
  })

  it('withPartial 只补取消结局,且不覆盖已有的那一段', () => {
    const first = textResult('first')
    const second = textResult('second')
    expect(Outcome.withPartial(Outcome.ok(textResult('x')), first)).toEqual(Outcome.ok(textResult('x')))
    const attached = Outcome.withPartial(Outcome.aborted('user stopped'), first)
    expect(attached.kind === 'aborted' && attached.partial).toBe(first)
    const again = Outcome.withPartial(attached, second)
    expect(again.kind === 'aborted' && again.partial).toBe(first)
  })

  it('isOk 收窄类型', () => {
    const outcome = Outcome.ok(textResult('x'))
    expect(Outcome.isOk(outcome)).toBe(true)
    expect(Outcome.isOk(Outcome.aborted())).toBe(false)
  })
})

describe('Result', () => {
  it('非文本 part 只留占位行', () => {
    const text = resultToText({
      content: [
        { type: 'text', text: 'line' },
        { type: 'image', path: '/tmp/a.png' },
        { type: 'file', path: '/tmp/a.txt' },
        { type: 'image' },
      ],
    })
    expect(text).toBe('line\n[Image: /tmp/a.png]\n[File: /tmp/a.txt]\n[Image]')
  })
})
