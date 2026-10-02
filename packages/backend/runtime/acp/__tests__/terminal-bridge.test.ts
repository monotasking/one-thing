/**
 * ACP 终端桥(A3-b,方案 §3.5 / §11.3):agent 的命令跑在 `TerminalService` 里(owner = 这台 agent),
 * 起之前按 `execute` 效果问一次。服务与授权者都是桩 —— PTY 本身有它自己的真机冒烟测试。
 */
import { describe, expect, it, vi } from 'vitest'
import { Decision } from '@onething/backend/core/toolkit'
import type { Authorizer, Intent } from '@onething/backend/core/toolkit'
import type { AcpClientRequestContext } from '@onething/backend/runtime/acp'
import type { TerminalCreateRequest } from '@shared/ipc.js'
import type { TerminalExitStatus } from '@onething/backend/runtime/terminal/service.wiring'

vi.mock('@onething/backend/runtime/permission/message-anchor', () => ({
  resolvePermissionMessageAnchor: (_sessionId: string, preferred?: string) => preferred ?? '',
}))

const { createAcpTerminalBridge, ACP_TERMINAL_MAX_PER_AGENT } = await import('../terminal-bridge.js')

function fakeService() {
  const created: TerminalCreateRequest[] = []
  const exitListeners = new Map<string, (status: TerminalExitStatus) => void>()
  const outputs = new Map<string, string>()
  const terminated: string[] = []
  const killed: string[] = []
  let next = 0
  return {
    created, outputs, terminated, killed,
    exit(id: string, status: TerminalExitStatus) { exitListeners.get(id)?.(status) },
    port: {
      create(request: TerminalCreateRequest) {
        created.push(request)
        const id = `t-${next += 1}`
        outputs.set(id, '')
        return { id, title: 'x', cwd: request.cwd ?? '', shell: request.command ?? '', cols: 80, rows: 24, createdAt: 0, owner: request.owner }
      },
      readOutput(id: string) {
        const output = outputs.get(id)
        return output === undefined ? undefined : { output, truncated: false }
      },
      onExit(id: string, listener: (status: TerminalExitStatus) => void) {
        exitListeners.set(id, listener)
        return () => exitListeners.delete(id)
      },
      terminate(id: string) { terminated.push(id) },
      async kill(id: string) { killed.push(id); outputs.delete(id) },
    },
  }
}

function context(overrides: Partial<AcpClientRequestContext> = {}): AcpClientRequestContext {
  return { agentId: 'kimi', agentName: 'Kimi', localSessionId: 'session-1', messageId: 'msg-1', cwd: '/tmp/acp-project', ...overrides }
}

function harness(answer: () => Decision = () => Decision.allow()) {
  const service = fakeService()
  const asked: Intent[] = []
  const authorizer: Authorizer = { async decide(intent) { asked.push(intent); return answer() } }
  const bridge = createAcpTerminalBridge({
    authorizer: () => authorizer,
    service: () => service.port as never,
    available: () => true,
    spawnEnv: () => ({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:8080', DROPPED: undefined }),
  })
  return { bridge, service, asked }
}

describe('terminal/create', () => {
  it('先按 execute 问(bash 分析),准了才在服务里起;owner = 这台 agent,环境 = 代理 ⊕ agent 的 env', async () => {
    const { bridge, service, asked } = harness()
    const { terminalId } = await bridge.create(context(), { command: 'npm', args: ['run', 'build'], env: { FOO: 'bar', PATH: '/x' } })
    expect(asked[0].effects.map(effect => effect.kind)).toContain('bash')
    expect(service.created[0]).toMatchObject({
      command: 'npm',
      args: ['run', 'build'],
      cwd: '/tmp/acp-project',
      env: { PATH: '/x', HTTPS_PROXY: 'http://proxy:8080', FOO: 'bar' },
      owner: { kind: 'acp', agentId: 'kimi', sessionId: 'session-1' },
    })
    expect(service.created[0].env).not.toHaveProperty('DROPPED')
    expect(terminalId).toBe('t-1')
  })

  it('拒了:不起终端,答一句人话', async () => {
    const { bridge, service } = harness(() => Decision.deny('The user rejected permission for this tool.'))
    await expect(bridge.create(context(), { command: 'npm', args: ['publish'] })).rejects.toThrow(/onething denied running "npm publish"/)
    expect(service.created).toEqual([])
  })

  it("unattended: 'allow' 前置放行,不进 ask", async () => {
    const { bridge, service, asked } = harness(() => Decision.deny('should not be asked'))
    await bridge.create(context({ unattended: 'allow' }), { command: 'npm', args: ['test'] })
    expect(asked).toEqual([])
    expect(service.created).toHaveLength(1)
  })

  it(`每台 agent 最多 ${ACP_TERMINAL_MAX_PER_AGENT} 格;release 之后腾出位置,别的 agent 不受影响`, async () => {
    const { bridge } = harness()
    const ids: string[] = []
    for (let i = 0; i < ACP_TERMINAL_MAX_PER_AGENT; i += 1) ids.push((await bridge.create(context(), { command: 'true' })).terminalId)
    await expect(bridge.create(context(), { command: 'true' })).rejects.toThrow(/Too many open terminals/)
    await expect(bridge.create(context({ agentId: 'other' }), { command: 'true' })).resolves.toBeDefined()
    await bridge.release(context(), { terminalId: ids[0] })
    await expect(bridge.create(context(), { command: 'true' })).resolves.toBeDefined()
  })
})

describe('output / wait_for_exit / kill / release', () => {
  it('output 读回放环、截在字节上限(丢最早的);结局带信号名', async () => {
    const { bridge, service } = harness()
    const { terminalId } = await bridge.create(context(), { command: 'yes', outputByteLimit: 4 })
    service.outputs.set(terminalId, 'abcdefgh')
    await expect(bridge.output(context(), { terminalId })).resolves.toEqual({ output: 'efgh', truncated: true, exitStatus: null })

    const waiting = bridge.waitForExit(context(), { terminalId })
    service.exit(terminalId, { exitCode: null, signal: 15 })
    await expect(waiting).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(bridge.output(context(), { terminalId })).resolves.toMatchObject({ exitStatus: { signal: 'SIGTERM' } })
  })

  it('kill 只结束进程、留下这一格;release 摘表;别的 agent 碰不到这一格', async () => {
    const { bridge, service } = harness()
    const { terminalId } = await bridge.create(context(), { command: 'sleep', args: ['30'] })
    await expect(bridge.kill(context({ agentId: 'intruder' }), { terminalId })).rejects.toThrow(/not created by this agent/)
    await bridge.kill(context(), { terminalId })
    expect(service.terminated).toEqual([terminalId])
    expect(service.killed).toEqual([])
    await bridge.release(context(), { terminalId })
    expect(service.killed).toEqual([terminalId])
    await expect(bridge.output(context(), { terminalId })).rejects.toThrow(/released/)
  })
})
