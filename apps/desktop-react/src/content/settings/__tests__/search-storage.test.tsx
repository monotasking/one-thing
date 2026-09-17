import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchStorage } from '../SearchStorage'
import {
  configureSearchSettingsPort,
  type SearchSettingsPort,
} from '../../../data/search-settings-port'
import {
  searchStorageQuery,
  shouldRemeasureStorage,
  storagePhaseOf,
} from '../../../data/search-settings-source'
import { resetSearchCatalog } from '../../../data/search-catalog-source'
import { configureSearchPort } from '../../../data/search-port'
import type { SearchStorageResponse } from '@shared/ipc/search'
import { t } from '../../../i18n'
import { zh } from '../../../i18n/zh'
import { en } from '../../../i18n/en'

/**
 * 设置 → 搜索 →「占用空间」那一节(2026-09-18)。
 *
 * 用户 09-17:「我要知道搜索占得空间,不管是现在的 fts5 还是向量库。」
 *
 * 钉住五件事:
 *  ① **三态**各说各的话(计算中 / 四行读数 / 没量出来),判据是纯函数;
 *  ② **WAL 并进字面那一行** —— 屏上没有「预写日志」这一行,但它的字节数在里面;
 *  ③ `vectorBytes` **缺席画「—」**(还没有向量库),与「0 MB」分得开;
 *  ④ 量红了**旧值留在屏上**(律②),底下补一句「没量出来」;
 *  ⑤ 每一句话在 zh / en 两本字典里都有。
 */

const READING: SearchStorageResponse = {
  lexicalBytes: 157_286_400, // 150 MB
  vectorBytes: 1_048_576, //     1 MB
  walBytes: 5_242_880, //        5 MB
  modelBytes: 135_266_304, //  129 MB
  totalBytes: 298_844_160,
  measuredAt: 1,
}

function stubPort(storage: SearchSettingsPort['storage']): void {
  configureSearchSettingsPort({
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings: {} as never }),
    saveSettings: async () => ({ success: true }),
    downloadModel: async () => ({ success: true }),
    cancelModelDownload: async () => ({ success: true }),
    removeModel: async () => ({ success: true }),
    storage,
  })
  // 这一节还订着 `search.status` 的 `vector`(嵌完那一刻要重量一次)。
  configureSearchPort({
    ready: async () => undefined,
    query: async () => ({ success: true, results: [] }) as never,
    capabilities: async () => [],
    status: async () => ({ mode: 'owner', pending: 0, vectorExtension: 'loadable', vector: 'off' }),
    preview: async () => ({ success: true }),
  })
}

beforeEach(() => {
  searchStorageQuery.reset()
  resetSearchCatalog()
})
afterEach(() => {
  configureSearchSettingsPort(undefined)
  configureSearchPort(undefined)
  searchStorageQuery.reset()
  resetSearchCatalog()
})

describe('storagePhaseOf', () => {
  it('三态', () => {
    expect(storagePhaseOf(undefined, undefined)).toBe('loading')
    expect(storagePhaseOf(READING, undefined)).toBe('ready')
    expect(storagePhaseOf(undefined, '量不到')).toBe('error')
    // 有数就不算 loading,哪怕正在重量 —— 一个每次重量都翻回「计算中…」的读数会闪。
    expect(storagePhaseOf(READING, '量不到')).toBe('error')
  })
})

describe('shouldRemeasureStorage', () => {
  it('判的是跃迁,不是当前值', () => {
    // 首载:上一个值是「还不知道」,那一刻刚 ensure 过,再量一遍是白量。
    expect(shouldRemeasureStorage(undefined, 'ready')).toBe(false)
    expect(shouldRemeasureStorage('embedding', 'ready')).toBe(true)
    expect(shouldRemeasureStorage('ready', 'ready')).toBe(false)
    expect(shouldRemeasureStorage('ready', 'off')).toBe(false)
  })
})

describe('占用空间那一节', () => {
  it('首载只画合计那一行、写「计算中…」——三行骨架比一行字吵', async () => {
    let release = (): void => {}
    stubPort(() => new Promise<SearchStorageResponse>((resolve) => {
      release = () => resolve(READING)
    }))
    render(<SearchStorage />)

    await waitFor(() => {
      expect(screen.getByTestId('search-storage-total').textContent)
        .toBe(`${t('search.storageTotal')}${t('search.storageMeasuring')}`)
    })
    expect(screen.queryByText(t('search.storageLexical'))).toBeNull()
    release()
    await waitFor(() => expect(screen.queryByText(t('search.storageLexical'))).toBeTruthy())
  })

  it('三行 + 合计;**WAL 并进字面那一行**,屏上没有「预写日志」这一行', async () => {
    stubPort(async () => READING)
    render(<SearchStorage />)

    await waitFor(() => expect(screen.queryByText(t('search.storageLexical'))).toBeTruthy())
    // 150 MB + 5 MB(WAL)= 155 MB。这一条就是「WAL 不单列」那条判词的活证据。
    expect(screen.getByText('155 MB')).toBeTruthy()
    expect(screen.getByText('1.0 MB')).toBeTruthy()
    expect(screen.getByText('129 MB')).toBeTruthy()
    expect(screen.getByTestId('search-storage-total').textContent)
      .toBe(`${t('search.storageTotal')}285 MB`)
  })

  it('还没有向量库那一行画「—」,不是「0 MB」', async () => {
    const { vectorBytes: _drop, ...noVector } = READING
    stubPort(async () => ({ ...noVector, totalBytes: 297_795_584 }))
    render(<SearchStorage />)

    await waitFor(() => expect(screen.queryByText(t('search.storageVector'))).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('0 B')).toBeNull()
  })

  it('量红了:旧值留在屏上,底下补一句「没量出来」', async () => {
    let fail = false
    stubPort(async () => {
      if (fail) throw new Error('量不到')
      return READING
    })
    render(<SearchStorage />)
    await waitFor(() => expect(screen.queryByText('155 MB')).toBeTruthy())

    fail = true
    await searchStorageQuery.refetch().catch(() => undefined)
    await waitFor(() => expect(screen.queryAllByText(t('search.storageFailed')).length).toBe(1))
    // 律②:量不到一次不等于那些地方不占了。
    expect(screen.getByText('155 MB')).toBeTruthy()
    expect(screen.getByTestId('search-storage-total').textContent)
      .toBe(`${t('search.storageTotal')}285 MB`)
  })

  it('一份都没量到过就红了:合计那一行自己说那句话', async () => {
    stubPort(async () => { throw new Error('量不到') })
    render(<SearchStorage />)

    await waitFor(() => {
      expect(screen.getByTestId('search-storage-total').textContent)
        .toBe(`${t('search.storageTotal')}${t('search.storageFailed')}`)
    })
    expect(screen.queryByText(t('search.storageLexical'))).toBeNull()
  })
})

describe('字典', () => {
  it('七句话中英成对', () => {
    for (const key of [
      'search.storageTitle',
      'search.storageLexical',
      'search.storageVector',
      'search.storageModel',
      'search.storageTotal',
      'search.storageMeasuring',
      'search.storageFailed',
    ] as const) {
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })
})
