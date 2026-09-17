import { describe, expect, it } from 'vitest'
import { newlyDone, plainTaskText, summarizePlan } from '../plan-model'

describe('计划条读法', () => {
  it('数任务、找下一步、跳过非任务行', () => {
    const plan = summarizePlan(['# 计划', '- [x] 读代码', '- 普通项', '- [ ] **改** `store.ts`', '- [ ] 跑门'].join('\n'))
    expect(plan).toEqual({ total: 3, done: 1, next: '改 store.ts', doneTexts: ['读代码'] })
  })

  it('全部完成时没有下一步;没有任务时 total 为 0', () => {
    expect(summarizePlan('- [x] a\n- [X] b').next).toBeNull()
    expect(summarizePlan('# 空\n\n正文').total).toBe(0)
  })

  it('纯文字去掉链接、强调、行内码与转义', () => {
    expect(plainTaskText('看[文档](https://x.y) *里* 的 ~~旧~~ \\* 号')).toBe('看文档 里 的 旧 * 号')
  })

  it('刚完成:第一次读数不算,同名两项各算各的', () => {
    expect(newlyDone(null, ['a'])).toBeNull()
    expect(newlyDone(['a'], ['a'])).toBeNull()
    expect(newlyDone(['a'], ['a', 'b'])).toBe('b')
    expect(newlyDone(['a'], ['a', 'a'])).toBe('a')
    expect(newlyDone(['a', 'b'], ['b'])).toBeNull()
  })
})
