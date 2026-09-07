/**
 * 装配的**生命周期**门(方案 `docs/design/backend-composition-root-2026-09.md` 的 A0)。
 *
 * 施工前的事实:全仓没有一份测试真的调用 `createOnethingBackend`。于是"装配 →
 * 关机 → 再装配"这条路在仓库里从来没有被走过一遍,而 A2 要改的正是它
 * (三个单例模块的 `let` 换成"进程当前实例")。这份测试是那次改造的安全网:
 * A0 先把**当时**的行为钉下来,A2 把 ② 那条从"随便抛点什么"扳成具名拒绝,
 * 并补上 ⑥⑦ 两条只有实例化之后才问得出口的问题。
 *
 * 十二条断言(C0 之后全绿):
 *   ① 装配后 `engine` / `eventBus` / `streamChannel` 在位,且 `getEventBus()`
 *      拿到的就是返回值里那一只(不是另一份拷贝)。
 *   ② **不 dispose 直接第二次装配 → 抛 `BackendAlreadyAssembledError`。**
 *      A0 施工记录:那时这条也"绿",但绿得不对 —— 拒它的是**第 31 步**的 RPC
 *      域挂载守卫(`[feature] "rpc:logs" is already mounted`),抛之前 stores /
 *      settings / provider 迁移 / 凭证升级 / 事件系统 / 引擎 / 权限 / 工具目录
 *      已经又跑了一遍且不可回滚。A2 把这声拒绝挪到了 `assemble` 的第一行并给了
 *      它一个具名错误,所以这条断言现在钉的是**类型**,不再是"随便抛点什么"。
 *   ③ dispose 之后 `getEventBus()` 抛 —— 关完就是关完,不许还能摸到旧总线。
 *      C0 R10 追加两条:进程级的两个 safe 访问器(`getStreamEngineSafe()` /
 *      `isEventSystemInitialized()`)交出 null / false,以及**这只实例自己**那五格
 *      也清了(`first.engine` 抛)。前两条经进程当前实例槽,槽本来就在 dispose 末尾
 *      清 —— 它们钉的是契约;第三条才是 R10 那句 `delete this.parts[…]` 的判据
 *      (反证:把那段 for 循环摘掉 → 只有第三条红)。
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
 *   ⑨ **`own()` 登记表在 dispose 之后清空**(A3;C0 R3 削掉了定时器那半边)。
 *      从前这一条还数 `process.getActiveResourcesInfo()` 里的 `Timeout`,而装配起的
 *      那三只定时器(blob-gc / list-backfill / 用户调度器)全是 **`unref` 过的** ——
 *      那张表里根本看不见它们,于是那半条断言在量的是 vitest 自己的超时钟与同
 *      worker 的邻居,恒绿,还得写成"不高于"才不抖。删掉它不是放弃判据:定时器
 *      泄漏改由三个起定时器的模块**各自的单测**用 `vi.getTimerCount()` 钉
 *      (`session/__tests__/shutdown-flush-and-blob-gc` / `list-projection-backfill` /
 *      `wiring/scheduler/__tests__/user-tasks`,都带反证)—— fake timers 看得见
 *      unref 定时器,是唯一说得出话的口径。
 *   ⑩ **宿主表里的本机信任在装配那一刻就生效**(B3,方案
 *      `backend-transport-forks-2026-09.md`)。B2 之前这句话只在内嵌 HTTP 面挂载
 *      成功那一刻说得出口,于是桌面自己的调用方在面起来之前被当成不可信的联网
 *      调用方(`search.query` 直接抛)。判据取 `isHostLocallyTrusted()` 与
 *      `hostLocalTrustOrigin()` 这两个**六个域真在读的**函数,不另造一个观察口。
 *      反证(实跑过):把 `host-ports.ts` 里 `applyHostPorts` 那句
 *      `configureHostLocalTrust(host.localTrust)` 摘掉 → 这一条第一段立刻红
 *      (`expected false to be true`)。**注意反证不是"改宿主的那张表"** ——
 *      这份文件交的是自己那张表;而 React 壳那张表改成 `null` 之后 smoke:core
 *      仍然绿,因为探针是在内嵌 HTTP 面挂上来**之后**才问的能力位,而
 *      `server/embed.ts` 会再声明一次同 origin(见那里的"两个声明点"注释)。
 *      宿主表那一格救的正是**挂载之前 / 挂载失败**那段时间,真机探针够不着。
 *   ⑪ **关门之后来的 `own()` 就地执行**(C0 R1)。宿主里有几处登记排在一个
 *      `.then()` 里(React 壳的 MCP),而 `dispose()` 可能比那个 `.then()` 先跑完;
 *      从前那种登记被静默丢弃 —— 已经拉起来的 stdio 子进程于是成了孤儿。
 *      反证(实跑过):把 `backend.ts` `own()` 里的 `if (this.disposeStarted)` 那段
 *      摘掉 → 这一条红(disposer 没跑)。
 *   ⑫ **宿主端口随 dispose 还原**(C0 R6)。第一份用 `voice: {}` 装配 → 语音在场;
 *      dispose → 不在场;第二份用 `voice: null` 装配 → 仍然不在场。B3 那版
 *      `applyHostPorts` 只还原 `localTrust` 一格,于是第二只 backend 会继承第一只
 *      注入的语音端口 —— 而"这台宿主有没有语音"正是 B 期把 voice 域十一条挂上去的
 *      那句话。反证(实跑过):把 `host-ports.ts` 里 `restores.push(resetVoiceHost)`
 *      摘掉 → 这一条最后一段红。
 *   ⑬ **MCP / ACP 的收尾"构造即登记",与起没起过无关**(C1,方案
 *      `backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。`mcpAcp: false`
 *      装配之后 `ownedLabels()` 里就得有 `mcp` 与 `acp` 两格,而两只子系统仍是
 *      `idle` —— 这正是审查第 2 条的结构性修法:**登记不再等 start 完成**。
 *      反证(实跑过):把 `backend.ts` 里那两句 `own(() => mcp.dispose(), 'mcp')` /
 *      `'acp'` 挪回 `if (options.mcpAcp)` 里 → 这一条红。
 *   ⑭ **在途的 start 上来一发 dispose,子进程照样收得回来**(C1)。装配成
 *      `mcpAcp: false`,然后**不 await** 地 `backend.mcp.start()`,紧接着
 *      `dispose()` —— 这就是"壳起来一秒内 Cmd+Q"那条真实路径(从前它靠壳里那句
 *      `.then(() => own(MCPManager.shutdown))`,而 dispose 常常跑在它前面)。
 *      dispose 返回时 `MCPManager.shutdown` 必须已经被调过。
 *      反证(实跑过):把 `backend.ts` 那两句 `own(..., 'mcp'/'acp')` 挪回
 *      `if (options.mcpAcp)` 里 → ⑬ 与这一条一起红。
 *      **「shutdown 必须排在在途 start 落地之后」那半条判在别处**
 *      (`wiring/mcp/__tests__/subsystem.test.ts`,反证 = 去掉 `dispose()` 里的
 *      `await inFlight` → 红):在整只 backend 上判不了它 —— 要让"关到 mcp 那一格
 *      时 start 仍在途"确定地成立,就得由 dispose 链自己去放闸,而正确实现正好
 *      死等那个闸,判据会把自己判死锁。
 *
 * **store 隔离**:`stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就
 * 解析 store 根,所以 `ONETHING_STORE_PATH` 必须在任何 backend 模块被求值之前
 * 设好 —— 这就是这份文件里全部 import 都是**动态**的原因(顶层只留 vitest 的),
 * 照 `server/__tests__/runtime-over-backend.test.ts` 的 mkdtemp + afterAll 还原先例。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
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
   * 这份文件的十四条是**接力**的(①建 → ③关 → ④再建 …),所以任何一条在整仓
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

type LocalTrust = { origin: 'desktop-embedded' | 'loopback-server'; host?: string } | null

async function assemble(
  hooks?: { afterSettings?: () => void | Promise<void> },
  localTrust: LocalTrust = null,
  // C0 R6 的 ⑫ 用它:除了那一条,每次装配都是 `null`(= 这个宿主没有语音)。
  voice: Record<string, never> | null = null,
  // 只有 CLI daemon 那一档才取 store 锁(08-24 拍板「store 不要锁」),所以缺省
  // 不给 owner —— 唯一要看真 lease 生命周期的那一条自己把它交上来。
  owner?: 'daemon',
): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
    ...(hooks ? { hooks } : {}),
    ...(owner ? { owner } : {}),
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice,
      terminal: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      mcp: null,
      localTrust,
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
  /**
   * ① 里就把第一只总线记下来。C0 R10 之后 `dispose()` 会把实例那五格也清掉,
   * 所以 ④ 不能再在关掉之后回头读 `first.eventBus`(那会抛)—— 它要比的是
   * 「第二次装配拿到的是不是同一只对象」,与那只对象还挂不挂在 first 上无关。
   */
  let firstEventBus: unknown

  it('① 装配后三件产物在位,且 getEventBus() 就是返回值里那一只', { timeout: 180_000 }, async () => {
    first = await assemble()
    expect(first.engine).toBeTruthy()
    expect(first.eventBus).toBeTruthy()
    expect(first.streamChannel).toBeTruthy()

    const { getEventBus } = await import('../events/index.js')
    expect(getEventBus()).toBe(first.eventBus)
    firstEventBus = first.eventBus
  })

  /**
   * A2:拒绝在第一行,并且是具名的。用 `name` 判而不是 `instanceof` —— 这份
   * 文件的 import 全是动态的,而 vitest 可能把 `current.js` 求值成不止一份
   * 模块实例;类**身份**在那种情况下不可靠,类**名字**可靠。
   */
  it('② 不 dispose 直接第二次装配 → 抛 BackendAlreadyAssembledError', { timeout: 180_000 }, async () => {
    await expect(assemble()).rejects.toMatchObject({ name: 'BackendAlreadyAssembledError' })
  })

  it('③ dispose 之后 getEventBus() 抛,装配产物那五格也清了', { timeout: 180_000 }, async () => {
    await first.dispose()
    const [{ getEventBus, isEventSystemInitialized }, { getStreamEngineSafe }] = await Promise.all([
      import('../events/index.js'),
      import('../wiring/engine/index.js'),
    ])
    expect(() => getEventBus()).toThrow()
    // C0 R10。前两条经进程当前实例槽(它在 dispose 末尾本来就清);
    // 第三条直接问这只实例 —— 那才是 `delete this.parts[…]` 的判据。
    expect(getStreamEngineSafe()).toBeNull()
    expect(isEventSystemInitialized()).toBe(false)
    expect(() => first.engine).toThrow(/BackendNotAssembled|engine/)
    expect(() => first.eventBus).toThrow(/BackendNotAssembled|eventBus/)
  })

  it('④ dispose 之后再装配,拿到的是新的 eventBus 实例', { timeout: 180_000 }, async () => {
    second = await assemble()
    expect(second.eventBus).not.toBe(firstEventBus)
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
   * A3;C0 R3 删掉了定时器那半边(见文件头 ⑨ 的说明:装配起的三只定时器都
   * `unref` 过,`process.getActiveResourcesInfo()` 看不见它们,那半条断言恒绿)。
   * 留下的这一半是确定性的:起了什么就登记什么,dispose 之后表是空的。
   */
  it('⑨ dispose 之后 own 表清空', { timeout: 180_000 }, async () => {
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
  })

  /**
   * B3。`applyHostPorts` 的还原函数登记在这里(`own('hostPorts')`),所以 dispose
   * 之后信任必须弹回"从未声明"—— 否则一个进程里先后装配两只 backend(测试、
   * `server:start` 接管)会继承上一只的信任。C0 R6 之后同一个还原函数还原的是
   * **十六格全部**,⑫ 钉的是另外那十五格里的一格。
   */
  it('⑩ 宿主表的 localTrust 在装配那一刻生效,dispose 之后弹回', { timeout: 180_000 }, async () => {
    const { isHostLocallyTrusted, hostLocalTrustOrigin } = await import('../server/host-trust.js')

    expect(isHostLocallyTrusted()).toBe(false)
    expect(hostLocalTrustOrigin()).toBeNull()

    const trusted = await assemble(undefined, { origin: 'desktop-embedded' })
    expect(isHostLocallyTrusted()).toBe(true)
    expect(hostLocalTrustOrigin()).toBe('desktop-embedded')

    await trusted.dispose()
    expect(isHostLocallyTrusted()).toBe(false)
    expect(hostLocalTrustOrigin()).toBeNull()

    // `localTrust: null` = 这个宿主不声明可信(独立 server / CLI daemon 的那一列)。
    const untrusted = await assemble()
    expect(isHostLocallyTrusted()).toBe(false)
    expect(hostLocalTrustOrigin()).toBeNull()
    await untrusted.dispose()
  })

  /**
   * C0 R1。要挡的那条真实路径:React 壳开窗之后非阻塞起 MCP,登记 `own()` 排在
   * 一个 `.then()` 里;壳起来两秒内 Cmd+Q,`dispose()` 先跑完,那句登记落到一只
   * 已经关门的 backend 上 —— 从前被静默丢弃,已经拉起来的 stdio 子进程成了孤儿。
   *
   * 两段都要:dispose **完**之后来的(下面第一段),以及 dispose **正在跑**时来的
   * (第二段 —— 由一只慢 disposer 制造那段窗口,它正是 `disposeStarted` 这个同步旗
   * 存在的理由:`this.disposing` 那格要到第一个 await 之后才赋上)。
   */
  it('⑪ 关门之后来的 own() 就地执行,不静默丢弃', { timeout: 180_000 }, async () => {
    const eighth = await assemble()

    // 第二段的窗口:这只 disposer 在 dispose 途中把 own() 叫一次。
    let duringDispose: 'pending' | 'ran' = 'pending'
    let sawDuring: Promise<void> | void
    eighth.own(async () => {
      sawDuring = eighth.own(() => {
        duringDispose = 'ran'
      }, 'ownedDuringDispose')
      await sawDuring
    }, 'slowDisposer')

    await eighth.dispose()
    expect(duringDispose).toBe('ran')
    // 就地执行的不入表 —— 表在 dispose 末尾清空,再入表要么跑两次要么跑不到。
    expect(eighth.ownedLabels()).toEqual([])

    // 第一段:dispose 已经跑完之后来的。
    let afterDispose = 'pending'
    await eighth.own(() => {
      afterDispose = 'ran'
    }, 'ownedAfterDispose')
    expect(afterDispose).toBe('ran')
    expect(eighth.ownedLabels()).toEqual([])

    // Late cleanup still runs immediately; its caller receives the failure.
    await expect(eighth.own(() => {
      throw new Error('disposer exploded')
    }, 'ownedAfterDisposeThrows')).rejects.toThrow('disposer exploded')
  })

  /**
   * C0 R6。取 `voice` 那一格是因为它有一个现成的、**六个域真在读的**观察口
   * (`hasVoiceHost()`,B2 拿它替掉 voice 域十一条的 `transport === 'http'`),
   * 不必为这条断言另造一个探针 —— 与 ⑩ 取 `isHostLocallyTrusted()` 同一个理由。
   */
  it('⑫ 宿主端口随 dispose 还原:voice:{} → dispose → voice:null 仍是没有', { timeout: 180_000 }, async () => {
    const { hasVoiceHost } = await import('@onething/runtime/voice/host-ports.wiring')

    expect(hasVoiceHost()).toBe(false)

    const withVoice = await assemble(undefined, null, {})
    expect(hasVoiceHost()).toBe(true)

    await withVoice.dispose()
    expect(hasVoiceHost()).toBe(false)

    const withoutVoice = await assemble(undefined, null, null)
    expect(hasVoiceHost()).toBe(false)
    await withoutVoice.dispose()
  })

  /**
   * C1。`assemble()` 这张表里 `mcpAcp` 是**不开**的(这份文件问的是装配生命周期,
   * 不是任何一个子系统)—— 而这一条要的正是那个档:没起过 MCP 的 backend 也得把
   * 收尾登记好,因为宿主(React 壳)是在开窗**之后**才 start 的。
   */
  it('⑬ mcpAcp:false 也登记 mcp / acp 两格收尾,子系统停在 idle', { timeout: 180_000 }, async () => {
    const ninth = await assemble()
    const labels = ninth.ownedLabels()
    expect(labels).toContain('mcp')
    expect(labels).toContain('acp')
    expect(ninth.mcp.state).toBe('idle')
    expect(ninth.acp.state).toBe('idle')
    await ninth.dispose()
  })

  /**
   * C1。审查第 2 条那条真实路径的端到端复现:壳开窗后非阻塞 `backend.mcp.start()`,
   * 一秒内 Cmd+Q。`MCPManager` 是产品层的进程单例(子系统拿到的就是它),所以判据
   * 直接钉在它的两个方法上。
   */
  it('⑭ 在途 start 上来一发 dispose:MCPManager.shutdown 仍被调到', { timeout: 180_000 }, async () => {
    const { MCPManager } = await import('@onething/runtime/mcp/index.wiring')
    const order: string[] = []
    let openGate = (): void => {}
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const initialize = vi.spyOn(MCPManager, 'initialize').mockImplementation(async () => {
      order.push('initialize')
      await gate
    })
    const shutdown = vi.spyOn(MCPManager, 'shutdown').mockImplementation(async () => {
      order.push('shutdown')
    })

    try {
      const tenth = await assemble()
      // 不 await —— 这就是壳里那句 `void b.mcp.start().catch(...)`。
      void tenth.mcp.start().catch(() => undefined)
      expect(initialize).toHaveBeenCalledTimes(1)
      // 关的这一刻,那趟 start 还挂在闸上(= stdio 子进程已经拉起来了)。
      expect(shutdown).not.toHaveBeenCalled()

      const disposed = tenth.dispose()
      openGate()
      await disposed

      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['initialize', 'shutdown'])
      expect(tenth.mcp.state).toBe('disposed')
    } finally {
      openGate()
      initialize.mockRestore()
      shutdown.mockRestore()
    }
  })

  it('accepted transport work drains before the journal and lease are released', { timeout: 180_000 }, async () => {
    const backend = await assemble(undefined, null, null, 'daemon')
    const lease = backend.storeLease
    const { writeSessionEvent } = await import('../session/event-writer.js')
    const { getSessionEventsLogPath } = await import('../session/event-log.js')
    const sessionId = 'shutdown-accepted-request'
    const logPath = getSessionEventsLogPath(sessionId)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const accepted = backend.runTask('test accepted request', async () => {
      await gate
      writeSessionEvent(sessionId, 'session/created', { sessionId, model: 'saved-before-exit' })
    })
    const closing = backend.requestShutdown('test')
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(lease.held).toBe(true)
      expect(() => backend.runTask('new request', () => {})).toThrow('shutting down')
      finish()
      await accepted
      await closing
      expect(lease.held).toBe(false)
      expect(fs.readFileSync(logPath, 'utf8')).toContain('saved-before-exit')
    } finally {
      finish()
      await closing
    }
  })

  it('binds each Backend connector generation before afterSettings', { timeout: 180_000 }, async () => {
    const runtime = await import('@onething/runtime/external-agents')
    const registry = await import('../wiring/external-agents/index.js')
    const original = runtime.createClaudeCodeConnector
    const created = vi.spyOn(runtime, 'createClaudeCodeConnector').mockImplementation(options => original(options))
    try {
      let earlyConnector: ReturnType<typeof original> | undefined
      const backend = await assemble({
        afterSettings: () => {
          earlyConnector = registry.getExternalAgentConnectors()['claude-code-agent']
        },
      })
      const dispose = vi.spyOn(earlyConnector!, 'dispose')
      try {
        expect(created).toHaveBeenCalledTimes(1)
        expect(registry.getExternalAgentConnectors()['claude-code-agent']).toBe(earlyConnector)
        // A rejected second assembly cannot overwrite the live instance's options.
        await expect(assemble()).rejects.toMatchObject({ name: 'BackendAlreadyAssembledError' })
        expect(registry.getExternalAgentConnectors()['claude-code-agent']).toBe(earlyConnector)
        const closing = backend.dispose()
        expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
        await closing
        // Early rollback ownership and the established late cleanup share one operation.
        expect(dispose).toHaveBeenCalledTimes(1)
        expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
      } finally {
        await backend.dispose()
        dispose.mockRestore()
      }
    } finally {
      created.mockRestore()
    }
  })

  it('drains a connector created by a failing early hook before allowing the next Backend', { timeout: 180_000 }, async () => {
    const registry = await import('../wiring/external-agents/index.js')
    const { getCurrentBackendSafe } = await import('../current.js')
    const boom = new Error('afterSettings failed after creating a connector')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let markDisposing!: () => void
    const disposing = new Promise<void>(resolve => { markDisposing = resolve })
    let dispose: ReturnType<typeof vi.spyOn> | undefined
    let settled = false
    const failed = assemble({
      afterSettings: () => {
        const connector = registry.getExternalAgentConnectors()['claude-code-agent']!
        const original = connector.dispose.bind(connector)
        dispose = vi.spyOn(connector, 'dispose').mockImplementation(async () => {
          markDisposing()
          await gate
          await original()
        })
        throw boom
      },
    })
    void failed.then(() => { settled = true }, () => { settled = true })
    try {
      await disposing
      expect(settled).toBe(false)
      expect(getCurrentBackendSafe()).not.toBeNull()
      expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
      await expect(assemble()).rejects.toMatchObject({ name: 'BackendAlreadyAssembledError' })
      release()
      await expect(failed).rejects.toBe(boom)
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(getCurrentBackendSafe()).toBeNull()
      const next = await assemble()
      try {
        expect(registry.getExternalAgentConnectors()['claude-code-agent']).toBeTruthy()
      } finally {
        await next.dispose()
      }
    } finally {
      release()
      await failed.catch(() => {})
      dispose?.mockRestore()
    }
  })

  it('cleans an unused early connector binding when afterSettings fails before any getter', { timeout: 180_000 }, async () => {
    const runtime = await import('@onething/runtime/external-agents')
    const original = runtime.createClaudeCodeConnector
    const created = vi.spyOn(runtime, 'createClaudeCodeConnector').mockImplementation(options => original(options))
    const registry = await import('../wiring/external-agents/index.js')
    const boom = new Error('afterSettings failed without creating a connector')
    try {
      await expect(assemble({ afterSettings: () => { throw boom } }))
        .rejects.toBe(boom)
      expect(created).not.toHaveBeenCalled()
      const next = await assemble()
      try {
        registry.getExternalAgentConnectors()
        expect(created).toHaveBeenCalledTimes(1)
      } finally {
        await next.dispose()
      }
    } finally {
      created.mockRestore()
    }
  })
})
