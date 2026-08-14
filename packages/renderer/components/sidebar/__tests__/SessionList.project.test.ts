// @vitest-environment happy-dom
/**
 * 项目组头上的「＋」——「在这个项目里新建会话」的入口。
 *
 * 三件事钉在这里:
 *  1. 只有项目组有这颗钮(置顶 / 未归类没有 projectPath);
 *  2. 点它**不会**顺带折叠组头 —— 它住在 SubMenu 的 title <button> 里面,
 *     不自己 stop 的话点击会冒到组头的开合上;
 *  3. 组是收着的时候先展开再报上去,否则新草稿落进一个看不见的抽屉。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SessionList from '../SessionList.vue'
import type { SessionGroup } from '../useSessionOrganizer'

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ sessions: [], currentSessionId: '' }),
}))

function row(id: string, name: string) {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    branches: [],
    depth: 0,
    hasBranches: false,
    isCollapsed: false,
    isLastChild: true,
    branchCount: 0,
    isHidden: false,
    lastBranchUpdate: 0,
    ancestorsLastChild: [],
  } as any
}

function mountList(groups: SessionGroup[]) {
  return mount(SessionList, {
    props: {
      groups,
      activeIndex: '',
      currentSessionId: null,
      isSessionGenerating: () => false,
      editingSessionId: null,
      editingName: '',
    },
    global: {
      stubs: { SessionItem: true, Tooltip: { template: '<div><slot /></div>' } },
    },
  })
}

const PROJECT_GROUP: SessionGroup = {
  key: 'proj:/Users/me/code/app',
  label: 'app',
  kind: 'project',
  sessions: [row('s1', 'One')],
  projectPath: '/Users/me/code/app',
  isRegistered: true,
}

const MISC_GROUP: SessionGroup = {
  key: 'uncategorized',
  label: '未归类',
  kind: 'other',
  sessions: [row('s2', 'Two')],
}

describe('SessionList 项目组头的「＋」', () => {
  it('只画在项目组上', () => {
    const wrapper = mountList([PROJECT_GROUP, MISC_GROUP])
    const buttons = wrapper.findAll('.group-new-session')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('aria-label')).toBe('在 app 中新建会话')
  })

  it('点击报出项目目录,且不把组头折叠掉', async () => {
    const wrapper = mountList([PROJECT_GROUP])
    // 组头默认展开(collapsedGroups 只装显式收起过的键)
    expect(wrapper.find('.session-group-items').exists()).toBe(true)

    await wrapper.find('.group-new-session').trigger('click')

    const emitted = wrapper.emitted('new-session-in-project')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toBe('/Users/me/code/app')
    // 第二个参数是触发事件:多根项目要靠它给「落在哪个根」的菜单定位。
    expect(emitted?.[0]?.[1]).toBeInstanceOf(Event)
    // 冒泡到了组头的话这一层就没了
    expect(wrapper.find('.session-group-items').exists()).toBe(true)
  })

  it('组收着时先展开再报上去', async () => {
    const wrapper = mountList([PROJECT_GROUP])
    // 走宿主自己的收起路径(SubMenu 关闭 → handleMenuClose)
    wrapper.findComponent({ name: 'AppMenu' }).vm.$emit(
      'close',
      'group:proj:/Users/me/code/app',
    )
    await wrapper.vm.$nextTick()
    // 面板是 v-if,收起后整块不在 DOM 里 —— 先钉住这一步,免得后面那句
    // 「还在」变成永远为真的空断言
    expect(wrapper.find('.session-group-items').exists()).toBe(false)

    await wrapper.find('.group-new-session').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('new-session-in-project')).toHaveLength(1)
    expect(wrapper.find('.session-group-items').exists()).toBe(true)
  })

  it('回车与空格与点击等价(它是 span 假扮的钮,键盘要自己接)', async () => {
    const wrapper = mountList([PROJECT_GROUP])
    await wrapper.find('.group-new-session').trigger('keydown.enter')
    await wrapper.find('.group-new-session').trigger('keydown.space')
    expect(wrapper.emitted('new-session-in-project')).toHaveLength(2)
  })

  it('右键项目名报出这一组,供宿主开「移出名册」菜单', async () => {
    const wrapper = mountList([PROJECT_GROUP, MISC_GROUP])
    const labels = wrapper.findAll('.group-label')
    await labels[0].trigger('contextmenu')
    const emitted = wrapper.emitted('project-context-menu')
    expect(emitted).toHaveLength(1)
    expect((emitted![0][1] as SessionGroup).projectPath).toBe('/Users/me/code/app')

    // 非项目组不开菜单
    await labels[1].trigger('contextmenu')
    expect(wrapper.emitted('project-context-menu')).toHaveLength(1)
  })
})
