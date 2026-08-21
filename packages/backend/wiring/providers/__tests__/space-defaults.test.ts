/**
 * 装配层的注入函数:「这条会话所在空间的默认选择」(批 B9;C2 换源)。
 *
 * C2 起源头是 `workspaces/<id>/providers.json` 的 `provider` +
 * `providers[provider].model`(overlay 的 `defaultSelection` 已并进去)。
 * 两态:这个空间没表达过 = `undefined`(解析链落到「没有默认」那支);
 * 表达过就把那一对递出去。**default 不是特例**。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { workspaceId?: string }>(),
}))

vi.mock('../../../stores/sessions.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/runtime/spaces/types')
  return {
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  resetSpaceProviderSettingsCacheForTests,
  writeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { resolveSessionSpaceDefaultSelection } from '../space-defaults.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-space-defaults-'))
  setRootDirForTests(tmpDir)
  resetSpaceProviderSettingsCacheForTests()
  mocks.sessions.clear()
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceProviderSettingsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolveSessionSpaceDefaultSelection(批 B9;C2 换源)', () => {
  it('C2:default 空间读的是它自己的 providers.json —— 与别的空间同一条路', () => {
    writeSpaceProviderSettings('default', {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5' } },
      customProviders: [],
    })
    mocks.sessions.set('s-default', { workspaceId: 'default' })
    const expected = { provider: 'zhipu', model: 'glm-5' }
    expect(resolveSessionSpaceDefaultSelection('s-default')).toEqual(expected)
    // 缺 workspaceId 的老会话同样落 default(读取端缺省,零迁移)。
    mocks.sessions.set('s-legacy', {})
    expect(resolveSessionSpaceDefaultSelection('s-legacy')).toEqual(expected)
    expect(resolveSessionSpaceDefaultSelection(undefined)).toEqual(expected)
  })

  it('default 空间没表达过 → undefined(全新安装:还没有默认可言)', () => {
    mocks.sessions.set('s-default', { workspaceId: 'default' })
    expect(resolveSessionSpaceDefaultSelection('s-default')).toBeUndefined()
  })

  it('非 default 空间没表达过 → undefined(解析链自己落全局)', () => {
    writeSpaceProviderSettings('work', { provider: '', providers: {}, customProviders: [] })
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    expect(resolveSessionSpaceDefaultSelection('s-work')).toBeUndefined()
  })

  it('非 default 空间表达过 → 把那一对递出去', () => {
    writeSpaceProviderSettings('work', {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5' } },
      customProviders: [],
    })
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    expect(resolveSessionSpaceDefaultSelection('s-work')).toEqual({
      provider: 'zhipu',
      model: 'glm-5',
    })
  })

  it('两个空间互不牵动', () => {
    writeSpaceProviderSettings('work', {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5' } },
      customProviders: [],
    })
    writeSpaceProviderSettings('study', {
      provider: 'deepseek',
      providers: {},
      customProviders: [],
    })
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    mocks.sessions.set('s-study', { workspaceId: 'study' })
    expect(resolveSessionSpaceDefaultSelection('s-work')).toEqual({
      provider: 'zhipu',
      model: 'glm-5',
    })
    expect(resolveSessionSpaceDefaultSelection('s-study')).toEqual({ provider: 'deepseek' })
  })
})
