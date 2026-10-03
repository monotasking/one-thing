import { describe, expect, it } from 'vitest'
import os from 'os'
import path from 'path'
import {
  checkCoreFileAccess,
  expandCorePath,
  findCoreReadSandboxRootForPath,
  findCoreSandboxRootForPath,
  getCoreReadSandboxRoots,
  getCoreSandboxBoundary,
  getCoreSandboxRoots,
  isCorePathContained,
  resolveCoreToolPath,
} from '../sandbox.js'

describe('runtime core sandbox helpers', () => {
  it('expands tilde without host adapters', () => {
    expect(expandCorePath('~/Documents')).toBe(path.join(os.homedir(), 'Documents'))
    expect(expandCorePath('/workspace/~literal')).toBe('/workspace/~literal')
  })

  it('resolves boundaries from explicit workdir, configured default, then cwd', () => {
    expect(getCoreSandboxBoundary({ workingDirectory: '/active' })).toBe('/active')
    expect(getCoreSandboxBoundary({ defaultWorkingDirectory: '~/workspace' }))
      .toBe(path.join(os.homedir(), 'workspace'))
    expect(getCoreSandboxBoundary({ cwd: '/fallback' })).toBe('/fallback')
  })

  it('resolves tool paths against the core sandbox boundary', () => {
    expect(resolveCoreToolPath('src/index.ts', { workingDirectory: '/workspace' }))
      .toBe(path.join('/workspace', 'src/index.ts'))
    expect(resolveCoreToolPath('/tmp/file.txt', { workingDirectory: '/workspace' }))
      .toBe('/tmp/file.txt')
  })

  it('deduplicates sandbox roots and guards against prefix attacks', () => {
    expect(getCoreSandboxRoots({
      workingDirectory: '/workspace',
      workingDirectoryRoots: ['/workspace', '/shared', '/shared'],
    })).toEqual(['/workspace', '/shared'])

    expect(isCorePathContained('/workspace', '/workspace/src/file.ts')).toBe(true)
    expect(isCorePathContained('/workspace', '/workspace-evil/file.ts')).toBe(false)
  })

  /**
   * 接入目录进**可写**根 —— 这是全套里唯一动权限面的一条,所以正反两侧都钉死。
   *
   * 效果链条:进了可写根 → `findCoreSandboxRootForPath` 命中 → write/edit 的
   * effect 不再标 `external` → `auto-accept-edits` 放行(permission-policy.ts:146)。
   * 反过来,空列表必须让这条链一个环节都不动。
   */
  describe('connected directories are writable sandbox roots', () => {
    it('缺席与空数组下,根列表与没有这个功能时逐字节一致', () => {
      const baseline = getCoreSandboxRoots({
        workingDirectory: '/workspace',
        workingDirectoryRoots: ['/shared'],
      })

      expect(baseline).toEqual(['/workspace', '/shared'])
      expect(getCoreSandboxRoots({
        workingDirectory: '/workspace',
        workingDirectoryRoots: ['/shared'],
        connectedDirectories: [],
      })).toEqual(baseline)

      // 空列表时越界仍然是越界 —— auto-accept 的那道闸不会被这个功能悄悄打开。
      expect(findCoreSandboxRootForPath('/Users/me/vault/note.md', {
        workingDirectory: '/workspace',
        connectedDirectories: [],
      })).toBeUndefined()
    })

    it('加入的目录成为可写根,界外路径因此变成界内', () => {
      expect(getCoreSandboxRoots({
        workingDirectory: '/workspace',
        connectedDirectories: ['/Users/me/vault'],
      })).toEqual(['/workspace', '/Users/me/vault'])

      expect(findCoreSandboxRootForPath('/Users/me/vault/note.md', {
        workingDirectory: '/workspace',
        connectedDirectories: ['/Users/me/vault'],
      })).toBe('/Users/me/vault')
    })

    it('只授权被加入的那棵树:兄弟目录与前缀近邻仍然越界', () => {
      const options = {
        workingDirectory: '/workspace',
        connectedDirectories: ['/Users/me/vault'],
      }

      expect(findCoreSandboxRootForPath('/Users/me/secrets/id_rsa', options)).toBeUndefined()
      // 前缀攻击:/Users/me/vault-evil 不在 /Users/me/vault 之内。
      expect(findCoreSandboxRootForPath('/Users/me/vault-evil/x', options)).toBeUndefined()
    })

    it('与工作目录/会话根重合时去重,~ 展开成绝对路径', () => {
      expect(getCoreSandboxRoots({
        workingDirectory: '/workspace',
        workingDirectoryRoots: ['/shared'],
        connectedDirectories: ['/workspace', '/shared', '~/vault'],
      })).toEqual(['/workspace', '/shared', path.join(os.homedir(), 'vault')])
    })

    it('可写根自动也是读根', () => {
      expect(getCoreReadSandboxRoots({
        workingDirectory: '/workspace',
        connectedDirectories: ['/Users/me/vault'],
        defaultReadRoots: ['/downloads'],
      })).toEqual(['/workspace', '/Users/me/vault', '/downloads'])
    })
  })

  it('finds write and read roots using host-supplied read roots', () => {
    expect(findCoreSandboxRootForPath('/shared/SKILL.md', {
      workingDirectory: '/workspace',
      workingDirectoryRoots: ['/shared'],
    })).toBe('/shared')

    expect(getCoreReadSandboxRoots({
      workingDirectory: '/workspace',
      workingDirectoryRoots: ['/shared'],
      defaultReadRoots: ['/notes/personal', '/downloads'],
    })).toEqual(['/workspace', '/shared', '/notes/personal', '/downloads'])

    expect(findCoreReadSandboxRootForPath('/notes/personal/today.md', {
      workingDirectory: '/workspace',
      defaultReadRoots: ['/notes/personal'],
    })).toBe('/notes/personal')
  })

  it('resolves file access without importing Electron or app stores', async () => {
    await expect(checkCoreFileAccess(
      'src/file.ts',
      { sessionId: 's1', messageId: 'm1', workingDirectory: '/workspace' },
      'read file',
    )).resolves.toBe(path.join('/workspace', 'src/file.ts'))
  })
})
