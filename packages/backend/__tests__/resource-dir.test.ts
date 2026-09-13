/**
 * K3-c —— 目录这一 scheme 在**真装配**里的门(`docs/design/atom-2026-09.md` §9 K3)。
 *
 * 单测那一半(`wiring/resource/__tests__/dir-provider.test.ts`)摆布的是一台假沙箱;
 * 这只文件要证的五句话没有一句在那里说得出口 —— 它们全都关乎「装配把什么递给了
 * 内核」:
 *
 *   ① 装配之后注册表里有 `dir`,工具目录里也有那只工具;
 *   ② `read('dir:<仓内某目录>','list')` 拿到的是**真条目** —— 而「仓内」这三个字
 *      本身就是读数:资源内核拿到的沙箱正是工具 runner 那一把(进程边界 =
 *      `process.cwd()`,因为这台临时 store 没有配默认工作目录);
 *   ③ `read('dir:/','list')` → `failed` —— 沙箱外一律拒;
 *   ④ AI 那条路(直接 `runner.run` 那只工具)读得到同一份东西的文本投影;
 *   ⑤ 设置里**接入**一个写根之外的目录,它就列得出来(2026-09-10 的读根那一格,
 *      K3-c 留账第 3 条还的)—— 同一条读在接入之前是 `failed`,之后是 `ok`,
 *      两句断言在同一个用例里,所以它证的是**这一次设置**,不是「什么都读得到」。
 *   ⑦ **发起会话绑的工作目录就是读根**(2026-09-13):资源读根 = 工具读根,同一张
 *      表 —— 少这一格,同一条会话、同一个仓,`read` 工具读得到而 `dir:` / `git:`
 *      资源答「outside」。按**会话**取:另一条没绑的会话问同一个路径照旧拒;
 *   ⑥ **写面走的是真权限卡**(K3-c'):AI 主体 `do('dir:…','createDirectory')` 停在
 *      一张 `file_write` 的卡上(那一类在效果表里是 `ask`),答 `once` 之后目录**真的
 *      在盘上**;`delete` 同样停一张 `file_destructive_edit` 的卡,答完之后目录没了,
 *      而 `deleted` 事件从**内核那条真总线**上到达。这一条同时证明写面与读面共用
 *      同一台 runner —— 卡不是这只测试造的,是管线出的。
 *
 * **反证②(缺席不是放行)**:把 `wiring/resource/index.ts` 里
 * `createResourceKernel` 的 `sandbox: createSandboxPolicy()` 那一行拆掉,②当场红 ——
 * provider 拿不到沙箱就一律拒(`DirOutsideSandboxError`,reason `no-sandbox`),
 * 而不是「没人拦就放过去」。
 *
 * **`localTrust` 这一格是必须的**:资源面今天没有 per-caller 的沙箱根,所以内核那只
 * 读守卫(`wiring/resource/read-guard.ts`)在没有声明本机可信的进程上一律拒 `dir`
 * 读。这台测试宿主声明 `desktop-embedded`,与桌面内嵌 HTTP 面逐字同一格。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts`:
 * `stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就解析 store 根。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-dir-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

const PRINCIPAL = { kind: 'user', userId: 'local' } as const
/** 会话里那个 AI。写面**不按主体分档**,所以人走这条路也一样会停卡 —— 用 AI 是因为
 *  这条路在生产上主要是它在走(界面上删文件走的是 `files` 域)。 */
const AI = { kind: 'agent', agentId: 'default' } as const

/**
 * 读的目标是**这个仓库里**的一个目录,不是 store 里的一个 —— 因为沙箱边界是
 * `process.cwd()`(这台 store 没有配默认工作目录),而 store 在 `os.tmpdir()` 下,
 * 它在界外。这不是绕开判据,这**就是**判据:同一把尺子,`read` 工具读一个路径与
 * 资源面列它的父目录判的是同一条边界。
 */
const TARGET_DIR = path.join(process.cwd(), 'packages', 'backend', 'wiring', 'resource')

describe('目录资源在真装配里(K3-c)', () => {
  let backend: Backend

  it('① 装配之后 dir 在注册表与工具目录里', { timeout: 180_000 }, async () => {
    const { createOnethingBackend } = await import('../backend.js')
    backend = await createOnethingBackend({
      host: {
        storePath: {},
        sandbox: {},
        auth: null,
        logging: null,
        shell: null,
        voice: null,
        terminal: null,
        skillsEnvironment: null,
        todoPlan: null,
        scratchpad: null,
        plugins: null,
        gateway: null,
        settings: null,
        evals: null,
        mcp: null,
        // 见文件头:没有它,内核那只读守卫会拒掉②与④。
        localTrust: { origin: 'desktop-embedded' },
      },
      toolRegistry: 'headless',
      sender: new NoopSender() as never,
    })

    expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain('dir')
    expect(backend.resources.tools().map(tool => tool.spec.id)).toContain('dir')

    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    expect(getToolkitCatalog()?.has('dir')).toBe(true)
  })

  it('② 界面 / 脚本那条路:list 拿到真条目', async () => {
    const outcome = await backend.resources.read(`dir:${TARGET_DIR}`, 'list', {}, { principal: PRINCIPAL })
    expect(outcome.kind).toBe('ok')
    const entries = outcome.kind === 'ok'
      ? (outcome.value as { entries: Array<{ name: string; kind: string }> }).entries
      : []
    expect(entries.some(entry => entry.name === 'dir-provider.ts' && entry.kind === 'file')).toBe(true)
    expect(entries.some(entry => entry.name === '__tests__' && entry.kind === 'dir')).toBe(true)

    const stat = await backend.resources.read(
      `dir:${path.join(TARGET_DIR, 'dir-provider.ts')}`,
      'stat',
      {},
      { principal: PRINCIPAL },
    )
    expect(stat.kind === 'ok' && (stat.value as { kind: string }).kind).toBe('file')
  })

  it('③ 沙箱外的目录读不到', async () => {
    const outcome = await backend.resources.read('dir:/', 'list', {}, { principal: PRINCIPAL })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.name).toBe('DirOutsideSandboxError')
  })

  it('④ AI 那条路(直接 run 那只工具)读得到同一份东西', async () => {
    const { createAppToolRunner } = await import('../wiring/toolkit/runner.js')
    const runner = createAppToolRunner({ observer: { on: () => {} } })
    const tool = backend.resources.toolFor('dir')
    expect(tool).toBeTruthy()

    const outcome = await runner.run(tool!, {
      callId: 'dir-ai-1',
      toolId: 'dir',
      input: { read: 'list', ref: `dir:${TARGET_DIR}` },
      sessionId: 'no-session',
      principal: PRINCIPAL,
    })

    expect(outcome.kind).toBe('ok')
    const { resultToText } = await import('@onething/core/toolkit')
    const text = outcome.kind === 'ok' ? resultToText(outcome.result) : ''
    expect(text).toContain('dir-provider.ts')
  })

  it('⑤ 接入目录在写根之外,但它读得出来', async () => {
    // 这棵树在 `os.tmpdir()` 下 —— 沙箱写根是 `process.cwd()`,它在界外。
    const connected = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-connected-dir-')))
    fs.writeFileSync(path.join(connected, 'note.md'), '# hi\n')

    const { getSettings, updateSettingsInMemory } = await import('../stores/settings.js')
    const before = getSettings()
    try {
      // 接入之前:写根之外,拒。
      const denied = await backend.resources.read(`dir:${connected}`, 'list', {}, { principal: PRINCIPAL })
      expect(denied.kind).toBe('failed')
      expect(denied.kind === 'failed' && denied.error.name).toBe('DirOutsideSandboxError')

      // 用户在设置里把它接进来(唯一读点是 `stores/connected-directories.ts`,
      // 这里写的正是它读的那一格)。
      updateSettingsInMemory({
        ...before,
        tools: { ...before.tools, connectedDirectories: [connected] },
      })

      // 接入之后:同一条读,`ok`。**改前这一句红** —— provider 判的是 `contains`
      // (写根),而接入目录不在写根里。
      const outcome = await backend.resources.read(`dir:${connected}`, 'list', {}, { principal: PRINCIPAL })
      expect(outcome.kind).toBe('ok')
      const entries = outcome.kind === 'ok'
        ? (outcome.value as { entries: Array<{ name: string; kind: string }> }).entries
        : []
      expect(entries.map(entry => entry.name)).toEqual(['note.md'])

      // 写根没有跟着放宽:同一个路径,`read` 工具那条路照旧报 `external_directory`
      // 的判据(`findSandboxRootForPath` 命中与否)不在这里断言,但沙箱端口的
      // `contains` 就在手边,直接问它。
      const { createSandboxPolicy } = await import('../wiring/toolkit/runner.js')
      expect(createSandboxPolicy().contains(path.join(connected, 'note.md'))).toBe(false)
    } finally {
      updateSettingsInMemory(before)
      fs.rmSync(connected, { recursive: true, force: true })
    }
  })

  it('⑦ 发起会话绑的工作目录就是读根 —— 资源读根 = 工具读根,同一张表(反证③)', async () => {
    /*
     * 病根:工具那条路(`toolkit/families/file.ts` 的 `sandboxRoots`)一直把
     * `scope.workingDirectory` 算进根里,而资源那条路的 `createSandboxPolicy()`
     * 没传这一格 —— 于是**同一条会话、同一个仓**,`read` 工具读得到、`dir:` / `git:`
     * 资源答「outside the sandbox root」。这一例证的是那一格补上了,而且它是
     * **按发起会话**取的:另一条没绑 workdir 的会话问同一个路径,照旧拒。
     */
    const bound = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-workdir-')))
    fs.mkdirSync(path.join(bound, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(bound, 'sub', 'note.md'), '# hi\n')

    const store = await import('../store.js')
    const { sessionCommands } = await import('../session/commands.js')
    const withWorkdir = store.createSession(`resource-workdir-${Date.now()}`, 'Bound').id
    const without = store.createSession(`resource-no-workdir-${Date.now()}`, 'Unbound').id
    sessionCommands.patchSession(withWorkdir, { patch: { workingDirectory: bound } })

    try {
      // 前提:它在进程写根之外(写根是 `process.cwd()`,这棵树在 `os.tmpdir()` 下),
      // 也不是接入目录 —— 所以下面读得到,靠的只能是那条会话绑的工作目录。
      const { createSandboxPolicy } = await import('../wiring/toolkit/runner.js')
      expect(createSandboxPolicy().contains(path.join(bound, 'sub'))).toBe(false)
      expect(createSandboxPolicy().readable(path.join(bound, 'sub'), withWorkdir)).toBe(false)

      // 发起坐标 = 那条绑了 workdir 的会话 → 读得到。**改前这一句红**。
      const allowed = await backend.resources.read(
        `dir:${path.join(bound, 'sub')}`,
        'list',
        {},
        { principal: PRINCIPAL, sessionId: withWorkdir },
      )
      expect(allowed.kind).toBe('ok')
      const entries = allowed.kind === 'ok'
        ? (allowed.value as { entries: Array<{ name: string }> }).entries
        : []
      expect(entries.map(entry => entry.name)).toEqual(['note.md'])

      // 另一条会话没绑 —— 同一个路径照旧拒。多的那一格是**按会话**的,不是全局放宽。
      const denied = await backend.resources.read(
        `dir:${path.join(bound, 'sub')}`,
        'list',
        {},
        { principal: PRINCIPAL, sessionId: without },
      )
      expect(denied.kind).toBe('failed')
      expect(denied.kind === 'failed' && denied.error.name).toBe('DirOutsideSandboxError')

      // 不给发起坐标(`NO_ORIGIN_SESSION`)也照旧拒 —— 缺席退回这一格存在之前的行为。
      const anonymous = await backend.resources.read(
        `dir:${path.join(bound, 'sub')}`,
        'list',
        {},
        { principal: PRINCIPAL },
      )
      expect(anonymous.kind).toBe('failed')
    } finally {
      fs.rmSync(bound, { recursive: true, force: true })
    }
  })

  /**
   * ⑥ 写面(K3-c')。
   *
   * **写根挪到一个临时目录里**,而不是在这个仓库里建了又删:写根是
   * `getSandboxBoundary()`,它读 `settings.tools.bash.defaultWorkingDirectory`,
   * 缺席才退到 `process.cwd()`。把那一格填上,这只用例的写就落在 `os.tmpdir()` 下 ——
   * 一次跑挂了也不会在别人的工作树里留下一个目录。**这不是绕开判据**:判据仍然是
   * 「写根之内才写得进」,只是这次的写根是它自己起的那一棵。
   */
  it('⑥ AI 主体的写:createDirectory 停在真权限卡上,答完真建出来;delete 之后 deleted 到达', async () => {
    const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-dir-write-')))
    const { getSettings, updateSettingsInMemory } = await import('../stores/settings.js')
    const before = getSettings()
    const store = await import('../store.js')
    const { Permission } = await import('../wiring/permission/index.js')
    const sessionId = store.createSession(`resource-dir-${Date.now()}`, 'Dir').id
    const target = path.join(workRoot, 'notes')

    /** 等那张卡出现,读一句它说的话,答 `once`。 */
    const answerOneCard = async (expectedType: string): Promise<string> => {
      await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
      const card = Permission.getPendingPrompts(sessionId)[0]!
      expect(card.type).toBe(expectedType)
      Permission.respond({ sessionId, permissionId: card.id, response: 'once' })
      return card.title ?? ''
    }

    const seen: Array<{ ref: string; event: string; payload: unknown }> = []
    const unwatch = backend.resources.events.watch('dir:', fact => {
      seen.push({ ref: fact.ref, event: fact.event, payload: fact.payload })
    })

    try {
      // `bash` 那一格是可选的,所以取它之前先问一句 —— 它不在,这一测就没有落点
      // (写根会退回 `process.cwd()`,于是这一测会在这个仓库里建目录)。
      const bashBefore = before.tools.bash
      if (!bashBefore) throw new Error('settings.tools.bash is missing — the sandbox write root has nowhere to move')
      updateSettingsInMemory({
        ...before,
        tools: { ...before.tools, bash: { ...bashBefore, defaultWorkingDirectory: workRoot } },
      })

      // 建目录:`file_write` 在效果表里是 `ask`,所以它停在一张真卡上。
      const creating = backend.resources.do(
        `dir:${workRoot}`,
        'createDirectory',
        { name: 'notes' },
        { principal: AI, sessionId },
      )
      const createTitle = await answerOneCard('file_write')
      expect(createTitle).toContain(target)

      const created = await creating
      expect(created.kind).toBe('ok')
      expect(fs.statSync(target).isDirectory()).toBe(true)
      expect(seen).toEqual([{ ref: `dir:${workRoot}`, event: 'created', payload: { path: target } }])

      // 删目录:另一类效果、另一张卡。`once` 不是记住,所以它必须再问一次。
      const deleting = backend.resources.do(`dir:${target}`, 'delete', {}, { principal: AI, sessionId })
      await answerOneCard('file_destructive_edit')

      const deleted = await deleting
      expect(deleted.kind).toBe('ok')
      expect(fs.existsSync(target)).toBe(false)
      expect(seen).toEqual([
        { ref: `dir:${workRoot}`, event: 'created', payload: { path: target } },
        { ref: `dir:${target}`, event: 'deleted', payload: { path: target } },
      ])
    } finally {
      unwatch()
      updateSettingsInMemory(before)
      fs.rmSync(workRoot, { recursive: true, force: true })
    }

    await backend.dispose()
  })
})
