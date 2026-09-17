import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningProfileEditor } from '../ReasoningProfileEditor'
import { useStageStore } from '../../../stage/store'

beforeEach(() => useStageStore.setState({ locale: 'zh' }))

describe('思考配置表单', () => {
  it('只覆盖名称时保留继承的档位；清空名称可正常保存，保留原生映射哨兵', () => {
    const onWrite = vi.fn()
    render(<ReasoningProfileEditor disabled={false} onWrite={onWrite}
      value={{ effortLabels: { high: '深入' }, custom: null }}
      inherited={{ efforts: ['low', 'high'], defaultEffort: 'high', toggleable: false }} />)
    fireEvent.change(screen.getByLabelText('高档的显示名称'), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('保存思考配置'))
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({
      efforts: ['low', 'high'], defaultEffort: 'high', effortLabels: {}, custom: null,
    }))
  })

  it.each([
    '{"effortPath":"reasoning.effort","enabledBody":[]}',
    '{"effortPath":"reasoning.effort","disabledValue":{}}',
    '{"effortPath":"reasoning.effort","disabledBody":{"constructor":{}}}',
    '{"effortPath":"__proto__.value"}',
  ])('非法映射在本地阻止保存：%s', (mapping) => {
    const onWrite = vi.fn()
    render(<ReasoningProfileEditor disabled={false} onWrite={onWrite} />)
    fireEvent.change(screen.getByLabelText('高级：请求参数映射'), { target: { value: mapping } })
    fireEvent.click(screen.getByText('保存思考配置'))
    expect(onWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
