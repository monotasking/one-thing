import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import type { SegmentModel } from '../../model/segments'
// 生产那张表要装上(「每一种归组节点都有人认领」那一格读的是它)。
import '..'
import {
  SegmentRegistry,
  missingGeometryAnswer,
  resolveSegment,
  segmentDefForNode,
  type SegmentDef,
} from '../registry'

/**
 * 段表的规矩(正本 `docs/stream-geometry-2026-09.md` §20.1 / §20.2)。
 *
 * 每条用例各起一张表 —— 「重复注册抛错」这类规矩本身就要测,共用生产那张单例必然
 * 互相污染。最后两组是**静态门**:注册表自己不认识任何一型,骨架(`SegmentView` /
 * `assemble/index.ts`)里不出现任何一型的名字 —— 这两句是这一单的全部意义,不能只靠
 * 文件头的注释说。
 */

const GEOMETRY = { liveForm: 'grow', settle: 'same-height', shrink: 'never' } as const

function claimer(kind: string, claim: SegmentDef['claim']): SegmentDef {
  return { kind: kind as SegmentDef['kind'], claim, View: () => null, geometry: GEOMETRY }
}

function producer(kind: string, node: string, produce: SegmentDef['produce'] = () => null): SegmentDef {
  return {
    kind: kind as SegmentDef['kind'],
    node: node as SegmentDef['node'],
    produce,
    View: () => null,
    geometry: GEOMETRY,
  }
}

const MESSAGE = { id: 'm1', role: 'assistant', content: '', timestamp: 0 } as ProjectedMessage

describe('产地:node 与 claim 二选一,必有其一', () => {
  it('两个都缺 = 注册即抛(一条没有产地的段是死词汇)', () => {
    const registry = new SegmentRegistry()
    const orphan = { kind: 'image', View: () => null, geometry: GEOMETRY } as SegmentDef
    expect(() => registry.register(orphan)).toThrow(/没有产地/)
    expect(registry.has('image')).toBe(false)
  })

  it('两个都有 = 注册即抛(「它从哪来」不许有两个答案)', () => {
    const registry = new SegmentRegistry()
    const both = { ...producer('image', 'image'), claim: () => null }
    expect(() => registry.register(both)).toThrow(/二选一/)
  })

  it('认了节点却没有 produce = 注册即抛', () => {
    const registry = new SegmentRegistry()
    const mute = { ...producer('image', 'image'), produce: undefined }
    expect(() => registry.register(mute)).toThrow(/没有 produce/)
  })

  it('一种节点只能有一个 def —— 第二个来抢的当场抛,并点名是谁占着', () => {
    const registry = new SegmentRegistry()
    registry.register(producer('tool-group', 'tool-group'))
    expect(() => registry.register(producer('research', 'tool-group'))).toThrow(/tool-group.*research/)
  })

  it('同一个 kind 注册两次 = 抛(不静默后胜)', () => {
    const registry = new SegmentRegistry()
    registry.register(producer('image', 'image'))
    expect(() => registry.register(claimer('image', () => null))).toThrow(/重复注册/)
  })
})

describe('几何三问:缺一不许注册', () => {
  it('答全了才放行', () => {
    expect(missingGeometryAnswer(GEOMETRY)).toBeUndefined()
  })

  it.each([
    ['geometry', undefined],
    ['liveForm', { settle: 'same-height', shrink: 'never' }],
    ['liveForm', { liveForm: 'auto', settle: 'same-height', shrink: 'never' }],
    ['settle', { liveForm: 'grow', shrink: 'never' }],
    ['settle', { liveForm: 'grow', settle: 'shorter', shrink: 'never' }],
    ['shrink', { liveForm: 'grow', settle: 'same-height' }],
    // 没有「自动」这一档(G3):答了一个不在词表里的值,与没答同罪。
    ['shrink', { liveForm: 'grow', settle: 'same-height', shrink: 'auto' }],
  ])('少答 / 答错 %s → 注册即抛', (missing, geometry) => {
    const registry = new SegmentRegistry()
    const def = { ...producer('image', 'image'), geometry } as unknown as SegmentDef
    expect(() => registry.register(def)).toThrow(new RegExp(`少答了:${missing}`))
    expect(registry.has('image')).toBe(false)
  })
})

describe('查表:查不到就抛,不兜底', () => {
  it('未知 kind → resolve 抛,并说清是哪一件事没做', () => {
    const registry = new SegmentRegistry()
    expect(() => registry.resolve('image')).toThrow(/没有注册:image/)
  })

  it('未知节点种 → forNode 抛', () => {
    const registry = new SegmentRegistry()
    expect(() => registry.forNode({ node: 'text', text: 'x' })).toThrow(/节点 text 没有段认领/)
  })

  it('认领型不进节点索引 —— 整条消息认领的 def 按节点查不到', () => {
    const registry = new SegmentRegistry()
    registry.register(claimer('compact', () => null))
    expect(registry.resolve('compact').kind).toBe('compact')
    expect(() => registry.forNode({ node: 'text', text: 'x' })).toThrow()
  })

  it('生产那张表(barrel 已装):每一种归组节点都有人认领', () => {
    // 这一格证的是 `assemble/index.ts` 的循环在生产里永远查得到 —— 归组步多出一种
    // 节点而没人认领,这里先红,不等真机上一条消息装配到一半炸掉。
    expect(segmentDefForNode({ node: 'reasoning', text: '', placement: 'top' }).kind).toBe('thinking')
    expect(segmentDefForNode({ node: 'text', text: '' }).kind).toBe('rich-text')
    expect(segmentDefForNode({ node: 'image', blob: { hash: 'h', bytes: 1 } }).kind).toBe('image')
    expect(segmentDefForNode({ node: 'tool-group', calls: [] }).kind).toBe('tool-group')
    expect(segmentDefForNode({ node: 'research', calls: [] }).kind).toBe('research')
    expect(() => resolveSegment('never-a-segment')).toThrow()
  })
})

describe('第 ⓪ 步:按注册序问,第一个认领的赢', () => {
  it('没人认领 → null(消息照常走节点循环)', () => {
    const registry = new SegmentRegistry()
    registry.register(claimer('compact', () => null))
    expect(registry.claim(MESSAGE)).toBeNull()
  })

  it('两个都认 → 先注册的那一个赢', () => {
    const registry = new SegmentRegistry()
    const first: SegmentModel = { kind: 'image', blob: { hash: 'first', bytes: 1 } }
    const second: SegmentModel = { kind: 'image', blob: { hash: 'second', bytes: 1 } }
    registry.register(claimer('compact', () => first))
    registry.register(claimer('image', () => second))
    expect(registry.claim(MESSAGE)).toBe(first)
  })

  it('先注册的不认 → 轮到下一个', () => {
    const registry = new SegmentRegistry()
    const second: SegmentModel = { kind: 'image', blob: { hash: 'second', bytes: 1 } }
    registry.register(claimer('compact', () => null))
    registry.register(claimer('image', () => second))
    expect(registry.claim(MESSAGE)).toBe(second)
  })

  it('节点消费型不被问(它们没有 claim)', () => {
    const registry = new SegmentRegistry()
    let asked = 0
    registry.register(producer('image', 'image', () => {
      asked += 1
      return null
    }))
    expect(registry.claim(MESSAGE)).toBeNull()
    expect(asked).toBe(0)
  })
})

/** 剥注释 —— 读源文本的门先剥注释(病历文本会让断言自红)。 */
function code(path: string): string {
  return readFileSync(resolve(__dirname, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

describe('静态门:注册表不认识任何一型', () => {
  it('registry.ts 的 import 全是 `import type`(运行时零依赖:不 import 组件、不 import assemble 步骤)', () => {
    const imports = code('../registry.ts').match(/^import .*$/gm) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line, line).toMatch(/^import type /)
  })

  it('kind 文件不 import `assemble/index.ts`(它 import barrel,反向就是环)', () => {
    for (const kind of ['thinking', 'rich-text', 'tool-group', 'research', 'compact', 'image']) {
      const source = code(`../kinds/${kind}.ts`)
      expect(source, kind).not.toMatch(/from '\.\.\/\.\.\/assemble'/)
      expect(source, kind).not.toMatch(/from '\.\.\/\.\.\/assemble\/index'/)
    }
  })
})

describe('静态门:骨架里不出现任何一型的名字(仓根「加功能不许改骨架」法)', () => {
  // 这张名单是**测试**在列举,不是骨架 —— 它问的正是「骨架里有没有这些字」。
  const KINDS = ['thinking', 'rich-text', 'tool-group', 'research', 'compact', 'image']
  const NODES = ['reasoning', 'text', 'tool-group', 'research', 'image']

  it.each([
    ['SegmentView.tsx', '../../SegmentView.tsx'],
    ['assemble/index.ts', '../../assemble/index.ts'],
  ])('%s 不写任何段种 / 节点种的字面量,也没有 switch', (_name, path) => {
    const source = code(path)
    for (const literal of new Set([...KINDS, ...NODES])) {
      expect(source, `出现了 '${literal}'`).not.toContain(`'${literal}'`)
    }
    expect(source).not.toMatch(/\bswitch\s*\(/)
  })
})
