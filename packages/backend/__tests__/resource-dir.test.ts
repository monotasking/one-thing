/**
 * K3-c —— 目录这一 scheme 在**真装配**里的门(`docs/design/atom-2026-09.md` §9 K3)。
 *
 * 单测那一半(`wiring/resource/__tests__/dir-provider.test.ts`)摆布的是一台假沙箱;
 * 这只文件要证的四句话没有一句在那里说得出口 —— 它们全都关乎「装配把什么递给了
 * 内核」:
 *
 *   ① 装配之后注册表里有 `dir`,工具目录里也有那只工具;
 *   ② `read('dir:<仓内某目录>','list')` 拿到的是**真条目** —— 而「仓内」这三个字
 *      本身就是读数:资源内核拿到的沙箱正是工具 runner 那一把(进程边界 =
 *      `process.cwd()`,因为这台临时 store 没有配默认工作目录);
 *   ③ `read('dir:/','list')` → `failed` —— 沙箱外一律拒;
 *   ④ AI 那条路(直接 `runner.run` 那只工具)读得到同一份东西的文本投影。
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
import { afterAll, describe, expect, it } from 'vitest'
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

    await backend.dispose()
  })
})
