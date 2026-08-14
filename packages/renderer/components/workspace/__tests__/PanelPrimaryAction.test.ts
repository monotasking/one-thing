// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelPrimaryAction from '../PanelPrimaryAction.vue'

describe('PanelPrimaryAction', () => {
  it('is a primary Button, not a second button implementation', () => {
    const wrapper = mount(PanelPrimaryAction, { slots: { default: '新建' } })

    const button = wrapper.find('button')
    expect(button.classes()).toContain('app-button')
    expect(button.classes()).toContain('app-button--primary')
    expect(button.attributes('type')).toBe('button')
    expect(button.text()).toBe('新建')
  })

  it('passes attrs (disabled, aria, click) straight through to the Button', async () => {
    const wrapper = mount(PanelPrimaryAction, {
      attrs: { disabled: true, 'aria-label': '开始练习' },
      slots: { default: '进行中' },
    })

    const button = wrapper.find('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-label')).toBe('开始练习')

    await button.trigger('click')
    // disabled 的按钮不该把 click 冒出去 —— 这条由 Button 自己保证,这里只钉住它没被绕开。
    expect(wrapper.emitted('click')).toBeUndefined()
  })
})
