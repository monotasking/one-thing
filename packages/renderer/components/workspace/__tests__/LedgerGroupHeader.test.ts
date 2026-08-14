// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LedgerGroupHeader from '../LedgerGroupHeader.vue'

describe('LedgerGroupHeader', () => {
  it('renders label, rule and count', () => {
    const wrapper = mount(LedgerGroupHeader, {
      props: { label: '今天', count: 12 },
    })

    expect(wrapper.find('.lgh-label').text()).toBe('今天')
    expect(wrapper.find('.lgh-rule').exists()).toBe(true)
    expect(wrapper.find('.lgh-count').text()).toBe('12')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('renders a zero count but skips undefined and empty ones', async () => {
    const wrapper = mount(LedgerGroupHeader, { props: { label: '空闲', count: 0 } })
    expect(wrapper.find('.lgh-count').text()).toBe('0')

    await wrapper.setProps({ count: undefined })
    expect(wrapper.find('.lgh-count').exists()).toBe(false)

    await wrapper.setProps({ count: '' })
    expect(wrapper.find('.lgh-count').exists()).toBe(false)
  })

  it('toggles collapsed through v-model and reports state via aria-expanded', async () => {
    const wrapper = mount(LedgerGroupHeader, {
      props: { label: '已归档', collapsible: true, collapsed: false },
    })

    const toggle = wrapper.find('.lgh-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.lgh-sign').text()).toBe('−')

    await toggle.trigger('click')
    expect(wrapper.emitted('update:collapsed')).toEqual([[true]])

    await wrapper.setProps({ collapsed: true })
    expect(wrapper.find('.lgh-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.lgh-sign').text()).toBe('+')
    expect(wrapper.classes()).toContain('is-collapsed')
  })

  it('keeps the trailing slot outside the collapse button (no nested buttons)', () => {
    const wrapper = mount(LedgerGroupHeader, {
      props: { label: '任务', collapsible: true },
      slots: { trailing: '<button class="probe-trailing">run</button>' },
    })

    expect(wrapper.find('.probe-trailing').exists()).toBe(true)
    expect(wrapper.find('.lgh-toggle .probe-trailing').exists()).toBe(false)
  })

  it('marks sticky headers with a class', async () => {
    const wrapper = mount(LedgerGroupHeader, { props: { label: '8 月 12 日' } })
    expect(wrapper.classes()).not.toContain('is-sticky')

    await wrapper.setProps({ sticky: true })
    expect(wrapper.classes()).toContain('is-sticky')
  })
})
