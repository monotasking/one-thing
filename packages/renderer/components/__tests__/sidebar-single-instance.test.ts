// @vitest-environment happy-dom
/**
 * 侧栏单实例(L4,`docs/design/shell-layout-2026-08.md` §L4)。
 *
 * 从前浮层态与停靠态各挂一个 `<Sidebar>`,靠 `v-if` 互斥 —— 每次 hover 勾出浮层
 * 就是一次**重挂**:滚动位置、展开的分组、搜索框里打了一半的字全部回到初值。
 * L4 把它改成"同一个实例 + 左栏面板收成 0 宽",于是这些内部 state 天然保留。
 *
 * 这里钉两件事:
 *  1. **机制** —— `SplitterPanel` 的 `:collapsed` 来回翻,槽里的子组件一次都不
 *     重挂,它自己的 ref 原样还在(这正是"浮层⇄停靠不丢 state"的全部依据);
 *  2. **接线** —— App.vue 里确实只剩一个 `<Sidebar>`,且浮层的三枚开关都接在
 *     它身上;壳外那棵 `.app-floating-sidebar-host` 兄弟树连同注释死码一起没了。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import Splitter from '@/components/common/Splitter.vue'
import SplitterPanel from '@/components/common/SplitterPanel.vue'

function readRendererFile(relativePath: string) {
  return readFileSync(resolve(process.cwd(), 'packages/renderer', relativePath), 'utf8')
}

describe('侧栏单实例', () => {
  it('左栏面板 collapsed 来回翻,槽里的实例不重挂、内部 state 不丢', async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()

    /** 冒充 Sidebar:一枚"滚动位置"式的内部 ref + 挂载/卸载两个探针。 */
    const StatefulSidebar = defineComponent({
      name: 'StatefulSidebar',
      setup(_, { expose }) {
        const scrollTop = ref(0)
        mounted()
        expose({ scrollTop })
        return () => h('div', { class: 'stateful-sidebar' }, String(scrollTop.value))
      },
      unmounted,
    })

    const docked = ref(true)
    const sidebarRef = ref<{ scrollTop: number } | null>(null)

    const Host = defineComponent({
      setup() {
        return () => h(Splitter, { class: 'app-shell' }, {
          default: () => [
            h(SplitterPanel, {
              class: 'app-left-sidebar-region',
              sizeUnit: 'px',
              size: 300,
              collapsed: !docked.value,
              resizable: docked.value,
            }, { default: () => h(StatefulSidebar, { ref: sidebarRef }) }),
            h(SplitterPanel, { flex: true, sizeUnit: 'px' }, { default: () => h('div') }),
          ],
        })
      },
    })

    const wrapper = mount(Host, { attachTo: document.body })
    await nextTick()

    expect(mounted).toHaveBeenCalledTimes(1)
    sidebarRef.value!.scrollTop = 420

    // 停靠 → 浮层(面板收成 0 宽)。
    docked.value = false
    await nextTick()
    await nextTick()
    expect(wrapper.find('.app-left-sidebar-region').classes()).toContain('is-collapsed')

    // 浮层 → 停靠。
    docked.value = true
    await nextTick()
    await nextTick()
    expect(wrapper.find('.app-left-sidebar-region').classes()).not.toContain('is-collapsed')

    // 一次都没重挂,内部 state 原样。
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    expect(sidebarRef.value!.scrollTop).toBe(420)
    expect(wrapper.find('.stateful-sidebar').text()).toBe('420')

    wrapper.unmount()
  })

  it('App.vue 只剩一个 <Sidebar>,浮层三开关都接在它身上', () => {
    const app = readRendererFile('App.vue')

    // 只数真的标签(行首那一处),注释里提到它的名字不算。
    expect(app.match(/^\s*<Sidebar\b/gm)).toHaveLength(1)
    expect(app).toContain(':floating="sidebarFloating"')
    expect(app).toContain(':floating-closing="sidebarFloatingClosing"')
    expect(app).toContain(':no-transition="sidebarNoTransition"')
    // 壳外那棵兄弟树没了(浮层现在住在 .app-shell 的左栏 region 里)。
    expect(app).not.toContain('app-floating-sidebar-host')
    expect(app).not.toContain(':floating="false"')
    // 注释死码:markup 早删了,规则躺了半年。
    expect(app).not.toContain('.sidebar-floating-backdrop {')
    expect(app).not.toContain('@keyframes fadeOut')
  })

  it('左栏 region 的接缝线在收起态不画(否则窗口左缘多一条 1px 竖线)', () => {
    // L5 起三栏树(与它的接缝线)住在 AppShell。
    const shell = readRendererFile('components/shell/AppShell.vue')
    expect(shell).toContain('.app-shell :deep(.app-left-sidebar-region:not(.is-collapsed))')
  })

  it('停用的分隔条不吃指针,免得压住左缘那 12px 的 hover 触发区', () => {
    const splitter = readRendererFile('components/common/Splitter.vue')
    const disabled = splitter.slice(splitter.indexOf('.splitter-resizer.is-disabled {'))
    expect(disabled.slice(0, disabled.indexOf('}'))).toContain('pointer-events: none;')
  })
})
