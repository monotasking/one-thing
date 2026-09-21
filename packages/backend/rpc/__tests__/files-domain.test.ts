/**
 * files 域,端到端穿过 dispatcher(结构债 P4c 第八批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/files.ts` 的工厂与
 * `@main/ipc/files.ts` 的壳适配(连同 `@main/ipc/__tests__/files.test.ts` ——
 * 那两条 @ 补全用例原样搬到了下面)、bridge 上那十四条包装、server 的十四条
 * REST 路由 + `files` facade adapter 的数据面。
 *
 * 本域最要紧的判据是 **#19 的安全面**:同一份实现要给出两种语义。
 *  - `transport:'ipc'`(桌面)**不夹**,与迁移前 `@main` handler 逐字同义;
 *  - `transport:'http'`(server)每条带路径的方法都夹进 `sandboxRoot`,越界回
 *    结构化失败(文案逐字沿用旧 server 路由);
 *  - `reveal` 走 `configureShellHost`,未注入即结构化降级,而且**先夹后降级**;
 *  - `list` 带 `sessionId` 时按会话归属解析接入目录(批 B2)。
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { filesRouter } from '@shared/ipc/files.js'
import {
  configureHostLocalTrust,
  resetHostLocalTrustForTests,
} from '../../server/host-trust.js'

const ripgrep = vi.hoisted(() => ({ listFiles: vi.fn() }))
const shell = vi.hoisted(() => ({ revealPath: vi.fn() }))
const connected = vi.hoisted(() => ({
  getConnectedDirectoriesForSession: vi.fn((): string[] => []),
}))

vi.mock('../../utils/ripgrep.js', () => ({ listFiles: ripgrep.listFiles }))

/**
 * 笔记根来自**笔记领域**(P3;从前是 `user_note_dir` / `work_note_dir` 两个变量)。
 * 反证:把 `domains/files.ts` 的 `getNoteRoots` 改回读变量仓,下面那条 @ 候选用例
 * 当场红。
 */
const notes = vi.hoisted(() => ({ roots: [] as string[] }))
vi.mock('../../wiring/notes/index.js', () => ({ noteRootsNow: () => notes.roots }))
vi.mock('@onething/runtime/shell/host-ports', async () => {
  const actual = await vi.importActual<typeof import('@onething/runtime/shell/host-ports')>(
    '@onething/runtime/shell/host-ports',
  )
  return { ...actual, getShellHost: () => shell }
})
vi.mock('../../stores/connected-directories.js', () => ({
  getConnectedDirectoriesForSession: connected.getConnectedDirectoriesForSession,
}))

async function* emit(items: string[]) {
  for (const item of items) yield item
}

const IPC: RpcDispatchContext = { transport: 'ipc' }

function http(sandboxRoot: string): RpcDispatchContext {
  return { transport: 'http', ownerUid: 'local-user', workspaceId: 'default', sandboxRoot }
}

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('files RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined
  let sandboxRoot: string

  beforeEach(async () => {
    const [registry, domain, { resetVariablesStoreForTests }, { createDefaultVariablesFile }]
      = await Promise.all([
        import('../registry.js'),
        import('../domains/files.js'),
        import('@onething/runtime/variables/store-bound'),
        import('@onething/runtime/variables/schema'),
      ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(filesRouter, domain.filesRpcHandlers)

    resetVariablesStoreForTests().hydrateForTests(createDefaultVariablesFile())
    notes.roots = []
    ripgrep.listFiles.mockReset().mockReturnValue(emit([]))
    shell.revealPath.mockReset().mockResolvedValue({ success: true })
    connected.getConnectedDirectoriesForSession.mockReset().mockReturnValue([])

    sandboxRoot = await mkdtemp(join(tmpdir(), 'onething-files-domain-'))

    // 本机宿主豁免是**进程级单槽**:每条用例从"未声明 + 无强制开关"起跑,
    // 否则一条用例的声明会漏进下一条。
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
    vi.restoreAllMocks()
  })

  function call(method: string, payload: unknown, context: RpcDispatchContext) {
    return dispatchRpc({ domain: 'files', method, payload }, context)
  }

  /**
   * 「这是一台桌面」这句话,C0 R2 之后要**声明**出来。
   *
   * 从前 `resolveRpcSandbox` 认的是 `transport === 'ipc'`,所以喂一个 IPC context
   * 就等于"我是桌面";现在它与 files 域自己那条判据合并成同一句
   * `isHostLocallyTrusted()` —— 而那句话由宿主在**装配时**说(两个桌面壳都写
   * `{ origin: 'desktop-embedded' }`)。这份测试里没有装配,所以由这个 helper 顶上。
   * 上面 beforeEach 里的 `resetHostLocalTrustForTests()` 保证它不漏到下一条。
   */
  function declareDesktopHost(): void {
    configureHostLocalTrust({ origin: 'desktop-embedded', host: '127.0.0.1' })
  }

  // ── #19:http 夹紧 ───────────────────────────────────────────────

  it('refuses every path-carrying method that escapes the http sandbox', async () => {
    const outside = '/etc/passwd'
    const cases: Array<[string, unknown, string]> = [
      ['readContent', { path: outside }, 'File path must stay inside the workspace sandbox root.'],
      ['saveContent', { path: outside, content: 'x' }, 'File path must stay inside the workspace sandbox root.'],
      ['listDirectory', { path: outside }, 'Directory path must stay inside the workspace sandbox root.'],
      ['stat', { path: outside }, 'Path must stay inside the workspace sandbox root.'],
      ['create', { path: outside }, 'File path must stay inside the workspace sandbox root.'],
      ['createDirectory', { path: outside }, 'Directory path must stay inside the workspace sandbox root.'],
      ['rename', { oldPath: outside, newPath: outside }, 'Rename paths must stay inside the workspace sandbox root.'],
      ['delete', { path: outside }, 'Path must stay inside the workspace sandbox root.'],
      ['reveal', { path: outside }, 'Path must stay inside the workspace sandbox root.'],
      ['watchStart', { root: outside }, 'Workspace watch root must stay inside the workspace sandbox root.'],
      ['watchStop', { root: outside }, 'Workspace watch root must stay inside the workspace sandbox root.'],
      ['rollback', { filePath: outside }, 'Rollback file path must stay inside the workspace sandbox root.'],
    ]
    for (const [method, payload, error] of cases) {
      expect(unwrap(await call(method, payload, http(sandboxRoot)))).toEqual({ success: false, error })
    }
    expect(unwrap(await call('list', { cwd: outside }, http(sandboxRoot)))).toEqual({
      success: false,
      files: [],
      entries: [],
      error: 'File search must stay inside the workspace sandbox root.',
    })
    expect(unwrap(await call('listDirs', { basePath: outside }, http(sandboxRoot)))).toEqual({
      success: false,
      dirs: [],
      basePath: '',
      error: 'Directory completion must stay inside the workspace sandbox root.',
    })
  })

  it('serves a path that stays inside the http sandbox', async () => {
    await writeFile(join(sandboxRoot, 'a.txt'), 'hello', 'utf-8')
    const read = unwrap(await call('readContent', { path: 'a.txt' }, http(sandboxRoot)))
    expect(read).toMatchObject({ success: true, content: 'hello' })

    // `~` 在联网宿主上只能是沙箱根本身。
    const stat = unwrap(await call('stat', { path: '~/a.txt' }, http(sandboxRoot)))
    expect(stat).toMatchObject({ success: true, type: 'file' })
  })

  it('fails closed when a networked context arrives without a sandbox root', async () => {
    const response = await call('stat', { path: '/tmp' }, { transport: 'http' })
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('expected a rejection')
    expect(response.error.message).toContain('sandboxRoot')
  })

  // ── 本机宿主豁免:三态 ──────────────────────────────────────────
  //
  // 2026-08-30 用户拍板的安全语义变更。同一条 http 请求、同一条仓外真实路径,
  // 三种装配现状要给三种答案:
  //  1. **未声明**(独立部署 / 非回环 / 单元测试默认)= 现状,照夹;
  //  2. **声明可信**(桌面内嵌面 / 回环 server)= 与桌面 IPC 同权,放行;
  //  3. **强制收紧**(`ONETHING_SERVER_FILES_SANDBOX=1`)= 即便声明了也照夹。
  //
  // 用的是 `readContent` 与 `listDirectory` 两口,因为它们的夹紧文案不同 ——
  // 三态各自比对的是**这一口自己的**那句原话,而不是一句通用错误。

  describe('local host trust exemption', () => {
    let outside: string

    beforeEach(async () => {
      // 沙箱根之外的一棵真目录 —— React 壳要的正是这种"仓内真实路径"。
      outside = await mkdtemp(join(tmpdir(), 'onething-files-untrusted-'))
      await writeFile(join(outside, 'real.txt'), 'from the real disk', 'utf-8')
    })

    it('clamps http when no host declared local trust (unchanged behaviour)', async () => {
      expect(unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'File path must stay inside the workspace sandbox root.' })
      expect(unwrap(await call('listDirectory', { path: outside }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'Directory path must stay inside the workspace sandbox root.' })
    })

    it('gives http the same rights as desktop IPC once the host declares local trust', async () => {
      configureHostLocalTrust({ origin: 'loopback-server', host: '127.0.0.1' })

      const read = unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot)))
      expect(read).toMatchObject({ success: true, content: 'from the real disk' })

      const listed = unwrap(await call('listDirectory', { path: outside }, http(sandboxRoot)))
      expect(listed).toMatchObject({ success: true })
      expect(listed.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'real.txt' })]),
      )

      // 逐字同权:桌面上空串由投影自己答,豁免之后 http 也是这一句 ——
      // 不是沙箱文案。
      expect(unwrap(await call('readContent', { path: '' }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'File path is required' })
    })

    it('lets ONETHING_SERVER_FILES_SANDBOX=1 override a declared trust', async () => {
      configureHostLocalTrust({ origin: 'desktop-embedded', host: '127.0.0.1' })
      process.env.ONETHING_SERVER_FILES_SANDBOX = '1'

      expect(unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'File path must stay inside the workspace sandbox root.' })
      expect(unwrap(await call('listDirectory', { path: outside }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'Directory path must stay inside the workspace sandbox root.' })

      // 强制收紧不是"把声明抹掉":开关一撤,声明照旧生效(端口每次现读)。
      delete process.env.ONETHING_SERVER_FILES_SANDBOX
      expect(unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot))))
        .toMatchObject({ success: true, content: 'from the real disk' })
    })

    it('restores the previous declaration instead of clearing the slot', async () => {
      const restoreOuter = configureHostLocalTrust({ origin: 'desktop-embedded' })
      const restoreInner = configureHostLocalTrust({ origin: 'loopback-server' })
      // 内层让位(桌面内嵌面与 server:start 在同一进程里先后起落),外层还在。
      restoreInner()
      expect(unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot))))
        .toMatchObject({ success: true })
      restoreOuter()
      expect(unwrap(await call('readContent', { path: join(outside, 'real.txt') }, http(sandboxRoot))))
        .toEqual({ success: false, error: 'File path must stay inside the workspace sandbox root.' })
    })

    it('still fails closed on a networked context with no sandbox root and no trust', async () => {
      const response = await call('stat', { path: '/tmp' }, { transport: 'http' })
      expect(response.ok).toBe(false)
      if (response.ok) throw new Error('expected a rejection')
      expect(response.error.message).toContain('sandboxRoot')
    })
  })

  // ── 桌面:不夹 ──────────────────────────────────────────────────

  it('does not clamp on the desktop transport', async () => {
    declareDesktopHost()
    const outside = await mkdtemp(join(tmpdir(), 'onething-files-outside-'))
    await writeFile(join(outside, 'note.md'), 'desktop', 'utf-8')

    const read = unwrap(await call('readContent', { path: join(outside, 'note.md') }, IPC))
    expect(read).toMatchObject({ success: true, content: 'desktop' })

    // 空串照旧由投影自己答(迁移前 `@main` handler 就是原样递下去的)。
    const empty = unwrap(await call('readContent', { path: '' }, IPC))
    expect(empty).toEqual({ success: false, error: 'File path is required' })
  })

  it('keeps watchStart/watchStop as the desktop projection stub', async () => {
    declareDesktopHost()
    expect(unwrap(await call('watchStart', { root: '/anywhere' }, IPC))).toEqual({ success: true })
    expect(unwrap(await call('watchStart', { root: '' }, IPC)))
      .toEqual({ success: false, error: 'Workspace root is required' })
    expect(unwrap(await call('watchStop', { root: '/anywhere' }, IPC))).toEqual({ success: true })
  })

  // ── reveal:宿主端口 ────────────────────────────────────────────

  it('degrades reveal structurally when no shell host is injected', async () => {
    declareDesktopHost()
    const target = join(sandboxRoot, 'shown.txt')
    await writeFile(target, 'x', 'utf-8')
    shell.revealPath.mockResolvedValue({ success: false, error: 'shell host not available' })

    expect(unwrap(await call('reveal', { path: target }, IPC)))
      .toEqual({ success: false, error: 'shell host not available' })

    shell.revealPath.mockResolvedValue({ success: true })
    expect(unwrap(await call('reveal', { path: target }, IPC))).toEqual({ success: true })
    expect(shell.revealPath).toHaveBeenLastCalledWith(target)
  })

  // ── list:两侧的搜索根 ──────────────────────────────────────────

  it('resolves connected directories by the session that asked (desktop only)', async () => {
    declareDesktopHost()
    const connectedDir = await mkdtemp(join(tmpdir(), 'onething-files-connected-'))
    connected.getConnectedDirectoriesForSession.mockReturnValue([connectedDir])
    ripgrep.listFiles.mockReturnValue(emit([]))

    const result = unwrap(await call('list', { cwd: '', query: '', limit: 50, sessionId: 's-1' }, IPC))

    expect(connected.getConnectedDirectoriesForSession).toHaveBeenCalledWith('s-1')
    expect(result).toMatchObject({ success: true })
    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: connectedDir, source: 'connected' })]),
    )
  })

  it('offers notes and Downloads as directory roots for a bare @ on the desktop', async () => {
    declareDesktopHost()
    const { getDownloadsDirectory } = await import('../../wiring/tools/core/sandbox.js')
    const noteRoot = '/notes/personal'
    notes.roots = [noteRoot]
    ripgrep.listFiles.mockReturnValue(emit([]))

    const result = unwrap(await call('list', { cwd: '', query: '', limit: 50 }, IPC))

    expect(result).toMatchObject({ success: true })
    expect(result.entries).toEqual(expect.arrayContaining([
      // 标签是库的目录名(P3;从前是写死的「Personal notes」/「Work notes」两句)。
      { path: noteRoot, type: 'directory', source: 'note', label: 'personal' },
      { path: getDownloadsDirectory(), type: 'directory', source: 'downloads', label: 'Downloads' },
    ]))
  })

  it('searches the sandbox with its own walker (no ripgrep) on the http transport', async () => {
    await mkdir(join(sandboxRoot, 'src'), { recursive: true })
    await writeFile(join(sandboxRoot, 'src', 'receipt.txt'), 'x', 'utf-8')

    const result = unwrap(await call('list', { query: 'receipt', limit: 50 }, http(sandboxRoot)))

    expect(ripgrep.listFiles).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: true,
      files: [join(sandboxRoot, 'src', 'receipt.txt')],
    })
  })

  it('http: picked roots are clamped one by one — an outside root drops, the inside one still answers', async () => {
    await mkdir(join(sandboxRoot, 'src'), { recursive: true })
    await writeFile(join(sandboxRoot, 'src', 'picked.txt'), 'x', 'utf-8')

    const result = unwrap(await call('list', {
      query: 'picked',
      limit: 50,
      roots: [join(tmpdir(), 'definitely-outside-the-sandbox'), sandboxRoot],
    }, http(sandboxRoot)))
    expect(result).toMatchObject({ success: true, files: [join(sandboxRoot, 'src', 'picked.txt')] })
    expect((result as { entries?: unknown[] }).entries?.[0]).toMatchObject({ source: 'picked', root: sandboxRoot })

    expect(unwrap(await call('list', {
      roots: [join(tmpdir(), 'definitely-outside-the-sandbox')],
    }, http(sandboxRoot)))).toMatchObject({
      success: false,
      error: 'File search must stay inside the workspace sandbox root.',
    })
  })

  // ── 写面:落到磁盘 ──────────────────────────────────────────────

  it('creates, saves and renames inside the http sandbox', async () => {
    expect(unwrap(await call('create', { path: 'b.txt', content: 'one' }, http(sandboxRoot))))
      .toEqual({ success: true })
    expect(unwrap(await call('rename', { oldPath: 'b.txt', newPath: 'c.txt' }, http(sandboxRoot))))
      .toEqual({ success: true })
    const saved = unwrap(await call(
      'saveContent',
      { path: 'c.txt', content: 'two' },
      http(sandboxRoot),
    ))
    expect(saved).toMatchObject({ success: true })
    await expect(readFile(join(sandboxRoot, 'c.txt'), 'utf-8')).resolves.toBe('two')
  })

  /* ── `~` 展开(09-21 真机报障)────────────────────────────────────────────
   *
   * 笔记正文里一格行内码 `` `~/Documents/.../0907/` `` 被认成目录 chip,点开落到
   * `listDirectory`,回一句 `ENOENT ... scandir '~/Documents/...'` —— 目录明明在。
   * 十四条里从前只有 `stat` 认得 `~`(它的投影自己展开),于是文件树的根靠 `stat`
   * 绕过去了,而 chip 直接打过来的那些条一条都不认。
   */
  describe("`~` is a way people write paths, so the desktop path understands it", () => {
    let home: string | undefined

    beforeEach(() => {
      home = process.env.HOME
      process.env.HOME = sandboxRoot
    })

    afterEach(() => {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    })

    it('expands ~ for listDirectory / readContent / stat on a desktop host', async () => {
      await mkdir(join(sandboxRoot, 'deploy'), { recursive: true })
      await writeFile(join(sandboxRoot, 'deploy', 'iva.lua'), 'return {}', 'utf-8')
      declareDesktopHost()

      // 尾随 `/` 是目录 chip 自己的记号,照样要认。
      const listed = unwrap(await call('listDirectory', { path: '~/deploy/' }, IPC))
      expect(listed).toMatchObject({ success: true })
      expect(listed.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'iva.lua' })]),
      )

      expect(unwrap(await call('readContent', { path: '~/deploy/iva.lua' }, IPC)))
        .toMatchObject({ success: true, content: 'return {}' })

      expect(unwrap(await call('stat', { path: '~/deploy' }, IPC)))
        .toMatchObject({ success: true, type: 'directory', path: join(sandboxRoot, 'deploy') })
    })

    it('leaves the empty-path answer alone (it is the projection that speaks)', async () => {
      declareDesktopHost()
      expect(unwrap(await call('readContent', { path: '' }, IPC)))
        .toEqual({ success: false, error: 'File path is required' })
    })

    it('never resolves ~ against the real home on a clamped http host', async () => {
      // 夹紧那一支里 `~` 展开到**沙箱根**,不是 `$HOME` —— 这一条不许被上面那格改掉。
      await mkdir(join(sandboxRoot, 'deploy'), { recursive: true })
      process.env.HOME = '/etc'
      const listed = unwrap(await call('listDirectory', { path: '~/deploy' }, http(sandboxRoot)))
      expect(listed).toMatchObject({ success: true })
    })
  })

  it('rejects a method that is not on the router allowlist', async () => {
    const response = await call('chmod', { path: '/tmp' }, IPC)
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('expected a rejection')
    expect(response.error.code).toBe('UNKNOWN_METHOD')
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})
