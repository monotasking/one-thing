import { describe, expect, it } from 'vitest'
import type { SegmentKind, SegmentModel } from '../../model/segments'
import type { BlockModel } from '../../model/blocks'
import '..'
import { registeredSegmentKinds, resolveSegment, type SegmentGeometry } from '../registry'

/**
 * 各型的几何答案(正本 `docs/stream-geometry-2026-09.md` §20.2 那张表,逐格钉死)。
 *
 * **答案变要改三处,一起改**:这张表、kind 文件、正本那张表。P3 里几何三问没有运行时
 * 读者(读者是 P4 的 HeightBook),所以这张测试就是它们唯一的读者 —— 一格悄悄变了,
 * 只有这里会红。
 *
 * `satisfies Record<SegmentKind, Row>` 钉的是「**每一种词汇都有一行**」:词汇里多一支、
 * 表上没有,tsc 先红;下面那条运行时断言再钉「表上每一行在生产那张段表里都有 def」。
 */

interface Row {
  liveForm: SegmentGeometry['liveForm']
  shrink: SegmentGeometry['shrink']
  /** 正文判据的样本:[模型, 期望]。空数组 = `prose` 缺席(不算正文)。 */
  prose: readonly (readonly [SegmentModel, boolean])[]
  /** 产地:节点种,或 `'claim'`(整条消息认领)。 */
  origin: string
}

const PARAGRAPH: BlockModel = { kind: 'paragraph', inline: [{ type: 'text', text: '正文' }] }

const TABLE = {
  thinking: { liveForm: 'fixed', shrink: 'user-only', prose: [], origin: 'reasoning' },
  'rich-text': {
    liveForm: 'grow',
    shrink: 'never',
    prose: [
      [{ kind: 'rich-text', blocks: [PARAGRAPH], offsets: [0] }, true],
      [{ kind: 'rich-text', blocks: [], offsets: [] }, false],
    ],
    origin: 'text',
  },
  'tool-group': { liveForm: 'grow', shrink: 'user-only', prose: [], origin: 'tool-group' },
  research: { liveForm: 'grow', shrink: 'user-only', prose: [], origin: 'research' },
  compact: { liveForm: 'fixed', shrink: 'user-only', prose: [], origin: 'claim' },
  image: {
    liveForm: 'reserve',
    shrink: 'never',
    prose: [[{ kind: 'image', blob: { hash: 'h', bytes: 1 } }, true]],
    origin: 'image',
  },
} satisfies Record<SegmentKind, Row>

describe('每一种词汇都有 def,表上没有多出来的', () => {
  it('生产那张段表的 kind 集合 = 词汇', () => {
    expect([...registeredSegmentKinds()].sort()).toEqual(Object.keys(TABLE).sort())
  })
})

describe.each(Object.entries(TABLE) as [SegmentKind, Row][])('%s', (kind, row) => {
  const def = resolveSegment(kind)

  it(`几何:liveForm=${row.liveForm} / settle=same-height / shrink=${row.shrink}`, () => {
    expect(def.geometry).toEqual({ liveForm: row.liveForm, settle: 'same-height', shrink: row.shrink })
  })

  it(`产地:${row.origin}`, () => {
    if (row.origin === 'claim') {
      expect(def.claim).toBeTypeOf('function')
      expect(def.node).toBeUndefined()
      expect(def.produce).toBeUndefined()
    } else {
      expect(def.node).toBe(row.origin)
      expect(def.produce).toBeTypeOf('function')
      expect(def.claim).toBeUndefined()
    }
  })

  it(row.prose.length === 0 ? '不算正文(prose 缺席)' : '正文判据', () => {
    if (row.prose.length === 0) {
      expect(def.prose).toBeUndefined()
      return
    }
    for (const [model, expected] of row.prose) expect(def.prose?.(model)).toBe(expected)
  })
})
