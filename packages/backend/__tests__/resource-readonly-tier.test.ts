/**
 * K3-a' —— **`readonly` 档装配之后,工具目录里一只资源工具都没有。**
 *
 * `wiring/resource/__tests__/catalog-sync.test.ts` 已经在一台裸内核 + 一本裸目录上
 * 证过这条规则本身。这只文件证的是另一半,而那一半只有真装配说得出口:
 * `createOnethingBackend({ toolRegistry: 'readonly' })` 走完整条装配序列之后,
 * **模型真正看见的那一份目录**(产品层的 `getToolkitCatalog` 端口,回合面
 * `Surface.resolve` 与设置页工具清单读的都是它)里没有 `session`、也没有 `resources`。
 *
 * 为什么值得单开一个装配:`readonly` 档的整句话是「零本地副作用工具」——
 * 一台不该改这台机器任何东西的宿主(`ONETHING_SERVER_TOOLS=readonly`)。资源工具
 * 带写面,漏进去是当场违约,而且是那种**不会有任何东西红**的违约:它不报错,
 * 只是那台宿主上的模型多了一只能改名、能归档、能删消息的工具。
 *
 * 同时钉住反面:`backend.resources` 照常在位、照常能做。「不进目录」说的只是
 * 「模型看不见」——界面 / 脚本经 `rpc/domains/resources.ts` 走管线那条路不受影响。
 *
 * headless 档那一半在 `resource-kernel.test.ts` 里(它就是拿 `'headless'` 装的)。
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
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-readonly-'))
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

describe("readonly 档不给资源工具(K3-a')", () => {
  let backend: Backend

  it('装配之后目录里没有 session / resources,而内核照常在位', { timeout: 180_000 }, async () => {
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
        localTrust: null,
      },
      toolRegistry: 'readonly',
      sender: new NoopSender() as never,
    })

    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    const catalog = getToolkitCatalog()
    expect(catalog).toBeTruthy()
    expect(catalog?.has('resources')).toBe(false)

    /*
     * 判据是「**注册表里的每一个** scheme 都不在目录里」,不是一张写死的名单
     * (K3-c 改法):这只测试要证的是那一档的契约 —— 零本地副作用 —— 而那句话对
     * 「今天有哪几种资源」不该有任何依赖。写死名单的下场是每加一种内置资源就要回来
     * 改一次断言,而漏改的那一次**不会红**在该红的地方:它会红在名单上,读起来像是
     * 「多了一种资源」而不是「那一档漏进了一只工具」。
     */
    const schemes = backend.resources.registry.list().map(spec => spec.scheme)
    expect(schemes.length).toBeGreaterThan(0)
    for (const scheme of schemes) expect(catalog?.has(scheme)).toBe(false)

    // provider 照样挂着 —— 缺席的是那份**投影**,不是那种资源。
    expect(backend.resources.tools().map(tool => tool.spec.id)).toEqual(schemes)
  })

  it('RPC 那条路不受影响:界面照样读得到、做得动', async () => {
    const store = await import('../store.js')
    const created = store.createSession(`readonly-${Date.now()}`, 'Before')

    const done = await backend.resources.do(
      `session:${created.id}`,
      'rename',
      { title: 'After' },
      { principal: { kind: 'user', userId: 'local' } },
    )
    expect(done.kind).toBe('ok')

    const { sessionReads } = await import('../session/reads.js')
    expect(sessionReads.getSession(created.id)?.name).toBe('After')

    await backend.dispose()
  })
})
