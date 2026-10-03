import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingPromptForIpc,
  deleteOnethingPromptForIpc,
  getOnethingPromptForIpc,
  listOnethingPromptsForIpc,
  updateOnethingPromptForIpc,
} from '../ipc-operations.js'

describe('prompt IPC operations', () => {
  const prompt = {
    id: 'prompt-1',
    title: 'Review',
    body: 'Review this.',
    createdAt: 1,
    updatedAt: 1,
  }

  it('formats prompt CRUD responses through adapters', () => {
    expect(listOnethingPromptsForIpc({
      listPrompts: () => [prompt],
    })).toEqual({ success: true, prompts: [prompt] })

    expect(getOnethingPromptForIpc({
      request: { id: 'prompt-1' },
      getPrompt: () => prompt,
    })).toEqual({ success: true, prompt })

    expect(createOnethingPromptForIpc({
      request: { title: 'New', body: 'Body' },
      createPrompt: request => ({ ...prompt, ...request }),
    })).toEqual({
      success: true,
      prompt: { ...prompt, title: 'New', body: 'Body' },
    })

    expect(updateOnethingPromptForIpc({
      request: { id: 'prompt-1', title: 'Updated' },
      updatePrompt: request => ({ ...prompt, ...request }),
    })).toEqual({
      success: true,
      prompt: { ...prompt, title: 'Updated' },
    })

    expect(deleteOnethingPromptForIpc({
      request: { id: 'prompt-1' },
      deletePrompt: () => true,
    })).toEqual({ success: true })
  })

  it('owns prompt validation and not-found presentation', () => {
    expect(createOnethingPromptForIpc({
      request: { title: ' ', body: 'Body' },
      createPrompt: () => prompt,
    })).toEqual({ success: false, error: 'Title is required' })

    expect(getOnethingPromptForIpc({
      request: { id: 'missing' },
      getPrompt: () => undefined,
    })).toEqual({ success: false, error: 'Prompt not found' })

    expect(updateOnethingPromptForIpc({
      request: { id: 'missing' },
      updatePrompt: () => undefined,
    })).toEqual({ success: false, error: 'Prompt not found' })
  })

  it('normalizes adapter failures', () => {
    const logger = { error: vi.fn() }

    expect(listOnethingPromptsForIpc({
      listPrompts: () => {
        throw new Error('read failed')
      },
      logger,
    })).toEqual({ success: false, error: 'read failed' })

    expect(logger.error).toHaveBeenCalled()
  })
})
