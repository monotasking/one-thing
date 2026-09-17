import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchSettings, downloadRatio, modelHint, statusMessage } from '../SearchSettings'
import {
  configureSearchSettingsPort,
  type SearchSettingsPort,
} from '../../../data/search-settings-port'
import {
  semanticModelPhaseOf,
  semanticPhaseOf,
  semanticSearchQuery,
  semanticStatusPollMs,
  setSemanticSearchEnabledMutation,
  toSemanticSearchView,
  cancelSemanticModelMutation,
  downloadSemanticModelMutation,
  removeSemanticModelMutation,
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
  /** 模型那三颗钮各按过几次(写路证据;回执由 `model` 那一格给)。 */
  modelCalls: string[]
  model?: NonNullable<SearchStatusResponse['model']>
}

function fakePort(settings: AppSettings): Fake {
  const answer = (op: string) => async () => {
    fake.modelCalls.push(op)
    return { success: true, ...(fake.model === undefined ? {} : { model: fake.model }) }
  }
  const fake: Fake = {
    settings,
    saves: [],
    modelCalls: [],
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings: fake.settings }),
    saveSettings: async (next) => {
      fake.saves.push(next)
      fake.settings = next
      return { success: true, settings: next }
    },
    downloadModel: answer('download'),
    cancelModelDownload: answer('cancel'),
    removeModel: answer('remove'),
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
  downloadSemanticModelMutation.reset()
  cancelSemanticModelMutation.reset()
  removeSemanticModelMutation.reset()
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

  it('轮询三档:下模型 1s / 会动的 5s / 什么都不会动的不问', () => {
    const idle: SemanticPhase[] = ['disabled', 'unsupported', 'needsModel']
    for (const phase of idle) expect(semanticStatusPollMs(phase, 'absent')).toBeUndefined()
    const moving: SemanticPhase[] = ['unknown', 'starting', 'downloading', 'embedding', 'ready', 'failed']
    for (const phase of moving) expect(semanticStatusPollMs(phase, 'ready')).toBe(5000)
    // 正在下模型 = 有一条会走的进度条,**哪一个 phase 都问得更勤**(1s)。
    for (const phase of [...idle, ...moving]) {
      expect(semanticStatusPollMs(phase, 'downloading')).toBe(1000)
    }
  })

  it('每个态都说得出一句话,而且 zh / en 两本都译过', () => {
    const phases: SemanticPhase[] = [
      'unknown', 'unsupported', 'needsModel', 'disabled', 'starting',
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

  /**
   * 失败态的那句原因(2026-09-17)。在这之前这一行只会写「原因在日志里」,而 Worker 的
   * 日志真机上从来没有落过地 —— 那是一句假话。后端答得出 `vectorError` 就插进来;
   * 答不出就退回老那句(编一个原因比不说更糟)。
   *
   * R12 起原因分**四类**(后端只答码 + 原话,句子由这一侧查字典):每一类查一行、
   * 四句中英都带 `{reason}`,不认识的码退回只说原话那一句。
   */
  it('failed:后端给了原因就说原因,给不出才退回「原因在日志里」', () => {
    const withReason = statusMessage('failed', undefined, 'fetch failed')
    expect(withReason.key).toBe('search.semanticStatusFailedReason')
    expect(withReason.vars).toEqual({ reason: 'fetch failed' })
    expect(zh[withReason.key]).toContain('{reason}')
    expect(en[withReason.key]).toContain('{reason}')

    expect(statusMessage('failed', undefined).key).toBe('search.semanticStatusFailed')
    expect(statusMessage('failed', undefined, '').key).toBe('search.semanticStatusFailed')
  })

  it('failed:四类原因各查一行,中英都带 {reason}', () => {
    const byKind = {
      network: 'search.semanticStatusFailedNetwork',
      runtime: 'search.semanticStatusFailedRuntime',
      model: 'search.semanticStatusFailedModel',
      unknown: 'search.semanticStatusFailedReason',
    } as const
    for (const [kind, key] of Object.entries(byKind)) {
      const message = statusMessage('failed', undefined, '原话', kind as keyof typeof byKind)
      expect(message.key).toBe(key)
      expect(message.vars).toEqual({ reason: '原话' })
      expect(zh[message.key]).toContain('{reason}')
      expect(en[message.key]).toContain('{reason}')
    }
    // 老后端不带这一格 = 不认识 = 只说原话(与 `unknown` 同一行)。
    expect(statusMessage('failed', undefined, '原话').key).toBe('search.semanticStatusFailedReason')
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

  it('没跑起来:后端那句原因按类上屏(不是只写「去看日志」)', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'off', vectorError: 'fetch failed', vectorErrorKind: 'network' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusFailedNetwork', { reason: 'fetch failed' }))
    })
  })

  it('翻开关那一下连原因一起抹掉 —— 上一任的死因不许跟在「正在启动」后面', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: false, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'off', vectorError: '上一条 Worker 的死因', vectorErrorKind: 'runtime' })
    render(<SearchSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusDisabled'))
    })

    act(() => void fireEvent.click(screen.getByRole('switch')))
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusStarting'))
  })

  it('设置拉不到:错话与**旧值并陈**,开关那一行不抹掉', async () => {
    configureSearchSettingsPort({
      ready: async () => undefined,
      readSettings: async () => ({ success: false, error: '拉不到' }),
      saveSettings: async () => ({ success: true }),
      downloadModel: async () => ({ success: true }),
      cancelModelDownload: async () => ({ success: true }),
      removeModel: async () => ({ success: true }),
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

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 模型那一行(2026-09-17;用户裁「把开关和下载模型拆开,另外下载模型要能够知道进度」)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 钉住四件事:
 *  ① **五个态各有各的副文案与各自那一颗钮**(没有一颗钮在两个态里换文案);
 *  ② **翻开关不再触发下载**:模型没下全时开关禁着,说明行写「先下载模型」;
 *  ③ **开着的时候永远许关** —— 老用户那一形(`enabled: true` 但模型从没下过)
 *     不能被锁死;
 *  ④ 三颗钮各打各的那条写路,乐观那一拍就把屏上那一行改过去。
 */
describe('模型那一行', () => {
  const MODEL = (extra: Partial<NonNullable<SearchStatusResponse['model']>> = {}) => ({
    id: DEFAULT_SEMANTIC_MODEL_ID,
    state: 'absent' as const,
    ...extra,
  })

  it('五个态各说得出一句话,zh / en 两本都译过', () => {
    const cases: Array<[Parameters<typeof modelHint>[1], SearchStatusResponse['model']]> = [
      ['unknown', undefined],
      ['absent', MODEL({ totalBytes: 118_300_000 })],
      ['downloading', MODEL({ state: 'downloading', loadedBytes: 40_000_000, totalBytes: 118_300_000 })],
      ['ready', MODEL({ state: 'ready', loadedBytes: 118_300_000, totalBytes: 118_300_000 })],
      ['failed', MODEL({ state: 'failed', errorKind: 'network', error: 'fetch failed' })],
    ]
    for (const [phase, status] of cases) {
      const line = modelHint(t, phase, status)
      expect(line, `${phase} 没话说`).toBeTruthy()
      expect(line).not.toContain('{')
    }
    // 四类原因各查一行,中英成对(与状态行那四句是**两族**:主语不同)。
    for (const key of [
      'search.semanticModelFailedNetwork',
      'search.semanticModelFailedRuntime',
      'search.semanticModelFailedFiles',
      'search.semanticModelFailedReason',
    ] as const) {
      expect(zh[key]).toContain('{reason}')
      expect(en[key]).toContain('{reason}')
    }
  })

  it('不知道总数就画「不知道进度」那一档,不画一条停在 0% 的槽', () => {
    expect(downloadRatio(undefined)).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 10 }))).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 10, totalBytes: 0 }))).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 25, totalBytes: 100 }))).toBe(0.25)
    // 后端的读数偶尔会越过分母(最后一个文件收尾那一拍),夹住而不是画 120%。
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 120, totalBytes: 100 }))).toBe(1)
  })

  it('模型没下:开关**禁着**、说明行写「先下载模型」、状态行不写「未启用」', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vector: 'off', model: MODEL({ totalBytes: 118_300_000 }) })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusNeedsModel'))
    })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('search-semantic-row').textContent)
      .toContain(t('search.semanticNeedsModelHint'))
    expect(screen.getByTestId('search-semantic-model-download')).toBeTruthy()
  })

  it('开着但模型没下(老用户那一形):开关**照样关得掉**,而且屏上同时给下载', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({
      vector: 'off',
      vectorErrorKind: 'model',
      vectorError: 'embedding model files are not downloaded',
      model: MODEL(),
    })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-model-download')).toBeTruthy()
    })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusFailedModel', { reason: 'embedding model files are not downloaded' }))
  })

  it('按下载:打的是那条写路,乐观那一拍屏上就换成「取消」', async () => {
    const port = fakePort(structuredClone(BASE))
    configureSearchSettingsPort(port)
    stubStatus({ vector: 'off', model: MODEL({ totalBytes: 118_300_000 }) })
    render(<SearchSettings />)
    await waitFor(() => expect(screen.getByTestId('search-semantic-model-download')).toBeTruthy())

    act(() => void fireEvent.click(screen.getByTestId('search-semantic-model-download')))
    // 乐观:这一拍就换成下载中那一态(取消钮 + 进度条),不等一个来回。
    expect(screen.getByTestId('search-semantic-model-cancel')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
    await waitFor(() => expect(port.modelCalls).toEqual(['download']))
  })

  it('已下载:画真数与删除钮;开关开着时那颗钮**禁着**(正在用的不许抽走)', async () => {
    const ready = MODEL({ state: 'ready', loadedBytes: 118_300_000, totalBytes: 118_300_000 })
    const port = fakePort(structuredClone(BASE))
    configureSearchSettingsPort(port)
    stubStatus({ vector: 'off', model: ready })
    const view = render(<SearchSettings />)
    await waitFor(() => expect(screen.getByTestId('search-semantic-model-remove')).toBeTruthy())

    // `formatBytes` 的进位口径:≥10 不留小数(全壳唯一把字节念成人话的地方)。
    expect(screen.getByTestId('search-semantic-model-row').textContent).toContain('113 MB')
    expect(screen.getByTestId('search-semantic-model-remove').hasAttribute('disabled')).toBe(false)
    act(() => void fireEvent.click(screen.getByTestId('search-semantic-model-remove')))
    await waitFor(() => expect(port.modelCalls).toEqual(['remove']))

    view.unmount()
    reset()
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'ready', model: ready })
    render(<SearchSettings />)
    await waitFor(() => expect(screen.getByTestId('search-semantic-model-remove')).toBeTruthy())
    expect(screen.getByTestId('search-semantic-model-remove').hasAttribute('disabled')).toBe(true)
  })

  it('这台宿主管不了模型(`model` 缺席):一颗钮都不画,而且**不拦开关**', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusDisabled'))
    })
    expect(screen.queryByTestId('search-semantic-model-download')).toBeNull()
    expect(screen.queryByTestId('search-semantic-model-remove')).toBeNull()
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
    expect(semanticModelPhaseOf({ mode: 'owner', pending: 0 })).toBe('unknown')
  })
})
