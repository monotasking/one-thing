/**
 * 「这份模型下全了没有」的判据(§15.8;产地 `model-store.ts`)。
 *
 * 用户裁定「把开关和下载模型拆开」之后,这个问题有了一个**新的、每天都要答**的读者:
 * 设置页那一行模型。答错的代价是两种谎话,这个文件各钉一条:
 *  - 半截文件被当成下全了 → 开开关之后在 ONNX 那一层抛,屏上写「运行时装不上」,
 *    而真因是文件是半截的(transformers 的 `FileCache` 直接写最终路径,没有 `.part`);
 *  - 下全了却说没下 → 用户永远在按「下载」,那是个死循环。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MODEL_MANIFEST_FILE,
  captureModelManifest,
  hasEmbedderModelFiles,
  isEmbedderModelPresent,
  probeEmbedderModel,
  readModelManifest,
  removeEmbedderModel,
} from '../model-store.js'

const ID = 'multilingual-e5-small'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-model-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(relative: string, bytes: number): void {
  const full = path.join(dir, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, Buffer.alloc(bytes, 7))
}

describe('模型清单 = 下全了的唯一判据', () => {
  it('没有清单 = 没下(哪怕目录里文件都在)', () => {
    write('Xenova/m/config.json', 12)
    write('Xenova/m/onnx/model_quantized.onnx', 4096)
    expect(probeEmbedderModel(dir, ID)).toEqual({ state: 'absent', bytes: 0 })
    expect(isEmbedderModelPresent(dir, ID)).toBe(false)
  })

  it('下载落定写下清单 → ready,字节数是磁盘上的真数', () => {
    write('Xenova/m/config.json', 12)
    write('Xenova/m/onnx/model_quantized.onnx', 4096)
    const manifest = captureModelManifest(dir, ID)

    expect(manifest.id).toBe(ID)
    expect(manifest.bytes).toBe(4108)
    // 清单自己不算进去 —— 否则它一写下去就与自己记的数对不上。
    expect(Object.keys(manifest.files).sort()).toEqual([
      'Xenova/m/config.json',
      'Xenova/m/onnx/model_quantized.onnx',
    ])
    expect(probeEmbedderModel(dir, ID)).toEqual({ state: 'ready', bytes: 4108 })
  })

  /**
   * **这一条就是派工单要求「必须证明」的那一条**:取消之后再下,半截文件不许被当成完整的。
   *
   * 现场逐字重演:清单是下载**落定**才写的,所以「下到一半被取消」= 磁盘上有个小一号的
   * onnx、没有清单。判据一句话就挡住了。
   */
  it('半截下载(有文件、没清单)不可能被当成完整的', () => {
    write('Xenova/m/onnx/model_quantized.onnx', 1024)
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
    expect(fs.existsSync(path.join(dir, MODEL_MANIFEST_FILE))).toBe(false)
  })

  it('下全之后文件被截断 / 删掉 → 回到 absent(字节数逐个核对,不是只看在不在)', () => {
    write('Xenova/m/config.json', 12)
    write('Xenova/m/onnx/model_quantized.onnx', 4096)
    captureModelManifest(dir, ID)
    expect(probeEmbedderModel(dir, ID).state).toBe('ready')

    write('Xenova/m/onnx/model_quantized.onnx', 512)
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')

    fs.rmSync(path.join(dir, 'Xenova/m/onnx/model_quantized.onnx'))
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
  })

  it('换了嵌入器 = 旧清单作不了证(同一个目录不同 id)', () => {
    write('Xenova/m/config.json', 12)
    captureModelManifest(dir, ID)
    expect(probeEmbedderModel(dir, 'some-other-embedder').state).toBe('absent')
  })

  it('空清单说不了「下全了」(挡住「往空目录里写一份清单」这种说谎法)', () => {
    const manifest = captureModelManifest(dir, ID)
    expect(manifest.files).toEqual({})
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
  })

  it('坏清单 = 没有清单,不抛', () => {
    fs.writeFileSync(path.join(dir, MODEL_MANIFEST_FILE), '{ 这不是 json')
    expect(readModelManifest(dir)).toBeUndefined()
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
  })

  /**
   * 「认领」的前置(2026-09-17,§15.8):清单缺席时,**空目录**与**满目录**是两件事 ——
   * 前者当场 `absent`(一次试装都不发生),后者才值得试装一次。它不是「下全了没有」
   * 的判据,那句话只有 `probeEmbedderModel` 说得出口。
   */
  it('有没有东西:空目录 / 目录不存在 / 只有一份清单,三样都是「没有」', () => {
    expect(hasEmbedderModelFiles(path.join(dir, '不存在'))).toBe(false)
    expect(hasEmbedderModelFiles(dir)).toBe(false)
    // 清单自己不算「东西」(否则删掉文件只剩清单时会去试装一次空气)。
    captureModelManifest(dir, ID)
    expect(hasEmbedderModelFiles(dir)).toBe(false)

    write('Xenova/m/config.json', 12)
    expect(hasEmbedderModelFiles(dir)).toBe(true)
  })

  it('删除:整个目录连清单一起没了', () => {
    write('Xenova/m/config.json', 12)
    captureModelManifest(dir, ID)
    removeEmbedderModel(dir)
    expect(fs.existsSync(dir)).toBe(false)
    // 目录不在也答得出(不抛)。
    expect(probeEmbedderModel(dir, ID).state).toBe('absent')
  })
})
