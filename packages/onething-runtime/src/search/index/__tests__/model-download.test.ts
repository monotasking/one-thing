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
import type { ModelStatus } from '../model-download.js'

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

/**
 * `status()` 在**试装**(认领)那几秒答 `undefined`(见 `ModelDownloader.status()`)。
 * 下面这些用例都不在那一态里,所以取出来判就是了 —— 真答了 `undefined` 就是回归。
 */
function statusOf(model: ModelDownloader): ModelStatus {
  const status = model.status()
  if (status === undefined) throw new Error('这一刻不该答「检查中」')
  return status
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
    const one = statusOf(model)
    expect(one).toMatchObject({ state: 'downloading', loadedBytes: 100, totalBytes: 100 })

    // 第二个文件露面 → 总数长一截;分子也跟着涨,两条都不许回头。
    fake.progress('model.onnx', 400, 8_000)
    const two = statusOf(model)
    expect(two.loadedBytes).toBe(500)
    expect(two.totalBytes).toBe(8_100)
    fake.progress('model.onnx', 8_000, 8_000)
    expect(statusOf(model).loadedBytes).toBe(8_100)

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

    expect(statusOf(model).state).toBe('absent')
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
    // 取消**不是失败**:不留错话。
    expect(statusOf(model).errorKind).toBeUndefined()
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

    const status = statusOf(model)
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
    expect(statusOf(model).state).toBe('absent')
  })

  it('删除:开关开着时拒,关着时把目录清干净', async () => {
    const fake = makeFactory()
    let inUse = true
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, inUse: () => inUse })
    model.download()
    fake.finishFile('config.json', 100)
    fake.settle()
    await model.drain()
    expect(statusOf(model).state).toBe('ready')

    expect(() => model.remove()).toThrow(MODEL_IN_USE_ERROR)
    expect(statusOf(model).state).toBe('ready')

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

/**
 * **认领**(2026-09-17;§15.8「认领」)。事故原话:「为什么下载了也当做没下载?」——
 * 上一版「翻开关即下载」把 113 MB 完整下到了盘上,这一版换成「清单说了算」,于是那份
 * 真下全了的模型因为没有清单被当成没下过。
 *
 * 这一组钉的是补法的四条边:**装得上才认**(不是「文件在就认」)、**装不上不删**、
 * **空目录一次装载都不发生**、**试装期间不说话**(`status()` 答 `undefined`)。
 * 「真的 onnx 装不装得上」不在这里证 —— 那是 `gate:search-index` ⑬e / ⑫ 的活。
 */
describe('认领:清单缺席、文件却在', () => {
  /** 一只手动挡的「试装」:`settle()` / `fail()` 决定它装不装得上,`calls` 数它被叫了几次。 */
  function makeTryLoad() {
    let resolveLoad: (() => void) | undefined
    let rejectLoad: ((error: Error) => void) | undefined
    const state = { calls: 0 }
    return {
      get calls() { return state.calls },
      tryLoad: (): Promise<void> => {
        state.calls += 1
        return new Promise<void>((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject })
      },
      settle: () => resolveLoad?.(),
      fail: (error: Error) => rejectLoad?.(error),
    }
  }

  /** 上一版留在盘上的那一份:文件齐,**没有清单**。 */
  function writeOldFiles(): void {
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), Buffer.alloc(658, 7))
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), Buffer.alloc(1_024, 7))
    fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), Buffer.alloc(4_096, 7))
  }

  it('装得上 = 这堆文件是完整的 → 补一份清单,answer ready', async () => {
    const fake = makeFactory()
    const loader = makeTryLoad()
    writeOldFiles()

    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, tryLoad: loader.tryLoad })
    expect(loader.calls).toBe(1)

    loader.settle()
    await model.drain()

    expect(statusOf(model)).toEqual({
      id: ID, state: 'ready', loadedBytes: 5_778, totalBytes: 5_778,
    })
    // 清单是**这一步**才写下的 —— 此后它才是那句「下全了」。
    expect(probeEmbedderModel(dir, ID)).toEqual({ state: 'ready', bytes: 5_778 })
    // 一个字节都没下过:认领不是下载。
    expect(fake.started).toBe(0)
  })

  it('装不上 = 半截的 → 维持 absent,而且**文件一个都不删**(下一次下载等于续传)', async () => {
    const fake = makeFactory()
    const loader = makeTryLoad()
    writeOldFiles()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, tryLoad: loader.tryLoad })

    loader.fail(new Error('Unexpected end of ONNX protobuf'))
    await model.drain()

    expect(statusOf(model)).toEqual({ id: ID, state: 'absent', totalBytes: APPROX })
    expect(fs.existsSync(path.join(dir, 'onnx', 'model_quantized.onnx'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.onething-model.json'))).toBe(false)
  })

  it('空目录 = 从没下过 → **一次试装都不发生**(⑬a 那个「零网络」的一半)', () => {
    const fake = makeFactory()
    const loader = makeTryLoad()

    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, tryLoad: loader.tryLoad })

    expect(loader.calls).toBe(0)
    expect(statusOf(model)).toEqual({ id: ID, state: 'absent', totalBytes: APPROX })
  })

  it('试装期间**整格缺席**(壳读成「检查中…」),落定之后才有话说', async () => {
    const fake = makeFactory()
    const loader = makeTryLoad()
    writeOldFiles()

    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, tryLoad: loader.tryLoad })
    // 还不知道 —— 报「未下载」再翻成「已下载」是闪一下错话。
    expect(model.status()).toBeUndefined()

    loader.settle()
    await model.drain()
    expect(model.status()?.state).toBe('ready')
  })

  it('开关开着:认领走的就是嵌入器那一次装载 —— **只装一次**,而且不喊宿主换 Worker', async () => {
    const fake = makeFactory()
    writeOldFiles()

    // 一只记账的嵌入器:`ready()` 记过账(第二次不重装),与真嵌入器同一种形。
    let loads = 0
    let loaded: Promise<void> | undefined
    const embedder = {
      ready: async (): Promise<void> => {
        if (loaded === undefined) {
          loads += 1
          loaded = Promise.resolve()
        }
        await loaded
      },
    }

    const settled: string[] = []
    const model = new ModelDownloader({
      factory: fake.factory,
      modelDir: dir,
      // 开关开着 = 这条 Worker 装了嵌入器。
      inUse: () => true,
      tryLoad: () => embedder.ready(),
    })
    model.onSettled(state => settled.push(state))
    await model.drain()

    expect(statusOf(model).state).toBe('ready')
    // 向量写路稍后照样问一次 —— 那是同一次装载,118 MB 不装第二遍。
    await embedder.ready()
    expect(loads).toBe(1)
    /*
     * **不喊那一声**:它的用处只有「让宿主换一条 Worker 使模型生效」,而这条 Worker
     * 自己就是认领的那一条,它已经生效了 —— 换一条只会把装好的扔掉重装。
     */
    expect(settled).toEqual([])
  })

  it('认领在飞时按「下载」:试装作废,照常下,状态由下载那一发说了算', async () => {
    const fake = makeFactory()
    const loader = makeTryLoad()
    writeOldFiles()
    const model = new ModelDownloader({ factory: fake.factory, modelDir: dir, tryLoad: loader.tryLoad })
    expect(model.status()).toBeUndefined()

    expect(model.download().state).toBe('downloading')
    // 作废之后那一发试装落定也改不动状态(它的 round 早过期了)。
    loader.settle()
    await Promise.resolve()
    expect(statusOf(model).state).toBe('downloading')

    fake.finishFile('config.json', 100)
    fake.settle()
    await model.drain()
    expect(statusOf(model).state).toBe('ready')
  })
})
