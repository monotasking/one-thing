import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import type { SpacesPort } from '../../data/spaces-port'
import { useNotifyStore } from '../../services/notify-store'
import { useWorkspaceStore } from '../store'
import { applyCurrentWorkspace, stopWorkspaceApplyForTest, startWorkspaceApply } from '../apply'
import { DEFAULT_SPACE_ID } from '../types'

/**
 * store 钉三件事:**读**(列表来自端口,读不到退兜底并如实标注)、
 * **写**(建 / 改名 / 换色 / 删各自落到端口上,失败弹出来不吞)、
 * **切**(当前工作区是这台壳自己的记忆 —— 后端没有这个概念)。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0, color: 'violet' }
const PERSONAL: SpaceRecord = { id: 'ws-personal', name: '个人', createdAt: 100, color: 'green' }

function installPort(overrides: Partial<SpacesPort> = {}): SpacesPort {
  const port: SpacesPort = {
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, PERSONAL] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
    ...overrides,
  }
  configureSpacesPort(port)
  return port
}

beforeEach(() => {
  useWorkspaceStore.getState().reset()
  useNotifyStore.getState().clear()
  stopWorkspaceApplyForTest()
})

describe('读列表', () => {
  it('读到就是 ready,列表原样进 store', async () => {
    installPort()
    await useWorkspaceStore.getState().load()
    expect(useWorkspaceStore.getState().status).toBe('ready')
    expect(useWorkspaceStore.getState().spaces.map((s) => s.id)).toEqual([
      DEFAULT_SPACE_ID,
      'ws-personal',
    ])
  })

  it('读不到退兜底表(至少一个空间)并如实标注 error,后端原话留着', async () => {
    installPort({ list: async () => ({ success: false, error: 'core unreachable' }) })
    await useWorkspaceStore.getState().load()
    const st = useWorkspaceStore.getState()
    expect(st.status).toBe('error')
    expect(st.error).toBe('core unreachable')
    expect(st.spaces.map((s) => s.id)).toEqual([DEFAULT_SPACE_ID])
  })

  /*
   * 08-31 真机抓到的那条(浏览器直开、没有 core):`list()` 不是回
   * `{success:false}` 而是**直接 reject**(RPC 404 抛)。修之前那条拒绝逃逸成
   * 一条未捕获的 promise —— 崩溃捕获弹「Something broke in promise」,而 store
   * 永远停在 loading、兜底表一次都没落上,瓦面也就没有字标。
   * 传输层拒绝与后端答「不成功」对这块界面是同一件事,归一在 store 的 call() 里。
   */
  it('端口**拒绝**(没连上 core)与答「不成功」走同一条路:退兜底 + 原话留着', async () => {
    installPort({
      list: async () => {
        throw new Error('Request failed: 404 Not Found')
      },
    })
    await useWorkspaceStore.getState().load()
    const st = useWorkspaceStore.getState()
    expect(st.status).toBe('error')
    expect(st.error).toBe('Request failed: 404 Not Found')
    expect(st.spaces.map((s) => s.id)).toEqual([DEFAULT_SPACE_ID])
  })

  it('写口拒绝同理:不抛出去,按失败弹一条', async () => {
    installPort({
      create: async () => {
        throw new Error('Request failed: 404 Not Found')
      },
    })
    expect(await useWorkspaceStore.getState().createWorkspace('新的')).toBeNull()
    expect(useNotifyStore.getState().items[0]?.detail).toBe('Request failed: 404 Not Found')
  })

  it('并发 load 只打一次 —— Dock 与总览会各调一次', async () => {
    const port = installPort()
    await Promise.all([useWorkspaceStore.getState().load(), useWorkspaceStore.getState().load()])
    expect(port.list).toHaveBeenCalledTimes(1)
  })
})

describe('切换', () => {
  it('切到别的工作区就记住它', async () => {
    installPort()
    await useWorkspaceStore.getState().load()
    useWorkspaceStore.getState().switchTo('ws-personal')
    expect(useWorkspaceStore.getState().currentId).toBe('ws-personal')
  })

  it('切换**不打端口** —— 后端没有「当前空间」这个概念', async () => {
    const port = installPort()
    await useWorkspaceStore.getState().load()
    ;(port.list as ReturnType<typeof vi.fn>).mockClear()
    useWorkspaceStore.getState().switchTo('ws-personal')
    expect(port.list).not.toHaveBeenCalled()
    expect(port.update).not.toHaveBeenCalled()
  })

  it('切换会把当前工作区贴到 documentElement 上(唯一碰 DOM 的那一半)', async () => {
    installPort()
    await useWorkspaceStore.getState().load()
    startWorkspaceApply()
    useWorkspaceStore.getState().switchTo('ws-personal')
    expect(document.documentElement.getAttribute('data-workspace')).toBe('ws-personal')
    expect(document.documentElement.getAttribute('data-workspace-swatch')).toBe('green')
  })

  it('applyCurrentWorkspace 不认识任何色值 —— 它只贴名字', () => {
    const probe = applyCurrentWorkspace('ws-x', 'amber')
    expect(probe.swatch).toBe('amber')
    expect(document.documentElement.getAttribute('data-workspace-swatch')).toBe('amber')
  })
})

describe('写', () => {
  it('建一个:落到端口,建完重读列表并切过去', async () => {
    const created: SpaceRecord = { id: 'ws-new', name: '新的', createdAt: 300 }
    const port = installPort({
      create: vi.fn(async () => ({ success: true, space: created })),
      list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, PERSONAL, created] })),
    })
    const id = await useWorkspaceStore.getState().createWorkspace('  新的  ')
    expect(id).toBe('ws-new')
    // 名字 trim 过才递出去 —— 前后空格不是名字的一部分。
    expect(port.create).toHaveBeenCalledWith(expect.objectContaining({ name: '新的' }))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-new')
  })

  it('空名字不建,也不打端口', async () => {
    const port = installPort()
    expect(await useWorkspaceStore.getState().createWorkspace('   ')).toBeNull()
    expect(port.create).not.toHaveBeenCalled()
  })

  it('改名与换色各自落到 update 上', async () => {
    const port = installPort()
    await useWorkspaceStore.getState().rename('ws-personal', '私人')
    expect(port.update).toHaveBeenCalledWith({ id: 'ws-personal', name: '私人' })
    await useWorkspaceStore.getState().recolor('ws-personal', 'teal')
    expect(port.update).toHaveBeenCalledWith({ id: 'ws-personal', color: 'teal' })
  })

  it('删当前那一个:store 自己就拦下,端口一次都不打', async () => {
    const port = installPort()
    await useWorkspaceStore.getState().load()
    useWorkspaceStore.getState().switchTo('ws-personal')
    expect(await useWorkspaceStore.getState().remove('ws-personal')).toBe(false)
    expect(port.remove).not.toHaveBeenCalled()
  })

  it('删被后端拒:按拒绝码说人话,失败**弹出来**不吞', async () => {
    installPort({
      remove: async () => ({ success: false, code: 'NOT_EMPTY', error: 'space still has 3 sessions' }),
    })
    await useWorkspaceStore.getState().load()
    expect(await useWorkspaceStore.getState().remove('ws-personal')).toBe(false)
    const latest = useNotifyStore.getState().items[0]
    expect(latest?.level).toBe('error')
    // 后端原话原样进详情 —— 那是排障唯一的线索。
    expect(latest?.detail).toBe('space still has 3 sessions')
  })
})
