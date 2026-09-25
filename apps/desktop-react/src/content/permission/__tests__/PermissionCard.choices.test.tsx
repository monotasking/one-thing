import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionCard } from '../PermissionCard'
import { askFromPendingInfo, askFromRequestEvent, type PermissionAsk } from '../../../data/permission-ask'
import type { PermissionRequestEvent } from '@shared/events/session-events'
import { t } from '../../../i18n'

/**
 * **权限卡 · 发问方自带选项与改动预览**(ACP A3-d)。
 *
 * 钉四件:
 *  ① `choices` 在场:四种 kind 各一颗,字用 agent 的原话,颜色 / 次序由 kind 定;
 *     `session` / `workdir` 照画(onething 自己的记忆);
 *  ② 按下哪颗答哪个 kind —— `reject-always` 也照原词答出去;
 *  ③ `choices` 缺席:五钮逐字不变(本地工具零回归;另一份原有用例整份没改);
 *  ④ `diff` 在场:一行摘要(改动 · 路径 · +a −d),缺省收着;点开挂的是 diff 块。
 * 反证:把 `PermissionCardFoot` 里 `if (ask.choices)` 那一支挖掉 → ① ② 红(真机门 ⑤ 同判)。
 */

const CHOICES = [
  { id: 'opt-reject-always', kind: 'reject-always', label: 'Always Reject' },
  { id: 'opt-allow-once', kind: 'once', label: 'Allow' },
  { id: 'opt-reject-once', kind: 'reject', label: 'Reject' },
  { id: 'opt-allow-always', kind: 'always', label: 'Always Allow' },
] as const

const ASK: PermissionAsk = {
  toolCallId: 'perm-1-1',
  permissionId: 'req-9',
  title: 'Fake: npm run build',
  type: 'bash',
  pattern: 'npm run build',
  permissionQueued: false,
  canRespond: true,
  choices: [...CHOICES],
}

function mount(over: Partial<PermissionAsk> = {}) {
  const onRespond = vi.fn()
  render(<PermissionCard ask={{ ...ASK, ...over }} onRespond={onRespond} />)
  return { onRespond }
}

const keys = () =>
  screen.queryAllByRole('button').filter((el) => el.hasAttribute('data-permission-decision'))

describe('权限卡:发问方自带选项(A3-d)', () => {
  it('① 四种 kind 各一颗,字是 agent 的原话;次序 once → 本会话 → 本工作目录 → always → reject → reject-always', () => {
    mount()
    expect(keys().map((el) => el.textContent)).toEqual([
      'Allow',
      t('permission.allowSession'),
      t('permission.allowWorkdir'),
      'Always Allow',
      'Reject',
      'Always Reject',
    ])
    const agentKeys = keys().filter((el) => el.hasAttribute('data-permission-choice'))
    expect(agentKeys.map((el) => el.getAttribute('data-permission-choice'))).toEqual([
      'once',
      'always',
      'reject',
      'reject-always',
    ])
    // 颜色由 kind 定:once 是 primary(焦点环挂 on-accent 那一档),reject-always 是 danger。
    expect(agentKeys[0].getAttribute('data-focus-ring-tone')).toBe('on-accent')
    expect(agentKeys[3].className).toMatch(/danger/)
    expect(agentKeys[1].className).not.toMatch(/danger|primary/)
    // 我们自己的五钮文案一颗都不混进来(「允许一次」「拒绝」「始终允许」是 agent 说的那几颗的位子)。
    expect(screen.queryByText(t('permission.allowOnce'))).toBeNull()
    expect(screen.queryByText(t('permission.reject'))).toBeNull()
  })

  it('① agent 没给的 kind 不画;不可授权的效果不画本会话 / 本工作目录', () => {
    mount({ type: 'capability_change', choices: [CHOICES[1], CHOICES[2]] })
    expect(keys().map((el) => el.textContent)).toEqual(['Allow', 'Reject'])
  })

  it('② 按哪颗答哪个 kind:reject-always 原词答出去,once / session 各答各的', () => {
    const { onRespond } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Always Reject' }))
    expect(onRespond).toHaveBeenLastCalledWith('perm-1-1', 'reject-always')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenLastCalledWith('perm-1-1', 'once')
    fireEvent.click(screen.getByRole('button', { name: t('permission.allowSession') }))
    expect(onRespond).toHaveBeenLastCalledWith('perm-1-1', 'session')
  })

  it('② 答了 reject-always 之后那一句是「已拒绝」', () => {
    mount({ canRespond: false, answered: 'reject-always' })
    expect(keys()).toEqual([])
    expect(screen.getByText(t('permission.answeredReject'))).toBeTruthy()
  })

  it('③ `choices` 缺席 = 今天那五个键,一颗不多一颗不少', () => {
    mount({ choices: undefined, type: 'session_destructive', alwaysScope: { scheme: 'session' } })
    expect(keys().map((el) => el.textContent)).toEqual([
      t('permission.allowOnce'),
      t('permission.allowSession'),
      t('permission.allowWorkdir'),
      t('permission.allowAlways', { app: 'session' }),
      t('permission.reject'),
    ])
    expect(document.querySelector('[data-permission-choice]')).toBeNull()
  })
})

const DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old line',
  '+new line',
  '',
].join('\n')

describe('权限卡:改动预览(A3-d)', () => {
  it('④ diff 在场:一行摘要缺省收着,点开挂 diff 块', () => {
    mount({ choices: undefined, type: 'file_edit', diff: DIFF, path: '/w/src/a.ts', additions: 1, deletions: 1 })
    const head = document.querySelector('[data-permission-diff]') as HTMLElement
    expect(head.getAttribute('data-permission-diff')).toBe('closed')
    expect(head.textContent).toContain(t('permission.diffLabel'))
    expect(head.textContent).toContain('/w/src/a.ts')
    expect(head.textContent).toContain(t('chat.tool.diffStat', { add: 1, del: 1 }))
    // 收着的时候块还没挂(一张等人答的卡不先去跑高亮)。
    expect(document.body.textContent).not.toContain('new line')
    fireEvent.click(head)
    expect(head.getAttribute('data-permission-diff')).toBe('open')
    expect(document.body.textContent).toContain('new line')
    expect(document.body.textContent).toContain('old line')
  })

  it('④ diff 缺席:一行摘要都不画', () => {
    mount({ choices: undefined, type: 'bash' })
    expect(document.querySelector('[data-permission-diff]')).toBeNull()
  })
})

describe('permission-ask:事件 / 对账口 → 卡上那几格', () => {
  const event = {
    type: 'permission:request',
    requestId: 'req-1',
    targetChannel: 'http',
    toolCallId: 'c1',
    messageId: 'm1',
    permissionType: 'file_write',
    title: 'write',
    metadata: { diff: DIFF, path: '/w/a.ts', additions: 3, deletions: 0, agentId: 'x' },
    choices: [...CHOICES, { id: 'bad', kind: 'maybe', label: '?' }],
  } as unknown as PermissionRequestEvent

  it('活事件:choices 只收四种 kind,diff 四格从 metadata 取', () => {
    const ask = askFromRequestEvent(event)
    expect(ask.choices?.map((c) => c.kind)).toEqual(['reject-always', 'once', 'reject', 'always'])
    expect(ask).toMatchObject({ diff: DIFF, path: '/w/a.ts', additions: 3, deletions: 0 })
  })

  it('对账口:同样两格;没有 choices / diff 的 ask 两格都缺席', () => {
    const ask = askFromPendingInfo({
      id: 'p1',
      type: 'bash',
      sessionID: 's',
      messageID: 'm',
      callId: 'c2',
      title: 'x',
      metadata: {},
      time: { created: 0 },
    } as never)
    expect(ask).toBeDefined()
    expect(ask && 'choices' in ask).toBe(false)
    expect(ask && 'diff' in ask).toBe(false)
  })
})

describe('没有工具卡可挂的审批(A3-d)', () => {
  it('车道里找不到调用的那几张才算;空车道交回同一个空表', async () => {
    const { orphanAsksOf } = await import('../PermissionSlot')
    const lane = {
      'call-in-card': { ...ASK, toolCallId: 'call-in-card' },
      'acp-terminal-1': { ...ASK, toolCallId: 'acp-terminal-1', choices: undefined },
      'nested-child': { ...ASK, toolCallId: 'nested-child' },
    }
    const messages = [
      { id: 'm1', toolCalls: [{ id: 'call-in-card' }], steps: [{ id: 's', childSteps: [{ id: 'c', toolCallId: 'nested-child' }] }] },
    ] as never
    expect(orphanAsksOf(lane, messages).map((ask) => ask.toolCallId)).toEqual(['acp-terminal-1'])
    const empty = orphanAsksOf({}, messages)
    expect(orphanAsksOf({}, [])).toBe(empty)
  })
})
