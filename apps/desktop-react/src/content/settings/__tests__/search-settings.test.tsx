import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchSettings, statusMessage } from '../SearchSettings'
import {
  configureSearchSettingsPort,
  type SearchSettingsPort,
} from '../../../data/search-settings-port'
import {
  semanticPhaseOf,
  semanticSearchQuery,
  semanticStatusWorthPolling,
  setSemanticSearchEnabledMutation,
  toSemanticSearchView,
  type SemanticPhase,
} from '../../../data/search-settings-source'
import { resetSearchCatalog } from '../../../data/search-catalog-source'
import { configureSearchPort } from '../../../data/search-port'
import { DEFAULT_SEMANTIC_MODEL_ID, type AppSettings } from '@shared/ipc/settings'
import type { SearchStatusResponse } from '@shared/ipc/search'
import { t } from '../../../i18n'
import { zh } from '../../../i18n/zh'
import { en } from '../../../i18n/en'

/**
 * 设置页「搜索 → 按含义找」那一节。
 *
 * 钉住五件事:
 *  ① **投影**:整份设置 → 两格,`search` 那一段整个缺席(老 store)也答得出;
 *  ② **八个态各有各的判据**,而且每个态在 zh / en 两本字典里都有一句话;
 *  ③ **翻开关那一下不闪「没跑起来」** —— 写路的乐观补丁把 `vector` 抹成「不知道」,
 *     所以中间那一段屏幕上写的是「正在启动」;
 *  ④ 写回时 **`modelId` 跟着一起交**(只交一格会被归一那一层补成缺省,把用户手改过
 *     的那一份抹掉);
 *  ⑤ 装不上扩展(`vectorExtension === 'missing'`)时开关**禁着而不是藏起来**。
 */

const BASE: AppSettings = {
  ai: {} as AppSettings['ai'],
  theme: 'dark',
  general: {} as AppSettings['general'],
  tools: {} as AppSettings['tools'],
  search: { semantic: { enabled: false, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
}

interface Fake extends SearchSettingsPort {
  settings: AppSettings
  saves: AppSettings[]
}

function fakePort(settings: AppSettings): Fake {
  const fake: Fake = {
    settings,
    saves: [],
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings: fake.settings }),
    saveSettings: async (next) => {
      fake.saves.push(next)
      fake.settings = next
      return { success: true, settings: next }
    },
  }
  return fake
}

/** 索引状态那一口的替身。默认「扩展装得上、向量路关着」= 出厂档。 */
function stubStatus(status: Partial<SearchStatusResponse>): void {
  configureSearchPort({
    ready: async () => undefined,
    query: async () => ({ success: true, results: [] }) as never,
    capabilities: async () => [],
    status: async () => ({
      mode: 'owner',
      pending: 0,
      vectorExtension: 'loadable',
      vector: 'off',
      ...status,
    }),
    preview: async () => ({ success: true }),
  })
}

const reset = (): void => {
  semanticSearchQuery.reset()
  setSemanticSearchEnabledMutation.reset()
  // 索引状态那一格的产地在检索面 —— 归零走它自己那一口,不写第二套。
  resetSearchCatalog()
}

beforeEach(reset)
afterEach(() => {
  configureSearchSettingsPort(undefined)
  configureSearchPort(undefined)
  reset()
})

describe('投影(纯函数)', () => {
  it('两格:开着没有、用哪个嵌入器', () => {
    expect(toSemanticSearchView({ search: { semantic: { enabled: true, modelId: 'fake' } } }))
      .toEqual({ enabled: true, modelId: 'fake' })
  })

  it('这一段压根不在(老 store)= 关着 + 缺省模型', () => {
    expect(toSemanticSearchView({})).toEqual({
      enabled: false,
      modelId: DEFAULT_SEMANTIC_MODEL_ID,
    })
  })
})

describe('八个态(纯函数)', () => {
  const on = { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID }
  const off = { enabled: false, modelId: DEFAULT_SEMANTIC_MODEL_ID }
  const status = (extra: Partial<SearchStatusResponse>): SearchStatusResponse =>
    ({ mode: 'owner', pending: 0, vectorExtension: 'loadable', ...extra })

  it('还没问到 = unknown(不许画成「未启用」)', () => {
    expect(semanticPhaseOf(undefined, status({ vector: 'off' }))).toBe('unknown')
    expect(semanticPhaseOf(off, undefined)).toBe('unknown')
  })

  it('装不上扩展 = unsupported,**与开关开没开无关**', () => {
    expect(semanticPhaseOf(off, status({ vectorExtension: 'missing' }))).toBe('unsupported')
    expect(semanticPhaseOf(on, status({ vectorExtension: 'missing', vector: 'ready' })))
      .toBe('unsupported')
  })

  it('关着 = disabled;开着按 `vector` 那一格分四档', () => {
    expect(semanticPhaseOf(off, status({ vector: 'off' }))).toBe('disabled')
    expect(semanticPhaseOf(on, status({ vector: 'downloading' }))).toBe('downloading')
    expect(semanticPhaseOf(on, status({ vector: 'embedding' }))).toBe('embedding')
    expect(semanticPhaseOf(on, status({ vector: 'ready' }))).toBe('ready')
    expect(semanticPhaseOf(on, status({ vector: 'off' }))).toBe('failed')
  })

  it('开着但 `vector` **缺席** = starting(缺席的意思是「不知道」,不是 off)', () => {
    expect(semanticPhaseOf(on, status({}))).toBe('starting')
  })

  it('关着 / 装不上时不轮询 —— 那两态下什么都不会动', () => {
    const idle: SemanticPhase[] = ['disabled', 'unsupported']
    for (const phase of idle) expect(semanticStatusWorthPolling(phase)).toBe(false)
    const moving: SemanticPhase[] = ['unknown', 'starting', 'downloading', 'embedding', 'ready', 'failed']
    for (const phase of moving) expect(semanticStatusWorthPolling(phase)).toBe(true)
  })

  it('每个态都说得出一句话,而且 zh / en 两本都译过', () => {
    const phases: SemanticPhase[] = [
      'unknown', 'unsupported', 'disabled', 'starting',
      'downloading', 'embedding', 'ready', 'failed',
    ]
    for (const phase of phases) {
      const { key } = statusMessage(phase, undefined)
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy()
      expect(en[key], `en 缺 ${key}`).toBeTruthy()
    }
    // 数得出来才给数(§7.3「不知道就别给」),不是画一个 0。
    expect(statusMessage('embedding', undefined).vars).toBeUndefined()
    expect(statusMessage('embedding', 0).vars).toBeUndefined()
    expect(statusMessage('embedding', 7).vars).toEqual({ count: 7 })
  })
})

describe('这一节(渲染)', () => {
  it('出厂档:开关关着、状态行写「未启用」、模型那一行画着 id', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusDisabled'))
    })
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('search-semantic-model-row').textContent)
      .toContain(DEFAULT_SEMANTIC_MODEL_ID)
  })

  it('翻开开关:**写回时 modelId 跟着一起交**,而且中间那一段写的是「正在启动」不是「没跑起来」', async () => {
    const port = fakePort({
      ...structuredClone(BASE),
      // 用户手改过 `settings.json` 的那一份 —— 一发写回不许把它抹成缺省。
      search: { semantic: { enabled: false, modelId: 'fake' } },
    })
    configureSearchSettingsPort(port)
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusDisabled'))
    })

    act(() => void fireEvent.click(screen.getByRole('switch')))
    // 乐观那一拍:开关翻过去了,状态行是「正在启动」——**不是**「没跑起来」。
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusStarting'))

    await waitFor(() => expect(port.saves.length).toBe(1))
    expect(port.saves[0]!.search?.semantic).toEqual({ enabled: true, modelId: 'fake' })
  })

  it('装不上扩展:开关**禁着而不是藏起来** —— 藏起来的开关说不出「这台机器做不了」', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vectorExtension: 'missing', vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusUnsupported'))
    })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  })

  it('建索引中:读数带着还欠几条', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'embedding', vectorPending: 42 })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusEmbeddingCount', { count: 42 }))
    })
  })

  it('设置拉不到:错话与**旧值并陈**,开关那一行不抹掉', async () => {
    configureSearchSettingsPort({
      ready: async () => undefined,
      readSettings: async () => ({ success: false, error: '拉不到' }),
      saveSettings: async () => ({ success: true }),
    })
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByText(/拉不到/)).toBeTruthy()
    })
    expect(screen.getByRole('switch')).toBeTruthy()
    // 设置那一格没答案 → 状态行说「检查中」,不说「未启用」。
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusUnknown'))
  })
})
