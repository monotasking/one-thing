import { describe, expect, it } from 'vitest'
import {
  dialPatchOf,
  providerDialsOf,
  regionRowApplies,
  resolveDialValue,
  storedDialsOf,
} from '../dials'

/**
 * 计费档位。**这一组守的是钱** —— 拨错一格会用按量的 Key 和地址去调订阅,
 * 在订阅之外再扣一次。所以它断言的不是「UI 画没画」,是**每一种组合算出来的
 * 地址逐字对不对**,以及那句风险说明一个字没被改写。
 *
 * 地址的期望值抄自 runtime 的那两张表
 * (`onething-runtime/src/providers/qwen.ts:24-38` / `kimi.ts:28-37, 51-64`)。
 * 这里再写一遍不是重复:它是**跨包的合同**,runtime 改了值而这块面没跟上时,
 * 该有一处红。
 */

describe('providerDialsOf', () => {
  it('只有三家有旋钮,别家返回 null', () => {
    expect(providerDialsOf('qwen')).not.toBeNull()
    expect(providerDialsOf('kimi')).not.toBeNull()
    expect(providerDialsOf('zhipu')).not.toBeNull()
    expect(providerDialsOf('claude')).toBeNull()
    expect(providerDialsOf('openai')).toBeNull()
  })
})

describe('归一:不认识的取值落到缺省,不抛也不留空', () => {
  it('千问三档 + 两地区', () => {
    const spec = providerDialsOf('qwen')!
    expect(resolveDialValue(spec.apiMode, 'token-plan')).toBe('token-plan')
    expect(resolveDialValue(spec.apiMode, 'coding-plan')).toBe('coding-plan')
    expect(resolveDialValue(spec.apiMode, undefined)).toBe('standard')
    expect(resolveDialValue(spec.apiMode, '乱写的')).toBe('standard')
    expect(resolveDialValue(spec.region!, 'intl')).toBe('intl')
    expect(resolveDialValue(spec.region!, undefined)).toBe('cn')
  })

  it('Kimi 两档 + 两地区', () => {
    const spec = providerDialsOf('kimi')!
    expect(resolveDialValue(spec.apiMode, 'coding-plan')).toBe('coding-plan')
    expect(resolveDialValue(spec.apiMode, 'token-plan')).toBe('standard')
    expect(resolveDialValue(spec.region!, 'intl')).toBe('intl')
  })

  it('智谱两档,没有地区', () => {
    const spec = providerDialsOf('zhipu')!
    expect(resolveDialValue(spec.apiMode, 'coding-plan')).toBe('coding-plan')
    expect(resolveDialValue(spec.apiMode, 'standard')).toBe('standard')
    expect(spec.region).toBeUndefined()
  })
})

describe('地区那一行画不画', () => {
  it('Kimi 选了编程套餐时**整行收起** —— 它只有一个全球地址', () => {
    const spec = providerDialsOf('kimi')!
    expect(regionRowApplies(spec, 'standard')).toBe(true)
    expect(regionRowApplies(spec, 'coding-plan')).toBe(false)
  })

  it('千问的地区行永远在', () => {
    const spec = providerDialsOf('qwen')!
    expect(regionRowApplies(spec, 'standard')).toBe(true)
    expect(regionRowApplies(spec, 'coding-plan')).toBe(true)
  })

  it('智谱没有地区行', () => {
    expect(regionRowApplies(providerDialsOf('zhipu')!, 'standard')).toBe(false)
  })
})

describe('拨一格写出去的到底是什么', () => {
  it('千问六种组合的地址逐字对上 runtime 那张表', () => {
    const spec = providerDialsOf('qwen')!
    const url = (mode: string, region: string) => dialPatchOf(spec, mode, region).baseUrl
    expect(url('standard', 'cn')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(url('standard', 'intl')).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    expect(url('token-plan', 'cn')).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    )
    expect(url('token-plan', 'intl')).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    )
    // Coding Plan 走的是裸 /v1,不是 /compatible-mode/v1 —— 少写一次就发错地址。
    expect(url('coding-plan', 'cn')).toBe('https://coding.dashscope.aliyuncs.com/v1')
    expect(url('coding-plan', 'intl')).toBe('https://coding-intl.dashscope.aliyuncs.com/v1')
  })

  it('Kimi:编程套餐两个地区落同一个地址', () => {
    const spec = providerDialsOf('kimi')!
    const url = (mode: string, region: string) => dialPatchOf(spec, mode, region).baseUrl
    expect(url('standard', 'cn')).toBe('https://api.moonshot.cn/v1')
    expect(url('standard', 'intl')).toBe('https://api.moonshot.ai/v1')
    expect(url('coding-plan', 'cn')).toBe('https://api.kimi.com/coding/v1')
    expect(url('coding-plan', 'intl')).toBe('https://api.kimi.com/coding/v1')
  })

  it('智谱两档', () => {
    const spec = providerDialsOf('zhipu')!
    expect(dialPatchOf(spec, 'standard', '').baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(dialPatchOf(spec, 'coding-plan', '').baseUrl).toBe(
      'https://open.bigmodel.cn/api/coding/paas/v4',
    )
  })

  /**
   * **档位与地址必须一起写。** 只写档位不写地址,请求还是发去旧地址 ——
   * 那正是「以为选对了、其实还在按量扣钱」的那一种错。
   */
  it('每一次拨动都带着 baseUrl 一起写,且写的是这家自己的字段名', () => {
    const qwen = dialPatchOf(providerDialsOf('qwen')!, 'token-plan', 'intl')
    expect(qwen).toEqual({
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      qwenApiMode: 'token-plan',
      qwenRegion: 'intl',
    })

    const kimi = dialPatchOf(providerDialsOf('kimi')!, 'coding-plan', 'cn')
    expect(kimi.kimiApiMode).toBe('coding-plan')
    expect(kimi.baseUrl).toBe('https://api.kimi.com/coding/v1')

    const zhipu = dialPatchOf(providerDialsOf('zhipu')!, 'coding-plan', '')
    expect(zhipu.zhipuApiMode).toBe('coding-plan')
    expect(zhipu.qwenApiMode).toBeUndefined()
  })
})

describe('storedDialsOf', () => {
  it('读的是这家自己的那两格,没存过就是缺省', () => {
    const qwen = providerDialsOf('qwen')!
    expect(storedDialsOf(qwen, { qwenApiMode: 'coding-plan', qwenRegion: 'intl' })).toEqual({
      apiMode: 'coding-plan',
      region: 'intl',
    })
    expect(storedDialsOf(qwen, undefined)).toEqual({ apiMode: 'standard', region: 'cn' })
    // 别家的字段不串门:kimi 的档位不该被 qwen 那一格读走。
    expect(storedDialsOf(qwen, { kimiApiMode: 'coding-plan' }).apiMode).toBe('standard')
  })
})

describe('风险说明', () => {
  /**
   * **原话保留。** 这几句是从生产那张表逐字搬来的,连全角逗号都没动 ——
   * 一句被改软的付费警告等于一笔真金白银,所以它按「不许漂」处理。
   */
  it('千问那句一个字都没改', () => {
    expect(providerDialsOf('qwen')!.note).toBe(
      '订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费，在订阅之外额外扣钱。',
    )
  })

  it('Kimi 那句一个字都没改', () => {
    expect(providerDialsOf('kimi')!.note).toBe(
      '编程套餐的 Key 与地址(api.kimi.com)和开放平台不通用：留着按量的那一套调用，会在订阅之外再按量扣一次钱。',
    )
  })

  it('智谱本来就没有这一句 —— 不替它补一句', () => {
    expect(providerDialsOf('zhipu')!.note).toBeUndefined()
  })
})
