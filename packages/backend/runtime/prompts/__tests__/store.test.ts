import { describe, expect, it, vi } from 'vitest'
import { OnethingPromptStore, type OnethingPromptsFile } from '../store.js'

function createStore(seed: unknown = { prompts: [] }) {
  let value = seed
  let id = 0
  const writeJson = vi.fn((_path: string, next: OnethingPromptsFile) => {
    value = next
  })
  const store = new OnethingPromptStore({
    getPath: () => '/tmp/prompts.json',
    readJson: (_path, fallback) => (value ?? fallback) as typeof fallback,
    writeJson,
    createId: () => `prompt-${++id}`,
    now: () => 1000 + id,
  })
  return { store, writeJson, get value() { return value } }
}

describe('OnethingPromptStore', () => {
  it('creates, lists, gets, updates, and deletes prompts', () => {
    const { store } = createStore()

    const first = store.create({
      title: '  Zed Review  ',
      body: 'Review this carefully.',
      description: '  Useful for reviews  ',
      tags: ['review', 'review', '  code  ', ''],
    })
    const second = store.create({
      title: 'Alpha Draft',
      body: 'Draft a concise answer.',
    })

    expect(first.title).toBe('Zed Review')
    expect(first.description).toBe('Useful for reviews')
    expect(first.tags).toEqual(['review', 'code'])
    expect(store.list().map(prompt => prompt.title)).toEqual(['Alpha Draft', 'Zed Review'])
    expect(store.get(first.id)?.body).toBe('Review this carefully.')

    const updated = store.update({
      id: first.id,
      title: 'Review Pass',
      body: 'Review it again.',
      tags: ['review', 'final'],
    })
    expect(updated?.title).toBe('Review Pass')
    expect(updated?.body).toBe('Review it again.')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)

    expect(store.delete(second.id)).toBe(true)
    expect(store.delete(second.id)).toBe(false)
    expect(store.list().map(prompt => prompt.id)).toEqual([first.id])
  })

  it('persists prompts across cache invalidation', () => {
    const context = createStore()
    const prompt = context.store.create({
      title: 'Persistent',
      body: 'Keep me on disk.',
    })

    context.store.invalidate()

    expect(context.store.get(prompt.id)?.title).toBe('Persistent')
    expect(context.store.list()).toHaveLength(1)
  })

  it('falls back to an empty list for invalid persisted schema', () => {
    const { store } = createStore({ prompts: [{ id: '', title: 123 }] })

    expect(store.list()).toEqual([])
  })
})
