/**
 * 模型那三个动作**过得了 Worker 协议**,而且落定那一声喊得到宿主(§15.8)。
 *
 * 这一条与 `model-download.test.ts` 的分工是硬的:那个文件证的是**状态机**
 * (进度怎么聚、取消是什么语义、清单什么时候写),这个文件证的是**协议**——
 * 三个动作的往返、状态跟着 `search.status` 一起回来、以及那个**不带 `id` 的通知帧**
 * 不会被当成一条没人等的答复扔掉(日志帧当年正是这么掉了两周,见 `worker-logging.ts`)。
 *
 * 「下完就生效」整条链的最后一环在装配层(`backend/wiring/search/index.ts` 收到这一声
 * 就 `restart()`);这里钉的是**这一声真的发得出来**。
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { Embedder } from '@onething/core/search'

import { probeEmbedderModel } from '../../embedding/model-store.js'
import type { EmbedderFactory } from '../../embedding/registry.js'
import { ModelDownloader } from '../model-download.js'
import { SearchIndexService } from '../service.js'
import { MODEL_UNAVAILABLE_ERROR } from '../worker-core.js'
import { createSameThreadWorker, createTempStore } from './helpers.js'
import type { SameThreadWorker, TempStore } from './helpers.js'

import fs from 'node:fs'
import path from 'node:path'

const ID = 'protocol-fake-model'

const stores: TempStore[] = []
const spawned: SameThreadWorker[] = []
afterEach(() => {
  for (const worker of spawned.splice(0)) worker.handle.terminate()
  for (const store of stores.splice(0)) store.dispose()
})

function newStore(): TempStore {
  const store = createTempStore()
  stores.push(store)
  return store
}

/** 一只「立刻下完」的假嵌入器:写一个文件就收工。 */
function instantFactory(modelDir: string): EmbedderFactory {
  return {
    id: ID,
    create: () => ({} as Embedder),
    model: { approxBytes: 4_242 },
    download: async options => {
      options.onFile?.({ file: 'model.bin', loaded: 64, total: 64 })
      fs.mkdirSync(modelDir, { recursive: true })
      fs.writeFileSync(path.join(modelDir, 'model.bin'), Buffer.alloc(64, 1))
      await Promise.resolve()
    },
  }
}

describe('模型三动作过协议', () => {
  it('download → 落定 → 宿主收到那一声,状态也跟着 `status` 一起回来', async () => {
    const store = newStore()
    const modelDir = path.join(store.root, 'models', 'embeddings', ID)
    const model = new ModelDownloader({ factory: instantFactory(modelDir), modelDir })

    const settled: string[] = []
    const service = new SearchIndexService({
      createWorker: () => {
        const worker = createSameThreadWorker({
          indexPath: store.indexPath,
          feeds: [],
          debounceMs: 5,
          model,
        })
        spawned.push(worker)
        return worker.handle
      },
    })
    service.onModelSettled(state => settled.push(state))
    service.start()

    // 出厂:没下过。`status` 那一发就带着它 —— 壳不必为模型再开一条口。
    expect((await service.status()).model).toEqual({ id: ID, state: 'absent', totalBytes: 4_242 })

    const started = await service.downloadModel()
    expect(started.state).toBe('downloading')
    await model.drain()

    expect((await service.status()).model).toMatchObject({ state: 'ready', loadedBytes: 64 })
    expect(probeEmbedderModel(modelDir, ID).state).toBe('ready')
    // **不带 `id` 的通知帧没有掉在地上**(那正是日志帧当年的病)。
    expect(settled).toEqual(['ready'])

    // 开关关着(这条 Worker 没装嵌入器)→ 删得掉。
    expect((await service.removeModel()).state).toBe('absent')
    expect(fs.existsSync(modelDir)).toBe(false)

    await service.dispose()
  })

  /**
   * 认领(2026-09-17,§15.8):试装那几秒 `status.model` **整格不出现**,与「这条
   * Worker 管不了模型」同一种缺席 —— 壳两边都读成 unknown「检查中…」,一颗钮不画。
   * 这里钉的是**缺席真的过得了协议**(`undefined` 不会被序列化成一个空对象)。
   */
  it('试装期间 status.model 缺席,落定之后才出现', async () => {
    const store = newStore()
    const modelDir = path.join(store.root, 'models', 'embeddings', ID)
    // 上一版留下的那一份:文件在、清单不在。
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'model.bin'), Buffer.alloc(64, 1))

    let settleLoad: (() => void) | undefined
    const model = new ModelDownloader({
      factory: instantFactory(modelDir),
      modelDir,
      tryLoad: () => new Promise<void>(resolve => { settleLoad = resolve }),
    })

    const service = new SearchIndexService({
      createWorker: () => {
        const worker = createSameThreadWorker({
          indexPath: store.indexPath,
          feeds: [],
          debounceMs: 5,
          model,
        })
        spawned.push(worker)
        return worker.handle
      },
    })
    service.start()

    expect((await service.status()).model).toBeUndefined()

    settleLoad?.()
    await model.drain()

    expect((await service.status()).model).toEqual({
      id: ID, state: 'ready', loadedBytes: 64, totalBytes: 64,
    })
    expect(probeEmbedderModel(modelDir, ID).state).toBe('ready')

    await service.dispose()
  })

  it('这条 Worker 管不了模型 = 结构化拒绝,不假装收下', async () => {
    const store = newStore()
    const service = new SearchIndexService({
      createWorker: () => {
        const worker = createSameThreadWorker({ indexPath: store.indexPath, feeds: [], debounceMs: 5 })
        spawned.push(worker)
        return worker.handle
      },
    })
    service.start()

    await expect(service.downloadModel()).rejects.toThrow(MODEL_UNAVAILABLE_ERROR)
    // 管不了就**缺席**,不是「没下」—— 壳据此画「检查中」,不画一颗按不动的下载钮。
    expect((await service.status()).model).toBeUndefined()

    await service.dispose()
  })
})
