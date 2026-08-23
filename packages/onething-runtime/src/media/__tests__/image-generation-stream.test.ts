import { describe, expect, it, vi } from 'vitest'
import {
  executeOnethingImageGenerationStream,
} from '../image-generation.js'

describe('executeOnethingImageGenerationStream', () => {
  it('runs image stream orchestration through the onething runtime entry point', async () => {
    const emitEvent = vi.fn()
    const pushStreamChunk = vi.fn()
    const generateOpenAIImage = vi.fn(async () => ({
      success: true,
      imageBase64: 'ZmFrZQ==',
      revisedPrompt: 'a small painted cabin',
    }))
    const saveMediaImage = vi.fn(async () => ({
      id: 'media-1',
      filePath: '/tmp/image.png',
      createdAt: 123,
    }))
    const store = {
      updateMessageContent: vi.fn(),
      addMessageContentPart: vi.fn(),
      updateMessageStreaming: vi.fn(),
      flushSessionSave: vi.fn(),
    }
    const notifyImageGenerated = vi.fn()

    await expect(executeOnethingImageGenerationStream({
      sessionId: 'session-1',
      assistantMessageId: 'assistant-1',
      prompt: 'a cabin',
      providerId: 'openai',
      apiKey: 'test-key',
      model: 'gpt-image-1',
      baseUrl: 'https://images.example/v1',
      sessionName: 'Image session',
      emitEvent,
      pushStreamChunk,
      generateOpenAIImage,
      saveMediaImage,
      store,
      notifyImageGenerated,
    })).resolves.toBe(true)

    expect(generateOpenAIImage).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseUrl: 'https://images.example/v1',
      model: 'gpt-image-1',
      prompt: 'a cabin',
    })
    expect(saveMediaImage).toHaveBeenCalledWith({
      base64: 'ZmFrZQ==',
      prompt: 'a cabin',
      revisedPrompt: 'a small painted cabin',
      model: 'gpt-image-1',
      sessionId: 'session-1',
      messageId: 'assistant-1',
    })

    const responseContent = expect.stringContaining('mediaId:media-1')
    expect(store.updateMessageContent).toHaveBeenCalledWith('session-1', 'assistant-1', responseContent)
    expect(store.addMessageContentPart).toHaveBeenCalledWith('session-1', 'assistant-1', {
      type: 'text',
      content: responseContent,
    })
    expect(store.updateMessageStreaming).toHaveBeenCalledWith('session-1', 'assistant-1', false)
    expect(store.flushSessionSave).toHaveBeenCalledWith('session-1')
    expect(pushStreamChunk).toHaveBeenCalledWith('session-1', expect.objectContaining({
      type: 'text-delta',
      text: responseContent,
    }))
    expect(emitEvent).toHaveBeenCalledWith('session-1', expect.objectContaining({ type: 'stream:start' }))
    expect(emitEvent).toHaveBeenCalledWith('session-1', expect.objectContaining({ type: 'stream:complete' }))
    expect(notifyImageGenerated).toHaveBeenCalledWith(expect.objectContaining({
      mediaId: 'media-1',
      filePath: '/tmp/image.png',
      prompt: 'a cabin',
      revisedPrompt: 'a small painted cabin',
      model: 'gpt-image-1',
      sessionId: 'session-1',
      messageId: 'assistant-1',
      createdAt: 123,
    }))
  })
})
