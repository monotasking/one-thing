/**
 * `ModelDownloader` 的四个态与三个动作(§15.8;2026-09-17 用户裁定「把开关和下载模型
 * 拆开,另外下载模型要能够知道进度」)。
 *
 * 这里不下任何真东西:嵌入器工厂是个假的,它的 `download` 自己往目录里写几个文件、
 * 自己喊进度、自己认 signal —— 于是**聚合进度、取消语义、清单落定**这三件事各自可以
 * 被单独钉死,而「transformers 到底怎么下」由 `gate:search-index` 在真产物上证。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Embedder } from '@onething/core/search'

import { probeEmbedderModel } from '../../embedding/model-store.js'
import type { EmbedderDownloadOptions, EmbedderFactory } from '../../embedding/registry.js'
import { MODEL_IN_USE_ERROR, MODEL_NOT_DOWNLOADABLE_ERROR, ModelDownloader } from '../model-download.js'

const ID = 'fake-downloadable'
const APPROX = 9_000

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-model-download-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 一只手动挡的闸:`begin()` 交出 signal,`abort()` 拉它。与真 `WorkerDownloadSignal` 同形。 */
function makeSignals() {
  let controller: AbortController | undefined
  return {
    begin(): AbortSignal {
      controller = new AbortController()
      return controller.signal
    },
    abort(): void { controller?.abort() },
    end(): void { controller = undefined },
  }
}

interface FakeDownload {
  factory: EmbedderFactory
  /** 手动推进:喊一次进度 / 落一个文件 / 收场。 */
  progress(file: string, loaded: number, total: number): void
  finishFile(file: string, bytes: number): void
  settle(): void
  fail(error: Error): void
  started: number
}

function makeFactory(): FakeDownload {
  let resolveRun: (() => void) | undefined
  let rejectRun: ((error: Error) => void) | undefined
  let onFile: EmbedderDownloadOptions['onFile']
  const state = { started: 0 }

  const factory: EmbedderFactory = {
    id: ID,
    create: () => ({} as Embedder),
    model: { approxBytes: APPROX },
    download: async options => {
      state.started += 1
      onFile = options.onFile
      await new Promise<void>((resolve, reject) => {
        resolveRun = resolve
        rejectRun = reject
        options.signal?.addEventListener('abort', () => {
          const error = new Error('model download cancelled')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
  }

  return {
    factory,
    get started() { return state.started },
    progress: (file, loaded, total) => onFile?.({ file, loaded, total }),
    finishFile: (file, bytes) => {
      const full = path.join(dir, file)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, Buffer.alloc(bytes, 3))
    },
    settle: () => resolveRun?.(),
    fail: error => rejectRun?.(error),
  }
}

describe('模型是一件独立的东西:四个态 + 三个动作', () => {
  it('没下过 = absent,总数报的是嵌入器自述的**估计值**', () => {
    const fake = makeFactory()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir })
    expect(model.status()).toEqual({ id: ID, state: 'absent', totalBytes: APPROX })
  })

  it('下载:进度逐文件聚合,总数单调不减,落定写清单 → ready', async () => {
    const fake = makeFactory()
    const settled: string[] = []
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir })
    model.onSettled(state => settled.push(state))

    expect(model.download().state).toBe('downloading')

    fake.progress('config.json', 100, 100)
    const one = model.status()
    expect(one).toMatchObject({ state: 'downloading', loadedBytes: 100, totalBytes: 100 })

    // 第二个文件露面 → 总数长一截;分子也跟着涨,两条都不许回头。
    fake.progress('model.onnx', 400, 8_000)
    const two = model.status()
    expect(two.loadedBytes).toBe(500)
    expect(two.totalBytes).toBe(8_100)
    fake.progress('model.onnx', 8_000, 8_000)
    expect(model.status().loadedBytes).toBe(8_100)

    fake.finishFile('config.json', 100)
    fake.finishFile('model.onnx', 8_000)
    fake.settle()
    await model.drain()

    expect(model.status()).toEqual({
      id: ID, state: 'ready', loadedBytes: 8_100, totalBytes: 8_100,
    })
    // 落定那一声是宿主换 Worker 的触发点(「下完就生效」)。
    expect(settled).toEqual(['ready'])
  })

  it('已经 ready 了再按「下载」= 什么都不做(幂等,不重下)', async () => {
    const fake = makeFactory()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir })
    model.download()
    fake.finishFile('config.json', 100)
    fake.settle()
    await model.drain()

    expect(model.download().state).toBe('ready')
    expect(fake.started).toBe(1)
  })

  /**
   * **派工单要求「必须证明」的那一条**:取消之后再下,半截文件不会被当成完整的。
   *
   * 判据不在这个类里 —— 清单是落定才写的(`model-store.ts`)。这里证的是那条判据在
   * 取消这条路上真的生效:取消后回 `absent`,而且此后 `download()` 真的又起了一发。
   */
  it('取消:当场回 absent,半截文件说不了「下全了」,再下是真的再下一发', async () => {
    const fake = makeFactory()
    const signals = makeSignals()
    const settled: string[] = []
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, signals })
    model.onSettled(state => settled.push(state))

    model.download()
    fake.progress('model.onnx', 3_000, 8_000)
    // 下到一半:文件在磁盘上,但小一号。
    fake.finishFile('model.onnx', 3_000)

    expect(model.cancel().state).toBe('absent')
    await model.drain()

    expect(model.status().state).toBe('absent')
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
    // 取消**不是失败**:不留错话。
    expect(model.status().errorKind).toBeUndefined()
    expect(settled).toEqual(['absent'])

    expect(model.download().state).toBe('downloading')
    expect(fake.started).toBe(2)
  })

  it('失败:留下原因码 + 原话(与语义召回自己关回去共用同一张判据表)', async () => {
    const fake = makeFactory()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir })
    model.download()
    fake.fail(new Error('TypeError: fetch failed'))
    await model.drain()

    const status = model.status()
    expect(status.state).toBe('failed')
    expect(status.errorKind).toBe('network')
    expect(status.error).toContain('fetch failed')
  })

  it('那一发说成了但磁盘上不齐 = absent,不是 ready(判据永远是磁盘)', async () => {
    const fake = makeFactory()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir })
    model.download()
    fake.settle()
    await model.drain()
    expect(model.status().state).toBe('absent')
  })

  it('删除:开关开着时拒,关着时把目录清干净', async () => {
    const fake = makeFactory()
    let inUse = true
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, inUse: () => inUse })
    model.download()
    fake.finishFile('config.json', 100)
    fake.settle()
    await model.drain()
    expect(model.status().state).toBe('ready')

    expect(() => model.remove()).toThrow(MODEL_IN_USE_ERROR)
    expect(model.status().state).toBe('ready')

    inUse = false
    expect(model.remove()).toEqual({ id: ID, state: 'absent', totalBytes: APPROX })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('这条嵌入器没有可下的模型 = 结构化拒绝,不假装', () => {
    const factory: EmbedderFactory = { id: 'fake', create: () => ({} as Embedder) }
    const model = new ModelDownloader({ factory, modelDir: dir })
    expect(() => model.download()).toThrow(MODEL_NOT_DOWNLOADABLE_ERROR)
    // `model` 那一格缺席时连估计值都不报 —— 不知道就不说。
    expect(model.status()).toEqual({ id: 'fake', state: 'absent' })
  })
})
