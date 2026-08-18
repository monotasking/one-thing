import * as os from 'node:os'
import { describe, expect, it } from 'vitest'
import { formatStateVariablesForPrompt } from '../format.js'
import type { ContextVariable } from '../types.js'

function v(partial: Partial<ContextVariable> & { name: string; value: string }): ContextVariable {
  return { state: true, ...partial }
}

describe('formatStateVariablesForPrompt', () => {
  it('renders one <var> element per variable with descriptions and skips empty values', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'a', value: '1', description: 'first' }),
      v({ name: 'empty', value: '' }),
      v({ name: 'b', value: '2' }),
    ])).toBe('<var name="a" state="true" desc="first">1</var>\n<var name="b" state="true">2</var>')
  })

  it('renders type and non-session scope as attributes', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'budget', value: '1.5', type: 'number', scope: 'session' }),
      v({ name: 'tags', value: '["x"]', type: 'set', scope: 'agent', description: 'labels' }),
      v({ name: 'plain', value: 'text', type: 'string', scope: 'global' }),
    ])).toBe([
      '<var name="budget" state="true" type="number">1.5</var>',
      '<var name="plain" state="true" scope="global">text</var>',
      '<var name="tags" state="true" type="set" scope="agent" desc="labels">["x"]</var>',
    ].join('\n'))
  })

  it('escapes XML special characters in attributes and content', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'q', value: 'a < b & c', description: 'says "hi" & <bye>' }),
    ])).toBe('<var name="q" state="true" desc="says &quot;hi&quot; &amp; &lt;bye>">a &lt; b &amp; c</var>')
  })

  // The formatter used to drop `workdir` because the prompt builder had its own
  // `# Work Directory` section. That section is gone (prompt-channels
  // 2026-08-18): the board is now the single place the working directory is
  // stated, so skipping it would mean nobody states it at all.
  it('renders workdir like any other variable — it is no longer stated twice', () => {
    const home = os.homedir()
    const out = formatStateVariablesForPrompt([
      v({
        name: 'workdir',
        value: `${home}/project`,
        values: [`${home}/project`, `${home}/.onething/skills/iva`],
      }),
      v({ name: 'a', value: '1' }),
    ])
    expect(out).toBe(
      '<var name="a" state="true">1</var>\n<var name="workdir" state="true">~/project</var>',
    )
  })

  it('folds multiline values and truncates with the existing ellipsis', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'note', value: 'line1\nline2\nline3' }),
      v({ name: 'long', value: 'x'.repeat(20) }),
    ], { maxValueLength: 10 })).toBe(
      '<var name="long" state="true">xxxxxxxxxx…</var>\n<var name="note" state="true">line1 (+2 …</var>',
    )
  })
})

/**
 * §R 的二分:一个 `state` 标志决定变量进不进请求。
 *
 * 这一组守的是"没有第三种去处"——非 state 变量不在任何通道里,只能工具读。
 */
describe('the state flag decides everything', () => {
  /**
   * 两种形状,一块里(§R.4 修订):state 带值,非 state 只报名字与介绍。
   * 值不进,所以一屋子大变量也撑不爆上下文;名字进,所以模型知道板上还有什么
   * —— 此前非 state 完全不渲染,发现一个变量要先花一次它没理由去调的 keys。
   */
  it('state 带值,非 state 只报名录(自闭合、无值)', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'my_cards', value: '#a1b2c3d4「登录页改版」doing', state: true }),
      v({ name: 'deploy_target', value: 'staging', state: false, description: '发布去哪' }),
      v({ name: 'unset', value: 'x', state: undefined }),
    ])).toBe([
      '<var name="my_cards" state="true">#a1b2c3d4「登录页改版」doing</var>',
      // state 在前、名录在后:先看见"现在怎么样",再看见"还有什么可查"。
      '<var name="deploy_target" state="false" desc="发布去哪"/>',
      '<var name="unset" state="false"/>',
    ].join('\n'))
  })

  it('值一个字节都不进名录 —— 撑不爆上下文靠的是这条', () => {
    const rendered = formatStateVariablesForPrompt([
      { name: 'archive', value: 'x'.repeat(5000) },
    ])
    expect(rendered).toBe('<var name="archive" state="false"/>')
    expect(rendered).not.toContain('xxx')
  })

  it('默认非 state —— 不主动要,就只进名录不进正文', () => {
    expect(formatStateVariablesForPrompt([
      { name: 'deploy_target', value: 'staging' },
      { name: 'archive', value: '[]' },
    ])).toBe('<var name="archive" state="false"/>\n<var name="deploy_target" state="false"/>')
  })

  it('marks state variables unchanged for 14+ days as stale (constant marker)', () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = 100 * DAY
    expect(formatStateVariablesForPrompt([
      v({ name: 'fresh', value: 'a', updatedAt: now - DAY }),
      v({ name: 'old', value: 'b', updatedAt: now - 15 * DAY }),
      v({ name: 'no_timestamp', value: 'c' }),
    ], { now })).toBe([
      '<var name="fresh" state="true">a</var>',
      '<var name="no_timestamp" state="true">c</var>',
      '<var name="old" state="true" stale="unchanged for 14+ days — may be out of date">b</var>',
    ].join('\n'))
  })
})

/**
 * 状态板不设上限(§R.5),但排序纪律不变:`<context-update>` 的去重判定是逐字
 * 相等,顺序一抖就等于每回合重发一整块。
 */
describe('no budget, deterministic order', () => {
  it('sorts by name — never by updatedAt', () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = 100 * DAY
    // 最近更新的排在输入的最前面:按 updatedAt 排序会原样保留这个顺序。
    expect(formatStateVariablesForPrompt([
      v({ name: 'zulu', value: 'z', updatedAt: now }),
      v({ name: 'alpha', value: 'a', updatedAt: now - DAY }),
      v({ name: 'mike', value: 'm', updatedAt: now - 2 * DAY }),
    ], { now })).toBe([
      '<var name="alpha" state="true">a</var>',
      '<var name="mike" state="true">m</var>',
      '<var name="zulu" state="true">z</var>',
    ].join('\n'))
  })

  it('renders the same bytes no matter what order the variables arrive in', () => {
    const now = 1_000_000
    const set: ContextVariable[] = [
      v({ name: 'alpha', value: 'a', updatedAt: now - 10 }),
      v({ name: 'mike', value: 'm', updatedAt: now - 20 }),
      v({ name: 'zulu', value: 'z', updatedAt: now - 30 }),
    ]
    const first = formatStateVariablesForPrompt(set, { now })
    const shuffled = formatStateVariablesForPrompt([set[2], set[0], set[1]], { now })
    // 一个变量被重写(updatedAt 前移)也不能改变字节 —— 否则每写一次就重发一块。
    const rewritten = formatStateVariablesForPrompt(
      set.map(item => (item.name === 'zulu' ? { ...item, updatedAt: now } : item)),
      { now },
    )
    expect(shuffled).toBe(first)
    expect(rewritten).toBe(first)
  })

  it('never truncates the state board — a state you cannot see is the bug it was built to fix', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      v({ name: `var_${String(i).padStart(2, '0')}`, value: 'x'.repeat(300) }))
    const lines = formatStateVariablesForPrompt(many).split('\n')
    expect(lines).toHaveLength(40)
    expect(lines[0]).toBe(`<var name="var_00" state="true">${'x'.repeat(300)}</var>`)
    expect(lines.at(-1)).toBe(`<var name="var_39" state="true">${'x'.repeat(300)}</var>`)
    // 溢出提示行随预算一起删掉了:没有被截掉的东西,就不该有"还有更多"这句话。
    expect(formatStateVariablesForPrompt(many)).not.toContain('var-overflow')
  })

  it('still truncates a single oversized value (that guard is not a budget)', () => {
    expect(formatStateVariablesForPrompt([
      v({ name: 'huge', value: 'x'.repeat(600) }),
    ])).toBe(`<var name="huge" state="true">${'x'.repeat(512)}…</var>`)
  })

  it('emits nothing when no variable is state — the caller drops the whole block', () => {
    expect(formatStateVariablesForPrompt([])).toBe('')
  })
})
