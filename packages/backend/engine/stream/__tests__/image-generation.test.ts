import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchHolder } = vi.hoisted(() => ({
  fetchHolder: {
    current: vi.fn(),
  },
}))

vi.mock('../../../providers/bound-fetch.js', () => ({
  createAppFetch: () => fetchHolder.current,
}))

import {
  generateGeminiImage,
  generateImage,
  normalizeImageModelId,
} from '../image-generation.js'

describe('native image generation', () => {
  beforeEach(() => {
    fetchHolder.current = vi.fn()
  })

  it('normalizes known OpenAI image model aliases', () => {
    expect(normalizeImageModelId('DALL-E 3')).toBe('dall-e-3')
    expect(normalizeImageModelId('chatgpt-image-latest')).toBe('gpt-image-1')
    expect(normalizeImageModelId('gpt-image-1')).toBe('gpt-image-1')
  })

  it('generates OpenAI-compatible images through the REST API without the AI SDK', async () => {
    fetchHolder.current.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{
        b64_json: 'image-base64',
        revised_prompt: 'A polished prompt',
      }],
    }), { status: 200 }))

    const result = await generateImage(
      'openai-key',
      'https://openai.test/v1/',
      'dall-e-3',
      'draw a calm workspace',
      {
        size: '1024x1792',
        quality: 'hd',
        style: 'natural',
      },
    )

    expect(result).toEqual({
      success: true,
      imageBase64: 'image-base64',
      revisedPrompt: 'A polished prompt',
    })
    expect(fetchHolder.current).toHaveBeenCalledTimes(1)
    const [url, init] = fetchHolder.current.mock.calls[0]
    expect(url).toBe('https://openai.test/v1/images/generations')
    expect(init.headers.Authorization).toBe('Bearer openai-key')
    expect(JSON.parse(init.body)).toEqual({
      model: 'dall-e-3',
      prompt: 'draw a calm workspace',
      size: '1024x1792',
      style: 'natural',
      quality: 'hd',
      response_format: 'b64_json',
    })
  })

  it('fetches OpenAI image URLs when the API does not return base64', async () => {
    fetchHolder.current
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'https://cdn.test/generated.png' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))

    const result = await generateImage(
      'openai-key',
      'https://openai.test/v1',
      'dall-e-2',
      'draw a small icon',
    )

    expect(result).toEqual({
      success: true,
      imageBase64: Buffer.from([1, 2, 3]).toString('base64'),
      revisedPrompt: undefined,
    })
    expect(fetchHolder.current).toHaveBeenNthCalledWith(2, 'https://cdn.test/generated.png')
  })

  it('generates Gemini images through generateContent without the AI SDK', async () => {
    fetchHolder.current.mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: 'image/png',
              data: 'gemini-image-base64',
            },
          }],
        },
      }],
    }), { status: 200 }))

    const result = await generateGeminiImage(
      'gemini-key',
      'gemini-2.5-flash-image',
      'make a product shot',
    )

    expect(result).toEqual({
      success: true,
      imageBase64: 'gemini-image-base64',
    })
    expect(fetchHolder.current).toHaveBeenCalledTimes(1)
    const [url, init] = fetchHolder.current.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent')
    expect(init.headers['x-goog-api-key']).toBe('gemini-key')
    expect(JSON.parse(init.body)).toEqual({
      contents: [{
        role: 'user',
        parts: [{ text: 'make a product shot' }],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    })
  })

  it('reports Gemini text-only responses as image generation failures', async () => {
    fetchHolder.current.mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: 'I cannot create an image for that prompt.' }],
        },
      }],
    }), { status: 200 }))

    const result = await generateGeminiImage(
      'gemini-key',
      'gemini-2.5-flash-image',
      'make an image',
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Model returned text instead of image')
  })
})
