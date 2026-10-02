import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const workerPath = fileURLToPath(new URL('./fixtures/file-mutex-worker.ts', import.meta.url))

function hasBun(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const tempDirs: string[] = []

function runWorker(lockPath: string, dataPath: string, workerId: string, iterations: number): Promise<number> {
  return new Promise(resolve => {
    const child = spawn('bun', [workerPath, lockPath, dataPath, workerId, String(iterations)], {
      stdio: 'ignore',
    })
    child.on('exit', code => resolve(code ?? -1))
    child.on('error', () => resolve(-1))
  })
}

describe('withFileLockSync cross-process', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBun())(
    'serializes read-modify-write across two OS processes with no lost updates',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-mutex-xproc-'))
      tempDirs.push(dir)
      const lockPath = path.join(dir, 'index.json.lock')
      const dataPath = path.join(dir, 'index.json')
      fs.writeFileSync(dataPath, '[]')

      const iterations = 40
      const [codeA, codeB] = await Promise.all([
        runWorker(lockPath, dataPath, 'A', iterations),
        runWorker(lockPath, dataPath, 'B', iterations),
      ])

      expect(codeA).toBe(0)
      expect(codeB).toBe(0)

      const entries = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as string[]
      // 无锁时并发 RMW 会互相覆盖,长度 < 80;有锁则每条都保留。
      expect(entries.length).toBe(iterations * 2)
      expect(new Set(entries).size).toBe(iterations * 2)
    },
    30_000,
  )
})
