import { describe, expect, it, vi } from 'vitest'
import { updateOnethingSessionWorkingDirectory } from '../working-directory.js'

/** 宿主那只 `resolvePath` 的替身:`~` 展开到一个定值,其余原样。 */
const resolvePath = (path: string) =>
  path === '~' ? '/home/me' : path.startsWith('~/') ? `/home/me/${path.slice(2)}` : path

describe('updateOnethingSessionWorkingDirectory', () => {
  it('clears the working directory without validating the filesystem', async () => {
    const isDirectory = vi.fn()
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: null,
      resolvePath,
      isDirectory,
      writeWorkingDirectory,
    })).resolves.toEqual({ success: true, path: '' })

    expect(isDirectory).not.toHaveBeenCalled()
    expect(writeWorkingDirectory).toHaveBeenCalledWith('session-1', '')
  })

  it('rejects existing paths that are not directories', async () => {
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '/tmp/file.txt',
      resolvePath,
      isDirectory: vi.fn(() => false),
      writeWorkingDirectory,
    })).resolves.toEqual({
      success: false,
      error: 'Not a directory: /tmp/file.txt',
    })

    expect(writeWorkingDirectory).not.toHaveBeenCalled()
  })

  it('reports missing directory paths when validation throws', async () => {
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '/tmp/missing',
      resolvePath,
      isDirectory: vi.fn(() => {
        throw new Error('ENOENT')
      }),
      writeWorkingDirectory,
    })).resolves.toEqual({
      success: false,
      error: 'Directory does not exist: /tmp/missing',
    })

    expect(writeWorkingDirectory).not.toHaveBeenCalled()
  })

  it('writes valid directory paths through the host adapter', async () => {
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '/repo',
      resolvePath,
      isDirectory: vi.fn(() => true),
      writeWorkingDirectory,
    })).resolves.toEqual({ success: true, path: '/repo' })

    expect(writeWorkingDirectory).toHaveBeenCalledWith('session-1', '/repo')
  })

  /*
   * 09-21 的那条报障:界面「绑定…」/ `/cd` 收的是**人打的**路径,`~/x` 是它最常见
   * 的写法。从前这条串原样进 `fs.stat` → ENOENT →「目录不存在」,而目录明明在。
   */
  it('resolves the path before stat-ing it, and stores the resolved one', async () => {
    const isDirectory = vi.fn(() => true)
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '  ~/Documents/data/work/lenovo  ',
      resolvePath,
      isDirectory,
      writeWorkingDirectory,
    })).resolves.toEqual({
      success: true,
      path: '/home/me/Documents/data/work/lenovo',
    })

    expect(isDirectory).toHaveBeenCalledWith('/home/me/Documents/data/work/lenovo')
    expect(writeWorkingDirectory)
      .toHaveBeenCalledWith('session-1', '/home/me/Documents/data/work/lenovo')
  })

  it('says "cannot access" — not "does not exist" — when stat fails for another reason', async () => {
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '~/Documents/locked',
      resolvePath,
      isDirectory: vi.fn(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }),
      writeWorkingDirectory,
    })).resolves.toEqual({
      success: false,
      error: 'Cannot access directory: /home/me/Documents/locked (EPERM)',
    })

    expect(writeWorkingDirectory).not.toHaveBeenCalled()
  })

  it('treats a blank string like a clear', async () => {
    const isDirectory = vi.fn()
    const writeWorkingDirectory = vi.fn()

    await expect(updateOnethingSessionWorkingDirectory({
      sessionId: 'session-1',
      workingDirectory: '   ',
      resolvePath,
      isDirectory,
      writeWorkingDirectory,
    })).resolves.toEqual({ success: true, path: '' })

    expect(isDirectory).not.toHaveBeenCalled()
    expect(writeWorkingDirectory).toHaveBeenCalledWith('session-1', '')
  })
})
