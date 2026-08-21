import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPrompt, setPromptsPathForTests } from '@onething/runtime/prompts/store-bound'
import { executeSearch } from '../providers.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-prompts-'))
  setPromptsPathForTests(path.join(tmpDir, 'prompts.json'))
})

afterEach(async () => {
  setPromptsPathForTests(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('Search Everywhere prompt provider', () => {
  it('returns matching prompts with insert actions ordered by match strength', async () => {
    const weak = createPrompt({ title: 'Code Notes', body: 'deploy checklist' })
    const strong = createPrompt({ title: 'Deploy Helper', body: 'release steps' })

    const results = await executeSearch('deploy', 'prompts', 10)

    expect(results[0]).toMatchObject({
      id: `prompt:${strong.id}`,
      type: 'prompt',
      title: 'Deploy Helper',
      actionId: `insert-prompt:${strong.id}`,
    })
    expect(results.some(result => result.actionId === `insert-prompt:${weak.id}`)).toBe(true)
  })

  it('offers a create shortcut when no prompt matches', async () => {
    createPrompt({ title: 'Existing', body: 'Something else' })

    const results = await executeSearch('new reusable thing', 'prompts', 10)

    expect(results[0]).toMatchObject({
      type: 'prompt',
      title: 'Create prompt "new reusable thing"',
      actionId: 'create-prompt:new%20reusable%20thing',
    })
  })

  it('preserves casing when creating from a create prompt query', async () => {
    const results = await executeSearch('Create Prompt Refactor Plan', 'prompts', 10)

    expect(results[0]).toMatchObject({
      title: 'Create prompt "Refactor Plan"',
      actionId: 'create-prompt:Refactor%20Plan',
    })
  })
})
