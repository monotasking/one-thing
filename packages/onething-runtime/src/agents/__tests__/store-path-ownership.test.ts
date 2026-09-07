import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOnethingAgentStore } from '../store.js'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-owner-')) })
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('moves a dynamic facade between real files without reusing another root cache or resetting it', async () => {
  const a = path.join(directory, 'a', 'agents.json')
  const b = path.join(directory, 'b', 'agents.json')
  let selected = a
  const store = createOnethingAgentStore({ agentsPath: () => selected })
  await store.initialize()
  store.createAgent({ id: 'same-agent', name: 'Agent A' })
  selected = b
  await store.initialize()
  expect(store.findAgent('same-agent')).toBeNull()
  expect(store.createAgent({ id: 'same-agent', name: 'Agent B' }).name).toBe('Agent B')
  selected = a
  expect(store.requireAgent('same-agent').name).toBe('Agent A')
  selected = b
  expect(store.requireAgent('same-agent').name).toBe('Agent B')
  expect(createOnethingAgentStore({ agentsPath: a }).requireAgent('same-agent').name).toBe('Agent A')
  expect(createOnethingAgentStore({ agentsPath: b }).requireAgent('same-agent').name).toBe('Agent B')
})

it('keeps a delayed initialization and its normalization write with the file that created it', async () => {
  const a = path.join(directory, 'a', 'agents.json')
  const b = path.join(directory, 'b', 'agents.json')
  fs.mkdirSync(path.dirname(a), { recursive: true })
  // Existing old shape forces the post-read normalization write as well.
  fs.writeFileSync(a, JSON.stringify({ agents: [{ id: 'same-agent', name: 'Agent A' }] }))
  let selected = a
  const store = createOnethingAgentStore({ agentsPath: () => selected })
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const readFile = fs.promises.readFile.bind(fs.promises)
  vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === a) { entered(); await held }
    return readFile(...args)
  })
  const initializingA = store.initialize()
  try {
    await started
    selected = b
    await store.initialize()
    expect(store.findAgent('same-agent')).toBeNull()
    store.createAgent({ id: 'same-agent', name: 'Agent B' })
  } finally {
    release()
    await initializingA
  }
  expect(store.requireAgent('same-agent').name).toBe('Agent B')
  expect(createOnethingAgentStore({ agentsPath: a }).requireAgent('same-agent').name).toBe('Agent A')
  expect(createOnethingAgentStore({ agentsPath: b }).requireAgent('same-agent').name).toBe('Agent B')
  expect(JSON.parse(fs.readFileSync(a, 'utf-8'))).toMatchObject({ version: 1 })
})
