// @vitest-environment happy-dom
/**
 * 外壳三栏结构(L5,`docs/design/shell-layout-2026-08.md` §L5)。
 *
 * AppShell 只画格子:每一个数由 props 灌进来,每一次拖拽以事件抛回去。所以这里
 * 钉的是**结构与接线**,不是像素 —— 三块 region 各就各位、插槽内容落在对的那块、
 * 收起态挂 `is-collapsed`、冻结宽写在 `.app-content` 上、拖拽事件如实转发。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AppShell from '../AppShell.vue'

const baseProps = {
  sidebarWidth: 300,
  sidebarMinWidth: 200,
  sidebarMaxWidth: 500,
  sidebarDocked: true,
  chatMinWidth: 480,
  workbenchPanelWidth: 360,
  workbenchMinWidth: 250,
  workbenchMaxWidth: 600,
  workbenchSlideWidth: 360,
}

const slots = {
  sidebar: '<div class="probe-sidebar" />',
  main: '<div class="probe-main" />',
  workbench: '<div class="probe-workbench" />',
  'content-overlays': '<div class="probe-overlay" />',
}

function mountShell(props: Record<string, unknown> = {}) {
  return mount(AppShell, { props: { ...baseProps, ...props }, slots })
}

describe('AppShell 三栏结构', () => {
  it('三块 region 各就各位,插槽内容落在对的那一块', () => {
    const wrapper = mountShell({ workbenchMounted: true, workbenchRevealed: true, workbenchVisible: true })

    const left = wrapper.find('aside.app-left-sidebar-region')
    const main = wrapper.find('.app-shell-main-region')
    const right = wrapper.find('aside.app-right-sidebar-region')

    expect(left.exists()).toBe(true)
    expect(main.exists()).toBe(true)
    expect(right.exists()).toBe(true)

    expect(left.find('.probe-sidebar').exists()).toBe(true)
    expect(main.find('.probe-main').exists()).toBe(true)
    // 右栏内容外面永远隔着那层冻结宽的滑动壳。
    expect(right.find('.workbench-slide > .probe-workbench').exists()).toBe(true)

    // 中栏那棵是"内容区 → 内层分栏器 → 中栏面板",顺序不能反。
    const content = main.find('.app-content')
    expect(content.exists()).toBe(true)
    expect(content.find('.app-content-splitter').exists()).toBe(true)
    // 语音那类窗内浮层留在 `.app-content` 作用域里(wallpaper.css 的 C 级块以它为根)。
    expect(content.find('.probe-overlay').exists()).toBe(true)

    wrapper.unmount()
  })

  it('侧栏不在停靠位时左栏收成 0 宽,但实例仍在树上(L4)', async () => {
    const wrapper = mountShell()
    expect(wrapper.find('.app-left-sidebar-region').classes()).not.toContain('is-collapsed')

    await wrapper.setProps({ sidebarDocked: false })
    const left = wrapper.find('.app-left-sidebar-region')
    expect(left.classes()).toContain('is-collapsed')
    // 关键的那一条:收起 ≠ 卸载。
    expect(left.find('.probe-sidebar').exists()).toBe(true)

    wrapper.unmount()
  })

  it('右栏没挂过就不进 DOM;挂过之后收起只是折叠', async () => {
    const wrapper = mountShell()
    expect(wrapper.find('.app-right-sidebar-region').exists()).toBe(false)

    await wrapper.setProps({ workbenchMounted: true, workbenchRevealed: false })
    const right = wrapper.find('.app-right-sidebar-region')
    expect(right.exists()).toBe(true)
    expect(right.classes()).toContain('is-collapsed')
    expect(right.find('.probe-workbench').exists()).toBe(true)

    await wrapper.setProps({ workbenchRevealed: true })
    expect(wrapper.find('.app-right-sidebar-region').classes()).not.toContain('is-collapsed')

    wrapper.unmount()
  })

  it('冻结宽写在 .app-content 上,且扣掉右栏那 1px border-left', async () => {
    const wrapper = mountShell({ workbenchSlideWidth: 360 })
    expect(wrapper.find('.app-content').attributes('style')).toContain('--workbench-width: 359px')

    // 0 宽不许溢出成负数。
    await wrapper.setProps({ workbenchSlideWidth: 0 })
    expect(wrapper.find('.app-content').attributes('style')).toContain('--workbench-width: 0px')

    wrapper.unmount()
  })

  it('拖侧栏与拖右栏是两条各自独立的事件线', () => {
    const wrapper = mountShell({ workbenchMounted: true, workbenchRevealed: true })

    const splitters = wrapper.findAllComponents({ name: 'Splitter' })
    expect(splitters).toHaveLength(2)

    splitters[0].vm.$emit('resize-start')
    splitters[0].vm.$emit('resize-end')
    splitters[1].vm.$emit('resize-start')
    splitters[1].vm.$emit('resize-end')

    expect(wrapper.emitted('sidebar-resize-start')).toHaveLength(1)
    expect(wrapper.emitted('sidebar-resize-end')).toHaveLength(1)
    expect(wrapper.emitted('workbench-resize-start')).toHaveLength(1)
    expect(wrapper.emitted('workbench-resize-end')).toHaveLength(1)

    wrapper.unmount()
  })

  it('两个元素 expose 给宿主:一处挂协调器的 ResizeObserver,一处当搜索窗锚点', () => {
    const wrapper = mountShell()
    const exposed = wrapper.vm as unknown as {
      shellElement: HTMLElement | null
      contentElement: HTMLElement | null
    }

    expect(exposed.shellElement?.classList.contains('app-shell')).toBe(true)
    expect(exposed.contentElement?.classList.contains('app-content')).toBe(true)

    wrapper.unmount()
  })
})
