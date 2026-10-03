/**
 * 用户思考覆盖里 `wire` 的合法取值(服务商自述试点 P3)。
 *
 * 从前是 `model-capability.ts` 里一行手写名单;现在是协议层名单
 * (`providers/thinking/protocol-wire-ids.ts`)+ 内置各家 manifest 的 `reasoningWires`
 * + 非线型的 `custom`。这里钉住:**搬家前合法的逐个仍合法,搬家前非法的仍非法**(尤其登记表里有、
 * 但从来不许用户点名的 DeepSeek 推断线型),以及名单与线型登记表对得上。
 */
import { describe, expect, it } from 'vitest'
import { normalizeOnethingReasoningProfileOverride } from '../model-capability.js'
import { PROTOCOL_DECLARABLE_REASONING_WIRE_IDS } from '../thinking/protocol-wire-ids.js'
import { getProviderManifestRegistry } from '../manifest.js'
import { thinkingWires } from '../base/index.js'
import '../thinking/index.js'
import '../vendors/runtimes.js'

/** 搬家前 `REASONING_WIRES` 的全部取值,逐字。 */
const LEGAL_BEFORE_P3 = [
  'anthropic-adaptive',
  'anthropic-budget',
  'anthropic-always',
  'openai-effort',
  'gemini-level',
  'gemini-budget',
  'thinking-type',
  'zhipu-thinking',
  'qwen-thinking',
  'grok-effort',
  'openrouter-reasoning',
  'codex',
  'custom',
  'none',
]

const CUSTOM_MAPPING = { effortPath: 'reasoning.effort' }

function accepts(wire: unknown): boolean {
  const profile = { wire, ...(wire === 'custom' ? { custom: CUSTOM_MAPPING } : {}) }
  const normalized = normalizeOnethingReasoningProfileOverride(profile)
  return normalized !== undefined && normalized.wire === wire
}

describe('思考覆盖的 wire 取值', () => {
  it('搬家前合法的取值逐个仍合法', () => {
    for (const wire of LEGAL_BEFORE_P3) expect(accepts(wire), wire).toBe(true)
  })

  it('搬家前非法的仍非法(含登记表里有、但不许用户点名的线型)', () => {
    for (const wire of ['deepseek-inferred', 'zhipu', 'qwen', 'grok', 'openrouter', 'responses', 'anthropic', 'OPENAI-EFFORT', '', 42, null, true]) {
      expect(normalizeOnethingReasoningProfileOverride({ wire }), String(wire)).toBeUndefined()
    }
  })

  it('合法集合恰好就是搬家前那十四个', () => {
    const declared = new Set<string>([
      ...PROTOCOL_DECLARABLE_REASONING_WIRE_IDS,
      'custom',
      ...getProviderManifestRegistry().list().flatMap((manifest) => manifest.reasoningWires ?? []),
    ])
    expect([...declared].sort()).toEqual([...LEGAL_BEFORE_P3].sort())
  })

  it('除 custom 之外,每个可点名的 id 都是已登记的思考线型', () => {
    const registered = new Set(thinkingWires.list().map((wire) => wire.id))
    const declared = [
      ...PROTOCOL_DECLARABLE_REASONING_WIRE_IDS,
      ...getProviderManifestRegistry().list().flatMap((manifest) => manifest.reasoningWires ?? []),
    ]
    for (const id of declared) expect(registered.has(id), id).toBe(true)
  })
})
