export interface SharedSlashCommandDefinition {
  id: string
  name: string
  description: string
  usage: string
  displayLabel: string
  insertText: string
  allowArgs?: boolean
}

export interface ParsedSharedSlashCommand {
  command: SharedSlashCommandDefinition
  args: string[]
  rawArgs: string
}

export interface InvalidSharedSlashCommand {
  command: SharedSlashCommandDefinition
  args: string[]
  rawArgs: string
  usage: string
}

export type SharedSlashCommandParseResult =
  | { type: 'command'; value: ParsedSharedSlashCommand }
  | { type: 'invalid'; value: InvalidSharedSlashCommand }
  | { type: 'none' }

export const NEW_SESSION_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'new',
  name: 'New Session',
  description: 'Start a new chat session',
  usage: '/new',
  displayLabel: '/new',
  insertText: '/new ',
}

export const CHANGE_DIRECTORY_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'cd',
  name: 'Change Directory',
  description: 'Change the working directory for this session',
  usage: '/cd <path>',
  displayLabel: '/cd',
  insertText: '/cd ',
  allowArgs: true,
}

export const COMPACT_CONTEXT_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'compact',
  name: 'Compact Context',
  description: 'Summarize older conversation history to reduce context usage',
  usage: '/compact',
  displayLabel: '/compact',
  insertText: '/compact ',
}

export const GOAL_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'goal',
  name: 'Session Goal',
  description: 'Set or view a persistent goal the agent keeps working toward',
  usage: '/goal [<objective> | pause | resume | clear | budget <tokens>]',
  displayLabel: '/goal',
  insertText: '/goal ',
  allowArgs: true,
}

export const KEGEL_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'kegel',
  name: 'Kegel Practice',
  description: '开始一组凯格尔练习(按当前参数)',
  usage: '/kegel',
  displayLabel: '/kegel',
  insertText: '/kegel',
}

export const POMODORO_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'pomodoro',
  name: 'Pomodoro',
  description: '开始一轮番茄钟,参数为分类(默认第一个分类)',
  usage: '/pomodoro [分类]',
  displayLabel: '/pomodoro',
  insertText: '/pomodoro ',
  allowArgs: true,
}

export const PRACTICE_STOP_SLASH_COMMAND: SharedSlashCommandDefinition = {
  id: 'practice-stop',
  name: 'Stop Practice',
  description: '结束当前进行中的练习(凯格尔/番茄),中途结束也会记账',
  usage: '/practice-stop',
  displayLabel: '/practice-stop',
  insertText: '/practice-stop',
}

export const SHARED_SLASH_COMMANDS = [
  NEW_SESSION_SLASH_COMMAND,
  CHANGE_DIRECTORY_SLASH_COMMAND,
  COMPACT_CONTEXT_SLASH_COMMAND,
  GOAL_SLASH_COMMAND,
  KEGEL_SLASH_COMMAND,
  POMODORO_SLASH_COMMAND,
  PRACTICE_STOP_SLASH_COMMAND,
] as const satisfies readonly SharedSlashCommandDefinition[]

export function findSharedSlashCommand(id: string): SharedSlashCommandDefinition | undefined {
  const normalizedId = id.trim().toLowerCase()
  return SHARED_SLASH_COMMANDS.find(command => command.id === normalizedId)
}

export function parseSharedSlashCommand(text: string): SharedSlashCommandParseResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') && !trimmed.startsWith('／')) {
    return { type: 'none' }
  }

  const body = trimmed.slice(1).trim()
  if (!body) return { type: 'none' }

  const [commandToken = '', ...args] = body.split(/\s+/)
  const command = findSharedSlashCommand(commandToken)
  if (!command) return { type: 'none' }

  const commandEndIndex = body.search(/\s/)
  const rawArgs = commandEndIndex === -1 ? '' : body.slice(commandEndIndex).trim()
  if (!command.allowArgs && rawArgs) {
    return {
      type: 'invalid',
      value: {
        command,
        args,
        rawArgs,
        usage: command.usage,
      },
    }
  }

  return {
    type: 'command',
    value: {
      command,
      args,
      rawArgs,
    },
  }
}
