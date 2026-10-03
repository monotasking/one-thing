import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkOnethingFileAccess,
  configureOnethingToolSandboxRuntime,
  findOnethingReadSandboxRootForPath,
  getOnethingDefaultReadRoots,
  getOnethingDownloadsDirectory,
  getOnethingReadSandboxRoots,
  getOnethingToolSandboxBoundary,
  resetOnethingToolSandboxRuntimeForTests,
  resolveOnethingToolPath,
} from '../sandbox-runtime.js'

describe('onething tool sandbox runtime', () => {
  afterEach(() => {
    resetOnethingToolSandboxRuntimeForTests()
  })

  it('uses the configured default working directory when no active workspace is provided', () => {
    configureOnethingToolSandboxRuntime({
      getDefaultWorkingDirectory: () => '~/workspace',
      homeDir: '/home/tester',
    })

    expect(getOnethingToolSandboxBoundary()).toBe(path.join(os.homedir(), 'workspace'))
    expect(resolveOnethingToolPath('src/index.ts')).toBe(path.resolve(os.homedir(), 'workspace/src/index.ts'))
  })

  it('builds default read roots from note directories and downloads', () => {
    configureOnethingToolSandboxRuntime({
      getHostPath: name => name === 'downloads' ? '/host/Downloads' : undefined,
      getNoteDirectories: () => ['', '/notes/personal', '/notes/work', '/notes/work'],
    })

    expect(getOnethingDefaultReadRoots()).toEqual([
      '/notes/personal',
      '/notes/work',
      '/host/Downloads',
    ])

    expect(getOnethingReadSandboxRoots('/repo', ['/shared'])).toEqual([
      '/repo',
      '/shared',
      '/notes/personal',
      '/notes/work',
      '/host/Downloads',
    ])
    expect(findOnethingReadSandboxRootForPath('/notes/personal/today.md', '/repo')).toBe('/notes/personal')
  })

  it('接入目录也进默认读根 —— 不出现「能改却要为读弹卡」', () => {
    configureOnethingToolSandboxRuntime({
      getHostPath: name => name === 'downloads' ? '/host/Downloads' : undefined,
      getNoteDirectories: () => ['/notes/personal'],
      getConnectedDirectories: () => ['', '/Users/me/vault', '/Users/me/vault'],
    })

    expect(getOnethingDefaultReadRoots()).toEqual([
      '/notes/personal',
      '/Users/me/vault',
      '/host/Downloads',
    ])
    expect(findOnethingReadSandboxRootForPath('/Users/me/vault/note.md', '/repo')).toBe('/Users/me/vault')
  })

  it('接入目录缺席/空数组时,默认读根与没有这个功能时一致', () => {
    configureOnethingToolSandboxRuntime({
      getHostPath: name => name === 'downloads' ? '/host/Downloads' : undefined,
      getNoteDirectories: () => ['/notes/personal'],
      getConnectedDirectories: () => [],
    })

    expect(getOnethingDefaultReadRoots()).toEqual(['/notes/personal', '/host/Downloads'])
    expect(findOnethingReadSandboxRootForPath('/Users/me/vault/note.md', '/repo')).toBeUndefined()
  })

  it('falls back to the user Downloads directory when the host path adapter fails', () => {
    expect(getOnethingDownloadsDirectory({
      homeDir: '/home/tester',
      getHostPath: () => {
        throw new Error('host unavailable')
      },
    })).toBe('/home/tester/Downloads')
  })

  it('delegates file access resolution to the core sandbox helpers', async () => {
    await expect(checkOnethingFileAccess('src/file.ts', {
      sessionId: 'session-1',
      messageId: 'message-1',
      workingDirectory: '/repo',
    }, 'read')).resolves.toBe(path.resolve('/repo/src/file.ts'))
  })
})
