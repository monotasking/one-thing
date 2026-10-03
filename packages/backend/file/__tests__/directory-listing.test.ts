import { describe, expect, it } from 'vitest'
import {
  expandOnethingDirectoryBasePath,
  listOnethingDirectoriesForCompletion,
  listOnethingDirectoriesForCompletionForIpc,
  type OnethingDirectoryEntryLike,
} from '../directory-listing.js'

function dir(name: string): OnethingDirectoryEntryLike {
  return { name, isDirectory: () => true }
}

function file(name: string): OnethingDirectoryEntryLike {
  return { name, isDirectory: () => false }
}

describe('directory completion runtime operation', () => {
  it('expands leading tilde with host-provided home dir', () => {
    expect(expandOnethingDirectoryBasePath('~/work', '/Users/test')).toBe('/Users/test/work')
    expect(expandOnethingDirectoryBasePath('/repo', '/Users/test')).toBe('/repo')
  })

  it('lists matching child directories for a concrete directory', async () => {
    await expect(listOnethingDirectoriesForCompletion({
      basePath: '~/repo',
      query: 's',
      limit: 3,
      homeDir: '/Users/test',
      stat: async targetPath => targetPath === '/Users/test/repo' ? { isDirectory: () => true } : null,
      readDir: async () => [dir('src'), dir('scripts'), dir('.secret'), file('setup.txt')],
    })).resolves.toEqual({
      success: true,
      dirs: ['/Users/test/repo/scripts', '/Users/test/repo/src'],
      basePath: '/Users/test/repo',
    })
  })

  it('treats a partial path as parent plus basename prefix', async () => {
    await expect(listOnethingDirectoriesForCompletion({
      basePath: '/repo/sr',
      homeDir: '/Users/test',
      stat: async targetPath => targetPath === '/repo' ? { isDirectory: () => true } : null,
      readDir: async () => [dir('src'), dir('scripts'), dir('test')],
    })).resolves.toEqual({
      success: true,
      dirs: ['/repo/src'],
      basePath: '/repo/sr',
    })
  })

  it('returns empty success for missing parent dirs and error for read failures', async () => {
    await expect(listOnethingDirectoriesForCompletion({
      basePath: '/missing/sr',
      homeDir: '/Users/test',
      stat: async () => null,
      readDir: async () => [],
    })).resolves.toEqual({
      success: true,
      dirs: [],
      basePath: '/missing/sr',
    })

    await expect(listOnethingDirectoriesForCompletion({
      basePath: '/repo',
      homeDir: '/Users/test',
      stat: async () => ({ isDirectory: () => true }),
      readDir: async () => {
        throw new Error('permission denied')
      },
    })).resolves.toEqual({
      success: false,
      dirs: [],
      basePath: '',
      error: 'permission denied',
    })
  })

  it('keeps directory completion IPC wrapper compatible with the core response', async () => {
    await expect(listOnethingDirectoriesForCompletionForIpc({
      basePath: '/repo',
      homeDir: '/Users/test',
      stat: async () => ({ isDirectory: () => true }),
      readDir: async () => [dir('src'), file('README.md')],
    })).resolves.toEqual({
      success: true,
      dirs: ['/repo/src'],
      basePath: '/repo',
    })
  })
})
