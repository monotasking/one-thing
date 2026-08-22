import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHANGE_DIRECTORY_SLASH_COMMAND,
  NEW_SESSION_SLASH_COMMAND,
  SHARED_SLASH_COMMANDS,
} from '@onething/core/slash-commands'
import { executeCommand, findCommand, getCommands } from '../index'

const storeMocks = vi.hoisted(() => ({
  createSessionWithoutSwitch: vi.fn(),
  isNewChatDraftId: vi.fn(() => false),
  materializeNewChatDraft: vi.fn(),
  updateSessionWorkingDirectory: vi.fn(),
  chatSendMessage: vi.fn(async () => true),
}))

const platformMocks = vi.hoisted(() => ({
  capabilities: {
    localFileSystem: true,
    workspaceFileSystem: true,
  },
  showOpenDialog: vi.fn(),
  updateSessionWorkingDirectory: vi.fn(),
  goalGet: vi.fn(),
  goalSet: vi.fn(),
  getPluginCommands: vi.fn(),
  executePluginCommand: vi.fn(),
  onSessionEvent: vi.fn(() => vi.fn()),
}))

// 命令总线是 `session-command` RPC 域(结构债 P4c 第四批),不再是 platformApi 上的属性。
const sessionCommandMocks = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('@/platform/session-command-client', () => ({ sessionCommands: sessionCommandMocks }))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    createSessionWithoutSwitch: storeMocks.createSessionWithoutSwitch,
    isNewChatDraftId: storeMocks.isNewChatDraftId,
    materializeNewChatDraft: storeMocks.materializeNewChatDraft,
    updateSessionWorkingDirectory: storeMocks.updateSessionWorkingDirectory,
  }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    sendMessage: storeMocks.chatSendMessage,
  }),
}))

vi.mock('@/platform', () => ({
  platformApi: platformMocks,
}))

describe('renderer command registry', () => {
  beforeEach(() => {
    storeMocks.createSessionWithoutSwitch.mockReset()
    storeMocks.isNewChatDraftId.mockReset()
    storeMocks.isNewChatDraftId.mockReturnValue(false)
    storeMocks.materializeNewChatDraft.mockReset()
    storeMocks.updateSessionWorkingDirectory.mockReset()
    storeMocks.chatSendMessage.mockReset()
    platformMocks.capabilities.localFileSystem = true
    platformMocks.capabilities.workspaceFileSystem = true
    platformMocks.showOpenDialog.mockReset()
    platformMocks.updateSessionWorkingDirectory.mockReset()
    platformMocks.goalGet.mockReset()
    platformMocks.goalSet.mockReset()
    platformMocks.getPluginCommands.mockReset()
    platformMocks.executePluginCommand.mockReset()
    sessionCommandMocks.emit.mockReset()
    platformMocks.onSessionEvent.mockReset()
    platformMocks.onSessionEvent.mockImplementation(() => vi.fn())
  })

  it('registers /new for the command picker', () => {
    const command = findCommand('new')

    expect(command).toMatchObject({
      id: NEW_SESSION_SLASH_COMMAND.id,
      name: NEW_SESSION_SLASH_COMMAND.name,
      usage: NEW_SESSION_SLASH_COMMAND.usage,
      displayLabel: NEW_SESSION_SLASH_COMMAND.displayLabel,
      insertText: NEW_SESSION_SLASH_COMMAND.insertText,
    })
  })

  it('keeps renderer built-in commands in sync with the shared slash registry', () => {
    expect(getCommands().map(command => command.id)).toEqual(
      SHARED_SLASH_COMMANDS.map(command => command.id),
    )
  })

  it('creates a new session and returns the target for /new', async () => {
    storeMocks.createSessionWithoutSwitch.mockResolvedValue({
      id: 'session-new',
      name: 'New Chat',
    })

    const result = await executeCommand('new', {
      sessionId: 'session-1',
      args: '',
    })

    expect(result).toEqual({
      success: true,
      message: 'New session opened',
      switchToSessionId: 'session-new',
    })
    expect(storeMocks.createSessionWithoutSwitch).toHaveBeenCalledWith('New Chat')
  })

  it('rejects unexpected /new arguments', async () => {
    const result = await executeCommand('new', {
      sessionId: 'session-1',
      args: 'session',
    })

    expect(result).toEqual({ success: false, error: `Usage: ${NEW_SESSION_SLASH_COMMAND.usage}` })
    expect(storeMocks.createSessionWithoutSwitch).not.toHaveBeenCalled()
  })

  it('materializes a new-chat draft before creating a goal and switches to the real session', async () => {
    storeMocks.isNewChatDraftId.mockReturnValue(true)
    storeMocks.materializeNewChatDraft.mockResolvedValue({ id: 'session-real', name: 'New Chat' })
    platformMocks.goalSet.mockResolvedValue({ success: true, goal: { status: 'active' } })

    const result = await executeCommand('goal', {
      sessionId: 'draft:abc',
      args: 'ship the release',
    })

    expect(storeMocks.materializeNewChatDraft).toHaveBeenCalledWith('draft:abc')
    expect(platformMocks.goalSet).toHaveBeenCalledWith({
      sessionId: 'session-real',
      action: 'create',
      objective: 'ship the release',
    })
    expect(result).toEqual({
      success: true,
      message: 'Goal set',
      switchToSessionId: 'session-real',
    })
    // The declaration itself drives the first run as a goal-set message.
    expect(storeMocks.chatSendMessage).toHaveBeenCalledWith(
      'session-real',
      'ship the release',
      undefined,
      { source: 'goal-set' },
    )
  })

  it('creates goals directly on materialized sessions without switching', async () => {
    platformMocks.goalSet.mockResolvedValue({ success: true, goal: { status: 'active' } })

    const result = await executeCommand('goal', {
      sessionId: 'session-1',
      args: 'ship the release',
    })

    expect(storeMocks.materializeNewChatDraft).not.toHaveBeenCalled()
    expect(platformMocks.goalSet).toHaveBeenCalledWith({
      sessionId: 'session-1',
      action: 'create',
      objective: 'ship the release',
    })
    expect(result).toEqual({
      success: true,
      message: 'Goal set',
      switchToSessionId: undefined,
    })
    expect(storeMocks.chatSendMessage).toHaveBeenCalledWith(
      'session-1',
      'ship the release',
      undefined,
      { source: 'goal-set' },
    )
  })

  it('treats objectives starting with reserved words as objectives, not subcommands', async () => {
    platformMocks.goalSet.mockResolvedValue({ success: true, goal: { status: 'active' } })

    const result = await executeCommand('goal', {
      sessionId: 'session-1',
      args: 'clear the sprint backlog',
    })

    expect(platformMocks.goalSet).toHaveBeenCalledWith({
      sessionId: 'session-1',
      action: 'create',
      objective: 'clear the sprint backlog',
    })
    expect(result.success).toBe(true)
    expect(result.message).toBe('Goal set')
    expect(storeMocks.chatSendMessage).toHaveBeenCalledWith(
      'session-1',
      'clear the sprint backlog',
      undefined,
      { source: 'goal-set' },
    )
  })

  it('still clears the goal on the exact clear subcommand', async () => {
    platformMocks.goalSet.mockResolvedValue({ success: true, goal: null })

    const result = await executeCommand('goal', {
      sessionId: 'session-1',
      args: 'clear',
    })

    expect(platformMocks.goalSet).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'clear' })
    expect(result).toEqual({ success: true, message: 'Goal cleared' })
  })

  it('short-circuits goal reads and updates on a new-chat draft', async () => {
    storeMocks.isNewChatDraftId.mockReturnValue(true)

    const read = await executeCommand('goal', { sessionId: 'draft:abc', args: '' })
    const resume = await executeCommand('goal', { sessionId: 'draft:abc', args: 'resume' })

    expect(read.success).toBe(true)
    expect(read.message).toContain('No goal is set')
    expect(resume).toEqual({ success: false, error: 'No goal is set for this session' })
    expect(platformMocks.goalGet).not.toHaveBeenCalled()
    expect(platformMocks.goalSet).not.toHaveBeenCalled()
    expect(storeMocks.materializeNewChatDraft).not.toHaveBeenCalled()
  })

  // P3(docs/design/context-compact-fix-2026-08.md §4):草稿会话上 /compact 从前
  // 会把命令发给一个引擎从没见过的 sessionId,回来一句 "Session not found"。
  it('short-circuits /compact on a new-chat draft', async () => {
    storeMocks.isNewChatDraftId.mockReturnValue(true)

    const result = await executeCommand('compact', { sessionId: 'draft:abc', args: '' })

    expect(result).toEqual({ success: true, message: 'Nothing to compact yet' })
    expect(sessionCommandMocks.emit).not.toHaveBeenCalled()
    expect(storeMocks.materializeNewChatDraft).not.toHaveBeenCalled()
  })

  it('does not open a native directory picker for /cd without args on web hosts', async () => {
    platformMocks.capabilities.localFileSystem = false

    const result = await executeCommand('cd', {
      sessionId: 'session-1',
      args: '',
    })

    expect(result).toEqual({
      success: false,
      error: `Usage: ${CHANGE_DIRECTORY_SLASH_COMMAND.usage}`,
    })
    expect(platformMocks.showOpenDialog).not.toHaveBeenCalled()
    expect(platformMocks.updateSessionWorkingDirectory).not.toHaveBeenCalled()
  })

  it('uses the native directory picker for /cd without args on desktop hosts', async () => {
    platformMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/workspace/project'],
    })
    storeMocks.updateSessionWorkingDirectory.mockResolvedValue({ success: true })

    const result = await executeCommand('cd', {
      sessionId: 'session-1',
      args: '',
    })

    expect(result).toEqual({
      success: true,
      message: 'Working directory set to /workspace/project',
    })
    expect(platformMocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory'],
      title: 'Select Working Directory',
    })
    // Must go through the sessions store (draft-aware), never raw IPC.
    expect(storeMocks.updateSessionWorkingDirectory).toHaveBeenCalledWith('session-1', '/workspace/project')
    expect(platformMocks.updateSessionWorkingDirectory).not.toHaveBeenCalled()
  })

  it('buffers /cd on a new-chat draft through the sessions store', async () => {
    storeMocks.isNewChatDraftId.mockReturnValue(true)
    storeMocks.updateSessionWorkingDirectory.mockResolvedValue({ success: true })

    const result = await executeCommand('cd', {
      sessionId: 'draft:abc',
      args: '/workspace/project',
    })

    expect(result).toEqual({
      success: true,
      message: 'Working directory set to /workspace/project',
    })
    expect(storeMocks.updateSessionWorkingDirectory).toHaveBeenCalledWith('draft:abc', '/workspace/project')
    expect(platformMocks.updateSessionWorkingDirectory).not.toHaveBeenCalled()
  })

  // Keep this test last: it registers plugin commands in module state, and
  // the registry-sync test above asserts on built-in commands only.
  it('resolves a real session before running a plugin command from a draft', async () => {
    storeMocks.isNewChatDraftId.mockReturnValue(true)
    storeMocks.materializeNewChatDraft.mockResolvedValue({ id: 'session-real', name: 'New Chat' })
    platformMocks.getPluginCommands.mockResolvedValue({
      success: true,
      commands: [{ id: 'plugin-hello', name: '/hello', description: 'test plugin', usage: '/hello' }],
    })
    platformMocks.executePluginCommand.mockResolvedValue({ success: true, message: 'done' })

    const result = await executeCommand('plugin-hello', {
      sessionId: 'draft:abc',
      args: 'x',
    })

    expect(platformMocks.executePluginCommand).toHaveBeenCalledWith('/hello', 'x', 'session-real')
    expect(result).toEqual({ success: true, message: 'done', switchToSessionId: 'session-real' })
  })
})
