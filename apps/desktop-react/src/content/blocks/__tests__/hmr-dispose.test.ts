import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BlockRegistry,
  isBlockRegistered,
  registerBlock,
  unregisterBlock,
  type BlockDef,
} from '../registry'

/**
 * **模块级副作用必须配 HMR dispose**(CLAUDE.md 施工纪律,09-01 立法)。
 *
 * 起因是这条 unhandledrejection:「块 kind 重复注册:list」—— 每个 kind 的
 * `index.ts` 在模块作用域里 `registerBlock`,热更把模块重跑一遍,旧的那一格还在,
 * 于是抛。它与「同一帧里两个 `?t=` 版本的 chat-source 各推各的屏」是同一个病:
 * **模块级副作用的寿命是模块实例,而热更换掉模块实例时没人替它收摊**。
 *
 * 这一组守两件事:
 *  ① 静态:每个 kind 的注册调用都把自己那份 `import.meta.hot` 递了进去 ——
 *    这是「加一个块」时唯一会被忘掉的那一格,所以它得有门盯着,不能靠自觉;
 *  ② 语义:退役那一口本身是对的(摘掉自己那格、不误摘别人的、可重复调)。
 */

const kindsDir = resolve(__dirname, '../kinds')

function def(kind: string): BlockDef {
  return {
    kind: kind as BlockDef['kind'],
    presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
    Component: () => null,
  }
}

describe('每个块的注册都配了热更退役', () => {
  const dirs = readdirSync(kindsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  it('kinds 目录不是空的(免得下面那一圈断言在零个文件上空转)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(10)
  })

  for (const dir of dirs) {
    it(`${dir}:registerBlock 递了 import.meta.hot`, () => {
      const source = readFileSync(resolve(kindsDir, dir, 'index.ts'), 'utf8')
      // 注释里也可能出现这个词,所以先剥注释(读源文本的门先剥注释,同一条纪律)。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code).toContain('registerBlock(')
      expect(code, `${dir}/index.ts 的 registerBlock 没有递 import.meta.hot`).toMatch(
        /registerBlock\([\s\S]*?import\.meta\.hot\s*\)/,
      )
    })
  }

  it('figure 的**二级表**(图种)同样递了 —— 两张表同一条法', () => {
    const source = readFileSync(resolve(kindsDir, 'figure/index.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/registerFigureKind\([^)]*import\.meta\.hot\s*\)/)
  })
})

describe('反注册这一口', () => {
  it('摘掉自己那一格之后,这个 kind 就不在表上了', () => {
    const registry = new BlockRegistry()
    const list = def('list')
    registry.register(list)
    expect(registry.has('list')).toBe(true)
    registry.unregister('list', list)
    expect(registry.has('list')).toBe(false)
  })

  it('**摘完能再注册** —— 这就是热更那一轮走的路,不该再抛「重复注册」', () => {
    const registry = new BlockRegistry()
    const old = def('list')
    registry.register(old)
    registry.unregister('list', old)
    expect(() => registry.register(def('list'))).not.toThrow()
  })

  it('反证:不摘就注册,照旧抛 —— 「重复注册是错误」这条法一个字没放宽', () => {
    const registry = new BlockRegistry()
    registry.register(def('list'))
    expect(() => registry.register(def('list'))).toThrow(/重复注册/)
  })

  it('表里已经是别人的了就不动手 —— dispose 的先后不由我们决定,盲摘会删掉新的那格', () => {
    const registry = new BlockRegistry()
    const old = def('list')
    const fresh = def('list')
    registry.register(old)
    registry.unregister('list', old)
    registry.register(fresh)
    // 旧模块的 dispose 迟到了一步:它要摘的是 old,而表上已经是 fresh。
    registry.unregister('list', old)
    expect(registry.has('list')).toBe(true)
  })

  it('摘一个不在表上的 kind:什么都不做,不抛(dispose 要幂等)', () => {
    const registry = new BlockRegistry()
    expect(() => registry.unregister('never-registered')).not.toThrow()
  })
})

describe('registerBlock 真的把退役接上了', () => {
  /** 一个只在这条用例里活着的 kind —— 用完它自己被 dispose 摘掉,不污染生产那张表。 */
  const PROBE = '__hmr-probe__'

  it('递了 hot:注册时登记一条 dispose,调它就把自己那格摘掉', () => {
    const disposers: (() => void)[] = []
    const fakeHot = { dispose: (cb: () => void) => disposers.push(cb) }

    registerBlock(def(PROBE) as never, fakeHot)
    expect(isBlockRegistered(PROBE)).toBe(true)
    // 这一格才是「接上了」的证据:hot 收到了一个退役回调。
    expect(disposers).toHaveLength(1)

    disposers[0]()
    expect(isBlockRegistered(PROBE)).toBe(false)
  })

  it('反证:不递 hot 就没有退役 —— 那一格自己不会走(运行时插件走的正是这条)', () => {
    registerBlock(def(PROBE) as never)
    expect(isBlockRegistered(PROBE)).toBe(true)
    // 收尾靠调用方自己那一口(没有 hot 的那些人本来就得这么收),
    // 用例造的东西用例自己清掉,不留给下一条。
    unregisterBlock(PROBE)
    expect(isBlockRegistered(PROBE)).toBe(false)
  })
})
