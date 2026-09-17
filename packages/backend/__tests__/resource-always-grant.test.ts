/**
 * 应用级许可在**真装配**里的门(2026-09-10 拍板:卡上多一个「始终允许这个应用」)。
 *
 * 一整只 `createOnethingBackend` + 临时 store,因为这一单要证的四句话没有一句在
 * 单测里说得出口:
 *
 *   ① AI 主体经资源面删一条消息,停在一张真权限卡上,而那张卡上**画得出**
 *      「始终允许这个应用」—— `alwaysScope.scheme === 'session'`。这一格是后端在
 *      `enforcePermissionPolicy` 里按效果的 resources 算出来的,壳只读不算;
 *   ② 答 `always` 之后,**同一条会话里再删一条**一张卡都不弹 —— 许可覆盖的是
 *      `session:*` 整个命名空间,不是刚才那一条地址;
 *   ③ `permissionGrants.list` 里那条记录带着投影 `app === 'session'` —— 设置页
 *      「每个应用一格」就是按它分组;
 *   ④ `revoke` 之后再删又弹 —— 撤销是真的。
 *
 * 会话必须有工作目录:这一档许可是**项目级**的(scope `workspace`)。资源内核拼的
 * `Invocation` 没有 cwd,授权者靠 `sessionWorkspaceRootFor` 退到发起会话的工作目录 ——
 * 拆掉那一处,①的 `alwaysScope` 照旧在,但②当场红(grant 落不下去 / 匹配不上)。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts`。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-always-'))
process.env.ONETHING_STORE_PATH = storeRoot
/** 「这个项目」。真存在的一棵树 —— grant 的 workspaceRoot 会被 `path.resolve` 归一。 */
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-always-project-'))

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
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
      // 账页那个域要一台**本机可信**的宿主才不夹沙箱(`rpc/sandbox.ts` 的不变量 2)。
      // 桌面壳声明的就是这一句。
      localTrust: { origin: 'desktop-embedded' },
      speechOutput: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

/** 模型那一侧的主体 —— `removeMessage` 对它是顶格 `session_destructive`(K3-a')。 */
const AGENT = { kind: 'agent', agentId: 'always-agent' } as const

describe('应用级许可在真装配里(2026-09-10)', () => {
  it('答一次「始终允许这个应用」→ 同一应用不再弹;账页按 app 分组;撤销后又弹', { timeout: 180_000 }, async () => {
    const backend = await assemble()
    try {
      const store = await import('../store.js')
      const { Permission } = await import('../wiring/permission/index.js')
      const { sessionCommands } = await import('../session/commands.js')
      const { permissionGrantsRpcHandlers } = await import('../rpc/domains/permission-grants.js')
      const { DESKTOP_RPC_CONTEXT } = await import('@shared/ipc/rpc.js')

      const sessionId = store.createSession(`always-${Date.now()}`, 'Always').id
      // 项目级许可要有项目。这条会话就在那棵树里。
      store.updateSessionWorkingDirectory(sessionId, projectRoot)

      const message = (id: string) => ({ id, role: 'system' as const, content: 'x', timestamp: Date.now() })
      for (const id of ['always-1', 'always-2', 'always-3']) {
        sessionCommands.appendMessage(sessionId, { message: message(id) as never })
      }

      // ① 第一次:停在一张真卡上,而卡上画得出那第四个键。
      const first = backend.resources.do(
        `session:${sessionId}`,
        'removeMessage',
        { messageId: 'always-1' },
        { principal: AGENT, sessionId },
      )
      await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
      const card = Permission.getPendingPrompts(sessionId)[0]
      expect(card.type).toBe('session_destructive')
      // 出现条件由后端算好交下来 —— 壳不解析 pattern 猜命名空间。
      expect(card.alwaysScope).toEqual({ scheme: 'session' })
      expect(Permission.respond({ sessionId, permissionId: card.id, response: 'always' })).toBe(true)
      expect((await first).kind).toBe('ok')

      // ② 再删一条**别的**消息:一张卡都没有。许可覆盖的是 `session:*`,不是
      //    刚才那一条地址。
      const second = await backend.resources.do(
        `session:${sessionId}`,
        'removeMessage',
        { messageId: 'always-2' },
        { principal: AGENT, sessionId },
      )
      expect(second.kind).toBe('ok')
      expect(Permission.getPendingPrompts(sessionId)).toHaveLength(0)

      // ③ 账页上那条记录带着投影 `app` —— 设置页「每个应用一格」按它分组。
      const listed = await permissionGrantsRpcHandlers.list(
        { workspaceRoot: projectRoot },
        DESKTOP_RPC_CONTEXT,
      )
      expect(listed.success).toBe(true)
      const applicationGrants = (listed.workspaceGrants ?? []).filter(grant => grant.app === 'session')
      expect(applicationGrants).toHaveLength(1)
      expect(applicationGrants[0]).toMatchObject({
        scope: 'workspace',
        type: 'session_destructive',
        pattern: 'session:*',
      })

      // ④ 撤销之后又回到「每次都问」。
      const revoked = await permissionGrantsRpcHandlers.revoke(
        { id: applicationGrants[0]!.id },
        DESKTOP_RPC_CONTEXT,
      )
      expect(revoked.success).toBe(true)

      const third = backend.resources.do(
        `session:${sessionId}`,
        'removeMessage',
        { messageId: 'always-3' },
        { principal: AGENT, sessionId },
      )
      await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
      const again = Permission.getPendingPrompts(sessionId)[0]
      Permission.respond({ sessionId, permissionId: again.id, response: 'reject' })
      expect((await third).kind).toBe('denied')
    } finally {
      await backend.dispose()
    }
  })
})
