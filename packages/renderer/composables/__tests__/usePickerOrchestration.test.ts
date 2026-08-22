import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { usePickerOrchestration } from '../usePickerOrchestration'
import { createFileToken, createPageToken, expandFileTokens } from '@shared/prompt-references'
import type { EditorCursorLineInfo, EditorHandle, EditorSelection } from '@/editor'
import type { PaletteItem } from '@/types/palette'
import { createPromptToken, createSkillToken } from '@shared/prompt-references'

const storeMocks = vi.hoisted(() => ({
  settingsStore: {
    settings: {
      general: {
        quickCommands: [],
      },
    },
  },
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => storeMocks.settingsStore,
}))

function makeEditorHandle(value: Ref<string>, cursor: Ref<number>): EditorHandle {
  function setSelection(from: number, to = from) {
    cursor.value = Math.max(0, Math.min(from, value.value.length))
    void to
  }

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
    setSelection,
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

function createHarness(initialValue: string, options: { cwd?: string } = {}) {
  const scope = effectScope()
  const input = ref(initialValue)
  const cursor = ref(initialValue.length)
  const cwd = ref(options.cwd ?? '/repo')
  const sessionId = ref('session-1')
  const editor = ref<EditorHandle | null>(makeEditorHandle(input, cursor))
  const adjustHeight = vi.fn()
  const checkHistoryEdit = vi.fn()

  const api = scope.run(() => usePickerOrchestration(
    input,
    cwd,
    editor,
    adjustHeight,
    checkHistoryEdit,
    sessionId,
  ))

  if (!api) throw new Error('failed to create picker harness')
  api.refreshTriggerState(input.value, cursor.value)

  return {
    scope,
    input,
    cursor,
    cwd,
    editor,
    adjustHeight,
    checkHistoryEdit,
    api,
  }
}

async function settleWatchers() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

// skills 域已迁到通用 RPC 通道(结构债 P4c 第二批):取技能表的是壳外客户端
// `@/platform/skills-client`,不再是 `electronAPI.getSkills`。
const skillsApi = vi.hoisted(() => ({
  getAll: vi.fn(),
}))
vi.mock('@/platform/skills-client', () => ({ skillsApi }))

// P4c 第八批:@ 文件补全与 /cd 目录补全从 `electronAPI.listFiles` / `listDirs`
// 换成 `@/platform/files-client` 的 `filesApi.list` / `filesApi.listDirs`。
const filesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listDirs: vi.fn(),
}))
vi.mock('@/platform/files-client', () => ({ filesApi }))

describe('usePickerOrchestration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    skillsApi.getAll.mockReset().mockResolvedValue({ success: true, skills: [] })
    filesApi.list.mockReset().mockResolvedValue({
      success: true,
      files: ['/repo/src/editor/TextEditor.vue'],
    })
    filesApi.listDirs.mockReset().mockResolvedValue({
      success: true,
      dirs: ['/Users/me/My Project'],
    })
    vi.stubGlobal('window', {
      electronAPI: {
        getPluginCommands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
        listVariables: vi.fn().mockResolvedValue({ success: true, variables: [] }),
        listPrompts: vi.fn().mockResolvedValue({
          success: true,
          prompts: [{
            id: 'prompt-1',
            title: 'Review Prompt',
            body: 'Review this.',
            createdAt: 1,
            updatedAt: 1,
          }],
        }),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tracks slash command triggers and replaces the active command range', async () => {
    const harness = createHarness('/c')
    await settleWatchers()

    expect(harness.api.showCommandPicker.value).toBe(true)
    expect(harness.api.commandQuery.value).toBe('c')
    expect(harness.api.activeExtension.value).toMatchObject({
      type: 'palette',
      query: 'c',
      paletteTypes: ['command', 'skill', 'prompt'],
    })

    await harness.api.handleCommandSelect({
      id: 'command:compact',
      type: 'command',
      title: '/compact',
      description: 'Compact context',
      command: { id: 'compact' },
    } as PaletteItem)

    expect(harness.input.value).toBe('/compact ')
    expect(harness.editor.value?.focus).toHaveBeenCalled()
    harness.scope.stop()
  })

  it('replaces @prompts triggers with prompt reference tokens', async () => {
    const harness = createHarness('use @prompts review')
    await settleWatchers()

    expect(harness.api.showCommandPicker.value).toBe(true)
    expect(harness.api.commandQuery.value).toBe('review')
    expect(harness.api.commandPickerTypes.value).toEqual(['prompt'])
    expect(harness.api.activeExtension.value).toMatchObject({
      type: 'palette',
      query: 'review',
      paletteTypes: ['prompt'],
    })

    await harness.api.handleCommandSelect({
      id: 'prompt:prompt-1',
      type: 'prompt',
      title: 'Review Prompt',
      description: 'Review this.',
      prompt: {
        id: 'prompt-1',
        title: 'Review Prompt',
        body: 'Review this.',
        createdAt: 1,
        updatedAt: 1,
      },
    } as PaletteItem)

    expect(harness.input.value).toBe(`use ${createPromptToken('prompt-1')} `)
    harness.scope.stop()
  })

  it('completes slash-selected skills into skill reference tokens', async () => {
    skillsApi.getAll.mockResolvedValue({
      success: true,
      skills: [{
        id: 'user:skill-development',
        name: 'Skill Development',
        description: 'Create or update skills',
        source: 'user',
        path: '/skills/skill-development/SKILL.md',
        directoryPath: '/skills/skill-development',
        enabled: true,
        instructions: 'Build skills carefully.',
      }],
    })
    const harness = createHarness('/sk')

    await harness.api.loadSkills()
    harness.api.refreshTriggerState(harness.input.value, harness.cursor.value)
    await settleWatchers()

    expect(harness.api.activeExtension.value.items[0]).toMatchObject({
      kind: 'skill',
      title: 'Skill Development',
    })

    await harness.api.confirmActiveExtension()

    expect(harness.input.value).toBe(`${createSkillToken('user:skill-development')} `)
    harness.scope.stop()
  })

  it('replaces @skills triggers with skill reference tokens', async () => {
    skillsApi.getAll.mockResolvedValue({
      success: true,
      skills: [{
        id: 'plugin:note-skills:daily',
        name: 'daily-note',
        description: 'Use daily note context',
        source: 'plugin',
        path: '/notes/daily/SKILL.md',
        directoryPath: '/notes/daily',
        enabled: true,
        instructions: 'Use note attachments.',
      }],
    })
    const harness = createHarness('use @skills daily')

    await harness.api.loadSkills()
    harness.api.refreshTriggerState(harness.input.value, harness.cursor.value)
    await settleWatchers()

    expect(harness.api.showCommandPicker.value).toBe(true)
    expect(harness.api.commandQuery.value).toBe('daily')
    expect(harness.api.commandPickerTypes.value).toEqual(['skill'])

    await harness.api.confirmActiveExtension()

    expect(harness.input.value).toBe(`use ${createSkillToken('plugin:note-skills:daily')} `)
    harness.scope.stop()
  })

  it('shows Downloads as a normal @ file picker directory result', async () => {
    vi.useFakeTimers()
    vi.mocked(filesApi.list).mockResolvedValue({
      success: true,
      files: [],
      entries: [{
        path: '/Users/me/Downloads',
        type: 'directory',
        source: 'downloads',
        label: 'Downloads',
      }],
    })
    const harness = createHarness('attach @downloads')

    try {
      await vi.advanceTimersByTimeAsync(200)
      await settleWatchers()

      expect(harness.api.showFilePicker.value).toBe(true)
      expect(harness.api.activeExtension.value).toMatchObject({
        type: 'files',
        query: 'downloads',
        items: [{
          kind: 'directory',
          title: 'Downloads',
          value: '/Users/me/Downloads',
        }],
      })
      expect(filesApi.list).toHaveBeenCalledWith({
        cwd: '/repo',
        query: 'downloads',
        limit: 50,
        // 接入目录 per-space,宿主按会话归属解析(批 B2)。
        sessionId: 'session-1',
      })
    } finally {
      harness.scope.stop()
      vi.useRealTimers()
    }
  })

  it('shows note and downloads directories for bare @ even without a workdir', async () => {
    vi.useFakeTimers()
    vi.mocked(filesApi.list).mockResolvedValue({
      success: true,
      files: [],
      entries: [
        {
          path: '/Users/me/Notes',
          type: 'directory',
          source: 'note',
          label: 'Personal notes',
        },
        {
          path: '/Users/me/Downloads',
          type: 'directory',
          source: 'downloads',
          label: 'Downloads',
        },
      ],
    })
    const harness = createHarness('attach @', { cwd: '' })

    try {
      await vi.advanceTimersByTimeAsync(200)
      await settleWatchers()

      expect(filesApi.list).toHaveBeenCalledWith({
        cwd: '',
        query: '',
        limit: 50,
        sessionId: 'session-1',
      })
      expect(harness.api.activeExtension.value.items).toEqual([
        expect.objectContaining({
          kind: 'directory',
          title: 'Personal notes',
          value: '/Users/me/Notes',
        }),
        expect.objectContaining({
          kind: 'directory',
          title: 'Downloads',
          value: '/Users/me/Downloads',
        }),
      ])
    } finally {
      harness.scope.stop()
      vi.useRealTimers()
    }
  })

  it('searches @files even when no workdir is available', async () => {
    vi.useFakeTimers()
    const harness = createHarness('attach @files receipt', { cwd: '' })

    try {
      await vi.advanceTimersByTimeAsync(200)
      await settleWatchers()

      expect(harness.api.showFilePicker.value).toBe(true)
      expect(filesApi.list).toHaveBeenCalledWith({
        cwd: '',
        query: 'receipt',
        limit: 50,
        sessionId: 'session-1',
      })
    } finally {
      harness.scope.stop()
      vi.useRealTimers()
    }
  })

  it('turns an @ pick into a hidden token that keeps the spot it was typed in', async () => {
    const harness = createHarness('read @first please')
    const triggerEnd = 'read @first'.length
    harness.cursor.value = triggerEnd
    harness.api.handleEditorSelectionChange({ from: triggerEnd, to: triggerEnd })
    await settleWatchers()

    expect(harness.api.activeExtension.value.type).toBe('files')

    await harness.api.handleFilePickerSelect('/repo/src/first.ts')

    expect(harness.input.value).toBe(
      `read ${createFileToken('/repo/src/first.ts')} please`,
    )
    // What the model eventually reads keeps the path exactly where it was.
    expect(expandFileTokens(harness.input.value)).toBe('read @/repo/src/first.ts please')
    expect(harness.api.showFilePicker.value).toBe(false)
    harness.scope.stop()
  })

  it('projects docked chips from the tokens and removes only the picked one', async () => {
    const harness = createHarness(
      `a ${createFileToken('/repo/src/a.ts')} b ${createFileToken('/repo/src/b.ts')}`,
    )
    await settleWatchers()

    expect(harness.api.fileReferences.value.map(entry => entry.path)).toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ])
    expect(harness.api.fileReferences.value[0].label).toBe('src/a.ts')

    harness.api.removeFileReference(harness.api.fileReferences.value[0].id)
    await settleWatchers()

    expect(harness.input.value).toBe(`a  b ${createFileToken('/repo/src/b.ts')}`)
    expect(harness.api.fileReferences.value.map(entry => entry.path)).toEqual([
      '/repo/src/b.ts',
    ])
    harness.scope.stop()
  })

  it('tracks /cd path triggers and replaces the exact path range', async () => {
    const harness = createHarness('/cd ~/wo')
    await settleWatchers()

    expect(harness.api.showPathPicker.value).toBe(true)
    expect(harness.api.pathQuery.value).toBe('~/wo')
    expect(harness.api.activeExtension.value).toMatchObject({
      type: 'paths',
      query: '~/wo',
      selectedIndex: 0,
    })

    await harness.api.handlePathPickerSelect('/Users/me/My Project')

    expect(harness.input.value).toBe('/cd /Users/me/My Project')
    expect(harness.api.showPathPicker.value).toBe(false)
    harness.scope.stop()
  })

  it('refreshes file triggers on cursor movement before replacing', async () => {
    const value = 'read @first then @second'
    const harness = createHarness(value)
    await settleWatchers()

    expect(harness.api.activeExtension.value.type).toBe('files')
    expect(harness.api.fileQuery.value).toBe('second')

    const firstTriggerEnd = 'read @first'.length
    harness.cursor.value = firstTriggerEnd
    harness.api.handleEditorSelectionChange({ from: firstTriggerEnd, to: firstTriggerEnd })
    await settleWatchers()

    expect(harness.api.fileQuery.value).toBe('first')
    expect(harness.api.activeExtension.value).toMatchObject({
      type: 'files',
      query: 'first',
    })

    await harness.api.handleFilePickerSelect('/repo/first.md')

    expect(harness.input.value).toBe(
      `read ${createFileToken('/repo/first.md')} then @second`,
    )
    harness.scope.stop()
  })

  it('updates trigger state from editor transactions and closes stale picker state', async () => {
    const harness = createHarness('open @files src')
    await settleWatchers()

    expect(harness.api.showFilePicker.value).toBe(true)
    expect(harness.api.fileQuery.value).toBe('src')
    expect(harness.api.activeExtension.value).toMatchObject({
      type: 'files',
      query: 'src',
    })

    harness.input.value = 'plain text'
    harness.cursor.value = 'plain text'.length
    harness.api.handleEditorTransaction({
      value: harness.input.value,
      selection: { from: harness.cursor.value, to: harness.cursor.value },
      docChanged: true,
      selectionChanged: true,
    })
    await settleWatchers()

    expect(harness.api.showFilePicker.value).toBe(false)
    expect(harness.api.fileQuery.value).toBe('')
    expect(harness.api.activeExtension.value.type).toBe('none')
    expect(harness.checkHistoryEdit).toHaveBeenCalledWith('plain text')
    harness.scope.stop()
  })

  function stubBrowserTabs() {
    // The picker harness hydrates the browser mirror at setup (per-access
    // platform proxy), so extending the stub before createHarness is enough.
    Object.assign(window.electronAPI, {
      hydrateBrowser: vi.fn().mockResolvedValue({
        success: true,
        tabs: [
          { id: 'tab-1', url: 'https://github.com/pull/7', title: 'Example PR', loading: false, canGoBack: false, canGoForward: false },
          { id: 'tab-2', url: 'https://vuejs.org/guide/', title: 'Vue Guide', loading: false, canGoBack: false, canGoForward: false },
        ],
        activeTabId: 'tab-1',
      }),
      onBrowserTabsChanged: vi.fn().mockReturnValue(() => {}),
    })
  }

  it('lists open tabs under @page with the current page first and inserts a page token', async () => {
    stubBrowserTabs()
    const harness = createHarness('use @page')
    await settleWatchers()

    expect(harness.api.activeExtension.value.type).toBe('pages')
    expect(harness.api.activeExtension.value.items).toEqual([
      expect.objectContaining({ kind: 'browser-page', value: 'tab-1', meta: 'Current page', title: 'Example PR' }),
      expect.objectContaining({ kind: 'browser-page', value: 'tab-2', meta: 'Tab', title: 'Vue Guide' }),
    ])

    await harness.api.confirmActiveExtension()

    expect(harness.input.value).toBe(`use ${createPageToken('tab-1')} `)
    harness.scope.stop()
  })

  it('pins the current page row at the top of the bare @ picker', async () => {
    vi.useFakeTimers()
    stubBrowserTabs()
    const harness = createHarness('attach @')

    try {
      await vi.advanceTimersByTimeAsync(200)
      await settleWatchers()

      expect(harness.api.activeExtension.value.type).toBe('files')
      expect(harness.api.activeExtension.value.items[0]).toMatchObject({
        kind: 'browser-page',
        value: 'tab-1',
        meta: 'Current page',
      })

      await harness.api.confirmActiveExtension()

      expect(harness.input.value).toBe(`attach ${createPageToken('tab-1')} `)
    } finally {
      harness.scope.stop()
      vi.useRealTimers()
    }
  })

  it('projects page chips from tokens and resolves them at send time', async () => {
    stubBrowserTabs()
    const harness = createHarness(`see ${createPageToken('tab-1')} now`)
    await settleWatchers()

    expect(harness.api.pageReferences.value).toEqual([
      expect.objectContaining({ tabId: 'tab-1', url: 'https://github.com/pull/7', label: 'Example PR' }),
    ])

    const { text, attachments } = harness.api.materializePageReferences(harness.input.value)
    // The URL never enters the message text — the attachment is the carrier.
    expect(text).toBe('see now')
    expect(attachments).toEqual([
      expect.objectContaining({
        mediaType: 'file',
        size: 0,
        sourceUrl: 'https://github.com/pull/7',
        sourceTitle: 'Example PR',
      }),
    ])
    expect(attachments[0].base64Data).toBeUndefined()
    harness.scope.stop()
  })

  it('labels dead page tokens and strips them at send time', async () => {
    stubBrowserTabs()
    const harness = createHarness(`see ${createPageToken('tab-9')} now`)
    await settleWatchers()

    expect(harness.api.pageReferences.value[0]).toMatchObject({
      tabId: 'tab-9',
      label: 'Closed page',
    })

    const { text, attachments } = harness.api.materializePageReferences(harness.input.value)
    expect(text).toBe('see now')
    expect(attachments).toEqual([])

    harness.api.removePageReference(harness.api.pageReferences.value[0].id)
    await settleWatchers()
    expect(harness.input.value).toBe('see  now')
    harness.scope.stop()
  })

  it('supports absolute and paged command palette navigation', async () => {
    skillsApi.getAll.mockResolvedValue({
      success: true,
      skills: Array.from({ length: 6 }, (_, index) => ({
        id: `user:skill-${index}`,
        name: `Skill ${index}`,
        description: `Skill description ${index}`,
        source: 'user',
        path: `/skills/skill-${index}/SKILL.md`,
        directoryPath: `/skills/skill-${index}`,
        enabled: true,
        instructions: `Use skill ${index}.`,
      })),
    })

    const harness = createHarness('/')
    await harness.api.loadSkills()
    harness.api.refreshTriggerState(harness.input.value, harness.cursor.value)
    await settleWatchers()

    const itemCount = harness.api.activeExtension.value.items.length
    expect(harness.api.showCommandPicker.value).toBe(true)
    expect(itemCount).toBeGreaterThan(5)

    expect(harness.api.setActiveSelection(itemCount - 1)).toBe(true)
    expect(harness.api.activeExtension.value.selectedIndex).toBe(itemCount - 1)

    harness.api.pageActiveSelection(-1, 5)
    expect(harness.api.activeExtension.value.selectedIndex).toBe(itemCount - 6)

    harness.api.pageActiveSelection(1, itemCount)
    expect(harness.api.activeExtension.value.selectedIndex).toBe(itemCount - 1)

    harness.api.setActiveSelection(-100)
    expect(harness.api.activeExtension.value.selectedIndex).toBe(0)

    harness.scope.stop()
  })
})
