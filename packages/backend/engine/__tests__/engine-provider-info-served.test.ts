/**
 * 服务商自述的三格真的随名册出门(服务商自述试点 P4)。
 *
 * 壳只读 `providers.getProviders` 下发的 `ProviderInfo`(`dials` / `hasQuota` / `family`)。
 * 从 manifest 投影到 RPC 之间隔着进程注册表与 RPC 域 —— 任何一层改成挑字段转手,壳就会在
 * 真机上悄悄丢掉档位卡、把四个家族拆成八行,而 runtime 那边的投影测试照样绿。这里用真的
 * 注册表装配一次,直接问后端会交出去的那一份。
 */
import { describe, expect, it } from 'vitest'
import { getAvailableProviders } from '../../provider-call/provider-call-chat.js'

describe('getAvailableProviders carries the P4 provider facts', () => {
  it('档位 / 余额源 / 家族三格都在下发的名册上', () => {
    const roster = getAvailableProviders()
    const byId = new Map(roster.map((info) => [info.id, info]))
    expect(byId.get('kimi')?.dials?.apiModeKey).toBe('kimiApiMode')
    expect(byId.get('kimi')?.family).toMatchObject({ id: 'kimi', role: 'api', sibling: 'kimi-code' })
    expect(byId.get('codex')?.family).toMatchObject({ id: 'openai', role: 'subscription', sibling: 'openai', tag: 'Codex' })
    expect(byId.get('deepseek')?.hasQuota).toBe(true)
    expect(byId.get('deepseek')?.family).toBeUndefined()
    // 出门要过一次 JSON(HTTP RPC):三格都是纯数据。
    expect(JSON.parse(JSON.stringify(byId.get('qwen')))).toEqual(byId.get('qwen'))
  })
})
