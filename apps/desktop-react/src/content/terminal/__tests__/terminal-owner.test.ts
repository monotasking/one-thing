import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@shared/ipc/terminal'
import type { ACPAgentState } from '@shared/ipc/acp'
import { agentNameOf, splitTerminalsByOwner } from '../terminal-owner'
import { t } from '../../../i18n'

/**
 * **终端是谁开的**(ACP A3-d)。钉三件:
 *  ① `owner.kind === 'acp'` 的进「Agent」组,缺席 `owner` 读作人自己的(老后端 / 人手开的);
 *  ② agent 名取名册的显示名,名册里没有就退回 id;
 *  ③ 那一行的字是「<agent 名> 开的 · <标题>」(菜单 `terminal-launcher.tsx` 读的就是这句)。
 */

function term(id: string, owner?: TerminalInfo['owner']): TerminalInfo {
  return { id, title: `t-${id}`, cwd: '/w', shell: 'zsh', cols: 80, rows: 24, createdAt: 0, ...(owner ? { owner } : {}) }
}

const roster = [
  { config: { id: 'claude-code', name: '', enabled: true, command: 'x' }, manifest: { id: 'claude-code', name: 'Claude Code' } },
  { config: { id: 'mine', name: 'Mine·工作', enabled: true, command: 'y' } },
] as unknown as ACPAgentState[]

describe('terminal-owner', () => {
  it('① 按 owner 分两组,缺席 owner = 人自己的', () => {
    const { mine, agents } = splitTerminalsByOwner([
      term('a'),
      term('b', { kind: 'user' }),
      term('c', { kind: 'acp', agentId: 'claude-code', sessionId: 's1' }),
    ])
    expect(mine.map((row) => row.id)).toEqual(['a', 'b'])
    expect(agents.map((row) => row.id)).toEqual(['c'])
  })

  it('② 名字:覆盖名 > 自述名 > id', () => {
    expect(agentNameOf('claude-code', roster)).toBe('Claude Code')
    expect(agentNameOf('mine', roster)).toBe('Mine·工作')
    expect(agentNameOf('gone', roster)).toBe('gone')
    expect(agentNameOf('claude-code', undefined)).toBe('claude-code')
    expect(agentNameOf(undefined, roster)).toBe('')
  })

  it('③ 那一行的字', () => {
    expect(t('terminal.openedBy', { agent: agentNameOf('claude-code', roster), title: 'npm test' })).toContain('Claude Code')
    expect(t('terminal.openedBy', { agent: 'Claude Code', title: 'npm test' })).toContain('npm test')
  })
})
