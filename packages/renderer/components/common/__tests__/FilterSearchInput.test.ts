// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FilterSearchInput from '../FilterSearchInput.vue'

describe('FilterSearchInput', () => {
  it('emits typed input and clears through the clear button', async () => {
    const wrapper = mount(FilterSearchInput, { props: { modelValue: '' } })
    expect(wrapper.find('.filter-search-clear').exists()).toBe(false)

    const input = wrapper.find('input')
    await input.setValue('cat')
    expect(wrapper.emitted('update:modelValue')).toEqual([['cat']])

    await wrapper.setProps({ modelValue: 'cat' })
    await wrapper.find('.filter-search-clear').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
  })

  it('stays on the default size unless asked otherwise', () => {
    const wrapper = mount(FilterSearchInput, { props: { modelValue: '' } })
    expect(wrapper.classes()).toContain('filter-search')
    expect(wrapper.classes()).not.toContain('is-compact')
  })

  it('opts into the 30px compact variant without touching the default markup', () => {
    const compact = mount(FilterSearchInput, { props: { modelValue: '', size: 'compact' } })
    expect(compact.classes()).toContain('is-compact')

    // 变体只加类与图标尺寸,结构与默认档逐一致 —— 现存调用点零变化。
    const plain = mount(FilterSearchInput, { props: { modelValue: '' } })
    expect(compact.findAll('input')).toHaveLength(plain.findAll('input').length)
    expect(compact.find('input').attributes('type')).toBe(plain.find('input').attributes('type'))
  })
})
