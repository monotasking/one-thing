import { platformApi } from '@/platform'
import { pluginsApi } from '@/platform/plugins-client'
import { sessionCommands } from '@/platform/session-command-client'
/**
 * Command Registry
 * Manages available commands for the "/" command system
 */

import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import type { CommandDefinition, CommandResult } from '@/types/commands'
import {
  CHANGE_DIRECTORY_SLASH_COMMAND,
  COMPACT_CONTEXT_SLASH_COMMAND,
  GOAL_SLASH_COMMAND,
  KEGEL_SLASH_COMMAND,
  NEW_SESSION_SLASH_COMMAND,
  POMODORO_SLASH_COMMAND,
  PRACTICE_STOP_SLASH_COMMAND,
} from '@onething/core/slash-commands'
import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'

/**
 * All registered commands
 */
const commands: CommandDefinition[] = [
  {
    id: NEW_SESSION_SLASH_COMMAND.id,
    name: NEW_SESSION_SLASH_COMMAND.name,
    description: NEW_SESSION_SLASH_COMMAND.description,
    usage: NEW_SESSION_SLASH_COMMAND.usage,
    displayLabel: NEW_SESSION_SLASH_COMMAND.displayLabel,
    insertText: NEW_SESSION_SLASH_COMMAND.insertText,
    async execute(context) {
      if (context.rawArgs.trim()) {
        return { success: false, error: `Usage: ${NEW_SESSION_SLASH_COMMAND.usage}` }
      }

      const sessionsStore = useSessionsStore()
      const session = await sessionsStore.createSessionWithoutSwitch('New Chat')
      if (!session) {
        return { success: false, error: 'Failed to create new session' }
      }
      return {
        success: true,
        message: 'New session opened',
        switchToSessionId: session.id,
      }
    },
  },
  {
    id: CHANGE_DIRECTORY_SLASH_COMMAND.id,
    name: CHANGE_DIRECTORY_SLASH_COMMAND.name,
    description: CHANGE_DIRECTORY_SLASH_COMMAND.description,
    usage: CHANGE_DIRECTORY_SLASH_COMMAND.usage,
    displayLabel: CHANGE_DIRECTORY_SLASH_COMMAND.displayLabel,
    insertText: CHANGE_DIRECTORY_SLASH_COMMAND.insertText,
    async execute(context) {
      let nextDirectory = context.rawArgs.trim()

      if (!nextDirectory) {
        if (!platformApi.capabilities.localFileSystem) {
          return {
            success: false,
            error: `Usage: ${CHANGE_DIRECTORY_SLASH_COMMAND.usage}`,
          }
        }

        const result = await platformApi.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Select Working Directory',
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'No directory selected' }
        }

        nextDirectory = result.filePaths[0]
      }

      // Go through the sessions store, not platformApi directly: on a
      // new-chat draft the store buffers the directory on the draft (applied
      // at materialization), while the raw IPC would silently no-op against
      // a session id the main process has never seen.
      const result = await useSessionsStore().updateSessionWorkingDirectory(
        context.sessionId,
        nextDirectory
      )

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to change directory' }
      }

      return { success: true, message: `Working directory set to ${nextDirectory}` }
    },
  },
  {
    id: COMPACT_CONTEXT_SLASH_COMMAND.id,
    name: COMPACT_CONTEXT_SLASH_COMMAND.name,
    description: COMPACT_CONTEXT_SLASH_COMMAND.description,
    usage: COMPACT_CONTEXT_SLASH_COMMAND.usage,
    displayLabel: COMPACT_CONTEXT_SLASH_COMMAND.displayLabel,
    insertText: COMPACT_CONTEXT_SLASH_COMMAND.insertText,
    consumesInputImmediately: true,
    async execute(context) {
      // On a new-chat draft the compact command would reach the engine with a
      // session id it has never seen and come back "Session not found".
      // Mirrors /goal's short-circuit.
      if (context.isDraftSession) {
        return { success: true, message: 'Nothing to compact yet' }
      }

      const requestId = globalThis.crypto?.randomUUID?.() || `compact-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const completion = waitForCompactCompletion(context.sessionId, requestId)

      const emitted = await sessionCommands.emit({
        sessionId: context.sessionId,
        command: {
          type: SESSION_COMMAND_TYPES.COMPACT_CONTEXT,
          requestId,
          manual: true,
        },
      })

      if (!emitted?.success) {
        completion.cancel()
        return { success: false, error: emitted?.error || 'Failed to start compact' }
      }

      const result = await completion.promise
      if (!result.success) {
        return { success: false, error: result.error || 'Compact failed' }
      }
      if (result.skipped) {
        return { success: true, message: result.error || 'Nothing to compact yet' }
      }
      return { success: true, message: 'Context compacted' }
    },
  },
  {
    id: GOAL_SLASH_COMMAND.id,
    name: GOAL_SLASH_COMMAND.name,
    description: GOAL_SLASH_COMMAND.description,
    usage: GOAL_SLASH_COMMAND.usage,
    displayLabel: GOAL_SLASH_COMMAND.displayLabel,
    insertText: GOAL_SLASH_COMMAND.insertText,
    async execute(context) {
      const rawArgs = context.rawArgs.trim()
      let sessionId = context.sessionId

      // On a new-chat draft the goal RPCs would fail with "Session not
      // found". Reads and updates short-circuit; creating a goal resolves a
      // real session first (mirroring the regular send path).
      const isDraft = context.isDraftSession

      if (!rawArgs) {
        if (isDraft) {
          return { success: true, message: `No goal is set. ${GOAL_SLASH_COMMAND.usage}` }
        }
        const result = await platformApi.goalGet(sessionId)
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to read goal' }
        }
        if (!result.goal) {
          return { success: true, message: `No goal is set. ${GOAL_SLASH_COMMAND.usage}` }
        }
        const goal = result.goal
        const budget = goal.tokenBudget ? `${goal.tokenBudget}` : 'unlimited'
        return {
          success: true,
          message: `Goal [${goal.status}] ${goal.objective} — ${goal.tokensUsed} tokens used (budget ${budget}), ${goal.continuationCount} auto-continuations`,
        }
      }

      const [keyword, ...rest] = rawArgs.split(/\s+/)
      const lowered = keyword.toLowerCase()
      // Reserved words act as subcommands only in their exact shape —
      // "/goal clear the backlog" is an objective, not a destructive clear.
      const isPause = lowered === 'pause' && rest.length === 0
      const isResume = lowered === 'resume' && rest.length === 0
      const isClear = lowered === 'clear' && rest.length === 0
      const isBudget = lowered === 'budget' && rest.length <= 1

      if (isDraft && (isPause || isResume || isBudget)) {
        return { success: false, error: 'No goal is set for this session' }
      }
      if (isDraft && isClear) {
        return { success: true, message: 'No goal is set' }
      }

      if (isPause || isResume) {
        const result = await platformApi.goalSet({
          sessionId,
          action: 'update',
          status: isPause ? 'paused' : 'active',
        })
        if (!result.success) return { success: false, error: result.error || 'Failed to update goal' }
        // Resuming does not reset tokensUsed: without budget headroom the
        // goal re-limits on the next turn, so warn instead of looking stuck.
        const resumed = result.goal
        const exhausted = isResume
          && resumed?.tokenBudget !== undefined
          && resumed.tokensUsed >= resumed.tokenBudget
        return {
          success: true,
          message: isPause
            ? 'Goal paused'
            : exhausted
              ? 'Goal resumed — token budget is already spent; raise it with /goal budget <tokens> or it will pause again immediately'
              : 'Goal resumed',
        }
      }

      if (isClear) {
        const result = await platformApi.goalSet({ sessionId, action: 'clear' })
        if (!result.success) return { success: false, error: result.error || 'Failed to clear goal' }
        return { success: true, message: 'Goal cleared' }
      }

      if (isBudget) {
        const value = rest[0]
        // Strict integer only: parseInt would silently truncate "500k" to 500.
        const parsed = value === 'off' ? null : value && /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN
        if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
          return { success: false, error: 'Usage: /goal budget <tokens> (or "off" to remove the cap)' }
        }
        const result = await platformApi.goalSet({
          sessionId,
          action: 'update',
          tokenBudget: parsed,
        })
        if (!result.success) return { success: false, error: result.error || 'Failed to set budget' }
        // A raised budget alone does not un-park a budget-limited goal;
        // point at the missing resume step instead of appearing to hang.
        const hint = result.goal?.status === 'budget_limited' ? ' — run /goal resume to continue' : ''
        return {
          success: true,
          message: (parsed === null ? 'Goal budget removed — no token cap' : `Goal budget set to ${parsed} tokens`) + hint,
        }
      }

      const resolvedSessionId = await context.requireSession()
      if (!resolvedSessionId) {
        return { success: false, error: 'Failed to create a session for the goal' }
      }
      sessionId = resolvedSessionId

      const result = await platformApi.goalSet({
        sessionId,
        action: 'create',
        objective: rawArgs,
      })
      if (!result.success) return { success: false, error: result.error || 'Failed to set goal' }

      // The goal declaration itself is the first drive: a visible user
      // message marked 'goal-set' (rendered as the GOAL frame in chat).
      // Main no longer emits a synthetic kick on create.
      void useChatStore().sendMessage(sessionId, rawArgs, undefined, { source: 'goal-set' })
      return { success: true, message: 'Goal set' }
    },
  },
  {
    id: KEGEL_SLASH_COMMAND.id,
    name: KEGEL_SLASH_COMMAND.name,
    description: KEGEL_SLASH_COMMAND.description,
    usage: KEGEL_SLASH_COMMAND.usage,
    displayLabel: KEGEL_SLASH_COMMAND.displayLabel,
    insertText: KEGEL_SLASH_COMMAND.insertText,
    async execute() {
      const { usePracticeStore } = await import('@/stores/practice')
      const store = usePracticeStore()
      await store.init()
      await store.startKegel()
      return { success: true, message: '凯格尔开始 · 跟着音效走' }
    },
  },
  {
    id: POMODORO_SLASH_COMMAND.id,
    name: POMODORO_SLASH_COMMAND.name,
    description: POMODORO_SLASH_COMMAND.description,
    usage: POMODORO_SLASH_COMMAND.usage,
    displayLabel: POMODORO_SLASH_COMMAND.displayLabel,
    insertText: POMODORO_SLASH_COMMAND.insertText,
    async execute(context) {
      const { usePracticeStore } = await import('@/stores/practice')
      const store = usePracticeStore()
      await store.init()
      const categories = store.config?.pomodoro.categories ?? []
      const requested = context.rawArgs.trim()
      const category = requested || categories[0]
      if (!category) return { success: false, error: '还没有可用的番茄分类' }
      await store.startPomodoro(category)
      return { success: true, message: `番茄开始 · ${category}` }
    },
  },
  {
    id: PRACTICE_STOP_SLASH_COMMAND.id,
    name: PRACTICE_STOP_SLASH_COMMAND.name,
    description: PRACTICE_STOP_SLASH_COMMAND.description,
    usage: PRACTICE_STOP_SLASH_COMMAND.usage,
    displayLabel: PRACTICE_STOP_SLASH_COMMAND.displayLabel,
    insertText: PRACTICE_STOP_SLASH_COMMAND.insertText,
    async execute() {
      const { usePracticeStore } = await import('@/stores/practice')
      const store = usePracticeStore()
      await store.init()
      if (!store.isRunning) return { success: false, error: '当前没有进行中的练习' }
      await store.stop()
      return { success: true, message: '已结束并记账' }
    },
  },
]

let pluginCommands: CommandDefinition[] = []
let pluginCommandsPromise: Promise<CommandDefinition[]> | null = null

export async function refreshPluginCommands(): Promise<CommandDefinition[]> {
  if (pluginCommandsPromise) return pluginCommandsPromise

  pluginCommandsPromise = (async () => {
    try {
      const result = await pluginsApi.getPluginCommands()
      if (!result.success) {
        pluginCommands = []
        return pluginCommands
      }
      pluginCommands = (result.commands || []).map(command => ({
        id: command.id,
        name: command.name.replace(/^\//, '') || command.id,
        description: command.description,
        usage: command.usage,
        async execute(context) {
          // Plugin commands run in the main process; a draft id would point
          // at a session that does not exist there.
          const sessionId = await context.requireSession()
          if (!sessionId) {
            return { success: false, error: `${command.name} needs a session` }
          }
          const response = await pluginsApi.executePluginCommand(
            command.name,
            context.rawArgs,
            sessionId,
          )
          if (!response.success) {
            return { success: false, error: response.error || `${command.name} failed` }
          }
          return { success: true, message: response.message || `${command.name} completed` }
        },
      }))
      return pluginCommands
    } catch {
      pluginCommands = []
      return pluginCommands
    } finally {
      pluginCommandsPromise = null
    }
  })()

  return pluginCommandsPromise
}

/** 只防传输死亡,不是压缩的时限 —— 时限在后端(见 core 的压缩超时常量)。 */
const COMPACT_TRANSPORT_FALLBACK_MS = 10 * 60 * 1000

function waitForCompactCompletion(sessionId: string, requestId: string): {
  promise: Promise<{ success: boolean; skipped?: boolean; error?: string }>
  cancel: () => void
} {
  let cleanup: (() => void) | undefined
  let timeout: number | undefined

  const promise = new Promise<{ success: boolean; skipped?: boolean; error?: string }>((resolve) => {
    const finish = (result: { success: boolean; skipped?: boolean; error?: string }) => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      cleanup?.()
      resolve(result)
    }

    // P3(2026-08-14):压缩的生死时限归后端(per-chunk AbortSignal 超时)。
    // 前端从前那个 120s 墙钟让长会话必然假超时 —— 先报失败,几十秒后卡片又
    // 变成功。这里剩下的只是「传输死了」的兜底,所以给足 10 分钟,而且文案不
    // 说失败:压缩很可能还在跑,结果会落在会话内的卡片上。
    timeout = window.setTimeout(() => {
      finish({ success: true, skipped: true, error: 'Still compacting — check the card in the conversation for the result' })
    }, COMPACT_TRANSPORT_FALLBACK_MS)

    cleanup = platformApi.onSessionEvent((envelope: any) => {
      if (envelope.sessionId !== sessionId) return
      const event = envelope.event
      if (event?.type !== SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED) return
      if (event.requestId !== requestId) return

      finish({
        success: event.success,
        skipped: event.skipped,
        error: event.error,
      })
    })
  })

  return {
    promise,
    cancel: () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      cleanup?.()
    },
  }
}

/**
 * Get all available commands
 */
export function getCommands(): CommandDefinition[] {
  const merged = new Map<string, CommandDefinition>()
  for (const command of commands) merged.set(command.id, command)
  for (const command of pluginCommands) {
    if (!merged.has(command.id)) merged.set(command.id, command)
  }
  return Array.from(merged.values())
}

/**
 * Find a command by its ID (exact match)
 */
export function findCommand(id: string): CommandDefinition | undefined {
  const normalized = id.toLowerCase()
  return getCommands().find((cmd) => cmd.id === normalized)
}

/**
 * Filter commands by query (fuzzy match on id, name, or description)
 */
export function filterCommands(query: string): CommandDefinition[] {
  const normalized = query.toLowerCase().replace(/^\//, '')

  if (!normalized) {
    return getCommands()
  }

  return getCommands().filter(
    (cmd) =>
      cmd.id.includes(normalized) ||
      cmd.name.toLowerCase().includes(normalized) ||
      cmd.description.toLowerCase().includes(normalized)
  )
}

/**
 * Execute a command by its ID.
 *
 * This is the single dispatch point for slash commands, and the place where
 * the session identity is resolved: a new chat is a renderer-local draft
 * whose id the main process has never seen, so the context hands commands a
 * `requireSession()` resolver instead of trusting `sessionId` blindly.
 * Commands that persist per-session state through IPC must resolve first;
 * commands that never call it stay side-effect-free on drafts.
 */
export async function executeCommand(
  id: string,
  context: { sessionId: string; args?: string }
): Promise<CommandResult> {
  let command = findCommand(id)
  if (!command) {
    await refreshPluginCommands()
    command = findCommand(id)
  }
  if (!command) {
    return { success: false, error: `Unknown command: ${id}` }
  }

  // Convert args string to array
  const argsArray = context.args ? context.args.trim().split(/\s+/) : []

  const sessionsStore = useSessionsStore()
  const isDraftSession = sessionsStore.isNewChatDraftId(context.sessionId)
  let materializedSessionId: string | undefined

  const requireSession = async (): Promise<string | null> => {
    if (!isDraftSession) return context.sessionId
    if (materializedSessionId) return materializedSessionId
    const materialized = await sessionsStore.materializeNewChatDraft(context.sessionId)
    if (!materialized) return null
    materializedSessionId = materialized.id
    return materialized.id
  }

  const result = await command.execute({
    sessionId: context.sessionId,
    isDraftSession,
    requireSession,
    args: argsArray,
    rawArgs: context.args || '',
  })

  // The draft was materialized into a real session mid-command: make the
  // invoking UI follow it, unless the command already picked a target.
  if (result.success && materializedSessionId && !result.switchToSessionId) {
    return { ...result, switchToSessionId: materializedSessionId }
  }
  return result
}
