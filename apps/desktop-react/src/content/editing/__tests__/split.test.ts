import { describe, expect, it } from 'vitest'
import { analyzeUnit } from '../inline-tokens'
import { splitValueAt } from '../split'
import { parseUnits } from '../units'

const split = (content: string, pos: number) => {
  const line = `- [ ] ${content}`
  const unit = parseUnits([line])[0]
  return splitValueAt(analyzeUnit(unit, content), content, pos)
}

describe('回车拆项不劈坏行内元素', () => {
  it('行内码正文中间:两半各自补齐反引号', () => {
    const value = '确认 `elcc_real_product` 值'
    const r = split(value, value.indexOf('real'))
    expect(r.left).toBe('确认 `elcc_`')
    expect(r.right).toBe('`real_product` 值')
  })

  it('粗体正文中间:两半各自是粗体', () => {
    const value = '先**刷新 token**再重试'
    const r = split(value, value.indexOf('token'))
    expect(r.left).toBe('先**刷新 **')
    expect(r.right).toBe('**token**再重试')
  })

  it('光标在开头记号里 → 拆在元素前面;在结尾记号里 → 拆在元素后面', () => {
    const value = 'a **bc** d'
    expect(split(value, 3)).toMatchObject({ left: 'a ', right: '**bc** d' })
    expect(split(value, 7)).toMatchObject({ left: 'a **bc**', right: ' d' })
  })

  it('链接不拆,挪到链接后面', () => {
    const value = '看[文档](https://x.y/a)再说'
    const r = split(value, value.indexOf('档'))
    expect(r.left).toBe('看[文档](https://x.y/a)')
    expect(r.right).toBe('再说')
  })

  it('普通文字照常拆', () => {
    expect(split('abcdef', 3)).toMatchObject({ left: 'abc', right: 'def' })
  })
})
