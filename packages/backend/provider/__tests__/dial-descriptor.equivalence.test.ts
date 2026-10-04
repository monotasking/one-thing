/**
 * 档位投影的等价证据(服务商自述试点 P4)。
 *
 * 壳不再拿 `DialSpec` 的函数,改读 `dialDescriptorOf` 投影出来的纯数据,再用
 * `@shared/provider-dials` 的三个读法(归一 / 地区适用 / 端点)。这份测试对每家带档位的
 * 内置服务商、对一批输入(每个合法值、别的格的合法值、非法串、`undefined`、`null`、空串、
 * 数字)证明:**投影之后的读法与 spec 的函数逐个相等**。不相等就说明那家的函数里有数据
 * 投不出去的判据 —— 那时别投影,先报告。
 */
import { describe, expect, it } from 'vitest'
import {
  dialBaseUrlOf,
  dialRegionApplies,
  normalizeDialValue,
} from '@shared/provider-dials.js'
import { BUILTIN_PROVIDER_MANIFESTS } from '../provider-builtin-manifests.js'
import { dialDescriptorOf, type DialSpec } from '../provider-dials.js'

const withDials = BUILTIN_PROVIDER_MANIFESTS.filter(
  (manifest): manifest is typeof manifest & { dials: DialSpec } => Boolean(manifest.dials),
)

function inputsOf(spec: DialSpec): unknown[] {
  const legal = [
    ...spec.apiMode.options.map((option) => option.value),
    ...(spec.region?.options.map((option) => option.value) ?? []),
  ]
  return [...legal, 'standard', 'token-plan', 'coding-plan', 'cn', 'intl', '乱写的', 'CN', ' intl', '', undefined, null, 0, 1]
}

describe('dial descriptor ≡ DialSpec functions', () => {
  it('今天带档位的三家都在(千问 / Kimi / 智谱)', () => {
    expect(withDials.map((manifest) => manifest.id).sort()).toEqual(['kimi', 'qwen', 'zhipu'])
  })

  for (const manifest of withDials) {
    const spec = manifest.dials
    const descriptor = dialDescriptorOf(spec)
    const inputs = inputsOf(spec)

    describe(manifest.id, () => {
      it('格名与原文逐字照搬', () => {
        expect(descriptor.apiModeKey).toBe(spec.apiModeKey)
        expect(descriptor.regionKey).toBe(spec.regionKey)
        expect(descriptor.note).toBe(spec.note)
        expect(descriptor.apiMode.label).toBe(spec.apiMode.label)
        expect(descriptor.apiMode.ariaLabel).toBe(spec.apiMode.ariaLabel)
        expect(descriptor.apiMode.options).toEqual(spec.apiMode.options)
        expect(descriptor.region?.label).toBe(spec.region?.label)
        expect(descriptor.region?.ariaLabel).toBe(spec.region?.ariaLabel)
        expect(descriptor.region?.options).toEqual(spec.region?.options)
      })

      it('归一:每个输入都与 normalize 相等', () => {
        for (const input of inputs) {
          expect(normalizeDialValue(descriptor.apiMode, input), `apiMode ${String(input)}`).toBe(
            spec.apiMode.normalize(input),
          )
          if (spec.region) {
            expect(normalizeDialValue(descriptor.region!, input), `region ${String(input)}`).toBe(
              spec.region.normalize(input),
            )
          }
        }
      })

      it('地区适用:每个输入都与 appliesTo(缺省恒真,无地区恒假)相等', () => {
        for (const input of inputs) {
          const expected = spec.region ? (spec.region.appliesTo?.(input as string) ?? true) : false
          expect(dialRegionApplies(descriptor, input), String(input)).toBe(expected)
        }
      })

      it('端点:档位 × 地区的整张交叉表都与 baseUrlOf(归一之后)相等', () => {
        for (const mode of inputs) {
          for (const region of inputs) {
            const normalizedMode = spec.apiMode.normalize(mode)
            const normalizedRegion = spec.region ? spec.region.normalize(region) : ''
            expect(dialBaseUrlOf(descriptor, mode, region), `${String(mode)} × ${String(region)}`).toBe(
              spec.baseUrlOf(normalizedMode, normalizedRegion),
            )
            // 不归一直接问也一样:三家的 baseUrlOf 自己就先归一。
            expect(dialBaseUrlOf(descriptor, mode, region), `raw ${String(mode)} × ${String(region)}`).toBe(
              spec.baseUrlOf(mode as string, region as string),
            )
          }
        }
      })

      it('投影是纯数据(能原样过一次 JSON)', () => {
        expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
      })
    })
  }
})
