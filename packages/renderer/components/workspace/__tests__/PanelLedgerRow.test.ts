// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelLedgerRow from '../PanelLedgerRow.vue'

describe('PanelLedgerRow', () => {
  it('renders the two-line body and skips empty slots', () => {
    const wrapper = mount(PanelLedgerRow, {
      props: { label: '晨间新闻', meta: '0 9 * * * · Daily 09:00' },
    })

    expect(wrapper.find('.plr-title').text()).toBe('晨间新闻')
    expect(wrapper.find('.plr-meta').text()).toBe('0 9 * * * · Daily 09:00')
    // 首列与行尾是槽位:没给内容就不占位,否则每个面板都会多出两个空盒子。
    expect(wrapper.find('.plr-lead').exists()).toBe(false)
    expect(wrapper.find('.plr-trail').exists()).toBe(false)
  })

  it('drops the meta line entirely when there is neither prop nor slot', () => {
    const wrapper = mount(PanelLedgerRow, { props: { label: '只有标题' } })
    expect(wrapper.find('.plr-meta').exists()).toBe(false)
  })

  it('renders lead / label-extra / trail slots into their fixed positions', () => {
    const wrapper = mount(PanelLedgerRow, {
      props: { label: '任务' },
      slots: {
        lead: '<span class="t-time">18:00</span>',
        'label-extra': '<span class="t-status">Healthy</span>',
        trail: '<span class="t-switch">on</span>',
      },
    })

    expect(wrapper.find('.plr-lead .t-time').text()).toBe('18:00')
    expect(wrapper.find('.plr-title-line .t-status').text()).toBe('Healthy')
    expect(wrapper.find('.plr-trail .t-switch').text()).toBe('on')
  })

  it('marks active and muted states without owning any events', async () => {
    const wrapper = mount(PanelLedgerRow, {
      props: { label: '任务', active: true },
      attrs: { role: 'button', tabindex: '0' },
    })

    expect(wrapper.classes()).toContain('is-active')
    expect(wrapper.attributes('role')).toBe('button')
    expect(wrapper.attributes('tabindex')).toBe('0')

    await wrapper.setProps({ active: false, muted: true })
    expect(wrapper.classes()).not.toContain('is-active')
    expect(wrapper.classes()).toContain('is-muted')
  })

  it('lets a meta slot replace the text line (progress bars, chips…)', () => {
    const wrapper = mount(PanelLedgerRow, {
      props: { label: '凯格尔' },
      slots: { meta: '<span class="t-progress" />' },
    })

    expect(wrapper.find('.plr-meta .t-progress').exists()).toBe(true)
  })
})
