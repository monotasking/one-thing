import { afterEach, describe, expect, it } from 'vitest'
import {
  claimContentSlot,
  registerContentHolder,
  releaseContentSlot,
  resetContentSlots,
  slotKeyOf,
} from '../content-slots'

/**
 * **配对只在同一片叶里发生**(09-24 报障「文件打开后主区只剩标签」)。
 *
 * 同一份文件开在两片叶里(文件不是单例)时,从前两张表只按 `refId` 记:右架子那片叶的
 * 槽认领了主区那片叶的 holder,`appendChild` 把主区的身子搬走,主区只剩标签。
 */

afterEach(() => resetContentSlots())

const ID = 'file:/repo/a.ts'

describe('content-slots:片叶 + 内容双键', () => {
  it('同一份内容在两片叶里:各配各的,谁也搬不走谁的身子', () => {
    const holderA = document.createElement('div')
    const slotA = document.createElement('div')
    registerContentHolder(slotKeyOf('leafA', ID), holderA)
    claimContentSlot(slotKeyOf('leafA', ID), slotA)
    expect(holderA.parentNode).toBe(slotA)

    // 第二片叶:先交槽(画法层先于内容层挂载,与 `PaneLeaf` 同序),再交身子。
    const slotB = document.createElement('div')
    const holderB = document.createElement('div')
    claimContentSlot(slotKeyOf('leafB', ID), slotB)
    registerContentHolder(slotKeyOf('leafB', ID), holderB)

    expect(holderA.parentNode).toBe(slotA)
    expect(holderB.parentNode).toBe(slotB)
  })

  it('旧槽撤场时只摘自己那一份:新槽已经先认领了就不动它', () => {
    const key = slotKeyOf('leafA', ID)
    const oldSlot = document.createElement('div')
    const newSlot = document.createElement('div')
    claimContentSlot(key, oldSlot)
    claimContentSlot(key, newSlot)
    releaseContentSlot(key, oldSlot)

    const holder = document.createElement('div')
    registerContentHolder(key, holder)
    expect(holder.parentNode).toBe(newSlot)
  })
})
