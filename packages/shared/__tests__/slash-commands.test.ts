import { describe, expect, it } from 'vitest'
import {
  CHANGE_DIRECTORY_SLASH_COMMAND,
  COMPACT_CONTEXT_SLASH_COMMAND,
  NEW_SESSION_SLASH_COMMAND,
  SHARED_SLASH_COMMANDS,
  findSharedSlashCommand,
  parseSharedSlashCommand,
} from '../slash-commands.js'

describe('shared slash commands', () => {
  it('defines the canonical built-in slash command set', () => {
    expect(SHARED_SLASH_COMMANDS.map(command => command.id)).toEqual([
      'new',
      'cd',
      'compact',
      'goal',
      'kegel',
      'pomodoro',
      'practice-stop',
    ])
    expect(findSharedSlashCommand('NEW')).toEqual(NEW_SESSION_SLASH_COMMAND)
    expect(NEW_SESSION_SLASH_COMMAND).toMatchObject({
      id: 'new',
      usage: '/new',
      displayLabel: '/new',
      insertText: '/new ',
    })
  })

  it('parses ASCII and full-width /new without arguments', () => {
    expect(parseSharedSlashCommand('/new')).toEqual({
      type: 'command',
      value: {
        command: NEW_SESSION_SLASH_COMMAND,
        args: [],
        rawArgs: '',
      },
    })
    expect(parseSharedSlashCommand('／new')).toEqual({
      type: 'command',
      value: {
        command: NEW_SESSION_SLASH_COMMAND,
        args: [],
        rawArgs: '',
      },
    })
  })

  it('rejects /new arguments with the canonical usage', () => {
    expect(parseSharedSlashCommand('/new session')).toEqual({
      type: 'invalid',
      value: {
        command: NEW_SESSION_SLASH_COMMAND,
        args: ['session'],
        rawArgs: 'session',
        usage: '/new',
      },
    })
  })

  it('parses /cd arguments as a command payload', () => {
    expect(parseSharedSlashCommand('/cd ~/work project')).toEqual({
      type: 'command',
      value: {
        command: CHANGE_DIRECTORY_SLASH_COMMAND,
        args: ['~/work', 'project'],
        rawArgs: '~/work project',
      },
    })
  })

  it('rejects unexpected /compact arguments with the canonical usage', () => {
    expect(parseSharedSlashCommand('/compact now')).toEqual({
      type: 'invalid',
      value: {
        command: COMPACT_CONTEXT_SLASH_COMMAND,
        args: ['now'],
        rawArgs: 'now',
        usage: '/compact',
      },
    })
  })
})
