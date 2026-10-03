import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  countLineChanges,
  hashTextFileSnapshot,
  readTextFileSnapshot,
} from '../file-snapshot.js'

describe('runtime file snapshot helpers', () => {
  it('hashes missing and existing snapshots differently', () => {
    expect(hashTextFileSnapshot(false, '')).not.toBe(hashTextFileSnapshot(true, ''))
    expect(hashTextFileSnapshot(true, 'a')).toBe(hashTextFileSnapshot(true, 'a'))
  })

  it('reads existing and missing text file snapshots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-file-snapshot-'))
    try {
      const target = path.join(root, 'note.txt')
      fs.writeFileSync(target, 'hello\nworld\n', 'utf-8')

      await expect(readTextFileSnapshot(root)).rejects.toThrow('Path is a directory')
      await expect(readTextFileSnapshot(path.join(root, 'missing.txt'))).resolves.toEqual({
        exists: false,
        content: '',
        hash: hashTextFileSnapshot(false, ''),
      })
      await expect(readTextFileSnapshot(target)).resolves.toEqual({
        exists: true,
        content: 'hello\nworld\n',
        hash: hashTextFileSnapshot(true, 'hello\nworld\n'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts line additions and deletions without third-party diff dependencies', () => {
    expect(countLineChanges('', '')).toEqual({ additions: 0, deletions: 0 })
    expect(countLineChanges('', 'one\n')).toEqual({ additions: 1, deletions: 0 })
    expect(countLineChanges('one\n', '')).toEqual({ additions: 0, deletions: 1 })
    expect(countLineChanges('one\ntwo\nthree\n', 'one\nchanged\nthree\nfour\n'))
      .toEqual({ additions: 2, deletions: 1 })
  })
})
