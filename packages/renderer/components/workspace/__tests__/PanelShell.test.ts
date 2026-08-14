// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelShell from '../PanelShell.vue'

describe('PanelShell', () => {
  it('renders the three layers and keeps controls/status out of the scroll area', () => {
    const wrapper = mount(PanelShell, {
      slots: {
        controls: '<div class="probe-controls">controls</div>',
        default: '<div class="probe-body">body</div>',
        status: '<span class="probe-status">48 项</span>',
      },
    })

    expect(wrapper.find('.panel-shell-controls .probe-controls').exists()).toBe(true)
    expect(wrapper.find('.panel-shell-body .probe-body').exists()).toBe(true)
    expect(wrapper.find('.panel-shell-status .probe-status').exists()).toBe(true)
    // 控制条与状态条是壳的兄弟层,不能落进滚动容器里。
    expect(wrapper.find('.panel-shell-body .probe-controls').exists()).toBe(false)
    expect(wrapper.find('.panel-shell-body .probe-status').exists()).toBe(false)
  })

  it('omits the controls bar when no controls slot is given', () => {
    const wrapper = mount(PanelShell, { slots: { default: '<div>body</div>' } })

    expect(wrapper.find('.panel-shell-controls').exists()).toBe(false)
    expect(wrapper.find('.panel-shell-body').exists()).toBe(true)
  })

  it('omits the status bar until there is a slot, text, or busy flag', async () => {
    const wrapper = mount(PanelShell, { slots: { default: '<div>body</div>' } })
    expect(wrapper.find('.panel-shell-status').exists()).toBe(false)

    await wrapper.setProps({ statusText: '共 3 项' })
    expect(wrapper.find('.panel-shell-status').text()).toBe('共 3 项')
  })

  it('shows the single allowed spinner only while busy', async () => {
    const wrapper = mount(PanelShell, {
      props: { busy: false, statusText: '正在索引' },
    })
    expect(wrapper.find('.panel-shell-spinner').exists()).toBe(false)

    await wrapper.setProps({ busy: true })
    const spinner = wrapper.find('.panel-shell-spinner')
    expect(spinner.exists()).toBe(true)
    // 装饰件,不该被读屏读出来。
    expect(spinner.attributes('aria-hidden')).toBe('true')
    // spinner 与文案同处状态条 —— 内容区永远没有 spinner。
    expect(wrapper.find('.panel-shell-body .panel-shell-spinner').exists()).toBe(false)
  })

  it('lets the body opt out of scrolling and padding', async () => {
    const wrapper = mount(PanelShell, { slots: { default: '<div>body</div>' } })
    const body = wrapper.find('.panel-shell-body')
    expect(body.classes()).toContain('is-scroll')
    expect(body.classes()).toContain('is-padded')

    await wrapper.setProps({ scroll: false, padded: false })
    expect(wrapper.find('.panel-shell-body').classes()).not.toContain('is-scroll')
    expect(wrapper.find('.panel-shell-body').classes()).not.toContain('is-padded')
  })

  it('drops the status padding for full-bleed status content', () => {
    const wrapper = mount(PanelShell, {
      props: { statusFlush: true },
      slots: { status: '<div class="player">44px player</div>' },
    })

    expect(wrapper.find('.panel-shell-status').classes()).toContain('is-flush')
  })
})
