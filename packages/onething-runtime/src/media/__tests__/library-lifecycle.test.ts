import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { MediaLibraryService, configureMediaLibraryService, mediaLibraryService } from '../library-service-bound.js'

it('drains the actual download and never redirects an old bound operation into a replacement library', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-lifetime-'))
  const paths = (name: string) => ({ indexPath: path.join(dir, name, 'index.json'), imagesDir: path.join(dir, name, 'images'), filesDir: path.join(dir, name, 'files') })
  const a = new MediaLibraryService(paths('a')), b = new MediaLibraryService(paths('b'))
  let release!: () => void
  let started!: () => void
  const receiving = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = createServer(async (_request, response) => { started(); await gate; response.end('late image') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }
  const unbindA = configureMediaLibraryService(a)
  let unbindB: (() => void) | undefined
  const input = { sessionId: 'source', messageId: 'm', prompt: 'image', model: 'image' }
  try {
    const captured = mediaLibraryService.ingestGeneratedImage
    const pending = captured({ ...input, url: `http://127.0.0.1:${address.port}/image` })
    const outcome = pending.then(() => undefined, error => error)
    await receiving
    a.quiesce()
    let drained = false
    const drain = a.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    unbindA(); unbindB = configureMediaLibraryService(b)
    await expect(captured({ ...input, base64: 'bmV3' })).rejects.toThrow('stopped')
    await mediaLibraryService.ingestGeneratedImage({ ...input, base64: 'Yi1pbWFnZQ==' })
    release()
    expect(await outcome).toMatchObject({ message: 'Media library has been stopped' })
    await drain
    expect(fs.existsSync(paths('a').indexPath)).toBe(false)
    expect(b.listAssets()).toHaveLength(1)
    expect(fs.readFileSync(b.listAssets()[0].filePath!, 'utf8')).toBe('b-image')
  } finally {
    release(); a.quiesce(); b.quiesce(); await Promise.all([a.drain(), b.drain()])
    unbindB?.(); unbindA()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
  expect(() => mediaLibraryService.listAssets()).toThrow('not been assembled')
})
