// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserStartPage from '../BrowserStartPage.vue'

// A1-b:浏览器面走宿主壳路由的 `browser` 域,渲染侧客户端是 `browserApi`。
const getSearchEngine = vi.fn()

vi.mock('@/platform/browser-client', () => ({
  browserApi: {
    get getSearchEngine() {
      return getSearchEngine
    },
  },
}))

async function mountStartPage() {
  const wrapper = mount(BrowserStartPage, { attachTo: document.body })
  await nextTick()
  await nextTick() // onMounted's engine fetch
  return wrapper
}

beforeEach(() => {
  getSearchEngine.mockReset()
  getSearchEngine.mockResolvedValue({ success: true, engineId: 'google' })
})

describe('BrowserStartPage', () => {
  it('opens on the persisted default engine', async () => {
    getSearchEngine.mockResolvedValue({ success: true, engineId: 'baidu' })
    const wrapper = await mountStartPage()
    expect(wrapper.get('.bsp-token').text()).toBe('百')
  })

  it('falls back to the default engine when the host has no answer', async () => {
    getSearchEngine.mockResolvedValue({ success: false, engineId: 'google' })
    const wrapper = await mountStartPage()
    expect(wrapper.get('.bsp-token').text()).toBe('G')
  })

  it('Tab cycles the engine and reveals the ring; Shift+Tab goes back', async () => {
    const wrapper = await mountStartPage()
    expect(wrapper.find('.bsp-ring').exists()).toBe(false)

    await wrapper.get('.bsp-input').trigger('keydown', { key: 'Tab' })
    expect(wrapper.get('.bsp-token').text()).toBe('B')
    expect(wrapper.findAll('.bsp-ring-item')).toHaveLength(4)
    expect(wrapper.get('.bsp-ring-item.on').text()).toContain('必应')

    await wrapper.get('.bsp-input').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(wrapper.get('.bsp-token').text()).toBe('G')
  })

  it('submits the query with the engine picked on the line, not the default', async () => {
    const wrapper = await mountStartPage()
    await wrapper.get('.bsp-input').setValue('上海 天气')
    await wrapper.get('.bsp-input').trigger('keydown', { key: 'Tab' })
    await wrapper.get('.bsp-input').trigger('keydown', { key: 'Tab' })
    await wrapper.get('.bsp-line').trigger('submit')

    expect(wrapper.emitted('submit')).toEqual([['上海 天气', 'baidu']])
  })

  it('does not submit an empty line', async () => {
    const wrapper = await mountStartPage()
    await wrapper.get('.bsp-input').setValue('   ')
    await wrapper.get('.bsp-line').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('shows what Enter will do — search vs navigate', async () => {
    const wrapper = await mountStartPage()
    expect(wrapper.get('.bsp-hint').text()).toContain('本次有效')

    await wrapper.get('.bsp-input').setValue('vue defineModel')
    expect(wrapper.get('.bsp-hint').text()).toContain('谷歌搜索')

    await wrapper.get('.bsp-input').setValue('vuejs.org')
    expect(wrapper.get('.bsp-hint').text()).toContain('前往')
  })

  it('Esc closes the ring first, then clears the line', async () => {
    const wrapper = await mountStartPage()
    const input = wrapper.get('.bsp-input')
    await input.setValue('half typed')
    await input.trigger('keydown', { key: 'Tab' })

    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.bsp-ring').exists()).toBe(false)
    expect((input.element as HTMLInputElement).value).toBe('half typed')

    await input.trigger('keydown', { key: 'Escape' })
    expect((input.element as HTMLInputElement).value).toBe('')
  })
})
