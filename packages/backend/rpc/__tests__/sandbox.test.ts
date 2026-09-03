/**
 * `resolveRpcSandbox` —— 七个域共用的那一份沙箱判据(C0 R2,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §1.3/§2.3)。
 *
 * 这个文件在 B0–B3 整整一期里没有测试,也不在棘轮量程内(那把尺子只扫
 * `rpc/domains/*.ts`,不递归),于是它按 `context.transport === 'ipc'` 分叉这件事
 * 一直没人看见 —— 而 React 壳的渲染层只走 HTTP,`project-dirs` / `markdown` /
 * `permission-grants` 三个域因此在自己的桌面上被夹进 `<workspaceRoot>/<uid>/<wid>`
 * 那棵空子树。C0 R2 把判据换成与那六个域同一句话的 `isHostLocallyTrusted()`,
 * 并把棘轮的扫描根提到 `packages/backend/rpc` 且改成递归。
 *
 * 三条:
 *  ① http + 已声明可信 → 不夹(这一条是本批新行为,也是修的那件事);
 *  ② http + 未声明 + 无 sandboxRoot → 抛(fail-closed,逐字不变);
 *  ③ http + 未声明 + 有 sandboxRoot → 夹进那棵根(逐字不变)。
 *
 * 反证(实跑过):把 `sandbox.ts` 那句改回 `context.transport === 'ipc'` →
 * ① 红(`expected { confined: true, … } to match { confined: false }`),
 * 同时 `bun run transport:gate` 红(`forks:packages/backend/rpc/sandbox.ts 0 → 1`)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { configureHostLocalTrust, resetHostLocalTrustForTests } from '../../server/host-trust.js'
import { resolveRpcSandbox } from '../sandbox.js'

const HTTP: RpcDispatchContext = { transport: 'http', ownerUid: 'u1', workspaceId: 'w1' }
const HTTP_WITH_ROOT: RpcDispatchContext = { ...HTTP, sandboxRoot: '/tmp/onething-sandbox-root' }

afterEach(() => {
  resetHostLocalTrustForTests()
})

describe('resolveRpcSandbox(C0 R2:判据是宿主可信,不是 transport)', () => {
  it('① http + 宿主声明过可信 → 不夹(与 IPC 同权)', () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    expect(resolveRpcSandbox(HTTP)).toEqual({ confined: false })
    // 带不带 sandboxRoot 都一样 —— 可信是面级事实,与请求里有什么无关。
    expect(resolveRpcSandbox(HTTP_WITH_ROOT)).toEqual({ confined: false })
  })

  it('② 未声明可信 + 没有 sandboxRoot → 抛(fail-closed,绝不退回"不夹")', () => {
    expect(() => resolveRpcSandbox(HTTP)).toThrow(/sandboxRoot/)
    // 非绝对路径同样是接线 bug。
    expect(() => resolveRpcSandbox({ ...HTTP, sandboxRoot: 'relative/root' })).toThrow(/sandboxRoot/)
  })

  it('③ 未声明可信 + 有 sandboxRoot → 夹进那棵根', () => {
    expect(resolveRpcSandbox(HTTP_WITH_ROOT)).toEqual({
      confined: true,
      root: '/tmp/onething-sandbox-root',
    })
  })

  it('ONETHING_SERVER_FILES_SANDBOX=1 压得住声明 —— 声明过也照夹', () => {
    const previous = process.env.ONETHING_SERVER_FILES_SANDBOX
    process.env.ONETHING_SERVER_FILES_SANDBOX = '1'
    try {
      configureHostLocalTrust({ origin: 'desktop-embedded' })
      expect(resolveRpcSandbox(HTTP_WITH_ROOT)).toEqual({
        confined: true,
        root: '/tmp/onething-sandbox-root',
      })
    } finally {
      if (previous === undefined) delete process.env.ONETHING_SERVER_FILES_SANDBOX
      else process.env.ONETHING_SERVER_FILES_SANDBOX = previous
    }
  })
})
