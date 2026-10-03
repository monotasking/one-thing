import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPrompt,
  deletePrompt,
  getPrompt,
  invalidatePromptsCache,
  listPrompts,
  setPromptsPathForTests,
  updatePrompt,
} from '../store-bound.js'

let tmpDir: string
let promptsPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-store-'))
  promptsPath = path.join(tmpDir, 'prompts.json')
  setPromptsPathForTests(promptsPath)
})

afterEach(async () => {
  setPromptsPathForTests(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('prompt store', () => {
  it('starts with an empty list when no file exists', () => {
    expect(listPrompts()).toEqual([])
  })

  it('creates, lists, gets, updates, and deletes prompts', () => {
    const first = createPrompt({
      title: '  Zed Review  ',
      body: 'Review this carefully.',
      description: '  Useful for reviews  ',
      tags: ['review', 'review', '  code  ', ''],
    })
    const second = createPrompt({
      title: 'Alpha Draft',
      body: 'Draft a concise answer.',
    })

    expect(first.title).toBe('Zed Review')
    expect(first.description).toBe('Useful for reviews')
    expect(first.tags).toEqual(['review', 'code'])
    expect(listPrompts().map(prompt => prompt.title)).toEqual(['Alpha Draft', 'Zed Review'])
    expect(getPrompt(first.id)?.body).toBe('Review this carefully.')

    const updated = updatePrompt({
      id: first.id,
      title: 'Review Pass',
      body: 'Review it again.',
      tags: ['review', 'final'],
    })
    expect(updated?.title).toBe('Review Pass')
    expect(updated?.body).toBe('Review it again.')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)

    expect(deletePrompt(second.id)).toBe(true)
    expect(deletePrompt(second.id)).toBe(false)
    expect(listPrompts().map(prompt => prompt.id)).toEqual([first.id])
  })

  it('persists prompts across cache invalidation', () => {
    const prompt = createPrompt({
      title: 'Persistent',
      body: 'Keep me on disk.',
    })

    invalidatePromptsCache()

    expect(getPrompt(prompt.id)?.title).toBe('Persistent')
    expect(listPrompts()).toHaveLength(1)
  })

  it('falls back to an empty list for invalid persisted schema', async () => {
    await fs.writeFile(promptsPath, JSON.stringify({ prompts: [{ id: '', title: 123 }] }), 'utf-8')
    invalidatePromptsCache()

    expect(listPrompts()).toEqual([])
  })
})
