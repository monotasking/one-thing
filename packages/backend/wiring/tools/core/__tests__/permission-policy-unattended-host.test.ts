/**
 * 无人值守宿主上的 `system` 主体自动拒(K4-d,还 K4-c 留账 1)。
 *
 * 这里用的是**真的 core `Permission`**,不是替身:整条判据的价值就在「那张卡最后
 * 到底有没有被答掉」——`Permission.respond` 走通了,`getPendingPrompts` 才会空。
 * 拿替身 `ask` 一挡,证到的只是「计时器响过」,而 K4-c 留账 1 那个病恰恰是
 * 「桥不等了,卡还挂着」。
 *
 * 会话读面被替身掉(与 `wiring/engine/__tests__/permission-policy-execution.test.ts`
 * 同一副夹具):这一份问的不是「会话里有什么」,而是「谁在敲门 + 这台宿主有没有
 * 人」。真店会把整棵装配拉进来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { systemPrincipal, localUserPrincipal } from '@onething/core/permission'
import { Permission } from '../../../permission/index.js'
import { markHostUnattended } from '@onething/runtime/permissions/unattended'
import { enforcePermissionPolicy } from '../permission-policy.js'
import type { PermissionEffect } from '../permission-policy.js'

vi.mock('../../../../stores/sessions.js', () => ({ getSession: () => undefined }))
vi.mock('../../../../session/reads.js', () => ({ sessionReads: {
  listMessages: () => ({ messages: [], changed: false }),
  lastMessageOfRole: () => undefined,
} }))

/** `session:s1` 上的 `removeMessage` —— 桥进来的那一支真实效果(K3-a')。 */
const removeMessageEffect: PermissionEffect = {
  kind: 'session_destructive',
  resources: ['session:s1/messages/m1'],
  barrier: true,
}

const HOST_TIMEOUT_MS = 60_000

let releaseHost: (() => void) | undefined
let sessionSeq = 0

function input(principal: ReturnType<typeof systemPrincipal> | undefined, sessionId: string) {
  return {
    sessionId,
    messageId: '',
    toolCallId: `call-${sessionId}`,
    toolName: 'session.removeMessage',
    effects: [removeMessageEffect],
    ...(principal ? { principal } : {}),
  }
}

/** 每例一条新会话 id:`Permission` 的 pending 表是进程级的,别互相看见对方的卡。 */
function nextSessionId(): string {
  sessionSeq += 1
  return `unattended-host-session-${sessionSeq}`
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  releaseHost?.()
  releaseHost = undefined
  vi.useRealTimers()
})

describe('无人值守宿主 + system 主体', () => {
  it('60 秒后把卡答掉(denied),pending 归空', async () => {
    releaseHost = markHostUnattended('test-daemon')
    const sessionId = nextSessionId()

    const settled = enforcePermissionPolicy(input(systemPrincipal('mcp:probe-agent'), sessionId))
      .then(() => undefined, (error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1)

    // 到点之前不许提前收场 —— 那一分钟是留给「万一有人来答」的。
    await vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS - 1_000)
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_000)
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('PermissionRejectedError')
    expect((error as Error).message).toContain('no one is attending this host')
    // 「桥不等了,卡还挂着」正是 K4-c 留账 1 那个病 —— 这一行是它的墓碑。
    expect(Permission.getPendingPrompts(sessionId)).toEqual([])
  })

  it('宿主没声明无人值守(桌面形)就不自动拒:卡一直等人来答', async () => {
    const sessionId = nextSessionId()
    let settledWith: unknown = 'still-pending'
    const settled = enforcePermissionPolicy(input(systemPrincipal('mcp:probe-agent'), sessionId))
      .then(() => { settledWith = undefined }, (error: unknown) => { settledWith = error })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10 * HOST_TIMEOUT_MS)
    expect(settledWith).toBe('still-pending')
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1)

    // 收尾:人来答了(这也顺手证了那张卡确实还是可答的)。
    const pending = Permission.getPendingPrompts(sessionId)[0]
    Permission.respond({ sessionId, permissionId: pending.id, response: 'reject' })
    await settled
    expect(settledWith).toBeInstanceOf(Error)
  })

  it('判据是主体不是宿主:无人值守宿主上,本机用户的 ask 照旧等着', async () => {
    releaseHost = markHostUnattended('test-daemon')
    const sessionId = nextSessionId()
    let settledWith: unknown = 'still-pending'
    const settled = enforcePermissionPolicy({ ...input(undefined, sessionId), principal: localUserPrincipal() })
      .then(() => { settledWith = undefined }, (error: unknown) => { settledWith = error })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10 * HOST_TIMEOUT_MS)
    expect(settledWith).toBe('still-pending')
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1)

    const pending = Permission.getPendingPrompts(sessionId)[0]
    Permission.respond({ sessionId, permissionId: pending.id, response: 'reject' })
    await settled
  })

  it('声明是可收回的:收回之后同一台进程回到「有人值守」', async () => {
    const release = markHostUnattended('test-daemon')
    release()
    const sessionId = nextSessionId()
    let settledWith: unknown = 'still-pending'
    const settled = enforcePermissionPolicy(input(systemPrincipal('mcp:probe-agent'), sessionId))
      .then(() => { settledWith = undefined }, (error: unknown) => { settledWith = error })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10 * HOST_TIMEOUT_MS)
    expect(settledWith).toBe('still-pending')

    const pending = Permission.getPendingPrompts(sessionId)[0]
    Permission.respond({ sessionId, permissionId: pending.id, response: 'reject' })
    await settled
  })
})
