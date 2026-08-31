import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenRouterModel } from '@shared/ipc/providers'
import { configureProviderSettingsPort } from '../../data/provider-settings-port'
import { useNotifyStore } from '../../services/notify-store'
import { catalogQuery } from '../catalog-query'
import { fakeProviderPort } from './fake-port'

/**
 * 模型目录那一族 query(K1 样板迁移)。
 *
 * 这一组的前身是 store.test.ts 里的 `describe('ensureCatalog')` —— 两条断言
 * **原样搬过来**,只换了读法:从「store 的四张表」换成「query 的快照」。
 * 搬而不是重写是有意的:迁移要证明的正是**行为没变**,重写一遍就没法比了。
 * 第三条是新的 —— 它守迁移带来的那件新东西(重拉不清屏)。
 */

function model(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: 8000,
    architecture: { modality: 'text', input_modalities: [], output_modalities: [], tokenizer: '' },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 8000, max_completion_tokens: 4000, is_moderated: false },
    supported_parameters: [],
  } as unknown as OpenRouterModel
}

beforeEach(() => {
  catalogQuery.reset()
  useNotifyStore.setState({ items: [] })
})

describe('目录 query', () => {
  it('拉过就不再拉;refetch 才是「刷新目录」那颗钮', async () => {
    const port = fakeProviderPort({
      listModels: vi.fn(async () => ({ success: true, models: [model('a')] })),
    })
    configureProviderSettingsPort(port)

    const q = catalogQuery.get('claude')
    await q.ensure()
    await q.ensure()
    expect(port.listModels).toHaveBeenCalledTimes(1)
    expect(port.listModels).toHaveBeenLastCalledWith('claude', false)

    await q.refetch()
    expect(port.listModels).toHaveBeenCalledTimes(2)
    expect(port.listModels).toHaveBeenLastCalledWith('claude', true)
    expect(q.get().updatedAt).toBeGreaterThan(0)
  })

  it('目录拉不到:记后端那句原话,**不**弹通知(人正在看这块面)', async () => {
    configureProviderSettingsPort(
      fakeProviderPort({
        listModels: vi.fn(async () => ({ success: false, error: '402 Insufficient Balance' })),
      }),
    )
    const q = catalogQuery.get('claude')
    await q.ensure()
    expect(q.get().error).toBe('402 Insufficient Balance')
    expect(q.get().phase).toBe('initial')
    expect(useNotifyStore.getState().items).toHaveLength(0)
  })

  it('迁移带来的那件新事:重拉失败**不清目录**,旧的一份还在', async () => {
    let call = 0
    configureProviderSettingsPort(
      fakeProviderPort({
        listModels: vi.fn(async () => {
          call += 1
          if (call === 1) return { success: true, models: [model('a')] }
          return { success: false, error: '网线掉了' }
        }),
      }),
    )
    const q = catalogQuery.get('claude')
    await q.ensure()
    await q.refetch()

    expect(q.get().data).toHaveLength(1)
    expect(q.get().phase).toBe('ready')
    expect(q.get().error).toBe('网线掉了')
  })

  it('答案逐字相同的一次刷新:内容号不动,时刻照样前进', async () => {
    configureProviderSettingsPort(
      fakeProviderPort({
        // 每次新造一份对象 —— 真机上后端就是这样答的。
        listModels: vi.fn(async () => ({ success: true, models: [model('a'), model('b')] })),
      }),
    )
    const q = catalogQuery.get('claude')
    await q.ensure()
    const before = q.get()
    await q.refetch()
    const after = q.get()

    expect(after.dataRev).toBe(before.dataRev)
    expect(after.data).toBe(before.data) // 同一个数组 = 行不重挂,key 不漂
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
  })

  it('一坑一格:两坑各拉各的,互不覆盖', async () => {
    configureProviderSettingsPort(
      fakeProviderPort({
        listModels: vi.fn(async (pid: string) => ({ success: true, models: [model(`${pid}-1`)] })),
      }),
    )
    await Promise.all([catalogQuery.get('a').ensure(), catalogQuery.get('b').ensure()])
    expect(catalogQuery.get('a').get().data?.[0].id).toBe('a-1')
    expect(catalogQuery.get('b').get().data?.[0].id).toBe('b-1')
  })
})
