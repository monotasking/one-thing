import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionGrants } from '../PermissionGrants'
import {
  configurePermissionGrantsPort,
  type PermissionGrantsPort,
} from '../../../data/permission-grants-port'
import {
  groupGrantsByApp,
  permissionGrantsQuery,
  revokeGrantMutation,
  revokeAppGrantsMutation,
} from '../../../data/permission-grants-source'
import type { PermissionGrantProjection } from '@shared/ipc/permission-grants'
import { t } from '../../../i18n'

/**
 * 设置页「已授权」那一节(应用级许可 · 壳半边,2026-09-10)。
 *
 * 钉住三件事:
 *  ① **按 `app` 分组**,一个应用可能好几条(`scheme × 效果类`,a50d4f99 留账);
 *     `app` 缺席的不是一个叫「其他」的应用,是「单条许可」那一摞;
 *  ② 撤销**就地更新**(律①):那一行当场没了,不等重拉;
 *  ③ 整应用一键撤 = **逐条 revoke**(后端没有批量口)。
 */

const T0 = 1_700_000_000_000

const grant = (over: Partial<PermissionGrantProjection>): PermissionGrantProjection => ({
  id: 'g1',
  scope: 'workspace',
  type: 'session_destructive',
  pattern: 'session:*',
  createdAt: T0,
  updatedAt: T0,
  createdFrom: { messageId: 'a1', toolCallId: 'call-1', title: '删一条消息' },
  app: 'session',
  ...over,
})

interface Fake extends PermissionGrantsPort {
  revoked: string[]
  rows: PermissionGrantProjection[]
  listCalls: number
}

function fakePort(rows: PermissionGrantProjection[]): Fake {
  const fake: Fake = {
    revoked: [],
    rows,
    listCalls: 0,
    ready: async () => undefined,
    list: async () => {
      fake.listCalls += 1
      const all = fake.rows
      return {
        success: true,
        sessionGrants: all.filter((g) => g.scope === 'session'),
        workspaceGrants: all.filter((g) => g.scope === 'workspace'),
      }
    },
    revoke: async (id) => {
      fake.revoked.push(id)
      fake.rows = fake.rows.filter((g) => g.id !== id)
      return { success: true }
    },
  }
  return fake
}

beforeEach(() => {
  permissionGrantsQuery.reset()
  revokeGrantMutation.reset()
  revokeAppGrantsMutation.reset()
})

afterEach(() => {
  configurePermissionGrantsPort(undefined)
  permissionGrantsQuery.reset()
})

describe('分组(纯函数)', () => {
  it('按 app 分组;一个应用好几条;散条排在最后自成一摞', () => {
    const groups = groupGrantsByApp([
      grant({ id: 'a', app: 'session', type: 'session_destructive' }),
      grant({ id: 'b', app: 'music', type: 'mcp' }),
      grant({ id: 'c', app: 'session', type: 'session_message' }),
      grant({ id: 'd', app: undefined, pattern: '/Users/x/a.ts', type: 'file_write' }),
    ])
    expect(groups.map((g) => g.app)).toEqual(['music', 'session', undefined])
    expect(groups[1].grants.map((g) => g.id)).toEqual(['a', 'c'])
    expect(groups[2].grants.map((g) => g.id)).toEqual(['d'])
  })

  it('一条都没有 = 一个组都没有(不造一个空的「其他」)', () => {
    expect(groupGrantsByApp([])).toEqual([])
  })
})

describe('设置页那一节', () => {
  it('空账页说一句实话', async () => {
    configurePermissionGrantsPort(fakePort([]))
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() => expect(screen.getByText(t('permissions.empty'))).toBeTruthy())
  })

  it('按应用分组画出来,每条一行 + 一颗撤销', async () => {
    configurePermissionGrantsPort(
      fakePort([
        grant({ id: 'a', app: 'session', type: 'session_destructive' }),
        grant({ id: 'b', app: 'session', type: 'session_message' }),
      ]),
    )
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(2))
    expect(screen.getByText('session')).toBeTruthy()
    // 组头那颗「全部撤销」是一颗,不是两颗。
    expect(
      screen.getAllByRole('button', { name: t('permissions.revokeAppOf', { app: 'session' }) }),
    ).toHaveLength(1)
  })

  it('撤一条:**就地更新**(那一行当场没了),端口只收到这一条', async () => {
    const port = fakePort([
      grant({ id: 'a', app: 'session', type: 'session_destructive' }),
      grant({ id: 'b', app: 'session', type: 'session_message' }),
    ])
    configurePermissionGrantsPort(port)
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(2))

    const rowButtons = screen.getAllByRole('button', { name: /^撤销「|^Revoke “/ })
    await act(async () => {
      rowButtons[0].click()
    })

    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(1))
    await waitFor(() => expect(port.revoked).toEqual(['a']))
  })

  it('整应用一键撤 = **逐条** revoke(后端没有批量口)', async () => {
    const port = fakePort([
      grant({ id: 'a', app: 'session', type: 'session_destructive' }),
      grant({ id: 'b', app: 'session', type: 'session_message' }),
    ])
    configurePermissionGrantsPort(port)
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(2))

    await act(async () => {
      screen.getByRole('button', { name: t('permissions.revokeAppOf', { app: 'session' }) }).click()
    })

    await waitFor(() => expect(port.revoked).toEqual(['a', 'b']))
    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(0))
  })

  it('散条那一摞没有「全部撤销」(它不是一个应用)', async () => {
    configurePermissionGrantsPort(
      fakePort([grant({ id: 'd', app: undefined, pattern: '/Users/x/a.ts', type: 'file_write' })]),
    )
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() => expect(document.querySelectorAll('[data-grant-id]').length).toBe(1))
    expect(screen.getByText(t('permissions.ungrouped'))).toBeTruthy()
    expect(screen.queryByText(t('permissions.revokeApp'))).toBeNull()
  })

  it('拉不到:说那句话,**不把「拉不到」画成「你一条都没授权过」**', async () => {
    const port = fakePort([])
    port.list = async () => ({ success: false, error: '断了' })
    configurePermissionGrantsPort(port)
    await act(async () => {
      render(<PermissionGrants />)
    })
    await waitFor(() =>
      expect(screen.getByText(`${t('permissions.loadFailed')} · 断了`)).toBeTruthy(),
    )
  })
})
