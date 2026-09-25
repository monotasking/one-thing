import { describe, expect, it } from 'vitest'
/* 引用种类互相借自述(技能借命令的 argHint),单独 import 一种会先撞上还没装好的那一种;
 * 与生产同一条路:先装 barrel(判词在 `references/index.ts`「谁来 import 它」)。 */
import '../references'
import type { ACPSessionOption } from '@shared/ipc/acp'
import type { AcpSessionState } from '@shared/contracts/acp'
import { choiceNameOf, claimAgentOptions, claimsOfState } from './agent-claims'
import { agentBarFactOf, firstLine } from './strips/agent'
import { agentCommandEntries } from '../references/kinds/agent-command'
import { meterRowsOf, withAgentUsage } from './components/MeterCard'
import { EMPTY_VIEW } from '../data/meter-source'
import { t } from '../i18n'

/**
 * A2-c 的四只纯判据:按 category 认领、会话横条挑哪一件、命令并表、读数卡的来源。
 * 组件层(药丸 / 模式粒 / 抽屉 / 右卡)的用例在 `components/Composer.test.tsx` 的 A2-c 一段。
 */

const opt = (
  id: string,
  category: string | undefined,
  currentValue = 'a',
  type?: 'select' | 'boolean',
): ACPSessionOption => ({
  id,
  name: id,
  ...(category ? { category } : {}),
  ...(type ? { type } : {}),
  currentValue,
  choices: [
    { value: 'a', name: 'A 名' },
    { value: 'b', name: 'B 名' },
  ],
})

const state = (partial: Partial<AcpSessionState> = {}): AcpSessionState => ({
  localSessionId: 's',
  agentId: 'x',
  configOptions: [],
  commands: [],
  notices: [],
  process: { status: 'connected' },
  ...partial,
})

describe('claimAgentOptions:只认 category,不认名字', () => {
  it('model / thought_level / mode 各认第一格,其余按原顺序留给右卡', () => {
    const claims = claimAgentOptions([
      opt('whatever-model', 'model'),
      opt('effort', 'thought_level'),
      opt('m', 'mode', 'b'),
      opt('fast', 'model_config'),
      opt('model-2', 'model'),
      opt('custom', 'x-vendor'),
    ])
    expect(claims.model?.id).toBe('whatever-model')
    expect(claims.thought?.id).toBe('effort')
    expect(claims.mode).toMatchObject({ kind: 'option', name: 'B 名', settable: true })
    expect(claims.rest.map((o) => o.id)).toEqual(['fast', 'model-2', 'custom'])
  })

  it('boolean 型永远不进药丸 / 阶梯 / 模式粒', () => {
    const claims = claimAgentOptions([opt('m', 'model', 'true', 'boolean')])
    expect(claims.model).toBeNull()
    expect(claims.rest.map((o) => o.id)).toEqual(['m'])
  })

  it('没有 mode 那一格就退到 modes:只读', () => {
    const claims = claimAgentOptions([], { current: 'ask', available: [{ id: 'ask', name: 'Ask' }] })
    expect(claims.mode).toEqual({ kind: 'modes', current: 'ask', name: 'Ask', settable: false })
  })

  it('没有 thought_level:阶梯那一格是 null(调用方据此不画)', () => {
    expect(claimAgentOptions([opt('model', 'model')]).thought).toBeNull()
  })

  it('值不在 choices 里:照实写值,不编名字;没有状态 = null', () => {
    expect(choiceNameOf({ ...opt('m', 'model'), currentValue: 'zzz' })).toBe('zzz')
    expect(claimsOfState(null)).toBeNull()
  })
})

describe('agentBarFactOf:会话横条一次只说一件', () => {
  const notice = { severity: 'warning' as const, title: '限流', description: '慢一点', at: 1 }
  it('整理上下文 > 进程出错 > 最近一条通知 > 不出现', () => {
    expect(
      agentBarFactOf(
        state({
          compaction: { status: 'in_progress', startedAt: 1 },
          process: { status: 'error', error: 'boom' },
          notices: [notice],
        }),
      ),
    ).toEqual({ kind: 'compacting' })
    expect(agentBarFactOf(state({ process: { status: 'error', error: 'boom' }, notices: [notice] }))).toEqual({
      kind: 'process-error',
      error: 'boom',
    })
    expect(agentBarFactOf(state({ notices: [{ ...notice, title: '旧' }, notice] }))).toEqual({
      kind: 'notice',
      notice,
    })
    expect(agentBarFactOf(state({ compaction: { status: 'done', startedAt: 1 } }))).toBeNull()
    expect(agentBarFactOf(null)).toBeNull()
  })

  it('错误原话只念第一行', () => {
    expect(firstLine('\n  spawn ENOENT\n    at x')).toBe('spawn ENOENT')
  })
})

describe('agentCommandEntries:agent 命令并进 `/` 抽屉', () => {
  it('名 = /name,inputHint 是占位;撞内置的、带空白斜杠的、重复的剔掉', () => {
    const entries = agentCommandEntries([
      { name: 'review', description: 'Review', inputHint: 'path' },
      { name: 'compact', description: '撞内置' },
      { name: 'bad name', description: '带空白' },
      { name: '/review', description: '重复' },
      { name: 'plain', description: '无参' },
    ])
    expect(entries.map((e) => [e.name, e.argHint ?? null, e.kind])).toEqual([
      ['/review', 'path', 'agent'],
      ['/plain', null, 'agent'],
    ])
  })
})

describe('读数卡:agent 自报的用量优先,并写明来源', () => {
  it('自报了:上下文那一行换成「agent 自报」,本地那行不再重复;带花费就跟一行', () => {
    const usage = { used: 12_000, size: 200_000, cost: { amount: 0.1234, currency: 'USD' } }
    const view = withAgentUsage({ ...EMPTY_VIEW, present: true, contextUsed: 5, contextMax: 10 }, usage)
    const rows = meterRowsOf(view, t, undefined, usage)
    expect(rows.map((r) => r.key)).toEqual([t('meter.contextAgent'), t('meter.costAgent')])
    expect(rows[0]!.value).toContain('%')
    expect(rows[1]!.value).toBe('0.1234 USD')
  })

  it('没报:一个字不改(本地估算照旧)', () => {
    const view = { ...EMPTY_VIEW, present: true, contextUsed: 5, contextMax: 10 }
    expect(withAgentUsage(view, null)).toBe(view)
    expect(meterRowsOf(view, t).map((r) => r.key)).toEqual([t('meter.context')])
  })
})
