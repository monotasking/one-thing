import { describe, expect, it } from 'vitest'
import { clampLead, passedReorderThreshold, reorderFrame } from '../reorder-math'
import type { ReorderBox } from '../reorder-math'

/**
 * **换序算术**(`ui/reorder-math`)—— 标签条与竖列表共用的那一句话。
 *
 * 判的全是**数**,一个 DOM 都不碰:这正是把它单独一个文件的理由。
 * 每一条都对着文件头那三条前科写,拆掉判据当场红。
 */

/** 等高四格,起点 0/10/20/30。够表达「往前挪 / 往后挪 / 两端」全部情形。 */
const four: ReorderBox[] = [
  { start: 0, size: 10 },
  { start: 10, size: 10 },
  { start: 20, size: 10 },
  { start: 30, size: 10 },
]

describe('passedReorderThreshold', () => {
  it('恰好等于阈值就算起拖(手感的下界,不是开区间)', () => {
    expect(passedReorderThreshold(8, 8)).toBe(true)
    expect(passedReorderThreshold(-8, 8)).toBe(true)
    expect(passedReorderThreshold(7.9, 8)).toBe(false)
    expect(passedReorderThreshold(0, 8)).toBe(false)
  })
})

describe('clampLead', () => {
  it('夹在两端之内', () => {
    expect(clampLead(-30, 0, 30)).toBe(0)
    expect(clampLead(12, 0, 30)).toBe(12)
    expect(clampLead(99, 0, 30)).toBe(30)
  })

  it('容器比那一格还小时不反向夹(max < min:答 min,不是答一个负数)', () => {
    // 一行比整条列表还高(列表被挤到只剩半行)时 `bottom - size` 会小于 `top`。
    expect(clampLead(50, 100, 80)).toBe(100)
  })
})

describe('reorderFrame', () => {
  it('没动:排在原位,一个邻居都不让', () => {
    const frame = reorderFrame(four, 1, 10)
    expect(frame.settleIndex).toBe(1)
    expect(frame.insertIndex).toBe(1)
    expect(frame.shifts).toEqual([0, 0, 0, 0])
  })

  it('往后挪一格:越过后邻居的中心那一刻换位,那一格让开被拖者的身量', () => {
    // 第 1 格往下走 4:后缘 10+4+10=24 > 第 2 格中心 25?还没有 —— 不换。
    expect(reorderFrame(four, 1, 14).settleIndex).toBe(1)
    // 再走 2:后缘 26 > 25,第 2 格滑到前面去。
    const frame = reorderFrame(four, 1, 16)
    expect(frame.settleIndex).toBe(2)
    expect(frame.shifts).toEqual([0, 0, -10, 0])
  })

  it('往前挪一格:看的是前缘越没越过前邻居的中心', () => {
    // 第 2 格往上走 4:前缘 16 >= 第 1 格中心 15 —— 还排在它后面。
    expect(reorderFrame(four, 2, 16).settleIndex).toBe(2)
    const frame = reorderFrame(four, 2, 14)
    expect(frame.settleIndex).toBe(1)
    expect(frame.shifts).toEqual([0, 10, 0, 0])
  })

  it('两端各自到得了,**一句特例都没有**(前科之一:中心对中心时「拖到最后一位」到不了)', () => {
    // 顶到前端。
    const head = reorderFrame(four, 3, 0)
    expect(head.settleIndex).toBe(0)
    expect(head.insertIndex).toBe(0)
    expect(head.shifts).toEqual([10, 10, 10, 0])
    // 顶到后端(夹紧之后被拖那格的起边 = 容器尾 - 身量 = 30)。
    const tail = reorderFrame(four, 0, 30)
    expect(tail.settleIndex).toBe(3)
    expect(tail.shifts).toEqual([0, -10, -10, -10])
  })

  it('两个下标:往前挪时相同,往后挪时差一格', () => {
    expect(reorderFrame(four, 2, 0)).toMatchObject({ settleIndex: 0, insertIndex: 0 })
    const back = reorderFrame(four, 0, 30)
    expect(back.settleIndex).toBe(3)
    // 「插到第 4 格之前」是对着**还没摘掉自己**的那张表说的 —— 差的这一格正是
    // W6-b 真机门量到的那条:答 3 会命中「原地不动」那道闸,序一格不变。
    expect(back.insertIndex).toBe(4)
  })

  it('行高不等也准:让位量恒等于**被拖那一格自己的身量**', () => {
    const uneven: ReorderBox[] = [
      { start: 0, size: 40 },
      { start: 40, size: 10 },
      { start: 50, size: 30 },
    ]
    // 第 0 格(高 40)往下走到 20:后缘 60 > 第 1 格中心 45、> 第 2 格中心 65?否。
    const frame = reorderFrame(uneven, 0, 20)
    expect(frame.settleIndex).toBe(1)
    // 只有第 1 格让开,让开的是 40(被拖那格的高),不是它自己的 10。
    expect(frame.shifts).toEqual([0, -40, 0])
  })

  it('邻居中心读的是**基准矩形**:同一份 boxes 喂两次答案逐字相同(前科之三的反证)', () => {
    const a = reorderFrame(four, 1, 16)
    const b = reorderFrame(four, 1, 16)
    expect(b).toEqual(a)
  })

  it('一格的列表:怎么拖都排第 0 位', () => {
    const one: ReorderBox[] = [{ start: 0, size: 10 }]
    expect(reorderFrame(one, 0, 0)).toMatchObject({ settleIndex: 0, insertIndex: 0 })
    expect(reorderFrame(one, 0, 999).shifts).toEqual([0])
  })
})
