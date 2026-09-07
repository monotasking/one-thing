import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ url: '', signals: [] as AbortSignal[] }))
vi.mock('../provider-binding/bound-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../provider-binding/bound-fetch.js')>(),
  // Real provider serializer/parser and TCP request; this local transport deliberately
  // ignores abort to prove shutdown awaits the underlying response, not an abort race.
  createRequiredAppFetch: () => (_url: unknown, init?: RequestInit) => {
    if (init?.signal) transport.signals.push(init.signal)
    return fetch(transport.url, { ...init, signal: undefined })
  },
}))

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

let directory: string
let previousStore: string | undefined
let previousHome: string | undefined
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'music-backend-')))
  previousStore = process.env.ONETHING_STORE_PATH
  previousHome = process.env.HOME
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  process.env.HOME = directory
  transport.signals = []
  vi.resetModules()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await backend?.dispose()
  backend = undefined
  if (previousStore === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStore
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble(storePath: string) {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath, owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
  } })
}

it('owns real player processes and delayed provider requests through shutdown, then rejects captured A handles in B', { timeout: 60000 }, async () => {
  const received = barrier()
  let response: ServerResponse | undefined
  let body = ''
  const server = createServer(async (request, reply) => {
    for await (const chunk of request) body += chunk.toString()
    response = reply
    received.release()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  transport.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/speech`
  cleanups.push(() => { response?.end('fake-audio'); server.closeAllConnections(); server.close() })
  const storeA = path.join(directory, 'a')
  const storeB = path.join(directory, 'b')
  backend = await assemble(storeA)
  const oldMusic = backend.music
  const oldService = oldMusic.service
  const oldRadio = oldMusic.radio
  const oldDj = oldMusic.djVoice
  const oldOperations = oldMusic.operations
  const { radioAdapters } = await import('../wiring/toolkit/adapters.js')
  const oldTool = radioAdapters()
  const oldStore = oldRadio.getRadioStore()
  oldStore.writeBrief({ active: false, intent: 'A station', played: [], skipped: [], loved: [] })
  const { getSettings, saveSettings } = await import('../stores/settings.js')
  const settings = getSettings()
  if (!settings.voice) throw new Error('Fixture requires the default voice settings')
  saveSettings({ ...settings, voice: { ...settings.voice, tts: {
    ...settings.voice.tts, provider: 'openai-tts', openai: { ...settings.voice.tts.openai, apiKey: 'local-test-only' },
  } } })
  oldDj.prefetchDjPatter('A provider request', 'A song')
  await received.promise
  expect(JSON.parse(body).input).toBe('A provider request')
  const ready = barrier()
  const terminated = barrier()
  const childRelease = path.join(directory, 'release-child')
  cleanups.unshift(() => fs.writeFile(childRelease, 'release'))
  process.env.ONETHING_STORE_PATH = storeB
  const child = oldService.runner.spawn({ command: process.execPath, args: ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      process.stdout.write('terminating\\n');
      setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0) }, 5);
    });
    process.stdout.write('ready:' + process.env.ONETHING_STORE_PATH + '\\n');
    setInterval(() => {}, 1000);
  `, childRelease], onStdout: chunk => {
    if (chunk.includes(`ready:${storeA}`)) ready.release()
    if (chunk.includes('terminating')) terminated.release()
  } })
  await ready.promise
  process.env.ONETHING_STORE_PATH = storeA
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await terminated.promise
  expect(transport.signals.at(-1)?.aborted).toBe(true)
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('held')
  expect(disposed).toBe(false)
  response!.writeHead(200, { 'content-type': 'audio/mpeg' }).end('fake-audio')
  await oldDj.drain()
  expect(disposed).toBe(false)
  await fs.writeFile(childRelease, 'release')
  await child.done
  await stopping
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('absent')
  backend = await assemble(storeB)
  expect(backend.music).not.toBe(oldMusic)
  expect(() => oldService.runner.spawn({ command: process.execPath, args: ['-e', 'throw 1'] })).toThrow('shutting down')
  expect(() => oldStore.writeBrief({ active: true, intent: 'late', played: [], skipped: [], loved: [] })).toThrow('shutting down')
  expect(() => oldRadio.openRadioStation('late', { clearProgramme: true })).toThrow('shutting down')
  expect(() => oldDj.prefetchDjPatter('late', 'late')).toThrow('shutting down')
  expect(() => oldOperations.searchMusicSongs('late')).toThrow('shutting down')
  expect(() => oldTool.status({ userId: 'local-user', workspaceId: 'default' })).toThrow('shutting down')
  expect(backend.music.radio.getRadioStore().readBrief().intent).toBe('')
  expect(JSON.parse(await fs.readFile(oldStore.briefPath, 'utf8')).intent).toBe('A station')
})
