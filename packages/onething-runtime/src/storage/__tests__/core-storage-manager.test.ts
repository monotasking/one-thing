import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  appendTextFile,
  CoreFileStorageProvider,
  dirnamePath,
  ensureDirAsync,
  HeadlessStorageManager,
  getDebugDir,
  getDocsDir,
  getMCPToolsCatalogPath,
  getMacOSAutomationDocsPath,
  getPluginDataDir,
  getSessionDatabasePath,
  getSessionPath,
  getStoreDirs,
  getToolUsageDocsPath,
  isDirectory,
  isFile,
  joinPaths,
  listDirectoryEntries,
  listFilesUnderRoots,
  pathExists,
  pathExistsInDir,
  readTextFileAsync,
  readTextFileIfExists,
  readTextFileLimited,
  readTextFile,
  relativePath,
  relativePathPosix,
  statPath,
  writeTextFile,
  writeTextFileAtomic,
  writeTextFileInDir,
  writeTextFileIfMissing,
  type CoreStorageConfig,
  type CoreStorageProvider,
} from '@onething/core/storage'

class MockStorageProvider implements CoreStorageProvider {
  initialize = vi.fn(async () => {})
  close = vi.fn(async () => {})

  constructor(readonly config: CoreStorageConfig) {}
}

describe('HeadlessStorageManager', () => {
  it('initializes providers through an injected factory and reuses the same backend', async () => {
    const created: MockStorageProvider[] = []
    const manager = new HeadlessStorageManager((config) => {
      const provider = new MockStorageProvider(config)
      created.push(provider)
      return provider
    })

    const first = await manager.initializeStorage('file')
    const second = await manager.initializeStorage('file')

    expect(first).toBe(second)
    expect(created).toHaveLength(1)
    expect(first.initialize).toHaveBeenCalledTimes(1)
    expect(first.close).not.toHaveBeenCalled()
    expect(manager.instance).toBe(first)
    expect(manager.type).toBe('file')
  })

  it('lazily creates file storage from getStorage', async () => {
    const errors: unknown[] = []
    const manager = new HeadlessStorageManager(config => new MockStorageProvider(config))

    const storage = manager.getStorage({ onInitializeError: error => errors.push(error) }) as MockStorageProvider
    await Promise.resolve()

    expect(storage.config).toEqual({ type: 'file' })
    expect(storage.initialize).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('closes the active provider', async () => {
    const manager = new HeadlessStorageManager(config => new MockStorageProvider(config))
    const storage = await manager.initializeStorage('file')

    await manager.closeStorage()

    expect(storage.close).toHaveBeenCalledTimes(1)
    expect(manager.instance).toBeNull()
  })

  it('initializes file storage directories without main process helpers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-file-storage-'))
    try {
      const provider = new CoreFileStorageProvider({
        dataDir: path.join(root, 'data'),
        directories: [
          path.join(root, 'sessions'),
          path.join(root, 'media', 'images'),
        ],
      })

      await provider.initialize()

      expect(fs.existsSync(path.join(root, 'data'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'sessions'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'media', 'images'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds generic core storage paths without Electron', () => {
    const storePath = path.join(os.tmpdir(), 'onething-core-paths')
    const options = { storePath, cwd: '/repo', resourcesPath: '/resources', isPackaged: true }

    expect(getSessionPath('abc', options)).toBe(path.join(storePath, 'sessions', 'abc.json'))
    expect(getSessionDatabasePath(options)).toBe(path.join(storePath, 'sessions.sqlite'))
    expect(getDebugDir(options)).toBe(path.join(storePath, 'debug'))
    expect(getMCPToolsCatalogPath(options)).toBe(path.join(storePath, 'mcp-tools-catalog.md'))
    expect(getPluginDataDir(options)).toBe(path.join(storePath, 'plugin-data'))
    expect(getStoreDirs(options)).toContain(path.join(storePath, 'permissions'))
    expect(getStoreDirs(options)).toContain(path.join(storePath, 'plugin-data'))
    expect(getDocsDir(options)).toBe(path.join('/resources', 'docs'))
    expect(getMacOSAutomationDocsPath(options)).toBe(path.join('/resources', 'docs', 'macos-automation.md'))
    expect(getToolUsageDocsPath({ cwd: '/repo' })).toBe(path.join('/repo', 'resources', 'docs', 'tool-usage-guide.md'))
  })

  it('writes text files atomically from core storage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-text-atomic-'))
    try {
      const target = path.join(root, 'nested', 'memory.md')

      await writeTextFileAtomic(target, 'hello core')

      expect(fs.readFileSync(target, 'utf-8')).toBe('hello core')
      expect(fs.readdirSync(path.dirname(target)).filter(name => name.includes('.tmp'))).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes missing text files and reads limited text from core storage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-text-missing-'))
    try {
      const target = path.join(root, 'nested', 'memory.md')

      await writeTextFileIfMissing(target, 'first value')
      await writeTextFileIfMissing(target, 'second value')

      expect(pathExists(target)).toBe(true)
      expect(isDirectory(path.dirname(target))).toBe(true)
      expect(isDirectory(target)).toBe(false)
      expect(isFile(target)).toBe(true)
      expect(fs.readFileSync(target, 'utf-8')).toBe('first value')
      expect(readTextFileLimited(target, 5, (content, limit) => `${content.slice(0, limit)}...`)).toBe('first...')
      expect(readTextFileLimited(path.join(root, 'missing.md'), 5)).toBe('')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports async text, stat, directory, and path helpers from core storage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-text-async-'))
    try {
      const nested = joinPaths(root, 'nested')
      const target = joinPaths(nested, 'memory.md')

      await ensureDirAsync(nested)
      await appendTextFile(target, 'first\n')
      await appendTextFile(target, 'second\n')

      expect(dirnamePath(target)).toBe(nested)
      expect(relativePath(root, target)).toBe(path.join('nested', 'memory.md'))
      expect(await readTextFileAsync(target)).toBe('first\nsecond\n')
      expect(await readTextFileIfExists(joinPaths(root, 'missing.md'), 'fallback')).toBe('fallback')
      expect((await statPath(target))?.isFile()).toBe(true)
      expect(await listDirectoryEntries(nested)).toEqual([
        { name: 'memory.md', isFile: true, isDirectory: false },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes sync text files from core storage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-text-sync-'))
    try {
      const target = path.join(root, 'catalog', 'mcp-tools.md')

      writeTextFile(target, 'tools catalog')

      expect(pathExists(target)).toBe(true)
      expect(readTextFile(target)).toBe('tools catalog')
      expect(pathExistsInDir(root, path.join('catalog', 'mcp-tools.md'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists files under root directories with posix relative paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-list-roots-'))
    try {
      writeTextFileInDir(root, path.join('references', 'nested', 'a.md'), 'A')
      writeTextFileInDir(root, path.join('templates', 'b.md'), 'B')
      writeTextFileInDir(root, path.join('ignored', 'c.md'), 'C')

      expect(relativePathPosix(root, path.join(root, 'references', 'nested', 'a.md')))
        .toBe('references/nested/a.md')
      expect(listFilesUnderRoots(root, ['references', 'templates']))
        .toEqual(['references/nested/a.md', 'templates/b.md'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
