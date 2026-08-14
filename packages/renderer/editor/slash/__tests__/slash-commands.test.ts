import { describe, expect, it } from 'vitest'
import { SLASH_COMMANDS, filterSlashCommands, slashQueryBefore } from '../slash-commands'

describe('斜杠菜单 · 过滤', () => {
  it('空词给全清单', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length)
    expect(filterSlashCommands('   ')).toHaveLength(SLASH_COMMANDS.length)
  })

  it('前缀命中排在包含命中前面', () => {
    const ids = filterSlashCommands('h').map(item => item.id)

    // `h1/h2/h3` 是前缀命中,必须压过任何"词里含 h"的条目。
    expect(ids.slice(0, 3)).toEqual(['heading-1', 'heading-2', 'heading-3'])
  })

  it('中英两套词都认', () => {
    expect(filterSlashCommands('代码').map(item => item.id)).toEqual(['code-block'])
    expect(filterSlashCommands('code').map(item => item.id)).toEqual(['code-block'])
    expect(filterSlashCommands('todo').map(item => item.id)).toEqual(['task-list'])
    expect(filterSlashCommands('勾选').map(item => item.id)).toEqual(['task-list'])
  })

  it('大小写不敏感', () => {
    expect(filterSlashCommands('HR').map(item => item.id)).toEqual(['horizontal-rule'])
  })

  it('一条都不中就返回空数组(调用方据此收起菜单)', () => {
    expect(filterSlashCommands('zzzz')).toEqual([])
  })
})

describe('斜杠菜单 · 触发词识别', () => {
  it('行首的 / 触发', () => {
    expect(slashQueryBefore('/')).toBe('')
    expect(slashQueryBefore('/head')).toBe('head')
  })

  it('空白之后的 / 也触发', () => {
    expect(slashQueryBefore('先写一句 /引')).toBe('引')
  })

  it('贴在字后面的 / 不是命令', () => {
    expect(slashQueryBefore('a/b')).toBeNull()
    expect(slashQueryBefore('https://x')).toBeNull()
  })

  it('打了空格就退场 —— 那是在写正文', () => {
    expect(slashQueryBefore('/head ')).toBeNull()
    expect(slashQueryBefore('/引用 一段')).toBeNull()
  })

  it('没有 / 就没有菜单', () => {
    expect(slashQueryBefore('')).toBeNull()
    expect(slashQueryBefore('随手写一句')).toBeNull()
  })
})
