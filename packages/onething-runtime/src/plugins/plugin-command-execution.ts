import type {
  CorePluginCommandContext,
  CorePluginCommandDefinition,
} from '@onething/core/plugins'

import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingPluginCommandSessionLike {
  workingDirectory?: string
}

export type OnethingPluginCommandNotificationLevel = 'info' | 'warn' | 'error'

export interface OnethingPluginCommandExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface OnethingPluginCommandExecOptions {
  cwd?: string
}

export interface OnethingPluginCommandSteeringEvent {
  type: typeof SESSION_COMMAND_TYPES.INJECT_STEERING
  content: string
  source: string
}

export interface OnethingPluginCommandFollowUpEvent {
  type: typeof SESSION_COMMAND_TYPES.INJECT_FOLLOWUP
  content: string
  source: string
}

export interface OnethingPluginCommandNotificationEvent {
  type: 'plugin:notification'
  pluginId: string
  message: string
  level: OnethingPluginCommandNotificationLevel
}

export type OnethingPluginCommandSessionEvent =
  | OnethingPluginCommandSteeringEvent
  | OnethingPluginCommandFollowUpEvent

export interface ExecuteOnethingPluginCommandOptions<
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
  TSession extends OnethingPluginCommandSessionLike = OnethingPluginCommandSessionLike,
> {
  commandName: string
  args?: string
  sessionId: string
  getCommandHandler(commandName: string): MaybePromise<TCommand | undefined>
  getSession(sessionId: string): MaybePromise<TSession | undefined>
  emitSessionCommand(sessionId: string, event: OnethingPluginCommandSessionEvent): MaybePromise<unknown>
  emitGlobalEvent(event: OnethingPluginCommandNotificationEvent): MaybePromise<unknown>
  exec(
    command: string,
    args: string[],
    options: OnethingPluginCommandExecOptions,
  ): Promise<OnethingPluginCommandExecResult>
  onEmitError?(label: 'steer' | 'follow-up' | 'notification', error: unknown): void
}

export interface ExecuteOnethingPluginCommandResult {
  success: boolean
  message?: string
  error?: string
}

export function normalizeOnethingPluginCommandName(commandName: string): string {
  return commandName.startsWith('/') ? commandName : `/${commandName}`
}

export async function executeOnethingPluginCommand<
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
  TSession extends OnethingPluginCommandSessionLike,
>(
  options: ExecuteOnethingPluginCommandOptions<TCommand, TSession>,
): Promise<ExecuteOnethingPluginCommandResult> {
  const commandName = normalizeOnethingPluginCommandName(options.commandName)
  const command = await options.getCommandHandler(commandName)
  if (!command) {
    return { success: false, error: `Unknown plugin command: ${commandName}` }
  }

  const session = await options.getSession(options.sessionId)
  const cwd = session?.workingDirectory
  let lastNotification: string | undefined

  await command.handler(options.args || '', {
    sessionId: options.sessionId,
    cwd,
    steer(content) {
      emitSessionCommand(options, 'steer', options.sessionId, {
        type: SESSION_COMMAND_TYPES.INJECT_STEERING,
        content,
        source: `plugin-command:${commandName}`,
      })
    },
    followUp(content) {
      emitSessionCommand(options, 'follow-up', options.sessionId, {
        type: SESSION_COMMAND_TYPES.INJECT_FOLLOWUP,
        content,
        source: `plugin-command:${commandName}`,
      })
    },
    notify(message, level = 'info') {
      lastNotification = message
      emitGlobalEvent(options, {
        type: 'plugin:notification',
        pluginId: 'command',
        message,
        level,
      })
    },
    exec(commandToRun, args = []) {
      return options.exec(commandToRun, args, { cwd })
    },
  })

  return {
    success: true,
    message: lastNotification || `${commandName} completed`,
  }
}

function emitSessionCommand(
  options: Pick<ExecuteOnethingPluginCommandOptions, 'emitSessionCommand' | 'onEmitError'>,
  label: 'steer' | 'follow-up',
  sessionId: string,
  event: OnethingPluginCommandSessionEvent,
): void {
  try {
    void Promise.resolve(options.emitSessionCommand(sessionId, event))
      .catch(error => options.onEmitError?.(label, error))
  } catch (error) {
    options.onEmitError?.(label, error)
  }
}

function emitGlobalEvent(
  options: Pick<ExecuteOnethingPluginCommandOptions, 'emitGlobalEvent' | 'onEmitError'>,
  event: OnethingPluginCommandNotificationEvent,
): void {
  try {
    void Promise.resolve(options.emitGlobalEvent(event))
      .catch(error => options.onEmitError?.('notification', error))
  } catch (error) {
    options.onEmitError?.('notification', error)
  }
}
