import { describe, expect, it } from 'vitest'
import { displayAlt } from '../alt'

/** alt 的显示口径:只剥引擎的 `|mediaId:<id>` 机器标记,别的字一个不动(G 线 §23.3)。 */
describe('displayAlt', () => {
  it('剥掉生图流写的那一截', () => {
    expect(displayAlt('Generated Image|mediaId:media_1')).toBe('Generated Image')
    expect(displayAlt('Generated Image | mediaId:media_mfx1_ab2')).toBe('Generated Image')
  })

  it('只有标记的 alt 剥完是空串(调用方各自有空 alt 的退路)', () => {
    expect(displayAlt('|mediaId:media_1')).toBe('')
  })

  it('没有标记的 alt 原样(含普通的竖线)', () => {
    expect(displayAlt('一只猫')).toBe('一只猫')
    expect(displayAlt('a | b')).toBe('a | b')
    expect(displayAlt('')).toBe('')
  })
})
