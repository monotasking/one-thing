import { describe, expect, it } from 'vitest'
import { ACPClient, describeConnectFailure, toAcpPromptError } from '../client.js'

/**
 * 连不上 agent 时交给会话的那句话(2026-09-24,ACP「发了没反应」报障)。
 * 设置里的默认命令是 `claude-agent-acp` / `pi-acp` 这类要另装的适配器 ——
 * Node 原话 `spawn pi-acp ENOENT` 既没说「没装」也没说「PATH 里没有」。
 */
describe('describeConnectFailure', () => {
  it('ENOENT 说成「命令不在 PATH 上」并点名命令', () => {
    const enoent = Object.assign(new Error('spawn pi-acp ENOENT'), { code: 'ENOENT' })
    const failure = describeConnectFailure('pi-acp', enoent)
    expect(failure.message).toContain('"pi-acp" was not found on PATH')
    expect(failure.cause).toBe(enoent)
  })

  it('握手前退出时带上 stderr 尾巴', () => {
    const failure = describeConnectFailure('x', new Error('ACP agent exited with code 1.'), 'Error: not logged in\n')
    expect(failure.message).toContain('not logged in')
  })

  it('没有 stderr 就原样交回', () => {
    const original = new Error('did not initialize in time')
    expect(describeConnectFailure('x', original)).toBe(original)
  })
})

describe('ACPClient 真 spawn 一条不存在的命令', () => {
  it('connect 抛出的是那句人话,状态落 error', async () => {
    const client = new ACPClient({
      id: 'ghost',
      name: 'Ghost',
      enabled: true,
      command: 'onething-definitely-not-installed-acp',
      args: [],
      connectTimeoutMs: 5000,
    } as never)
    await expect(client.connect()).rejects.toThrow(/was not found on PATH/)
    expect(client.state.status).toBe('error')
    expect(client.state.error).toMatch(/onething-definitely-not-installed-acp/)
  })
})

/**
 * prompt 失败时的那句话(2026-09-24 真机:会话里的错误卡写着 `[object Object]`)。
 * SDK 把对端的 JSON-RPC 错误原样 reject 成普通对象。
 */
describe('toAcpPromptError', () => {
  it('JSON-RPC 错误对象取出 message,不再是 [object Object]', () => {
    const err = toAcpPromptError({ code: -32603, message: 'Internal error', data: { details: 'boom' } }, 'Pi')
    expect(err.message).toBe('Internal error: boom')
  })

  it('authRequired 说成「agent 没登录」,带上 agent 自报的原话', () => {
    const err = toAcpPromptError({ code: -32000, message: 'Authentication required' }, 'Claude Code', 'Not logged in')
    expect(err.message).toContain('"Claude Code" is not logged in (Not logged in)')
  })

  it('本来就是 Error 的原样交回', () => {
    const original = new Error('x')
    expect(toAcpPromptError(original, 'a')).toBe(original)
  })
})
