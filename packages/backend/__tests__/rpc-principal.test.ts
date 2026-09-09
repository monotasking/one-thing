/**
 * K2a —— 在 RPC 边界铸一次主体(`docs/design/atom-2026-09.md` §9 K2)。
 *
 * 三条次序,三个用例,一条不多:本机可信 → 桌面前面那个人;认证过的 owner → 那个
 * 用户;都没有 → **抛**。
 *
 * 第三条是这份文件唯一真正在守的东西:回落到本机用户就是提权(与
 * `runtime/src/engine/turn-principal.ts` 头注释那句「一个继承默认 agent 全部可达范围
 * 的兜底不是兜底,是绕过」同一句话)。反证在文件末尾那条注释里写了怎么做。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import {
  configureHostLocalTrust,
  resetHostLocalTrustForTests,
} from '../server/host-trust.js'
import { principalOf, RpcPrincipalUnavailableError } from '../rpc/principal.js'

afterEach(() => {
  resetHostLocalTrustForTests()
})

const HTTP: RpcDispatchContext = { transport: 'http' }

describe('principalOf(context)', () => {
  it('本机可信宿主 → 桌面前面的那个人', () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    // 注意 context 本身一格身份都没有 —— 可信是**面级**声明(装配时说的),
    // 不是请求带来的东西。
    expect(principalOf(HTTP)).toEqual({ kind: 'user', userId: 'local' })
  })

  it('不可信但过了认证 → 那个 owner(带上租户作用域)', () => {
    expect(principalOf({ transport: 'http', ownerUid: 'u-1' }))
      .toEqual({ kind: 'user', userId: 'u-1' })
    expect(principalOf({ transport: 'http', ownerUid: 'u-1', workspaceId: 'w-9' }))
      .toEqual({ kind: 'user', userId: 'u-1', workspaceId: 'w-9' })
  })

  it('两样都没有 → 抛具名错,**不回落**', () => {
    // 反证:把这一支改成 `return localUserPrincipal()`,这条就红 —— 而它红的正是
    // 「未认证的联网调用方拿到了桌面主人的授权范围」。读也不许:授权是查询输入,
    // 不是事后过滤。
    expect(() => principalOf(HTTP)).toThrow(RpcPrincipalUnavailableError)
    expect(() => principalOf({ transport: 'ipc' })).toThrow(RpcPrincipalUnavailableError)
    // 空串不算认证过 —— `''` 读起来像"有这一格",实际是没填。
    expect(() => principalOf({ transport: 'http', ownerUid: '' })).toThrow(RpcPrincipalUnavailableError)
  })

  it('可信压过 owner:本机面上先答本机用户(与六个域共用的那一问同序)', () => {
    configureHostLocalTrust({ origin: 'loopback-server' })
    expect(principalOf({ transport: 'http', ownerUid: 'u-1' }))
      .toEqual({ kind: 'user', userId: 'local' })
  })
})
