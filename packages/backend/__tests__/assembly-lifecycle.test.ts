/**
 * 装配的**生命周期**门(方案 `docs/design/backend-composition-root-2026-09.md` 的 A0)。
 *
 * 施工前的事实:全仓没有一份测试真的调用 `createOnethingBackend`。于是"装配 →
 * 关机 → 再装配"这条路在仓库里从来没有被走过一遍,而 A2 要改的正是它
 * (三个单例模块的 `let` 换成"进程当前实例")。这份测试是那次改造的安全网:
 * A0 先把**当时**的行为钉下来,A2 把 ② 那条从"随便抛点什么"扳成具名拒绝,
 * 并补上 ⑥⑦ 两条只有实例化之后才问得出口的问题。
 *
 * 七条断言(A2 之后全绿):
 *   ① 装配后 `engine` / `eventBus` / `streamChannel` 在位,且 `getEventBus()`
 *      拿到的就是返回值里那一只(不是另一份拷贝)。
 *   ② **不 dispose 直接第二次装配 → 抛 `BackendAlreadyAssembledError`。**
 *      A0 施工记录:那时这条也"绿",但绿得不对 —— 拒它的是**第 31 步**的 RPC
 *      域挂载守卫(`[feature] "rpc:logs" is already mounted`),抛之前 stores /
 *      settings / provider 迁移 / 凭证升级 / 事件系统 / 引擎 / 权限 / 工具目录
 *      已经又跑了一遍且不可回滚。A2 把这声拒绝挪到了 `assemble` 的第一行并给了
 *      它一个具名错误,所以这条断言现在钉的是**类型**,不再是"随便抛点什么"。
 *   ③ dispose 之后 `getEventBus()` 抛 —— 关完就是关完,不许还能摸到旧总线。
 *   ④ dispose → 再装配,拿到的是**新的** eventBus 实例。这条挡的是"关机没把
 *      槽清干净,第二次装配复用了尸体"。
 *   ⑤ 第二份 dispose 不抛。
 *   ⑥ **装配中途失败不留槽**:`hooks.afterSettings` 抛错的那次装配失败之后,
 *      进程当前实例槽必须是 `null`,而且下一次装配照样成功 —— 失败的装配不许
 *      在进程里留下一个半死的槽。
 *   ⑦ 同一只实例 `dispose()` 两次不抛(幂等)。
 *   ⑧ **(b) 类闩真的重跑**(A3,方案 §2.5):内置触发器在第二份装配里是**重新
 *      注册的**。判据取 `triggerManager.getTriggers()` 的条目数 —— 装配后 3 条、
 *      dispose 后 0 条、再装配回到 3 条。选它是因为它是这四个闩里唯一一个"注册
 *      进了一张能被数的表"的:变量注册表撞 id 直接抛(那条由 ④ 之后的再装配
 *      顺带证),目标断路器与 project-dirs 只留下订阅与缓存,数不出来。
 *   ⑨ **dispose 之后没有留下新的定时器**(A3)。两条判据一起上:`own()` 登记表
 *      在 dispose 之后清空(`ownedLabels()`,确定性判据),以及
 *      `process.getActiveResourcesInfo()` 里 `Timeout` 的条数不高于装配之前
 *      (真实判据,但它会被 vitest 自己的定时器与同 worker 的邻居影响 —— 所以
 *      它是**不高于**而不是**等于**,并且只在这一条里出现)。
 *
 * **store 隔离**:`stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就
 * 解析 store 根,所以 `ONETHING_STORE_PATH` 必须在任何 backend 模块被求值之前
 * 设好 —— 这就是这份文件里全部 import 都是**动态**的原因(顶层只留 vitest 的),
 * 照 `server/__tests__/runtime-over-backend.test.ts` 的 mkdtemp + afterAll 还原先例。
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

// 顶层语句先于任何 `await import()` 求值:装配层看到的 store 根从第一行起就是
// 这个临时目录,真机库结构上够不着。
const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-assembly-lifecycle-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  /*
   * 这份文件的七条是**接力**的(①建 → ③关 → ④再建 …),所以任何一条在整仓
   * 满载下超时都会把后面几条一起带红,而且会把一只活 backend 留在进程当前实例
   * 槽里。超时是既有的负载抖动(真机实测:单文件跑 5s,整仓 300+ 文件并发时
   * 同一条要 60s+),不是这份改动的性质问题 —— 但槽必须还干净,所以收尾无条件
   * 清一次。
   */
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  const leaked = getCurrentBackendSafe()
  if (leaked) setCurrentBackend(null)

  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

/**
 * 引擎在没有绑定 sender 时会静默丢命令(那道闸是给桌面的窗口生命周期用的)。
 * 形状照 `server/runtime.ts` 的 `ServerNoopSender`:三件事 —— 是个
 * EventEmitter、`isDestroyed()` 恒假、`send()` 什么也不做。
 */
class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {
    /* 这份测试不观察推送面。 */
  }
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(hooks?: { afterSettings?: () => void | Promise<void> }): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
    ...(hooks ? { hooks } : {}),
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      mcp: null,
    },
    // 最小面:三档目录里最轻的一档,不开 collab / mcpAcp / sessionSkills /
    // promptVersion —— 这份测试问的是装配的生命周期,不是任何一个子系统。
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

describe('createOnethingBackend 的装配生命周期(A0)', () => {
  let first: Backend
  let second: Backend

  it('① 装配后三件产物在位,且 getEventBus() 就是返回值里那一只', { timeout: 180_000 }, async () => {
    first = await assemble()
    expect(first.engine).toBeTruthy()
    expect(first.eventBus).toBeTruthy()
    expect(first.streamChannel).toBeTruthy()

    const { getEventBus } = await import('../events/index.js')
    expect(getEventBus()).toBe(first.eventBus)
  })

  /**
   * A2:拒绝在第一行,并且是具名的。用 `name` 判而不是 `instanceof` —— 这份
   * 文件的 import 全是动态的,而 vitest 可能把 `current.js` 求值成不止一份
   * 模块实例;类**身份**在那种情况下不可靠,类**名字**可靠。
   */
  it('② 不 dispose 直接第二次装配 → 抛 BackendAlreadyAssembledError', { timeout: 180_000 }, async () => {
    await expect(assemble()).rejects.toMatchObject({ name: 'BackendAlreadyAssembledError' })
  })

  it('③ dispose 之后 getEventBus() 抛', { timeout: 180_000 }, async () => {
    await first.dispose()
    const { getEventBus } = await import('../events/index.js')
    expect(() => getEventBus()).toThrow()
  })

  it('④ dispose 之后再装配,拿到的是新的 eventBus 实例', { timeout: 180_000 }, async () => {
    second = await assemble()
    expect(second.eventBus).not.toBe(first.eventBus)
  })

  it('⑤ 第二份 dispose 不抛', { timeout: 180_000 }, async () => {
    await expect(second.dispose()).resolves.toBeUndefined()
  })

  /**
   * 装配中途炸掉:钩子 `afterSettings` 排在事件系统之前,所以那一刻槽里已经有
   * 句柄(方案 §5 风险 1 要的"装配中途可见"),但几乎什么都还没建。判据是
   * **失败之后槽必须是空的** —— 否则下一次装配会撞上 ② 那条拒绝,一个进程从此
   * 再也装不起来。
   */
  it('⑥ 装配中途失败不留槽,下一次照样装得起来', { timeout: 180_000 }, async () => {
    const boom = new Error('afterSettings exploded')
    await expect(assemble({ afterSettings: () => { throw boom } })).rejects.toBe(boom)

    const { getCurrentBackendSafe } = await import('../current.js')
    expect(getCurrentBackendSafe()).toBeNull()

    const third = await assemble()
    expect(third.eventBus).toBeTruthy()
    await third.dispose()
  })

  it('⑦ 同一只实例 dispose 两次不抛', { timeout: 180_000 }, async () => {
    const fourth = await assemble()
    await expect(fourth.dispose()).resolves.toBeUndefined()
    await expect(fourth.dispose()).resolves.toBeUndefined()
  })

  /**
   * A3。反证做法:把 `backend.ts` 里 `this.own(registerBuiltinTriggers(), …)`
   * 换回 `registerBuiltinTriggers()`(丢掉 disposer),这一条的第二段与第三段
   * 立刻红 —— 闩留在 true,第二份装配一条都不注册。
   */
  it('⑧ (b) 类闩重跑:内置触发器在第二份装配里重新注册', { timeout: 180_000 }, async () => {
    const { triggerManager } = await import('../wiring/engine/triggers/index.js')

    const fifth = await assemble()
    const afterAssemble = triggerManager.getTriggers().length
    expect(afterAssemble).toBe(3)

    await fifth.dispose()
    expect(triggerManager.getTriggers().length).toBe(0)

    const sixth = await assemble()
    expect(triggerManager.getTriggers().length).toBe(afterAssemble)
    await sixth.dispose()
    expect(triggerManager.getTriggers().length).toBe(0)
  })

  /**
   * A3。`ownedLabels()` 那一半是确定性的;定时器那一半是**真判据**但会抖
   * (vitest 自己的超时钟、同一个 worker 里邻居文件的残留),所以口径是"不高于
   * 装配之前",而且判的是 `Timeout` 这一类而不是资源总数。
   */
  it('⑨ dispose 之后 own 表清空,且没留下新的定时器', { timeout: 180_000 }, async () => {
    const timeouts = (): number =>
      process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
    const before = timeouts()

    const seventh = await assemble()
    // 装配途中登记下来的收尾:清单非空,且带得出名字(排障时要看的就是这张表)。
    const labels = seventh.ownedLabels()
    expect(labels.length).toBeGreaterThan(10)
    expect(labels).toContain('builtinTriggers')
    expect(labels).toContain('variableSystem')
    expect(labels).toContain('flushAllPendingSaves')

    // 宿主口:起完就登记,dispose 时逆序跑到。两个 GUI 宿主的调度器 / watcher /
    // 内嵌 HTTP 面走的就是这条(A3 §2.4)。
    let hostServiceStopped = false
    seventh.own(() => {
      hostServiceStopped = true
    }, 'hostService')
    expect(seventh.ownedLabels()).toContain('hostService')

    await seventh.dispose()
    expect(hostServiceStopped).toBe(true)
    expect(seventh.ownedLabels()).toEqual([])
    expect(timeouts()).toBeLessThanOrEqual(before)
  })
})
