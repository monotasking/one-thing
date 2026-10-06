/**
 * 调用上下文的铸法(第④步批 1,决策 D8 / D277):客户端的壳坐标从请求头 `X-Onething-Shell-Id` 进来,
 * HTTP 边界把它铸进 `callerId` —— **只从请求头**,信封里没有可以放它的地方;形状不合规矩就当没带
 * (它只是一个坐标,答错的后果是命令发给「最近活动的那一扇」,不是越权)。
 */
import { describe, expect, it } from 'vitest'
import { createServerRpcDispatchContext } from '../http-server-rpc-context.js'

const IDENTITY = { userId: 'local-user', workspaceId: 'default' } as Parameters<typeof createServerRpcDispatchContext>[1]

describe('createServerRpcDispatchContext 的 callerId', () => {
  it('请求头带了合规矩的壳坐标 → 铸进 callerId', () => {
    const context = createServerRpcDispatchContext(undefined, IDENTITY, undefined, '0b7f3c1e-6f0a-4a5e-9d0c-1f2e3d4c5b6a')
    expect(context).toMatchObject({ transport: 'http', callerId: '0b7f3c1e-6f0a-4a5e-9d0c-1f2e3d4c5b6a' })
  })

  it('没带 / 形状不对 → 没有 callerId 这一格', () => {
    expect('callerId' in createServerRpcDispatchContext(undefined, IDENTITY)).toBe(false)
    expect('callerId' in createServerRpcDispatchContext(undefined, IDENTITY, undefined, '')).toBe(false)
    expect('callerId' in createServerRpcDispatchContext(undefined, IDENTITY, undefined, 'has space')).toBe(false)
    expect('callerId' in createServerRpcDispatchContext(undefined, IDENTITY, undefined, 'x'.repeat(129))).toBe(false)
  })
})
