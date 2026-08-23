/**
 * 设置页的能力徽标 —— 全部读账本,这个文件自己没有一张模式表。
 *
 * 生图徽标(`hasImageGeneration`)问的是「能不能出图」,与
 * `onethingModelSupportsImageGeneration`(「换不换通路」)是两个问题;拍板 #13
 * 之后 OpenAI 直连那批有原生 `image_generation` 工具的模型在这里点亮,而**通路
 * 不变**(它们仍旧走普通对话流)。
 */
import { describe, expect, it } from 'vitest'
import {
  createCustomModel,
  hasImageGeneration,
  hasVision,
} from '../model-capabilities'

describe('hasImageGeneration', () => {
  it('lights up OpenAI models that carry the native image_generation tool (#13)', () => {
    // 目录条目逐字照官方模型页:输出模态只有 text —— 图是**工具**产出的。
    const gpt55 = createCustomModel('gpt-5.5')
    expect(gpt55.architecture?.output_modalities).toEqual(['text'])
    expect(hasImageGeneration(gpt55, 'openai')).toBe(true)
    expect(hasImageGeneration(createCustomModel('gpt-4.1-mini'), 'openai')).toBe(true)
    expect(hasImageGeneration(createCustomModel('o3'), 'openai')).toBe(true)
  })

  it('stays dark for OpenAI models the official table does not list', () => {
    expect(hasImageGeneration(createCustomModel('gpt-5.4'), 'openai')).toBe(false)
    expect(hasImageGeneration(createCustomModel('gpt-5-mini'), 'openai')).toBe(false)
    expect(hasImageGeneration(createCustomModel('gpt-4o'), 'openai')).toBe(false)
    // 判据锁在 openai 家上:同一个名字经 OpenRouter 不吃这条规则。
    expect(hasImageGeneration(createCustomModel('openai/gpt-5.5'), 'openrouter')).toBe(false)
  })

  it('keeps the dedicated image endpoints lit', () => {
    const model = createCustomModel('gpt-image-1')
    model.architecture!.output_modalities = ['image']
    expect(hasImageGeneration(model, 'openai')).toBe(true)
  })

  it('leaves the other badges alone — the new rule only answers imageOutput', () => {
    // 目录条目的 `input_modalities: ['text']` 仍然说了算(vision 不受影响)。
    expect(hasVision(createCustomModel('gpt-5.5'), 'openai')).toBe(false)
    const withImages = createCustomModel('gpt-5.5')
    withImages.architecture!.input_modalities = ['text', 'image']
    expect(hasVision(withImages, 'openai')).toBe(true)
    expect(hasImageGeneration(withImages, 'openai')).toBe(true)
  })
})
