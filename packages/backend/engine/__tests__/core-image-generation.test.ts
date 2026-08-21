import { describe, expect, it } from 'vitest'
import {
  buildImageGeneratedNotification,
  buildImageGenerationErrorContent,
  buildImageStreamErrorEventPlan,
  buildImageStreamResponseContent,
  buildImageStreamStartEventPlan,
  buildImageStreamSuccessEventPlan,
  buildGeminiImageGenerationRequest,
  buildOpenAIImageGenerationRequest,
  executeCoreImageGenerationStream,
  extractGeminiImageGenerationPayload,
  extractImageGenerationResponseError,
  extractOpenAIImageGenerationPayload,
  generateCoreGeminiImage,
  generateCoreOpenAIImage,
  normalizeImageModelId,
  normalizeOpenAIImageBaseUrl,
  planImageGenerationRequest,
} from '@onething/runtime/media'

describe('onething runtime image generation helpers', () => {
  it('normalizes known OpenAI image model aliases', () => {
    expect(normalizeImageModelId('DALL-E 3')).toBe('dall-e-3')
    expect(normalizeImageModelId('DALL-E-2')).toBe('dall-e-2')
    expect(normalizeImageModelId('chatgpt-image-latest')).toBe('gpt-image-1')
    expect(normalizeImageModelId('gpt-image-1')).toBe('gpt-image-1')
  })

  it('plans provider-specific image generation requests', () => {
    expect(planImageGenerationRequest({
      providerId: 'gemini',
      model: 'gemini-2.5-flash-image',
    })).toEqual({
      providerKind: 'gemini',
      modelForDisplay: 'gemini-2.5-flash-image',
      modelForRequest: 'gemini-2.5-flash-image',
    })

    expect(planImageGenerationRequest({
      providerId: 'openai',
      model: 'DALL-E 3',
    })).toEqual({
      providerKind: 'openai-compatible',
      modelForDisplay: 'dall-e-3',
      modelForRequest: 'dall-e-3',
      baseUrl: 'https://api.openai.com/v1',
    })
  })

  it('builds and parses OpenAI-compatible image generation payloads in core', () => {
    expect(normalizeOpenAIImageBaseUrl('https://openai.test/v1/')).toBe('https://openai.test/v1')
    expect(normalizeOpenAIImageBaseUrl(undefined)).toBe('https://api.openai.com/v1')

    expect(buildOpenAIImageGenerationRequest('dall-e-3', 'draw', {
      size: '1024x1792',
      quality: 'hd',
      style: 'natural',
    })).toEqual({
      model: 'dall-e-3',
      prompt: 'draw',
      size: '1024x1792',
      style: 'natural',
      quality: 'hd',
      response_format: 'b64_json',
    })

    expect(buildOpenAIImageGenerationRequest('gpt-image-1', 'draw')).toEqual({
      model: 'gpt-image-1',
      prompt: 'draw',
      size: '1024x1024',
      quality: 'auto',
    })

    expect(extractOpenAIImageGenerationPayload({
      data: [{
        b64_json: 'abc',
        revised_prompt: 'better draw',
      }],
    })).toEqual({
      success: true,
      imageBase64: 'abc',
      imageUrl: undefined,
      revisedPrompt: 'better draw',
    })

    expect(extractOpenAIImageGenerationPayload({
      data: [{ url: 'https://cdn.test/generated.png' }],
    })).toEqual({
      success: true,
      imageBase64: undefined,
      imageUrl: 'https://cdn.test/generated.png',
      revisedPrompt: undefined,
    })

    expect(extractOpenAIImageGenerationPayload({
      error: { message: 'bad key' },
    })).toEqual({ success: false, error: 'bad key' })
    expect(extractImageGenerationResponseError(
      '{"error":{"message":"bad request"}}',
      'fallback',
    )).toBe('bad request')
  })

  it('builds and parses Gemini image generation payloads in core', () => {
    expect(buildGeminiImageGenerationRequest('draw')).toEqual({
      contents: [{
        role: 'user',
        parts: [{ text: 'draw' }],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    })

    expect(extractGeminiImageGenerationPayload({
      candidates: [{
        content: {
          parts: [{
            inline_data: {
              mime_type: 'image/png',
              data: 'gemini-image',
            },
          }],
        },
      }],
    })).toEqual({
      success: true,
      imageBase64: 'gemini-image',
    })

    expect(extractGeminiImageGenerationPayload({
      candidates: [{
        content: {
          parts: [{ text: 'text only' }],
        },
      }],
    })).toEqual({
      success: false,
      error: 'Model returned text instead of image: text only',
    })
  })

  it('runs OpenAI-compatible image generation through injected fetch in core', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/images/generations')) {
        return new Response(JSON.stringify({
          data: [{
            url: 'https://cdn.test/generated.png',
            revised_prompt: 'better draw',
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }

    await expect(generateCoreOpenAIImage({
      apiKey: 'key',
      baseUrl: 'https://openai.test/v1/',
      model: 'dall-e-3',
      prompt: 'draw',
      imageOptions: { size: '1024x1792' },
      fetch: fetchImpl,
    })).resolves.toEqual({
      success: true,
      imageBase64: 'AQID',
      revisedPrompt: 'better draw',
    })

    expect(calls.map(call => call.url)).toEqual([
      'https://openai.test/v1/images/generations',
      'https://cdn.test/generated.png',
    ])
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'dall-e-3',
      prompt: 'draw',
      size: '1024x1792',
    })
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer key')
  })

  it('returns normalized OpenAI-compatible image errors from core', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      error: { message: 'bad key' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })

    await expect(generateCoreOpenAIImage({
      apiKey: 'bad',
      baseUrl: 'https://openai.test/v1',
      model: 'gpt-image-1',
      prompt: 'draw',
      fetch: fetchImpl,
    })).resolves.toEqual({
      success: false,
      error: 'bad key',
    })
  })

  it('runs Gemini image generation through injected fetch in core', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: 'image/png',
                data: 'gemini-image',
              },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await expect(generateCoreGeminiImage({
      apiKey: 'gemini-key',
      model: 'gemini image',
      prompt: 'draw',
      fetch: fetchImpl,
    })).resolves.toEqual({
      success: true,
      imageBase64: 'gemini-image',
    })

    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini%20image:generateContent')
    expect((calls[0].init?.headers as Record<string, string>)['x-goog-api-key']).toBe('gemini-key')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(buildGeminiImageGenerationRequest('draw'))
  })

  it('formats image stream content and notifications without main media APIs', () => {
    expect(buildImageStreamResponseContent({
      prompt: 'draw a cat',
      revisedPrompt: 'draw a bright cat',
      imageBase64: 'abc123',
      mediaId: 'media-1',
    })).toBe('**优化后的提示词:** draw a bright cat\n\n![Generated Image|mediaId:media-1](data:image/png;base64,abc123)')

    expect(buildImageGenerationErrorContent()).toBe('图片生成失败: 未知错误')
    expect(buildImageStreamStartEventPlan({
      assistantMessageId: 'm1',
      model: 'dall-e-3',
    })).toEqual({
      startEvent: {
        type: 'stream:start',
        messageId: 'm1',
        assistantMessageId: 'm1',
        model: 'dall-e-3',
      },
      loadingEvent: {
        type: 'content:part',
        part: { type: 'image-loading', label: 'Generating image' },
      },
    })
    expect(buildImageStreamSuccessEventPlan({
      responseContent: '![image](data:image/png;base64,abc)',
      sessionName: 'Session',
    })).toEqual({
      streamChunk: {
        type: 'text-delta',
        text: '![image](data:image/png;base64,abc)',
      },
      contentEvent: {
        type: 'content:part',
        part: { type: 'text', content: '![image](data:image/png;base64,abc)' },
      },
      completeEvent: {
        type: 'stream:complete',
        data: { sessionName: 'Session' },
      },
    })
    expect(buildImageStreamErrorEventPlan('bad key')).toEqual({
      errorContent: '图片生成失败: bad key',
      errorEvent: {
        type: 'stream:error',
        data: { error: 'bad key' },
      },
    })
    expect(buildImageGeneratedNotification({
      mediaId: 'media-1',
      filePath: '/tmp/media-1.png',
      prompt: 'draw',
      model: 'dall-e-3',
      sessionId: 's1',
      messageId: 'm1',
      createdAt: 1,
    })).toEqual({
      id: 'media-1',
      mediaId: 'media-1',
      filePath: '/tmp/media-1.png',
      prompt: 'draw',
      revisedPrompt: undefined,
      model: 'dall-e-3',
      sessionId: 's1',
      messageId: 'm1',
      createdAt: 1,
    })
  })

  it('runs the image stream success lifecycle through core adapters', async () => {
    const events: Array<{ sessionId: string; event: { type: string } }> = []
    const chunks: Array<{ sessionId: string; text: string }> = []
    const storeCalls: string[] = []
    const notifications: unknown[] = []

    await expect(executeCoreImageGenerationStream({
      sessionId: 's1',
      assistantMessageId: 'm1',
      prompt: 'draw a sunrise',
      providerId: 'openai',
      apiKey: 'key',
      model: 'DALL-E 3',
      emitEvent: (sessionId, event) => {
        events.push({ sessionId, event })
      },
      pushStreamChunk: (sessionId, chunk) => {
        chunks.push({ sessionId, text: chunk.text })
      },
      generateOpenAIImage: input => {
        expect(input).toMatchObject({
          apiKey: 'key',
          baseUrl: 'https://api.openai.com/v1',
          model: 'dall-e-3',
          prompt: 'draw a sunrise',
        })
        return {
          success: true,
          imageBase64: 'img',
          revisedPrompt: 'draw a warm sunrise',
        }
      },
      generateGeminiImage: () => {
        throw new Error('gemini should not be used')
      },
      saveMediaImage: input => {
        expect(input).toMatchObject({
          base64: 'img',
          model: 'dall-e-3',
          sessionId: 's1',
          messageId: 'm1',
        })
        return {
          id: 'media-1',
          filePath: '/tmp/media-1.png',
          createdAt: 123,
        }
      },
      store: {
        updateMessageContent: (_sessionId, _messageId, content) => {
          storeCalls.push(`content:${content}`)
        },
        addMessageContentPart: (_sessionId, _messageId, part) => {
          storeCalls.push(`part:${part.content}`)
        },
        updateMessageStreaming: (_sessionId, _messageId, streaming) => {
          storeCalls.push(`streaming:${streaming}`)
        },
        flushSessionSave: sessionId => {
          storeCalls.push(`flush:${sessionId}`)
        },
      },
      notifyImageGenerated: notification => {
        notifications.push(notification)
      },
    })).resolves.toBe(true)

    expect(events.map(entry => entry.event.type)).toEqual([
      'stream:start',
      'content:part',
      'content:part',
      'stream:complete',
    ])
    expect(chunks).toEqual([{
      sessionId: 's1',
      text: '**优化后的提示词:** draw a warm sunrise\n\n![Generated Image|mediaId:media-1](data:image/png;base64,img)',
    }])
    expect(storeCalls).toEqual([
      'content:**优化后的提示词:** draw a warm sunrise\n\n![Generated Image|mediaId:media-1](data:image/png;base64,img)',
      'part:**优化后的提示词:** draw a warm sunrise\n\n![Generated Image|mediaId:media-1](data:image/png;base64,img)',
      'streaming:false',
      'flush:s1',
    ])
    expect(notifications).toEqual([{
      id: 'media-1',
      mediaId: 'media-1',
      filePath: '/tmp/media-1.png',
      prompt: 'draw a sunrise',
      revisedPrompt: 'draw a warm sunrise',
      model: 'dall-e-3',
      sessionId: 's1',
      messageId: 'm1',
      createdAt: 123,
    }])
  })

  it('runs the image stream error lifecycle through core adapters', async () => {
    const events: string[] = []
    const storeCalls: string[] = []

    await expect(executeCoreImageGenerationStream({
      sessionId: 's1',
      assistantMessageId: 'm1',
      prompt: 'draw a sunrise',
      providerId: 'gemini',
      apiKey: 'key',
      model: 'gemini-image',
      emitEvent: (_sessionId, event) => {
        events.push(event.type)
      },
      generateOpenAIImage: () => {
        throw new Error('openai should not be used')
      },
      generateGeminiImage: input => {
        expect(input).toMatchObject({
          apiKey: 'key',
          model: 'gemini-image',
          prompt: 'draw a sunrise',
        })
        return {
          success: false,
          error: 'model returned text',
        }
      },
      saveMediaImage: () => {
        throw new Error('media should not be saved')
      },
      store: {
        updateMessageContent: (_sessionId, _messageId, content) => {
          storeCalls.push(`content:${content}`)
        },
        addMessageContentPart: () => {
          storeCalls.push('part')
        },
        updateMessageStreaming: (_sessionId, _messageId, streaming) => {
          storeCalls.push(`streaming:${streaming}`)
        },
        flushSessionSave: sessionId => {
          storeCalls.push(`flush:${sessionId}`)
        },
      },
    })).resolves.toBe(true)

    expect(events).toEqual([
      'stream:start',
      'content:part',
      'stream:error',
    ])
    expect(storeCalls).toEqual([
      'content:图片生成失败: model returned text',
      'streaming:false',
      'flush:s1',
    ])
  })
})
