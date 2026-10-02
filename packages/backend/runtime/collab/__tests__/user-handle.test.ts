/**
 * 用户句柄的归一(docs/design/agent-dm-user.md §2.1)。
 *
 * 规则住产品层是因为**两侧都要用它**:设置页在 blur 时清洗输入,app 层在解析
 * dm 目标时清洗存量。两份实现的下场是设置页显示的句柄与 dm 认的句柄不是同一个。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_USER_DEFAULT_HANDLE,
  COLLAB_USER_HANDLE_MAX_CHARS,
  normalizeCollabUserHandle,
} from '../user-handle.js'

describe('normalizeCollabUserHandle', () => {
  it('小写化', () => {
    expect(normalizeCollabUserHandle('YiTian')).toBe('yitian')
  })

  it('只留 [a-z0-9_-]', () => {
    expect(normalizeCollabUserHandle('Yi Tian!@#')).toBe('yitian')
    expect(normalizeCollabUserHandle('yi_tian-01')).toBe('yi_tian-01')
  })

  it('截到上限', () => {
    expect(normalizeCollabUserHandle('x'.repeat(99)))
      .toHaveLength(COLLAB_USER_HANDLE_MAX_CHARS)
  })

  it('清洗到空 / 空输入一律落回 user —— 那一档永远可达', () => {
    expect(normalizeCollabUserHandle('一天')).toBe(COLLAB_USER_DEFAULT_HANDLE)
    expect(normalizeCollabUserHandle('   ')).toBe(COLLAB_USER_DEFAULT_HANDLE)
    expect(normalizeCollabUserHandle(undefined)).toBe(COLLAB_USER_DEFAULT_HANDLE)
    expect(normalizeCollabUserHandle(null)).toBe(COLLAB_USER_DEFAULT_HANDLE)
  })
})
