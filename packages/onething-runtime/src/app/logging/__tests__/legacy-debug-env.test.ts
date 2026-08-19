import { describe, expect, it } from 'vitest'
import { LevelFilter } from '@onething/core/logging'
import { composeLevelSpecWithLegacyAliases, resolveLegacyDebugAliases } from '../legacy-debug-env.js'

/**
 * 旧 `ONETHING_DEBUG_*` 开关的别名层(L4 §8.1 最后一行)。
 *
 * 断言的是**行为等价**:开旧开关 = 那几个命名空间到 trace/debug;而显式
 * `ONETHING_LOG` 永远压过别名。
 */
function filterFor(env: Record<string, string | undefined>, base?: string): LevelFilter {
  return new LevelFilter(composeLevelSpecWithLegacyAliases(base, 'info', resolveLegacyDebugAliases(env)))
}

describe('legacy debug env aliases', () => {
  it('no switch = the plain spec', () => {
    const filter = filterFor({})
    expect(filter.defaultLevel).toBe('info')
    expect(filter.isEnabled('engine.stream', 'debug')).toBe(false)
  })

  it('ONETHING_DEBUG_STREAM turns the stream + provider + renderer hot paths to trace', () => {
    const filter = filterFor({ ONETHING_DEBUG_STREAM: '1' })
    expect(filter.isEnabled('engine.stream', 'trace')).toBe(true)
    expect(filter.isEnabled('engine.stream.coalescer', 'trace')).toBe(true)
    expect(filter.isEnabled('providers.codex', 'trace')).toBe(true)
    expect(filter.isEnabled('renderer.chat-store', 'trace')).toBe(true)
    expect(filter.isEnabled('renderer.ipc-hub', 'trace')).toBe(true)
    // 别的地方原样:别名不是全域开关。
    expect(filter.isEnabled('sessions', 'debug')).toBe(false)
  })

  it('the codex / deepseek variants map to the same spec', () => {
    for (const name of ['ONETHING_DEBUG_CODEX_STREAM', 'ONETHING_DEBUG_DEEPSEEK_STREAM']) {
      const filter = filterFor({ [name]: '1' })
      expect(filter.isEnabled('engine.stream', 'trace')).toBe(true)
      expect(filter.isEnabled('providers.deepseek', 'trace')).toBe(true)
    }
  })

  it('ONETHING_DEBUG_HISTORY_SHAPE opens the per-row history dump (trace)', () => {
    const filter = filterFor({ ONETHING_DEBUG_HISTORY_SHAPE: '1' })
    expect(filter.isEnabled('engine.history', 'trace')).toBe(true)
    expect(filter.isEnabled('engine.stream', 'trace')).toBe(false)
  })

  it('ONETHING_DEBUG_SKILLS opens skills at debug only', () => {
    const filter = filterFor({ ONETHING_DEBUG_SKILLS: '1' })
    expect(filter.isEnabled('skills', 'debug')).toBe(true)
    expect(filter.isEnabled('skills', 'trace')).toBe(false)
  })

  it('a generic DEBUG lowers the default level, but never over an explicit ONETHING_LOG', () => {
    expect(filterFor({ DEBUG: 'anything' }).defaultLevel).toBe('debug')
    expect(filterFor({ DEBUG: 'anything' }, 'warn').defaultLevel).toBe('warn')
    expect(filterFor({ DEBUG: '0' }).defaultLevel).toBe('info')
  })

  it('an explicit ONETHING_LOG rule wins over the alias rule for the same namespace', () => {
    const filter = filterFor({ ONETHING_DEBUG_STREAM: '1' }, 'info,engine.stream=warn')
    expect(filter.isEnabled('engine.stream', 'trace')).toBe(false)
    expect(filter.isEnabled('engine.stream', 'warn')).toBe(true)
    // 没被显式提到的那些仍然跟着别名走。
    expect(filter.isEnabled('providers.codex', 'trace')).toBe(true)
  })

  it('reports which deprecated switches were seen', () => {
    expect(resolveLegacyDebugAliases({ ONETHING_DEBUG_STREAM: '1', DEBUG: '1' }).matched)
      .toEqual(['ONETHING_DEBUG_STREAM', 'DEBUG'])
    expect(resolveLegacyDebugAliases({}).matched).toEqual([])
  })
})
