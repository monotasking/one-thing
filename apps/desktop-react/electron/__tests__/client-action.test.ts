import { describe, expect, it, vi } from 'vitest'
import { parseClientAction, runClientAction, type ClientActionPorts } from '../client-action'

/**
 * `host:client-action` 的主进程那一半(第④步批 1,决策 D5 / D278)。载荷来自渲染进程,所以判据住在收件
 * 这一侧:四个动词逐格校验,不合规矩的一律拒、永不抛;合规矩的才交给 Electron 那几下(这里是替身)。
 */
function ports(): ClientActionPorts & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    showOpenDialog: vi.fn(async request => {
      calls.push(`dialog:${(request.properties ?? []).join(',')}`)
      return { canceled: false, filePaths: ['/picked'] }
    }),
    openExternal: vi.fn(async url => { calls.push(`external:${url}`) }),
    openPath: vi.fn(async filePath => { calls.push(`open:${filePath}`); return '' }),
    revealPath: vi.fn(filePath => { calls.push(`reveal:${filePath}`) }),
  }
}

describe('parseClientAction', () => {
  it('openExternal 只放行 http(s) 与 mailto', () => {
    expect(parseClientAction({ kind: 'openExternal', url: 'https://example.test/x' })).toEqual({ kind: 'openExternal', url: 'https://example.test/x' })
    expect(parseClientAction({ kind: 'openExternal', url: 'mailto:a@b.test' })).toMatchObject({ kind: 'openExternal' })
    expect(parseClientAction({ kind: 'openExternal', url: 'file:///etc/passwd' })).toEqual({ error: 'scheme file: is not allowed' })
    expect(parseClientAction({ kind: 'openExternal', url: 'not a url' })).toEqual({ error: 'url is not a valid absolute URL' })
  })

  it('openPath / revealPath 只收绝对路径', () => {
    expect(parseClientAction({ kind: 'revealPath', path: '/Users/x/a.txt' })).toEqual({ kind: 'revealPath', path: '/Users/x/a.txt' })
    expect(parseClientAction({ kind: 'openPath', path: 'relative/a' })).toEqual({ error: 'path must be absolute' })
    expect(parseClientAction({ kind: 'openPath', path: '' })).toEqual({ error: 'path is required' })
  })

  it('showOpenDialog 只认契约里那几个词;认不出的 kind 一律拒', () => {
    expect(parseClientAction({ kind: 'showOpenDialog', request: { properties: ['openDirectory', 'createDirectory'], title: 't' } }))
      .toEqual({ kind: 'showOpenDialog', request: { properties: ['openDirectory', 'createDirectory'], title: 't' } })
    expect(parseClientAction({ kind: 'showOpenDialog', request: { properties: ['openDirectory', 'treatPackageAsDirectory'] } }))
      .toMatchObject({ error: expect.stringContaining('unknown dialog property') })
    expect(parseClientAction({ kind: 'showOpenDialog', request: { filters: [{ name: 'x' }] } }))
      .toMatchObject({ error: expect.stringContaining('filter') })
    expect(parseClientAction({ kind: 'runCommand', command: 'rm -rf /' })).toMatchObject({ error: expect.stringContaining('unknown client action') })
    expect(parseClientAction(null)).toEqual({ error: 'client action must be an object' })
  })
})

describe('runClientAction', () => {
  it('合规矩的交给端口,答契约里那一支', async () => {
    const p = ports()
    await expect(runClientAction({ kind: 'revealPath', path: '/a/b' }, p)).resolves.toEqual({ ok: true })
    await expect(runClientAction({ kind: 'openExternal', url: 'https://example.test' }, p)).resolves.toEqual({ ok: true })
    await expect(runClientAction({ kind: 'showOpenDialog', request: { properties: ['openFile'] } }, p))
      .resolves.toEqual({ canceled: false, filePaths: ['/picked'] })
    expect(p.calls).toEqual(['reveal:/a/b', 'external:https://example.test', 'dialog:openFile'])
  })

  it('不合规矩的一下都不做;端口失败折成结局,永不抛', async () => {
    const p = ports()
    await expect(runClientAction({ kind: 'openExternal', url: 'javascript:alert(1)' }, p)).resolves.toMatchObject({ ok: false })
    await expect(runClientAction({ kind: 'showOpenDialog', request: { properties: ['bogus'] } }, p))
      .resolves.toEqual({ canceled: true, filePaths: [] })
    expect(p.calls).toEqual([])

    p.openPath = vi.fn(async () => 'No application knows how to open this')
    await expect(runClientAction({ kind: 'openPath', path: '/a' }, p)).resolves.toEqual({ ok: false, error: 'No application knows how to open this' })
    p.openExternal = vi.fn(async () => { throw new Error('boom') })
    await expect(runClientAction({ kind: 'openExternal', url: 'https://x.test' }, p)).resolves.toEqual({ ok: false, error: 'boom' })
  })
})
