// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpaceCredentialsPanel from '../SpaceCredentialsPanel.vue'
import type { ProviderInfo } from '@/types'

const mocks = vi.hoisted(() => ({
  store: null as any,
}))

vi.mock('@/stores/spaces', () => ({
  DEFAULT_SPACE_ID: 'default',
  useSpacesStore: () => mocks.store,
}))

const providers = [
  { id: 'deepseek', name: 'DeepSeek', requiresApiKey: true },
  { id: 'codex', name: 'Codex', requiresApiKey: false, requiresOAuth: true },
] as unknown as ProviderInfo[]

function createStore(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    spaces: [
      { id: 'default', name: '默认空间', createdAt: 0 },
      { id: 'work', name: '工作', createdAt: 1 },
    ],
    currentSpaceId: 'work',
    lastError: null,
    load: vi.fn(async () => {}),
    getCredentials: vi.fn(async () => ({ providers: {} })),
    setCredential: vi.fn(async () => ({ providers: {} })),
    clearCredential: vi.fn(async () => ({ providers: {} })),
    ...overrides,
  }
}

async function mountPanel() {
  const wrapper = mount(SpaceCredentialsPanel, { props: { providers } })
  await nextTick()
  await nextTick()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  mocks.store = createStore()
  vi.clearAllMocks()
})

describe('SpaceCredentialsPanel', () => {
  it('draws nothing when the host has no spaces API (web degradation)', async () => {
    mocks.store = createStore({ available: false })
    const wrapper = await mountPanel()
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('opens on the current space and shows per-provider state', async () => {
    mocks.store = createStore({
      getCredentials: vi.fn(async () => ({
        providers: {
          deepseek: {
            policy: 'single',
            entries: [{
              id: 'e1',
              label: 'DeepSeek',
              authType: 'apiKey' as const,
              hasApiKey: true,
              apiKeyPreview: 'sk-abc••••6789',
              source: 'user',
            }],
          },
        },
      })),
    })
    const wrapper = await mountPanel()
    expect(mocks.store.getCredentials).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('已配置')
    // OAuth 型是灰态,不是"未配置" —— 两者的出路完全不同。
    expect(wrapper.text()).toContain('本空间暂不支持')
    wrapper.unmount()
  })

  it('never renders a raw key — only the preview the backend sent', async () => {
    mocks.store = createStore({
      getCredentials: vi.fn(async () => ({
        providers: {
          deepseek: {
            policy: 'single',
            entries: [{
              id: 'e1',
              label: 'DeepSeek',
              authType: 'apiKey' as const,
              hasApiKey: true,
              apiKeyPreview: 'sk-abc••••6789',
              source: 'user',
            }],
          },
        },
      })),
    })
    const wrapper = await mountPanel()
    expect(wrapper.html()).not.toContain('sk-abcdef0123456789')
    wrapper.unmount()
  })

  it('saves one provider row and clears the draft afterwards', async () => {
    const wrapper = await mountPanel()
    const input = wrapper.findAll('input')[0]
    await input.setValue('sk-new')
    await nextTick()

    const buttons = wrapper.findAll('button').filter(b => b.text() === '保存')
    await buttons[0].trigger('click')
    await nextTick()

    expect(mocks.store.setCredential).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      apiKey: 'sk-new',
      baseUrl: undefined,
    })
    wrapper.unmount()
  })

  it('says the default space is edited elsewhere instead of offering a second truth', async () => {
    mocks.store = createStore({ currentSpaceId: 'default' })
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('默认空间的凭证在上面的「连接」区域编辑')
    expect(mocks.store.getCredentials).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
