/**
 * K4-a —— 资源自述 `state` → 变量的那一只 provider(`providers/resource-state.ts`)。
 *
 * 这一层用假 gateway 跑,证的是**投影的判据**:哪一档进板、名字怎么拼、值怎么序列
 * 化、外部变更怎么转发。「值真的来自一条真会话」是装配级那一单的事
 * (`packages/backend/__tests__/resource-state-variable.test.ts`)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ResourceStateProvider,
  resourceStateVariableName,
  stableStateValue,
  type ResourceStateFact,
  type ResourceStateVariableGateway,
} from '../providers/resource-state.js'
import { RESOURCE_STATE_VARIABLE_PREFIX } from '../types.js'
import { isReservedName } from '../validation.js'

function gatewayOf(
  facts: ResourceStateFact[],
  onChange?: ResourceStateVariableGateway['onChange'],
): ResourceStateVariableGateway {
  return onChange ? { listStates: () => facts, onChange } : { listStates: () => facts }
}

const TURN_FACT: ResourceStateFact = {
  scheme: 'session',
  name: 'current',
  title: 'The session this turn is happening in',
  volatility: 'turn',
  value: { title: 'Hello', id: 's1' },
}

describe('ResourceStateProvider(K4-a)', () => {
  it('一条 turn 状态 → 一条只读的 state 变量,说明就是自述里那句话', async () => {
    const provider = new ResourceStateProvider(gatewayOf([TURN_FACT]))
    const variables = await provider.list({ sessionId: 's1' })
    expect(variables).toEqual([
      {
        name: 'resource_session_current',
        // 键排序:自述里先写的是 `title`,渲染出来 `id` 在前。
        value: '{"id":"s1","title":"Hello"}',
        readonly: true,
        state: true,
        description: 'The session this turn is happening in',
      },
    ])
  })

  /**
   * **反证①**:把 provider 里 `fact.volatility !== 'turn'` 那道过滤拆掉,这一例红。
   *
   * `live` 不投的理由不是「变得太快」,而是「已经有一份真相了」—— `music.nowPlaying`
   * 在变量板上早有 `MusicRadioProvider` 那一份。
   */
  it('live 与 stable 一律不投,只有 turn 进板', async () => {
    const provider = new ResourceStateProvider(gatewayOf([
      TURN_FACT,
      { scheme: 'music', name: 'nowPlaying', title: 'Now playing', volatility: 'live', value: { title: 'x' } },
      { scheme: 'demo', name: 'profile', title: 'Profile', volatility: 'stable', value: { a: 1 } },
    ]))
    const names = (await provider.list({ sessionId: 's1' })).map(variable => variable.name)
    expect(names).toEqual(['resource_session_current'])
  })

  it('没有值的那一格整条不出现(而不是出现一格 undefined)', async () => {
    const provider = new ResourceStateProvider(gatewayOf([
      { scheme: 'session', name: 'current', title: 'x', volatility: 'turn' },
    ]))
    expect(await provider.list({ sessionId: 's1' })).toEqual([])
  })

  it('连续两次 list 逐字相同,而且键的书写顺序不影响字节(尾块去重的前提)', async () => {
    const provider = new ResourceStateProvider(gatewayOf([TURN_FACT]))
    const first = await provider.list({ sessionId: 's1' })
    const second = await provider.list({ sessionId: 's1' })
    expect(second[0].value).toBe(first[0].value)

    const flipped = new ResourceStateProvider(gatewayOf([
      { ...TURN_FACT, value: { id: 's1', title: 'Hello' } },
    ]))
    expect((await flipped.list({ sessionId: 's1' }))[0].value).toBe(first[0].value)
  })

  /**
   * **反证②**:把 `onExternalChange` 里那一句转发拆掉(改成 `return () => {}`),
   * 这一例红 —— 于是「资源上发生了事,变量板不知道」会被当场抓住。
   */
  it('onExternalChange 转发 gateway 的变更:带会话 = 单会话,不带 = 广播', () => {
    let fire: ((sessionId?: string) => void) | undefined
    const stop = vi.fn()
    const provider = new ResourceStateProvider(gatewayOf([TURN_FACT], emit => {
      fire = emit
      return stop
    }))

    const emitted: Array<{ sessionId: string } | undefined> = []
    const unsubscribe = provider.onExternalChange(ctx => emitted.push(ctx))
    fire?.('s1')
    fire?.()
    expect(emitted).toEqual([{ sessionId: 's1' }, undefined])

    unsubscribe()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('gateway 不给 onChange 时,退订是个安全的空操作', () => {
    const provider = new ResourceStateProvider(gatewayOf([TURN_FACT]))
    expect(() => provider.onExternalChange(() => {})()).not.toThrow()
  })

  it('认领整条前缀 —— 认领了才拿得到 READONLY 那句实话', () => {
    const provider = new ResourceStateProvider(gatewayOf([TURN_FACT]))
    expect(provider.claims('resource_session_current')).toBe(true)
    expect(provider.claims('resource_anything_at_all')).toBe(true)
    expect(provider.claims('goal')).toBe(false)
    expect(provider.claims('session_current')).toBe(false)
  })
})

describe('变量名(K4-a)', () => {
  it('前缀 + 命名空间 + 状态名,scheme 里的连字符折成下划线', () => {
    expect(resourceStateVariableName('session', 'current')).toBe('resource_session_current')
    expect(resourceStateVariableName('demo-archive', 'inbox')).toBe('resource_demo_archive_inbox')
    expect(resourceStateVariableName('session', 'current').startsWith(RESOURCE_STATE_VARIABLE_PREFIX)).toBe(true)
  })

  /**
   * 名字是现生成的,所以 `RESERVED_NAMES` 那张静态表登记不了它们 —— 登记的是**前缀
   * 规则**。挡的是一次真实的事故形状:自建一个同名变量 → `registry.list` 以
   * `PROVIDER_CONFLICT` 抛出 → 整块变量板没了。
   */
  it('前缀规则进了保留名:自建变量抢不到这些名字', () => {
    expect(isReservedName('resource_session_current')).toBe(true)
    expect(isReservedName('resource_')).toBe(true)
    // 前缀之外一格都不多占:`session_notes` 仍然是用户的。
    expect(isReservedName('session_notes')).toBe(false)
    expect(isReservedName('resourceful')).toBe(false)
    // 静态表照旧。
    expect(isReservedName('goal')).toBe(true)
  })
})

describe('稳定序列化(K4-a)', () => {
  it('恒定一行:值里的换行被转义,不会被 format.ts 砍掉后半截', () => {
    const rendered = stableStateValue({ title: 'a\nb' })
    expect(rendered).toBe('{"title":"a\\nb"}')
    expect(rendered.includes('\n')).toBe(false)
  })

  it('嵌套对象也按键排序,数组保序', () => {
    expect(stableStateValue({ b: { d: 1, c: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":{"c":2,"d":1}}')
  })

  it('undefined 的格子整格省掉,数组里的洞照 JSON 规矩变 null', () => {
    expect(stableStateValue({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(stableStateValue([undefined, 1])).toBe('[null,1]')
  })

  it('顶层的 undefined 渲染成空串 —— format.ts 据此整行跳过', () => {
    expect(stableStateValue(undefined)).toBe('')
  })

  it('标量与 null 照 JSON 写(引号是买「恒定一行」的价钱)', () => {
    expect(stableStateValue('hi')).toBe('"hi"')
    expect(stableStateValue(3)).toBe('3')
    expect(stableStateValue(null)).toBe('null')
  })
})
