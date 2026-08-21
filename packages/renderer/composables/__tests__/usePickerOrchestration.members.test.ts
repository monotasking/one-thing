/**
 * W14a §4.5 — the composer half of 身份 id 化.
 *
 * The member popover no longer types a name into the draft: it inserts a
 * `{{member:<agentId>}}` token (painted as @名字 by the editor) that
 * materializes at SEND into plain `@名字` text plus the id in mentions[].
 * These tests pin the two ends of that trip — what lands in the draft, and
 * what leaves it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import {
  COMPOSER_MENTION_ALL_VALUE,
  buildCollabMemberPickerItems,
  usePickerOrchestration,
} from '../usePickerOrchestration'
import { createMemberToken } from '@shared/prompt-references'
import type { EditorCursorLineInfo, EditorHandle, EditorSelection } from '@/editor'

// skills 域已迁到通用 RPC 通道(结构债 P4c 第二批):取技能表走壳外客户端。
vi.mock('@/platform/skills-client', () => ({
  skillsApi: { getAll: vi.fn().mockResolvedValue({ success: true, skills: [] }) },
}))


interface TestAgent { id: string; name: string; title?: string }

const storeMocks = vi.hoisted(() => ({
  sessions: [
    { id: 'room-1', kind: 'room', room: { memberAgentIds: ['pm', 'fe'] } },
  ] as Array<{ id: string; kind: string; room?: { memberAgentIds: string[]; dm?: true } }>,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: { general: { quickCommands: [] } } }),
}))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ sessions: storeMocks.sessions }),
}))
// The roster is a REACTIVE ref on purpose: renaming a member has to invalidate
// the composable's roster computed exactly the way the real store does.
vi.mock('@/stores/agents', async () => {
  const { ref } = await import('vue')
  const agents = ref<TestAgent[]>([])
  return {
    useAgentsStore: () => ({ agents: agents.value, loadAgents: vi.fn() }),
    __setAgents: (next: TestAgent[]) => { agents.value = next },
  }
})

const { __setAgents: setAgents } = await import('@/stores/agents') as unknown as
  { __setAgents: (next: TestAgent[]) => void }

function makeEditorHandle(value: Ref<string>, cursor: Ref<number>): EditorHandle {
  return {
    focus: vi.fn(),
    blur: vi.fn(),
    getValue: () => value.value,
    getSelectedText: () => '',
    setValue: (nextValue) => {
      value.value = nextValue
      cursor.value = nextValue.length
    },
    getSelection: (): EditorSelection => ({ from: cursor.value, to: cursor.value }),
    setSelection: (from: number) => {
      cursor.value = Math.max(0, Math.min(from, value.value.length))
    },
    replaceRange: (from, to, text) => {
      value.value = `${value.value.slice(0, from)}${text}${value.value.slice(to)}`
      cursor.value = from + text.length
    },
    scrollToTop: vi.fn(),
    getScrollTop: () => 0,
    setScrollTop: vi.fn(),
    getCursorLineInfo: (): EditorCursorLineInfo => ({
      lineNumber: 1,
      totalLines: 1,
      from: 0,
      to: value.value.length,
      text: value.value,
    }),
  }
}

function createHarness(initialValue: string) {
  const scope = effectScope()
  const input = ref(initialValue)
  const cursor = ref(initialValue.length)
  const editor = ref<EditorHandle | null>(makeEditorHandle(input, cursor))
  const api = scope.run(() => usePickerOrchestration(
    input,
    ref('/repo'),
    editor,
    vi.fn(),
    vi.fn(),
    ref('room-1'),
  ))
  if (!api) throw new Error('failed to create picker harness')
  api.refreshTriggerState(input.value, cursor.value)
  return { scope, input, api }
}

beforeEach(() => {
  storeMocks.sessions = [
    { id: 'room-1', kind: 'room', room: { memberAgentIds: ['pm', 'fe'] } },
  ]
  setActivePinia(createPinia())
  vi.stubGlobal('window', {
    electronAPI: {
      getPluginCommands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
      listVariables: vi.fn().mockResolvedValue({ success: true, variables: [] }),
      listPrompts: vi.fn().mockResolvedValue({ success: true, prompts: [] }),
    },
  })
  setAgents([
    { id: 'pm', name: '阿明', title: '产品经理' },
    { id: 'fe', name: '小李', title: '前端工程师' },
  ])
})

describe('member picker → identity token (W14a)', () => {
  it('offers members with their AGENT ID as the pick value', async () => {
    const harness = createHarness('@小')
    await nextTick()
    const state = harness.api.activeExtension.value
    expect(state.type).toBe('members')
    expect(state.items.map(item => item.value)).toEqual(['fe'])
  })

  it('inserts a member token (not the bare name) at the trigger', async () => {
    const harness = createHarness('@小')
    await harness.api.handleMemberPickerSelect('fe')
    expect(harness.input.value).toBe(`${createMemberToken('fe')} `)
  })

  it('materializes at send into plain @名字 plus the id', () => {
    const harness = createHarness(`${createMemberToken('fe')} 登录页什么时候能好`)
    const { text, mentions } = harness.api.materializeMemberReferences(harness.input.value)
    expect(text).toBe('@小李 登录页什么时候能好')
    expect(mentions).toEqual([{ agentId: 'fe', label: '小李' }])
  })

  it('paints the CURRENT name when the member was renamed while the draft sat open', () => {
    const harness = createHarness(`${createMemberToken('fe')} 在吗`)
    setAgents([{ id: 'fe', name: '李工' }])
    const { text, mentions } = harness.api.materializeMemberReferences(harness.input.value)
    expect(text).toBe('@李工 在吗')
    expect(mentions).toEqual([{ agentId: 'fe', label: '李工' }])
  })

  it('leaves a mention-less draft untouched and reports nothing', () => {
    const harness = createHarness('大家早')
    expect(harness.api.materializeMemberReferences(harness.input.value))
      .toEqual({ text: '大家早', mentions: [] })
  })

  it('never ships a raw token when the member is gone', () => {
    const harness = createHarness(`${createMemberToken('ghost')} 在吗`)
    const { text, mentions } = harness.api.materializeMemberReferences(harness.input.value)
    expect(text).toBe('在吗')
    expect(mentions).toEqual([])
  })
})

/**
 * 「所有人」伪成员行 —— collab-room-clear-and-mention-all.md A1。
 *
 * 后端早就认 `@所有人`(ingress 展开成全体点名),缺的只是发现性:面板里没有
 * 这一行,用户必须凭记忆打出来。所以这里钉的是三件事:置顶、只在群房出现、
 * 选中产出**纯文本**(展开是 ingress 的事,面板不造第二种 @所有人)。
 */
describe('候选组装(纯函数)', () => {
  const MEMBERS = [
    { id: 'pm', name: '阿明', title: '产品经理' },
    { id: 'fe', name: '小李', title: '前端工程师' },
  ]

  it('置顶,并说清楚要提醒几个人', () => {
    const items = buildCollabMemberPickerItems({ query: '', members: MEMBERS })
    expect(items[0].value).toBe(COMPOSER_MENTION_ALL_VALUE)
    expect(items[0].title).toContain('所有人')
    expect(items[0].description).toBe('提醒全部 2 位成员')
    expect(items.slice(1).map(item => item.value)).toEqual(['pm', 'fe'])
  })

  it('dm 房里不出现 —— 那里没有第三个人', () => {
    const items = buildCollabMemberPickerItems({ query: '', members: MEMBERS, dm: true })
    expect(items.map(item => item.value)).toEqual(['pm', 'fe'])
  })

  it('一个成员都查不到时也不出现', () => {
    expect(buildCollabMemberPickerItems({ query: '', members: [] })).toEqual([])
  })

  it('认几种写法,不认别的', () => {
    for (const query of ['所有', '全体', 'all', 'every']) {
      expect(buildCollabMemberPickerItems({ query, members: MEMBERS })[0]?.value)
        .toBe(COMPOSER_MENTION_ALL_VALUE)
    }
    expect(buildCollabMemberPickerItems({ query: '小', members: MEMBERS }).map(item => item.value))
      .toEqual(['fe'])
  })
})

describe('选中「所有人」', () => {
  it('插入纯文本 @所有人,不产生 member token', async () => {
    const harness = createHarness('@')
    await harness.api.handleMemberPickerSelect(COMPOSER_MENTION_ALL_VALUE)
    expect(harness.input.value).toBe('@所有人 ')
    expect(harness.input.value).not.toContain('{{member:')
  })

  it('发送时不写 mentions[] —— 展开是 ingress 的事', () => {
    const harness = createHarness('@所有人 报数')
    expect(harness.api.materializeMemberReferences(harness.input.value))
      .toEqual({ text: '@所有人 报数', mentions: [] })
  })

  it('群房的 bare-@ 首行就是它', async () => {
    const harness = createHarness('@')
    await nextTick()
    const state = harness.api.activeExtension.value
    expect(state.type).toBe('members')
    expect(state.items[0]?.value).toBe(COMPOSER_MENTION_ALL_VALUE)
  })

  it('dm 房的 bare-@ 里没有它', async () => {
    storeMocks.sessions = [
      { id: 'room-1', kind: 'room', room: { memberAgentIds: ['fe'], dm: true } },
    ]
    const harness = createHarness('@')
    await nextTick()
    expect(harness.api.activeExtension.value.items.map(item => item.value)).toEqual(['fe'])
  })
})
