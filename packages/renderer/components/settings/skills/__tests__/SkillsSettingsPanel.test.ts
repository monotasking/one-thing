// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SkillsSettingsPanel from '../SkillsSettingsPanel.vue'
import { confirmStack } from '@/composables/useConfirm'
import { destroyUiOverlayHost } from '@/services/ui-overlay-host'
import type { SkillSettings } from '@/types'

const electronAPI = {
  // agents 域走通用 RPC 通道(主线 T1 第二批):打的是那一条通道。
  rpcInvoke: vi.fn(),
  openPath: vi.fn(),
  showOpenDialog: vi.fn(),
}

// skills 域整只迁到通用 RPC 通道(结构债 P4c 第二批):面板引的是壳外客户端
// `@/platform/skills-client`,十二条从前的 electronAPI 包装已经不存在了。
const skillsApi = vi.hoisted(() => ({
  getAll: vi.fn(),
  refresh: vi.fn(),
  readFile: vi.fn(),
  openDirectory: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  toggleEnabled: vi.fn(),
  listDirectories: vi.fn(),
  addDirectory: vi.fn(),
  updateDirectory: vi.fn(),
  removeDirectory: vi.fn(),
  setAgent: vi.fn(),
}))
vi.mock('@/platform/skills-client', () => ({ skillsApi }))

function skillFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user:demo',
    name: 'demo',
    description: 'Demo skill',
    source: 'user',
    path: '/skills/demo/SKILL.md',
    directoryPath: '/skills/demo',
    enabled: true,
    instructions: 'Use demo.',
    ...overrides,
  }
}

function settingsFixture(): SkillSettings {
  return { enableSkills: true, skills: {} }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('SkillsSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI
    skillsApi.getAll.mockResolvedValue({
      success: true,
      skills: [
        skillFixture(),
        skillFixture({
          id: 'custom:dir-1:team-review',
          name: 'team-review',
          source: 'custom',
          agentId: 'writer',
          directoryPath: '/team/skills/team-review',
        }),
      ],
    })
    skillsApi.listDirectories.mockResolvedValue({
      success: true,
      directories: [
        { id: 'dir-1', path: '/team/skills', label: 'Team', agentId: 'writer', enabled: true },
      ],
    })
    electronAPI.rpcInvoke.mockImplementation(async (request: { domain: string; method: string }) => {
      if (request.domain === 'agents' && request.method === 'list') {
        return {
          ok: true,
          data: {
            success: true,
            agents: [
              { id: 'default', name: 'Default Agent', systemPrompt: '', isDefault: true, createdAt: 0, updatedAt: 0 },
              { id: 'writer', name: 'Writer', systemPrompt: '', createdAt: 0, updatedAt: 0 },
            ],
          },
        }
      }
      return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
    })
    skillsApi.toggleEnabled.mockResolvedValue({ success: true })
    skillsApi.setAgent.mockResolvedValue({ success: true })
    skillsApi.refresh.mockResolvedValue({ success: true, skills: [] })
    skillsApi.removeDirectory.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    confirmStack.value = []
    destroyUiOverlayHost()
    document.body.innerHTML = ''
  })

  it('renders directories and skills grouped by source with agent bindings', async () => {
    const wrapper = mount(SkillsSettingsPanel, {
      props: { settings: settingsFixture() },
    })
    await settle()

    // Custom directory row with its label, path, and agent binding select.
    const dirRows = wrapper.findAll('.dir-row')
    expect(dirRows.length).toBeGreaterThanOrEqual(3) // 2 fixed roots + 1 custom
    const customRow = dirRows.at(-1)!
    expect(customRow.text()).toContain('Team')
    expect(customRow.text()).toContain('/team/skills')
    // P3: the binding is `<Select>`, so the bound value is the combobox's text.
    expect(customRow.find('.agent-select [role="combobox"]').text()).toBe('Writer')

    // Skills grouped by source, agent-bound skill wears the agent chip.
    const groupTitles = wrapper.findAll('.skill-group-title').map(node => node.text())
    expect(groupTitles).toEqual(['User', 'Custom directories'])
    expect(wrapper.find('.agent-chip').text()).toBe('Writer')
  })

  it('toggles a skill via IPC and mirrors the change into settings', async () => {
    const wrapper = mount(SkillsSettingsPanel, {
      props: { settings: settingsFixture() },
    })
    await settle()

    await wrapper.find('.skill-rows .enable-dot').trigger('click')
    await settle()

    expect(skillsApi.toggleEnabled).toHaveBeenCalledWith({ skillId: 'user:demo', enabled: false })
    const emitted = wrapper.emitted('update:settings')
    expect(emitted).toBeTruthy()
    const lastPayload = emitted![emitted!.length - 1][0] as SkillSettings
    expect(lastPayload.skills['user:demo']).toEqual({ enabled: false, agentId: undefined })
  })

  it('assigns an agent from the expanded row detail', async () => {
    const wrapper = mount(SkillsSettingsPanel, {
      props: { settings: settingsFixture() },
      attachTo: document.body,
    })
    await settle()

    await wrapper.find('.skill-rows .row-line').trigger('click')
    await settle()

    // P3: the binding is a teleported `<Select>` — open it and click the
    // option in document.body, where the panel lives.
    wrapper.find('.row-detail .agent-select [role="combobox"]').element
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()

    const option = [...document.querySelectorAll<HTMLElement>('.app-select-dropdown .app-select-option')]
      .find(node => node.textContent?.trim() === 'Writer')!
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()

    expect(skillsApi.setAgent).toHaveBeenCalledWith({ skillId: 'user:demo', agentId: 'writer' })
  })

  it('removes a custom directory after confirmation', async () => {
    const wrapper = mount(SkillsSettingsPanel, {
      props: { settings: settingsFixture() },
    })
    await settle()

    const customRow = wrapper.findAll('.dir-row').at(-1)!
    await customRow.find('.text-action.is-danger').trigger('click')
    await settle()

    // P2: the hand-rolled confirm is `useConfirm()`, rendered by the shared
    // host that the service mounts on `<body>` on first use.
    await vi.waitFor(() => expect(confirmStack.value).toHaveLength(1))
    const confirmButton = Array.from(document.querySelectorAll('.app-dialog-actions button'))
      .find(el => el.textContent?.trim() === 'remove') as HTMLButtonElement
    expect(confirmButton).toBeTruthy()
    confirmButton.click()
    await settle()

    expect(skillsApi.removeDirectory).toHaveBeenCalledWith({ id: 'dir-1' })
    const emitted = wrapper.emitted('update:settings')
    const lastPayload = emitted![emitted!.length - 1][0] as SkillSettings
    expect(lastPayload.customDirectories).toEqual([])
  })
})
