import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingDirectory,
  createOnethingFile,
  deleteOnethingPath,
  listOnethingDirectory,
  onethingBufferLooksBinary,
  readOnethingFileContent,
  renameOnethingPath,
  revealOnethingPath,
  saveOnethingFileContent,
  statOnethingPath,
} from '../file-operations.js'

function stat(input: Partial<{ file: boolean; directory: boolean; size: number; mtimeMs: number }> = {}) {
  return {
    isFile: () => input.file ?? false,
    isDirectory: () => input.directory ?? false,
    size: input.size ?? 0,
    mtimeMs: input.mtimeMs ?? 1,
  }
}

function dirent(name: string, directory: boolean) {
  return {
    name,
    isDirectory: () => directory,
  }
}

describe('file operations runtime adapters', () => {
  it('reads text previews and detects binary content', async () => {
    await expect(readOnethingFileContent({
      path: '/repo/a.txt',
      maxSize: 3,
      stat: async () => stat({ file: true, size: 12, mtimeMs: 9 }),
      readBytes: async (_path, byteLength) => new TextEncoder().encode('hello').slice(0, byteLength),
    })).resolves.toEqual({
      success: true,
      content: 'hel',
      encoding: 'utf-8',
      size: 12,
      mtimeMs: 9,
      isBinary: false,
    })

    expect(onethingBufferLooksBinary(new Uint8Array([65, 0, 66]))).toBe(true)
    await expect(readOnethingFileContent({
      path: '/repo/bin',
      stat: async () => stat({ file: true, size: 3 }),
      readBytes: async () => new Uint8Array([65, 0, 66]),
    })).resolves.toMatchObject({
      success: true,
      content: '',
      isBinary: true,
    })
  })

  it('maps read validation and filesystem errors', async () => {
    await expect(readOnethingFileContent({
      path: '',
      stat: async () => stat(),
      readBytes: async () => new Uint8Array(),
    })).resolves.toEqual({ success: false, error: 'File path is required' })

    await expect(readOnethingFileContent({
      path: '/repo',
      stat: async () => stat({ directory: true }),
      readBytes: async () => new Uint8Array(),
    })).resolves.toEqual({ success: false, error: 'Path is not a file' })

    await expect(readOnethingFileContent({
      path: '/missing',
      stat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      readBytes: async () => new Uint8Array(),
    })).resolves.toEqual({ success: false, error: 'File not found' })
  })

  it('saves with mtime conflict detection and permission errors', async () => {
    const writeFile = vi.fn()
    await expect(saveOnethingFileContent({
      path: '/repo/a.txt',
      content: 'next',
      expectedMtimeMs: 100,
      stat: async () => stat({ file: true, mtimeMs: 102 }),
      writeFile,
    })).resolves.toEqual({
      success: false,
      conflict: true,
      error: 'File changed on disk. Review before saving again.',
    })
    expect(writeFile).not.toHaveBeenCalled()

    await expect(saveOnethingFileContent({
      path: '/repo/a.txt',
      content: 'next',
      expectedMtimeMs: 100,
      stat: async () => stat({ file: true, mtimeMs: 100 }),
      writeFile,
    })).resolves.toEqual({ success: true, mtimeMs: 100 })
    expect(writeFile).toHaveBeenCalledWith('/repo/a.txt', 'next')

    await expect(saveOnethingFileContent({
      path: '/repo/a.txt',
      content: 'next',
      stat: async () => stat({ file: true }),
      writeFile: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    })).resolves.toEqual({ success: false, error: 'Permission denied' })
  })

  it('lists directories with ignored folders, stat projection, and stable ordering', async () => {
    await expect(listOnethingDirectory({
      path: '/repo',
      readDir: async () => [
        dirent('z.txt', false),
        dirent('src', true),
        dirent('.git', true),
        dirent('README.md', false),
        dirent('node_modules', true),
      ],
      stat: async targetPath => targetPath.endsWith('src')
        ? stat({ directory: true, size: 10, mtimeMs: 1 })
        : stat({ file: true, size: 20, mtimeMs: 2 }),
    })).resolves.toEqual({
      success: true,
      entries: [
        { name: 'src', path: '/repo/src', type: 'directory', size: 10, mtimeMs: 1 },
        { name: 'README.md', path: '/repo/README.md', type: 'file', size: 20, mtimeMs: 2 },
        { name: 'z.txt', path: '/repo/z.txt', type: 'file', size: 20, mtimeMs: 2 },
      ],
    })
  })

  it('stats paths for renderer projection', async () => {
    await expect(statOnethingPath({
      path: '/repo',
      stat: async () => stat({ directory: true, size: 50, mtimeMs: 6 }),
    })).resolves.toEqual({
      success: true,
      type: 'directory',
      size: 50,
      mtimeMs: 6,
      path: '/repo',
    })
  })

  it('expands a leading ~ when the host provides homeDir and reports the resolved path', async () => {
    const seen: string[] = []
    await expect(statOnethingPath({
      path: '~/notes/a.md',
      homeDir: '/Users/me',
      stat: async (target) => { seen.push(target); return stat({ size: 1, mtimeMs: 2 }) },
    })).resolves.toMatchObject({ success: true, path: '/Users/me/notes/a.md' })
    expect(seen).toEqual(['/Users/me/notes/a.md'])
    // 没给 homeDir 就原样 stat(server 侧自己已按沙箱根展开过)。
    await expect(statOnethingPath({ path: '~/x', stat: async () => stat({}) }))
      .resolves.toMatchObject({ path: '~/x' })
  })

  it('wraps create, mkdir, rename, and delete file actions', async () => {
    const createFile = vi.fn()
    const createDirectory = vi.fn()
    const renamePath = vi.fn()
    const deletePath = vi.fn()

    await expect(createOnethingFile({
      path: '/repo/new.txt',
      content: 'new',
      createFile,
    })).resolves.toEqual({ success: true })
    expect(createFile).toHaveBeenCalledWith('/repo/new.txt', 'new')

    await expect(createOnethingDirectory({
      path: '/repo/new-dir',
      createDirectory,
    })).resolves.toEqual({ success: true })
    expect(createDirectory).toHaveBeenCalledWith('/repo/new-dir')

    await expect(renameOnethingPath({
      oldPath: '/repo/a.txt',
      newPath: '/repo/b.txt',
      renamePath,
    })).resolves.toEqual({ success: true })
    expect(renamePath).toHaveBeenCalledWith('/repo/a.txt', '/repo/b.txt')

    await expect(deleteOnethingPath({
      path: '/repo/b.txt',
      deletePath,
    })).resolves.toEqual({ success: true })
    expect(deletePath).toHaveBeenCalledWith('/repo/b.txt')
  })

  it('projects action and reveal errors', async () => {
    await expect(createOnethingFile({
      path: '/repo/new.txt',
      createFile: async () => {
        throw new Error('exists')
      },
    })).resolves.toEqual({ success: false, error: 'exists' })

    await expect(createOnethingDirectory({
      path: '/repo/new-dir',
      createDirectory: async () => {
        throw 'bad'
      },
    })).resolves.toEqual({ success: false, error: 'Failed to create directory' })

    const revealPath = vi.fn()
    await expect(revealOnethingPath({
      path: '',
      stat: async () => stat(),
      revealPath,
    })).resolves.toEqual({ success: false, error: 'Path is required' })
    expect(revealPath).not.toHaveBeenCalled()

    await expect(revealOnethingPath({
      path: '/repo/a.txt',
      stat: async () => stat({ file: true }),
      revealPath,
    })).resolves.toEqual({ success: true })
    expect(revealPath).toHaveBeenCalledWith('/repo/a.txt')
  })
})
