import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { OutputAccumulator } from '../output-accumulator.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-output-'))
  dirs.push(dir)
  return dir
}

describe('runtime OutputAccumulator', () => {
  it('keeps small output in memory without a temp file', () => {
    const output = new OutputAccumulator({ maxBytes: 100, maxLines: 10 })
    output.append(Buffer.from('hello\nworld'))
    output.finish()

    const snapshot = output.snapshot({ persistIfTruncated: true })
    expect(snapshot.content).toBe('hello\nworld')
    expect(snapshot.truncation.truncated).toBe(false)
    expect(snapshot.fullOutputPath).toBeUndefined()
  })

  it('keeps a bounded tail and persists full output when byte limit is exceeded', async () => {
    const dir = await tempDir()
    const output = new OutputAccumulator({ maxBytes: 12, maxLines: 100, tempDir: dir, tempFilePrefix: 'bash' })
    output.append(Buffer.from('first line\n'))
    output.append(Buffer.from('second line\n'))
    output.finish()

    const snapshot = output.snapshot({ persistIfTruncated: true })
    await output.closeTempFile()

    expect(snapshot.truncation.truncated).toBe(true)
    expect(snapshot.truncation.truncatedBy).toBe('bytes')
    expect(snapshot.content).toContain('second line')
    expect(snapshot.fullOutputPath).toBeTruthy()
    await expect(fs.readFile(snapshot.fullOutputPath!, 'utf-8')).resolves.toBe('first line\nsecond line\n')
  })

  it('strips ansi and filters control characters', () => {
    const output = new OutputAccumulator({ maxBytes: 100, maxLines: 10 })
    output.append(Buffer.from('\u001b[31mred\u001b[0m\u0000 ok'))
    output.finish()

    expect(output.snapshot().content).toBe('red ok')
  })
})
