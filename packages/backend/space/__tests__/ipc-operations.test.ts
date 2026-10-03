import { describe, expect, it, vi } from 'vitest'
import {
  clearOnethingSpaceCredentialForIpc,
  createOnethingSpaceForIpc,
  getOnethingSpaceCredentialsForIpc,
  getOnethingSpaceOverlayForIpc,
  importOnethingSpaceCredentialsForIpc,
  listOnethingSpacesForIpc,
  removeOnethingSpaceForIpc,
  setOnethingSpaceCredentialForIpc,
  setOnethingSpaceOverlayForIpc,
  updateOnethingSpaceForIpc,
} from '../ipc-operations.js'
import type { Space } from '../types.js'

const defaultSpace: Space = { id: 'default', name: '默认空间', createdAt: 1 }
const workSpace: Space = { id: 'work', name: '工作', color: '#123456', createdAt: 2 }

describe('spaces IPC operations', () => {
  it('lists spaces as flat records', () => {
    expect(listOnethingSpacesForIpc({ listSpaces: () => [defaultSpace, workSpace] })).toEqual({
      success: true,
      spaces: [
        { id: 'default', name: '默认空间', createdAt: 1 },
        { id: 'work', name: '工作', color: '#123456', createdAt: 2 },
      ],
    })
  })

  it('turns a thrown store error into a structured failure', () => {
    const result = listOnethingSpacesForIpc({
      listSpaces: () => {
        throw new Error('disk on fire')
      },
    })
    expect(result).toEqual({ success: false, error: 'disk on fire', code: 'INTERNAL' })
  })

  it('creates and updates, and reports a missing space as NOT_FOUND', () => {
    expect(
      createOnethingSpaceForIpc({
        request: { name: '工作' },
        createSpace: input => ({ id: 'work', name: input.name, createdAt: 5 }),
      }),
    ).toEqual({ success: true, space: { id: 'work', name: '工作', createdAt: 5 } })

    const updateSpace = vi.fn(
      (id: string, patch: { name?: string }) =>
        (id === 'work' ? { ...workSpace, name: patch.name ?? workSpace.name } : null),
    )
    expect(
      updateOnethingSpaceForIpc({ request: { id: 'work', name: '工作台' }, updateSpace }),
    ).toMatchObject({ success: true, space: { name: '工作台' } })
    // id 不该混进 patch —— 它是定位用的,不是可改字段。
    expect(updateSpace).toHaveBeenCalledWith('work', { name: '工作台' })

    expect(
      updateOnethingSpaceForIpc({ request: { id: 'ghost', name: 'x' }, updateSpace }),
    ).toEqual({ success: false, error: 'No space "ghost"', code: 'NOT_FOUND' })
  })

  it('maps each removal refusal onto its own code and counts sessions first', () => {
    const countSessions = vi.fn(() => 2)
    const removeSpace = vi.fn(() => ({ removed: false, reason: 'not-empty' as const }))
    const notEmpty = removeOnethingSpaceForIpc({
      request: { id: 'work' },
      countSessions,
      removeSpace,
    })
    expect(countSessions).toHaveBeenCalledWith('work')
    expect(removeSpace).toHaveBeenCalledWith('work', { sessionCount: 2 })
    expect(notEmpty).toEqual({
      success: false,
      error: '空间里还有 2 条会话,先清空再删',
      code: 'NOT_EMPTY',
    })

    expect(
      removeOnethingSpaceForIpc({
        request: { id: 'default' },
        countSessions: () => 0,
        removeSpace: () => ({ removed: false, reason: 'default' }),
      }),
    ).toMatchObject({ success: false, code: 'DEFAULT_SPACE' })

    expect(
      removeOnethingSpaceForIpc({
        request: { id: 'ghost' },
        countSessions: () => 0,
        removeSpace: () => ({ removed: false, reason: 'not-found' }),
      }),
    ).toMatchObject({ success: false, code: 'NOT_FOUND' })

    expect(
      removeOnethingSpaceForIpc({
        request: { id: 'scratch' },
        countSessions: () => 0,
        removeSpace: () => ({ removed: true }),
      }),
    ).toEqual({ success: true, removed: true })
  })

  it('reads and writes an overlay only for a registered space', () => {
    const readOverlay = vi.fn(() => ({ connectedDirectories: ['/vault'] }))
    expect(
      getOnethingSpaceOverlayForIpc({
        request: { id: 'work' },
        hasSpace: id => id === 'work',
        readOverlay,
      }),
    ).toEqual({ success: true, overlay: { connectedDirectories: ['/vault'] } })

    // 未登记的 id 不该在 workspaces/ 下长出一个没有主人的目录。
    const writeOverlay = vi.fn((_id: string, overlay: { connectedDirectories?: string[] }) => overlay)
    expect(
      setOnethingSpaceOverlayForIpc({
        request: { id: 'ghost', overlay: { connectedDirectories: ['/x'] } },
        hasSpace: () => false,
        writeOverlay,
      }),
    ).toEqual({ success: false, error: 'No space "ghost"', code: 'NOT_FOUND' })
    expect(writeOverlay).not.toHaveBeenCalled()

    expect(
      setOnethingSpaceOverlayForIpc({
        request: { id: 'work', overlay: { connectedDirectories: ['/x'] } },
        hasSpace: () => true,
        writeOverlay,
      }),
    ).toEqual({ success: true, overlay: { connectedDirectories: ['/x'] } })
  })
})

/**
 * 凭证池的四条通道(批 B3)。这里只验**守门规则** —— 存储与解析各有自己的测试。
 */
describe('spaces credential IPC operations', () => {
  const emptySummary = { providers: {} }

  it('reads credentials only for a registered space', () => {
    expect(
      getOnethingSpaceCredentialsForIpc({
        request: { id: 'ghost' },
        hasSpace: () => false,
        readCredentials: () => emptySummary,
      }),
    ).toEqual({ success: false, error: 'No space "ghost"', code: 'NOT_FOUND' })

    expect(
      getOnethingSpaceCredentialsForIpc({
        request: { id: 'work' },
        hasSpace: () => true,
        readCredentials: () => emptySummary,
      }),
    ).toEqual({ success: true, credentials: emptySummary })
  })

  // C1:default 也是普通空间,写它的池是**唯一**的编辑路径。C1 之前这里挡着它
  // (理由是「settings.ai IS its credential layer」),迁移之后那个理由没有了。
  it('writes the default space like any other — it is a normal space now', () => {
    const writeCredential = vi.fn(() => emptySummary)
    const result = setOnethingSpaceCredentialForIpc({
      request: { id: 'default', providerId: 'deepseek', apiKey: 'sk' },
      hasSpace: () => true,
      writeCredential,
    })
    expect(result).toMatchObject({ success: true })
    expect(writeCredential).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty key instead of silently storing a useless entry', () => {
    const writeCredential = vi.fn(() => emptySummary)
    expect(
      setOnethingSpaceCredentialForIpc({
        request: { id: 'work', providerId: 'deepseek', apiKey: '   ' },
        hasSpace: () => true,
        writeCredential,
      }),
    ).toMatchObject({ success: false, code: 'INVALID' })
    expect(writeCredential).not.toHaveBeenCalled()

    expect(
      setOnethingSpaceCredentialForIpc({
        request: { id: 'work', providerId: '  ', apiKey: 'sk' },
        hasSpace: () => true,
        writeCredential,
      }),
    ).toMatchObject({ success: false, code: 'INVALID' })
  })

  /**
   * 批 B10:改一条 entry 的**档位/地区**不该要求重新粘一次密钥 —— 渲染层根本
   * 拿不到密钥原文(B3 决策 8),逼它重填就是逼用户重打一遍。
   */
  it('带 entryId 而不带 key = 只改非密钥字段(档位/地区),放行', () => {
    const writeCredential = vi.fn(() => emptySummary)
    const result = setOnethingSpaceCredentialForIpc({
      request: { id: 'work', providerId: 'kimi', entryId: 'a', region: 'intl' },
      hasSpace: () => true,
      writeCredential,
    })
    expect(result).toMatchObject({ success: true })
    expect(writeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'a', region: 'intl' }),
    )
  })

  it('**追加**那一支仍然要求密钥:池里不该多出一行永远用不了的东西', () => {
    const writeCredential = vi.fn(() => emptySummary)
    expect(
      setOnethingSpaceCredentialForIpc({
        request: { id: 'work', providerId: 'kimi', region: 'intl' },
        hasSpace: () => true,
        writeCredential,
      }),
    ).toMatchObject({ success: false, code: 'INVALID' })
    expect(writeCredential).not.toHaveBeenCalled()
  })

  it('writes and clears for a normal space', () => {
    expect(
      setOnethingSpaceCredentialForIpc({
        request: { id: 'work', providerId: 'deepseek', apiKey: 'sk' },
        hasSpace: () => true,
        writeCredential: () => emptySummary,
      }),
    ).toEqual({ success: true, credentials: emptySummary })

    expect(
      clearOnethingSpaceCredentialForIpc({
        request: { id: 'work', providerId: 'deepseek' },
        hasSpace: () => true,
        clearCredential: () => emptySummary,
      }),
    ).toEqual({ success: true, credentials: emptySummary })
  })

  it('will not import the default space into itself', () => {
    const importCredentials = vi.fn(() => ({ imported: [], skipped: [], credentials: emptySummary }))
    expect(
      importOnethingSpaceCredentialsForIpc({
        request: { id: 'default' },
        hasSpace: () => true,
        isDefaultSpace: id => id === 'default',
        importCredentials,
      }),
    ).toMatchObject({ success: false, code: 'DEFAULT_SPACE' })
    expect(importCredentials).not.toHaveBeenCalled()
  })

  it('passes the import outcome through verbatim (skips included)', () => {
    expect(
      importOnethingSpaceCredentialsForIpc({
        request: { id: 'work' },
        hasSpace: () => true,
        isDefaultSpace: () => false,
        importCredentials: () => ({
          imported: ['deepseek'],
          skipped: [{ providerId: 'codex', reason: 'oauth' as const }],
          credentials: emptySummary,
        }),
      }),
    ).toEqual({
      success: true,
      imported: ['deepseek'],
      skipped: [{ providerId: 'codex', reason: 'oauth' }],
      credentials: emptySummary,
    })
  })
})
