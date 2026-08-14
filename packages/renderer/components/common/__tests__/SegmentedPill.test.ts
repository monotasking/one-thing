// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SegmentedPill from '../SegmentedPill.vue'

const options = [
  { value: 'all', label: '全部' },
  { value: 'upload', label: '上传' },
  { value: 'generated', label: '生成' },
]

describe('SegmentedPill', () => {
  it('renders a radiogroup with the bound value checked', () => {
    const wrapper = mount(SegmentedPill, {
      props: { modelValue: 'upload', options, ariaLabel: '来源' },
    })

    expect(wrapper.attributes('role')).toBe('radiogroup')
    expect(wrapper.attributes('aria-label')).toBe('来源')

    const items = wrapper.findAll('.segmented-pill-item')
    expect(items).toHaveLength(3)
    expect(items.map(item => item.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(items[1].classes()).toContain('is-selected')
  })

  it('emits update:modelValue and change on click, staying silent on re-select', async () => {
    const wrapper = mount(SegmentedPill, { props: { modelValue: 'all', options } })

    await wrapper.findAll('.segmented-pill-item')[2].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['generated']])
    expect(wrapper.emitted('change')).toEqual([['generated']])

    await wrapper.findAll('.segmented-pill-item')[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
  })

  it('uses roving tabindex so the group is a single tab stop', async () => {
    const wrapper = mount(SegmentedPill, { props: { modelValue: 'generated', options } })
    expect(wrapper.findAll('.segmented-pill-item').map(i => i.attributes('tabindex')))
      .toEqual(['-1', '-1', '0'])

    // 值不在选项里时,首段接住 Tab,否则整组掉出 Tab 序列。
    await wrapper.setProps({ modelValue: 'nope' })
    expect(wrapper.findAll('.segmented-pill-item').map(i => i.attributes('tabindex')))
      .toEqual(['0', '-1', '-1'])
  })

  it('moves the value with arrow keys and wraps around', async () => {
    const wrapper = mount(SegmentedPill, { props: { modelValue: 'all', options } })
    const items = wrapper.findAll('.segmented-pill-item')

    await items[0].trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['upload'])

    await items[0].trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['generated'])

    await items[1].trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['generated'])
  })

  it('jumps to the ends with Home/End and ignores unrelated keys', async () => {
    const wrapper = mount(SegmentedPill, { props: { modelValue: 'upload', options } })
    const items = wrapper.findAll('.segmented-pill-item')

    await items[1].trigger('keydown', { key: 'End' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['generated'])

    await items[1].trigger('keydown', { key: 'Home' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['all'])

    const before = wrapper.emitted('update:modelValue')?.length ?? 0
    await items[1].trigger('keydown', { key: 'a' })
    expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(before)
  })
})
