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
    // 「占用空间」是隔壁那一节的读路(2026-09-18);这一节不画它,替身给一份就够。
    storage: async () => ({
      lexicalBytes: 0,
      walBytes: 0,
      modelBytes: 0,
      totalBytes: 0,
      measuredAt: 0,
    }),
  }
  return fake
}

/** 索引状态那一口的替身。默认「扩展装得上、向量路关着」= 出厂档。 */
function stubStatus(status: Partial<SearchStatusResponse>): void {
  configureSearchPort({
    ready: async () => undefined,
    query: async () => ({ success: true, results: [] }) as never,
    capabilities: async () => [],
    invoke: async () => ({ success: true }),
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

  it('关着 = disabled;开着按 `vector` 那一格分档', () => {
    expect(semanticPhaseOf(off, status({ vector: 'off' }))).toBe('disabled')
    expect(semanticPhaseOf(on, status({ vector: 'embedding' }))).toBe('embedding')
    expect(semanticPhaseOf(on, status({ vector: 'ready' }))).toBe('ready')
    expect(semanticPhaseOf(on, status({ vector: 'off', vectorError: '死因' }))).toBe('failed')
  })

  /**
   * 09-17 报障:后端 `'downloading'` 是 `VectorWriter` 的初始态名,今天的意思是
   * 「正在把模型装进内存」。照字面画就是屏上同时写着「已下载」与「正在下载模型…」。
   */
  it('`vector === downloading` 并进 starting —— 下载二字只属于模型行', () => {
    expect(semanticPhaseOf(on, status({ vector: 'downloading' }))).toBe('starting')
  })

  it('开着但 `vector` **缺席** = starting(缺席的意思是「不知道」,不是 off)', () => {
    expect(semanticPhaseOf(on, status({}))).toBe('starting')
  })

  /**
   * `off` 而**说不出死因** = 答话的还是上一条 Worker(它压根没装向量写路)。真的
   * 失败一定带死因(`VectorWriter.markOff` 每条路都 `failure ??= …`),所以这一帧
   * 画「没跑起来」是拿换 Worker 的中途当结论。
   */
  it('开着 + off 但没有死因 = starting;有死因才是 failed', () => {
    expect(semanticPhaseOf(on, status({ vector: 'off' }))).toBe('starting')
    expect(semanticPhaseOf(on, status({ vector: 'off', vectorError: '' }))).toBe('starting')
    expect(semanticPhaseOf(on, status({ vector: 'off', vectorError: 'fetch failed' }))).toBe('failed')
  })

  /** 模型没到位时**两种开关位置说同一句话** —— 下一步动作是同一个:去按那颗「下载」。 */
  it('模型不是 ready 也不是「管不了」= needsModel,开关开着也一样', () => {
    const notReady = ['absent', 'downloading', 'failed'] as const
    for (const state of notReady) {
      const s = status({ vector: 'off', model: { id: 'm', state } })
      expect(semanticPhaseOf(off, s), state).toBe('needsModel')
      expect(semanticPhaseOf(on, s), state).toBe('needsModel')
    }
    // 「管不了模型」的宿主(`model` 缺席)不拦路。
    expect(semanticPhaseOf(off, status({ vector: 'off' }))).toBe('disabled')
  })

  it('轮询三档:下模型 1s / 会动的 5s / 什么都不会动的不问', () => {
    const idle: SemanticPhase[] = ['disabled', 'unsupported', 'needsModel']
    for (const phase of idle) expect(semanticStatusPollMs(phase, 'absent')).toBeUndefined()
    /*
     * **模型那一格「不知道」时要问**(2026-09-17 认领):缺席有两种意思,其中一种
     * (后端正在试装盘上那堆没清单的文件)几秒后就会变。少了这一句,「开关关着 +
     * 正在认领」会永远停在「检查中…」。
     */
    for (const phase of idle) expect(semanticStatusPollMs(phase, 'unknown')).toBe(5000)
    const moving: SemanticPhase[] = ['unknown', 'starting', 'embedding', 'ready', 'failed']
    for (const phase of moving) expect(semanticStatusPollMs(phase, 'ready')).toBe(5000)
    // 正在下模型 = 有一条会走的进度条,**哪一个 phase 都问得更勤**(1s)。
    for (const phase of [...idle, ...moving]) {
      expect(semanticStatusPollMs(phase, 'downloading')).toBe(1000)
    }
  })

  it('每个会说话的态都译过 zh / en;`disabled` **一个字都不说**', () => {
    const phases: SemanticPhase[] = [
      'unknown', 'unsupported', 'needsModel', 'starting', 'embedding', 'ready', 'failed',
    ]
    for (const phase of phases) {
      const message = statusMessage(phase, 'ready', undefined)
      expect(message, `${phase} 没话说`).toBeDefined()
      expect(zh[message!.key], `zh 缺 ${message!.key}`).toBeTruthy()
      expect(en[message!.key], `en 缺 ${message!.key}`).toBeTruthy()
    }
    // 关着的开关本身就是那句「未启用」,底下再写一行是凑字(09-17)。
    expect(statusMessage('disabled', 'ready', undefined)).toBeUndefined()
    // 首载那一帧模型行也写着「检查中…」—— 同一句不印两遍(09-17)。
    expect(statusMessage('unknown', 'unknown', undefined)).toBeUndefined()
    expect(statusMessage('unknown', 'ready', undefined)?.key).toBe('search.semanticStatusUnknown')
    // 数得出来才给数(§7.3「不知道就别给」),不是画一个 0。
    expect(statusMessage('embedding', 'ready', undefined)?.vars).toBeUndefined()
    expect(statusMessage('embedding', 'ready', 0)?.vars).toBeUndefined()
    expect(statusMessage('embedding', 'ready', 7)?.vars).toEqual({ count: 7 })
  })

  /**
   * 失败态的那句原因(2026-09-17)。在这之前这一行只会写「原因在日志里」,而 Worker 的
   * 日志真机上从来没有落过地 —— 那是一句假话。后端答得出 `vectorError` 就用上;
   * 答不出就退回光秃秃那句(编一个原因比不说更糟)。
   *
   * **09-17 报障后改**:认得出的那三类**不再把原话括在屏上**(真机上那是一串
   * `Unsupported device: "wasm"…`),原话改挂 Tooltip = `detail`;只有不认识那一类
   * 把原话直接上屏。
   */
  it('failed:不认识的码只说原话,连原话都没有才说光秃秃那句', () => {
    const withReason = statusMessage('failed', 'ready', undefined, 'fetch failed')
    expect(withReason?.key).toBe('search.semanticStatusFailedReason')
    expect(withReason?.vars).toEqual({ reason: 'fetch failed' })
    expect(withReason?.detail).toBeUndefined()
    expect(zh[withReason!.key]).toContain('{reason}')
    expect(en[withReason!.key]).toContain('{reason}')

    expect(statusMessage('failed', 'ready', undefined)?.key).toBe('search.semanticStatusFailed')
    expect(statusMessage('failed', 'ready', undefined, '')?.key).toBe('search.semanticStatusFailed')
  })

  it('failed:三类认得出的原因各查一行,**句子里没有 {reason},原话进 Tooltip**', () => {
    const byKind = {
      network: 'search.semanticStatusFailedNetwork',
      runtime: 'search.semanticStatusFailedRuntime',
      model: 'search.semanticStatusFailedModel',
    } as const
    for (const [kind, key] of Object.entries(byKind)) {
      const message = statusMessage('failed', 'ready', undefined, '原话', kind as keyof typeof byKind)
      expect(message?.key).toBe(key)
      expect(message?.vars).toBeUndefined()
      expect(message?.detail).toBe('原话')
      expect(zh[key], key).not.toContain('{')
      expect(en[key], key).not.toContain('{')
    }
    // 认得出码但后端一句原话都没给 → 还是那句人话,只是没有可挂的提示。
    const bare = statusMessage('failed', 'ready', undefined, undefined, 'network')
    expect(bare?.key).toBe('search.semanticStatusFailedNetwork')
    expect(bare?.detail).toBeUndefined()
    // 老后端不带这一格 = 不认识 = 只说原话。
    expect(statusMessage('failed', 'ready', undefined, '原话')?.key).toBe('search.semanticStatusFailedReason')
  })
})

describe('这一节(渲染)', () => {
  /**
   * 09-17 报障后两处改法都钉在这一条上:**关着不画状态行**(一个关着的开关本身就是
   * 那句「未启用」),**模型 id 不上屏**(它不构成任何一个可做的决定)。
   */
  it('出厂档:开关关着、**状态行整行不画**、模型那一行不写 id', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId('search-semantic-status')).toBeNull()
    expect(screen.getByTestId('search-semantic-model-row').textContent)
      .not.toContain(DEFAULT_SEMANTIC_MODEL_ID)
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
    await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false))

    act(() => void fireEvent.click(screen.getByRole('switch')))
    // 乐观那一拍:开关翻过去了,状态行是「正在启动」——**不是**「没跑起来」。
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusStarting'))

    await waitFor(() => expect(port.saves.length).toBe(1))
    expect(port.saves[0]!.search?.semantic).toEqual({ enabled: true, modelId: 'fake' })
  })

  it('装不上扩展:开关**禁着而不是藏起来**,而模型那一行**整行不画**', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({
      vectorExtension: 'missing',
      vector: 'off',
      // 后端照样答得出模型那一格(`ModelDownloader` 与 vec0 装不装得上无关)——
      // 但在一台结构上做不了语义召回的机器上请人下 113MB 是骗人。
      model: { id: DEFAULT_SEMANTIC_MODEL_ID, state: 'absent', totalBytes: 118_300_000 },
    })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusUnsupported'))
    })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByTestId('search-semantic-model-row')).toBeNull()
    expect(screen.queryByTestId('search-semantic-model-download')).toBeNull()
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

  it('没跑起来:屏上只有那句人话,**机器原话不上屏**(它挂在 Tooltip 上)', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'off', vectorError: 'fetch failed', vectorErrorKind: 'network' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusFailedNetwork'))
    })
    expect(screen.getByTestId('search-semantic-status').textContent).not.toContain('fetch failed')
  })

  /**
   * 这一条就是 09-17 那张截图:后端 `vector === 'downloading'` 说的是「正在把模型装进
   * 内存」,模型明明已经下完了。**开关那一行不许出现「下载」二字** —— 归并拆掉当场红。
   */
  it('模型 ready + 开着 + `vector === downloading`:状态行写「正在启动…」,一个「下载」都没有', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({
      vector: 'downloading',
      model: {
        id: DEFAULT_SEMANTIC_MODEL_ID,
        state: 'ready',
        loadedBytes: 118_300_000,
        totalBytes: 118_300_000,
      },
    })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusStarting'))
    })
    expect(screen.getByTestId('search-semantic-row').textContent).not.toContain('下载')
    expect(screen.getByTestId('search-semantic-status').textContent).not.toContain('下载')
    // 模型行照旧说它自己那半句真话。
    expect(screen.getByTestId('search-semantic-model-row').textContent)
      .toContain(t('search.semanticModelReadySize', { size: '113 MB' }))
  })

  it('翻开关那一下连原因一起抹掉 —— 上一任的死因不许跟在「正在启动」后面', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: false, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({ vector: 'off', vectorError: '上一条 Worker 的死因', vectorErrorKind: 'runtime' })
    render(<SearchSettings />)
    // 关着 = 状态行整行不画(09-17),所以这一等等的是开关活过来。
    await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false))
    expect(screen.queryByTestId('search-semantic-status')).toBeNull()

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
      storage: async () => ({
        lexicalBytes: 0, walBytes: 0, modelBytes: 0, totalBytes: 0, measuredAt: 0,
      }),
    })
    stubStatus({ vector: 'off' })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByText(/拉不到/)).toBeTruthy()
    })
    expect(screen.getByRole('switch')).toBeTruthy()
    // 设置那一格没答案 → **绝不写「未启用」**(那是在编)。这台替身的状态里没有
    // `model`,模型行已经在写「检查中…」,所以状态行让位、整行不画(同一句不印两遍)。
    expect(screen.queryByTestId('search-semantic-status')).toBeNull()
    expect(screen.getByTestId('search-semantic-model-row').textContent)
      .toBe(`${t('search.semanticModelLabel')}${t('search.semanticModelUnknown')}`)
  })

  it('设置没答案但模型行有答案:状态行照写「检查中…」', async () => {
    configureSearchSettingsPort({
      ready: async () => undefined,
      readSettings: async () => ({ success: false, error: '拉不到' }),
      saveSettings: async () => ({ success: true }),
      downloadModel: async () => ({ success: true }),
      cancelModelDownload: async () => ({ success: true }),
      removeModel: async () => ({ success: true }),
      storage: async () => ({
        lexicalBytes: 0, walBytes: 0, modelBytes: 0, totalBytes: 0, measuredAt: 0,
      }),
    })
    stubStatus({
      vector: 'off',
      model: { id: DEFAULT_SEMANTIC_MODEL_ID, state: 'ready', totalBytes: 118_300_000 },
    })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusUnknown'))
    })
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
      expect(line.text, `${phase} 没话说`).toBeTruthy()
      expect(line.text).not.toContain('{')
    }
    // 认得出的三类:人话上屏、原话挂 Tooltip(句子里没有 {reason})。
    for (const key of [
      'search.semanticModelFailedNetwork',
      'search.semanticModelFailedRuntime',
      'search.semanticModelFailedFiles',
    ] as const) {
      expect(zh[key], key).not.toContain('{')
      expect(en[key], key).not.toContain('{')
    }
    const network = modelHint(t, 'failed', MODEL({ state: 'failed', errorKind: 'network', error: 'fetch failed' }))
    expect(network.text).toBe(t('search.semanticModelFailedNetwork'))
    expect(network.detail).toBe('fetch failed')
    // 不认识的码(老后端不带这一格)= 只说原话,中英都带 {reason}。
    const unknown = modelHint(t, 'failed', MODEL({ state: 'failed', error: '原话' }))
    expect(unknown.text).toBe(t('search.semanticModelFailedReason', { reason: '原话' }))
    expect(unknown.detail).toBeUndefined()
    expect(zh['search.semanticModelFailedReason']).toContain('{reason}')
    expect(en['search.semanticModelFailedReason']).toContain('{reason}')
    // 连原话都没有 = 光秃秃那一句。
    expect(modelHint(t, 'failed', MODEL({ state: 'failed' })).text)
      .toBe(t('search.semanticModelFailed'))
  })

  it('不知道总数就画「不知道进度」那一档,不画一条停在 0% 的槽', () => {
    expect(downloadRatio(undefined)).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 10 }))).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 10, totalBytes: 0 }))).toBeUndefined()
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 25, totalBytes: 100 }))).toBe(0.25)
    // 后端的读数偶尔会越过分母(最后一个文件收尾那一拍),夹住而不是画 120%。
    expect(downloadRatio(MODEL({ state: 'downloading', loadedBytes: 120, totalBytes: 100 }))).toBe(1)
  })

  it('模型没下:开关**禁着**、状态行写「先下载模型」、说明句**不换**', async () => {
    configureSearchSettingsPort(fakePort(structuredClone(BASE)))
    stubStatus({ vector: 'off', model: MODEL({ totalBytes: 118_300_000 }) })
    render(<SearchSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('search-semantic-status').textContent)
        .toBe(t('search.semanticStatusNeedsModel'))
    })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    // 说明句恒定一句(09-17):「该先下载」这件事状态行已经在说了。
    expect(screen.getByTestId('search-semantic-row').textContent)
      .toContain(t('search.semanticHint'))
    expect(screen.getByTestId('search-semantic-model-download')).toBeTruthy()
  })

  /**
   * 老用户那一形 + 正在下载那一形,合在一条里量的是同一条规矩:**模型行正在说这件事
   * 的时候,开关行不许说第二遍**。从前这里写的是「没跑起来:模型文件不完整,重新
   * 下载」—— 在一条正在走的进度条底下叫人重新下载,正是 09-17 报的那一类。
   */
  it('开着但模型没下(老用户那一形):开关照样关得掉,状态行说「先下载模型」而不是死因', async () => {
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
      .toBe(t('search.semanticStatusNeedsModel'))
  })

  it('开着 + 模型正在下载:状态行不叫人「重新下载」,进度由模型行一处说', async () => {
    configureSearchSettingsPort(fakePort({
      ...structuredClone(BASE),
      search: { semantic: { enabled: true, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    }))
    stubStatus({
      vector: 'off',
      vectorErrorKind: 'model',
      vectorError: 'embedding model files are not downloaded',
      model: MODEL({ state: 'downloading', loadedBytes: 40_000_000, totalBytes: 118_300_000 }),
    })
    render(<SearchSettings />)

    await waitFor(() => expect(screen.getByTestId('search-semantic-model-cancel')).toBeTruthy())
    expect(screen.getByTestId('search-semantic-status').textContent)
      .toBe(t('search.semanticStatusNeedsModel'))
    expect(screen.getByTestId('search-semantic-status').textContent)
      .not.toContain(t('search.semanticStatusFailedModel'))
    expect(screen.getByRole('progressbar')).toBeTruthy()
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

    await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false))
    expect(screen.getByTestId('search-semantic-model-row').textContent)
      .toContain(t('search.semanticModelUnknown'))
    expect(screen.queryByTestId('search-semantic-model-download')).toBeNull()
    expect(screen.queryByTestId('search-semantic-model-remove')).toBeNull()
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
    expect(semanticModelPhaseOf({ mode: 'owner', pending: 0 })).toBe('unknown')
  })
})
