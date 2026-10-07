/**
 * `onething backend …` 的几只纯判据(第④步批 3):档位怎么读、谁拉起的、哪台停得、时长怎么写。
 * 「真的停得掉 / 真的被拒」由 `gate:cli-http` 在真后端上证;这里钉住判据本身。
 * 反证:把 `refusalToStop` 里 `cli` 那一支改成也拒,第三条红。
 */
import { describe, expect, it } from 'vitest'
import { backendModeOf } from '../backend-connect.js'
import { formatUptime, launchedByOf, refusalToStop } from '../backend-command.js'

const record = (owner: string, launcher?: string) => ({
  record: { port: 1, host: '127.0.0.1', pid: 1, startedAt: 1, owner, ...(launcher ? { launcher } : {}) } as never,
})

describe('onething backend', () => {
  it('档位:--spawn 优先,其次 ONETHING_CLI_BACKEND=spawn,缺省 attach', () => {
    expect(backendModeOf({}, {})).toBe('attach')
    expect(backendModeOf({ spawn: true }, {})).toBe('spawn')
    expect(backendModeOf({}, { ONETHING_CLI_BACKEND: 'spawn' })).toBe('spawn')
    expect(backendModeOf({}, { ONETHING_CLI_BACKEND: 'attach' })).toBe('attach')
  })

  it('拉起者按发现文件的 owner + launcher 认', () => {
    expect(launchedByOf(record('backend', 'cli'))).toBe('cli')
    expect(launchedByOf(record('backend', 'desktop'))).toBe('desktop')
    expect(launchedByOf(record('server'))).toBe('server:start')
    expect(launchedByOf(record('backend'))).toBe('unknown')
  })

  it('只停 CLI 拉起的那台;桌面的、server:start 的各有一句该去哪儿停', () => {
    expect(refusalToStop(record('backend', 'cli'))).toBeUndefined()
    expect(refusalToStop(record('backend', 'desktop'))).toMatch(/started by the desktop app/)
    expect(refusalToStop(record('backend'))).toMatch(/started by the desktop app/)
    expect(refusalToStop(record('server'))).toMatch(/server:start/)
  })

  it('已运行时长', () => {
    expect(formatUptime(12_000)).toBe('12s')
    expect(formatUptime(250_000)).toBe('4m 10s')
    expect(formatUptime(2 * 3_600_000 + 180_000)).toBe('2h 03m')
  })
})
