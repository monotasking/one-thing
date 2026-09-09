/**
 * 守护进程自己说「这台宿主没人值守」(K4-d)。
 *
 * 判据的另一半在 `wiring/tools/core/__tests__/permission-policy-unattended-host.test.ts`
 * (声明之后 `system` 主体的卡 60 秒被答掉)。这一份只钉两件事:**谁说的**、
 * **什么时候收回** —— 收回若漏了,同一个进程里起过一次 daemon 之后,后面所有的
 * 后端(测试里、将来的嵌入场景里)都会以为自己无人值守。
 *
 * 装配被替身掉:这里问的不是「后端能不能起来」,那是 `assembly-lifecycle` 的事。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHostUnattended } from '@onething/runtime/permissions/unattended'

const disposers: Array<{ label: string; dispose: () => void | Promise<void> }> = []
let assembleFails = false

vi.mock('../../../backend.js', () => ({
  createOnethingBackend: async () => {
    if (assembleFails) throw new Error('assembly blew up')
    return {
      own(dispose: () => void | Promise<void>, label = 'anonymous') {
        disposers.push({ label, dispose })
      },
      async requestShutdown() {
        for (const entry of disposers.splice(0).reverse()) await entry.dispose()
      },
    }
  },
}))

beforeEach(() => {
  disposers.length = 0
  assembleFails = false
})

afterEach(() => {
  // 万一某一例没收干净,别把「无人值守」漏给下一个文件。
  expect(isHostUnattended()).toBe(false)
})

describe('HeadlessBackend 的无人值守声明', () => {
  it('start 声明、shutdown 收回', async () => {
    const { HeadlessBackend } = await import('../backend.js')
    const backend = new HeadlessBackend()

    expect(isHostUnattended()).toBe(false)
    await backend.start({ storePath: '/tmp/onething-unattended-host-test' })
    expect(isHostUnattended()).toBe(true)
    // 收尾走的是装配层那张清单,不是这里手抄的第二份。
    expect(disposers.map(entry => entry.label)).toContain('unattendedHost')

    await backend.shutdown('test over')
    expect(isHostUnattended()).toBe(false)
  })

  it('装配失败就地收回,不在进程里留下一句「无人值守」', async () => {
    const { HeadlessBackend } = await import('../backend.js')
    const backend = new HeadlessBackend()
    assembleFails = true

    await expect(backend.start({ storePath: '/tmp/onething-unattended-host-test' }))
      .rejects.toThrow(/assembly blew up/)
    expect(isHostUnattended()).toBe(false)
  })
})
