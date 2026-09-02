import { describe, expect, it } from 'vitest'
import { translate } from '../../../i18n'
import type { MessageKey, MessageVars, TFn } from '../../../i18n'
import { OTHER_GROUP } from '../../types'
import type { CatalogGroup, CatalogRow } from '../../types'
import {
  SKIP_ROWS_FROM,
  catalogEmptyLine,
  groupLabel,
  groupNote,
  shouldSkipRows,
} from '../model-catalog-transitions'

/**
 * 模型目录那几条**纯判据**的门(09-02 批 9a 出文件时补的)。
 * 从前它们是组件里的三个私有函数与一个常量 —— 只能靠渲染整块面来间接断言,
 * 于是「空态那句三层三元」的四个分支里,有两个从来没有被单独指着问过。
 *
 * 这里用**真字典**跑而不是桩:这几条交出去的就是屏幕上那句话,拿桩去测
 * 只能证明它拼了字符串,证明不了它挑对了哪一句。
 */

const t: TFn = (key: MessageKey, vars?: MessageVars) => translate('zh', key, vars)

function row(id: string): CatalogRow {
  return {
    id,
    name: id,
    selected: false,
    current: false,
    contextLength: null,
    maxOutput: null,
    caps: [],
    price: null,
    manual: false,
  }
}

function group(prefix: string, count: number, vendors = 0): CatalogGroup {
  return { prefix, rows: Array.from({ length: count }, (_, i) => row(`${prefix}m${i}`)), vendors }
}

describe('组名与组读数', () => {
  it('厂牌前缀是**数据**,原样交出去(不翻译、不美化)', () => {
    expect(groupLabel(t, group('anthropic/', 3))).toBe('anthropic/')
  })

  it('杂项组才说「其他」', () => {
    expect(groupLabel(t, group(OTHER_GROUP, 3))).toBe(t('providers.groupOther'))
  })

  it('普通组只报型数', () => {
    expect(groupNote(t, group('openai/', 18))).toBe(t('providers.groupCount', { count: 18 }))
  })

  it('厂牌数**只有杂项组说得出口** —— 一个厂牌的组说「1 个厂牌」是废话', () => {
    expect(groupNote(t, group(OTHER_GROUP, 125, 45))).toContain(
      t('providers.groupVendors', { count: 45 }),
    )
    expect(groupNote(t, group('openai/', 125, 45))).not.toContain(
      t('providers.groupVendors', { count: 45 }),
    )
  })

  it('杂项组但厂牌数是 0:也不说 —— 「0 个厂牌」不是一条事实', () => {
    expect(groupNote(t, group(OTHER_GROUP, 4, 0))).toBe(t('providers.groupCount', { count: 4 }))
  })
})

describe('跳排版:只对**展开的长组**挂', () => {
  it('展开且超过阈值才跳', () => {
    expect(shouldSkipRows(true, SKIP_ROWS_FROM + 1)).toBe(true)
  })

  it('恰好等于阈值不跳 —— 判据是「超过」', () => {
    expect(shouldSkipRows(true, SKIP_ROWS_FROM)).toBe(false)
  })

  it('收起的组恒假:它一行都没渲染,没有行可跳', () => {
    expect(shouldSkipRows(false, SKIP_ROWS_FROM + 999)).toBe(false)
  })

  it('短组不挂 —— 挂了只是多一层 containment,白付成本', () => {
    expect(shouldSkipRows(true, 3)).toBe(false)
  })
})

describe('空态那句话:三层三元的四个分支各指一次', () => {
  it('首载:说「在拿」—— 不说「这一坑还没有模型」(那句当时并不成立)', () => {
    expect(catalogEmptyLine(t, { firstLoad: true, rowCount: 0, searching: false })).toBe(
      t('providers.catalogLoading'),
    )
  })

  it('首载 + 有错:让位 —— 错误行已经把话说完了,两句话叠着说等于说两遍', () => {
    expect(
      catalogEmptyLine(t, { firstLoad: true, error: '402', rowCount: 0, searching: false }),
    ).toBeUndefined()
  })

  it('拿到过 + 一行没有 + 在检索:说「没命中」', () => {
    expect(catalogEmptyLine(t, { firstLoad: false, rowCount: 0, searching: true })).toBe(
      t('providers.catalogNoHit'),
    )
  })

  it('拿到过 + 一行没有 + 没检索:说「这一坑是空的」', () => {
    expect(catalogEmptyLine(t, { firstLoad: false, rowCount: 0, searching: false })).toBe(
      t('providers.catalogEmpty'),
    )
  })

  it('有行就一句都不说 —— 包括**重拉失败**那一档(律②:错误与旧行并存)', () => {
    expect(catalogEmptyLine(t, { firstLoad: false, rowCount: 12, searching: false })).toBeUndefined()
    expect(
      catalogEmptyLine(t, { firstLoad: false, error: '402', rowCount: 12, searching: true }),
    ).toBeUndefined()
  })

  it('反证:首载那一档**不看行数** —— 这正是「空是拿到过才说得出口」的分界', () => {
    // 首载时 rows 恰好非空(上一坑留下的引用之类)也仍然说「在拿」。
    expect(catalogEmptyLine(t, { firstLoad: true, rowCount: 9, searching: false })).toBe(
      t('providers.catalogLoading'),
    )
  })
})
