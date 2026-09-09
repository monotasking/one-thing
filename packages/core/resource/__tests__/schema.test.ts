/**
 * K1 —— 自述 → AI 工具契约的投影(`schema.ts`)。
 *
 * 这只文件钉的是「§4 那张表第一行是**生成**的,不是手写的」:分支的形状、描述的
 * 来源、效果并集、以及三样东西的**顺序稳定**(它们会进 system 前缀)。
 */

import { describe, expect, it } from 'vitest'
import {
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  toolDescriptionOf,
  toolEffectsOf,
  toolInputSchemaOf,
} from '../schema.js'
import type { JsonObject } from '../../json.js'
import type { ResourceSpec } from '../spec.js'
import { demoSpec } from './fakes.js'

function branches(spec: ResourceSpec): JsonObject[] {
  return toolInputSchemaOf(spec).oneOf as unknown as JsonObject[]
}

describe('toolInputSchemaOf', () => {
  it('每条做法一支、每条读法一支,做法在前,每族内按名字字典序', () => {
    const list = branches(demoSpec())
    const discriminators = list.map(branch => {
      const properties = branch.properties as Record<string, JsonObject>
      const key = RESOURCE_OP_KEY in properties ? RESOURCE_OP_KEY : RESOURCE_READ_KEY
      return `${key}:${String(properties[key].const)}`
    })
    expect(discriminators).toEqual([
      'op:focus',
      'op:hidden',
      'op:rename',
      'op:wipe',
      'read:get',
      'read:list',
    ])
  })

  it('一支做法分支 = 判别字段(const)+ 可选 ref + params 的属性;required 带上判别字段', () => {
    const rename = branches(demoSpec()).find(branch => {
      const properties = branch.properties as Record<string, JsonObject>
      return properties[RESOURCE_OP_KEY]?.const === 'rename'
    })
    expect(rename).toBeTruthy()
    expect(rename?.type).toBe('object')
    // description 来自 OpSpec.title —— 模型读的是这一句。
    expect(rename?.description).toBe('Rename one thing')
    const properties = rename?.properties as Record<string, JsonObject>
    expect(Object.keys(properties)).toEqual([RESOURCE_OP_KEY, RESOURCE_REF_KEY, 'title'])
    expect(properties[RESOURCE_OP_KEY]).toEqual({ type: 'string', const: 'rename' })
    expect(properties[RESOURCE_REF_KEY].type).toBe('string')
    expect(rename?.required).toEqual([RESOURCE_OP_KEY, 'title'])
  })

  it('一支读法分支同形,判别字段换成 read,description 来自 ReadSpec.title', () => {
    const list = branches(demoSpec()).find(branch => {
      const properties = branch.properties as Record<string, JsonObject>
      return properties[RESOURCE_READ_KEY]?.const === 'list'
    })
    expect(list?.description).toBe('List things')
    const properties = list?.properties as Record<string, JsonObject>
    expect(Object.keys(properties)).toEqual([RESOURCE_READ_KEY, RESOURCE_REF_KEY, 'limit'])
    expect(properties.limit).toEqual({ type: 'number', description: 'How many' })
    // query 里没有必填项 → required 只剩判别字段。
    expect(list?.required).toEqual([RESOURCE_READ_KEY])
  })

  it('零做法的自述只剩读法分支;零读法零做法出来的是空 oneOf', () => {
    const readOnly = demoSpec({ ops: {} })
    expect(branches(readOnly).every(branch => RESOURCE_READ_KEY in (branch.properties as object))).toBe(true)
    expect(branches(readOnly)).toHaveLength(2)

    const empty = demoSpec({ ops: {}, reads: {} })
    expect(branches(empty)).toEqual([])
  })

  it('顺序不随书写顺序变(system 前缀跨会话逐字相同的前提)', () => {
    const written = demoSpec()
    const reordered: ResourceSpec = {
      ...written,
      ops: {
        wipe: written.ops.wipe,
        rename: written.ops.rename,
        focus: written.ops.focus,
        hidden: written.ops.hidden,
      },
      reads: { list: written.reads.list, get: written.reads.get },
    }
    expect(toolInputSchemaOf(reordered)).toEqual(toolInputSchemaOf(written))
    expect(toolDescriptionOf(reordered)).toBe(toolDescriptionOf(written))
    expect(toolEffectsOf(reordered)).toEqual(toolEffectsOf(written))
  })
})

describe('toolEffectsOf', () => {
  it('是全部做法的效果并集,去重,按规范次序', () => {
    const spec = demoSpec({
      ops: {
        a: { title: 'a', params: { type: 'object' }, effects: ['bash', 'read'], home: 'core' },
        b: { title: 'b', params: { type: 'object' }, effects: ['read'], home: 'core' },
      },
    })
    // EFFECT_CLASSES 里 read 在 bash 前面 —— 结果跟规范表走,不跟声明先后走。
    expect(toolEffectsOf(spec)).toEqual(['read', 'bash'])
  })

  it('全都不报效果的自述 → 空上界', () => {
    expect(toolEffectsOf(demoSpec({ ops: { rename: demoSpec().ops.rename } }))).toEqual([])
  })
})

describe('toolDescriptionOf', () => {
  it('标题一行,然后一条做法一行', () => {
    expect(toolDescriptionOf(demoSpec())).toBe(
      [
        'Demo things',
        '- focus — Focus it in the window',
        '- hidden — Only in a scene that never happens',
        '- rename — Rename one thing',
        '- wipe — Wipe one thing',
      ].join('\n'),
    )
  })

  it('一条做法都没有时只剩标题(不留一个空清单的尾巴)', () => {
    expect(toolDescriptionOf(demoSpec({ ops: {} }))).toBe('Demo things')
  })
})
