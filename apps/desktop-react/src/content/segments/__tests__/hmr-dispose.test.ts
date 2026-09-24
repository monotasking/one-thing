import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SegmentRegistry,
  isSegmentRegistered,
  registerSegment,
  unregisterSegment,
  type SegmentDef,
} from '../registry'

/**
 * **模块级副作用必须配 HMR dispose**(CLAUDE.md 施工纪律,09-01 立法)—— 段表那一份。
 *
 * 与块表 `blocks/__tests__/hmr-dispose.test.ts` 逐条同形,因为病是同一个:每个 kind 文件在
 * 模块作用域里 `registerSegment`,热更把模块重跑一遍,旧的那一格还在,于是「段 kind 重复
 * 注册」当场抛。这一组守两件事:
 *  ① 静态:每个 kind 文件的注册调用都把自己那份 `import.meta.hot` 递了进去 ——
 *    这是「加一种段」时唯一会被忘掉的那一格,所以它得有门盯着;
 *  ② 语义:退役那一口本身是对的(摘掉自己那格、不误摘别人的、可重复调)。
 */

const kindsDir = resolve(__dirname, '../kinds')

/** 一条最小合法 def —— 认领型,免得与生产那张表的节点索引撞车。 */
function def(kind: string): SegmentDef {
  return {
    kind: kind as SegmentDef['kind'],
    claim: () => null,
    View: () => null,
    geometry: { liveForm: 'grow', settle: 'same-height', shrink: 'never' },
  }
}

describe('每一型段的注册都配了热更退役', () => {
  const files = readdirSync(kindsDir).filter((name) => name.endsWith('.ts'))

  it('kinds 目录不是空的(免得下面那一圈断言在零个文件上空转)', () => {
    // 六型:thinking / rich-text / tool-group / research / compact / image。
    expect(files.length).toBeGreaterThanOrEqual(6)
  })

  for (const file of files) {
    it(`${file}:registerSegment 递了 import.meta.hot`, () => {
      const source = readFileSync(resolve(kindsDir, file), 'utf8')
      // 注释里也可能出现这个词,所以先剥注释(读源文本的门先剥注释,同一条纪律)。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code).toContain('registerSegment(')
      expect(code, `${file} 的 registerSegment 没有递 import.meta.hot`).toMatch(
        /registerSegment\([\s\S]*?import\.meta\.hot\s*\)/,
      )
    })
  }
})

describe('反注册这一口', () => {
  it('摘掉自己那一格之后,这个 kind 就不在表上了', () => {
    const registry = new SegmentRegistry()
    const probe = def('thinking')
    registry.register(probe)
    expect(registry.has('thinking')).toBe(true)
    registry.unregister('thinking', probe)
    expect(registry.has('thinking')).toBe(false)
  })

  it('**摘完能再注册** —— 这就是热更那一轮走的路,不该再抛「重复注册」', () => {
    const registry = new SegmentRegistry()
    const old = def('thinking')
    registry.register(old)
    registry.unregister('thinking', old)
    expect(() => registry.register(def('thinking'))).not.toThrow()
  })

  it('节点索引跟着一起摘 —— 否则热更后的新一版会被「节点已由某段生产」挡在门外', () => {
    const registry = new SegmentRegistry()
    const make = (): SegmentDef => ({
      kind: 'thinking',
      node: 'reasoning',
      produce: () => null,
      View: () => null,
      geometry: { liveForm: 'fixed', settle: 'same-height', shrink: 'user-only' },
    })
    const old = make()
    registry.register(old)
    registry.unregister('thinking', old)
    expect(() => registry.register(make())).not.toThrow()
  })

  it('反证:不摘就注册,照旧抛 —— 「重复注册是错误」这条法一个字没放宽', () => {
    const registry = new SegmentRegistry()
    registry.register(def('thinking'))
    expect(() => registry.register(def('thinking'))).toThrow(/重复注册/)
  })

  it('表里已经是别人的了就不动手 —— dispose 的先后不由我们决定,盲摘会删掉新的那格', () => {
    const registry = new SegmentRegistry()
    const old = def('thinking')
    const fresh = def('thinking')
    registry.register(old)
    registry.unregister('thinking', old)
    registry.register(fresh)
    // 旧模块的 dispose 迟到了一步:它要摘的是 old,而表上已经是 fresh。
    registry.unregister('thinking', old)
    expect(registry.has('thinking')).toBe(true)
  })

  it('摘一个不在表上的 kind:什么都不做,不抛(dispose 要幂等)', () => {
    const registry = new SegmentRegistry()
    expect(() => registry.unregister('never-registered')).not.toThrow()
  })
})

describe('registerSegment 真的把退役接上了', () => {
  /** 一个只在这条用例里活着的 kind —— 用完它自己被 dispose 摘掉,不污染生产那张表。 */
  const PROBE = '__hmr-probe__'

  it('递了 hot:注册时登记一条 dispose,调它就把自己那格摘掉', () => {
    const disposers: (() => void)[] = []
    const fakeHot = { dispose: (cb: () => void) => disposers.push(cb) }

    registerSegment(def(PROBE) as never, fakeHot)
    expect(isSegmentRegistered(PROBE)).toBe(true)
    // 这一格才是「接上了」的证据:hot 收到了一个退役回调。
    expect(disposers).toHaveLength(1)

    disposers[0]()
    expect(isSegmentRegistered(PROBE)).toBe(false)
  })

  it('反证:不递 hot 就没有退役 —— 那一格自己不会走', () => {
    registerSegment(def(PROBE) as never)
    expect(isSegmentRegistered(PROBE)).toBe(true)
    // 用例造的东西用例自己清掉,不留给下一条。
    unregisterSegment(PROBE)
    expect(isSegmentRegistered(PROBE)).toBe(false)
  })
})
