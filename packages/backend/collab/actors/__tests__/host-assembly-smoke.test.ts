/**
 * 三宿主装配面的冒烟(D6-a)。
 *
 * D6-a 把协作的装配点从 v2 协调器换成了 v3 运行时,而那一行住在
 * `createOnethingBackend` 里 —— 三个宿主(桌面 / headless daemon / server)全从它
 * 出发。这份测试问的是**最便宜也最容易忘的那一条**:换完之后,这三条 import 图
 * 还求得动值吗。
 *
 * 为什么值得单独一份:v3 的运行时静态引了引擎、看板、计费、providers,而
 * `backend.ts` 又静态引了它。一条新的实边把 `@onething/backend` 的 import 图接成环
 * (或者把某个带顶层 await 的模块排到了它的依赖前面)时,症状不是测试红,是
 * **打包产物启动即卡死** —— 那是最贵的一类回归,而它在这里只要一次 import 就能
 * 照出来。
 *
 * **不 mock 任何东西**:import 图的形状正是被测对象,替掉一个节点就等于没测。
 */
import { describe, expect, it } from 'vitest'

describe('D6-a 三宿主装配冒烟', () => {
  it('createOnethingBackend 的 import 图求得动值', { timeout: 60_000 }, async () => {
    const backend = await import('../../../backend.js')
    expect(typeof backend.createOnethingBackend).toBe('function')
    expect(typeof backend.configureAppRuntimeAdapters).toBe('function')
  })

  it('CLI daemon 的 HeadlessBackend 同样求得动值', { timeout: 60_000 }, async () => {
    const headless = await import('../../../wiring/headless/backend.js')
    expect(typeof headless.HeadlessBackend).toBe('function')
  })

  /**
   * 装配面上**只剩一代**(D6-b)。
   *
   * D6-a 时这一条断言的是"两代并存、v2 仍导出";现在断言的是反面 —— 旧协调器
   * 的生命周期口在装配面上**不存在**。写成显式的 `toBeUndefined` 而不是删掉这
   * 一条:壳层(electron IPC / daemon)吃的是这个桶,一个悄悄复活的 v2 入口正是
   * 本期要防的事,而只测"新的在"证明不了"旧的不在"。
   */
  it('collab 装配面只导出 v3 运行时,v2 协调器的生命周期口已不存在', { timeout: 60_000 }, async () => {
    const collab = await import('../../index.js')
    // 新的(也是唯一的)生产路径。
    expect(typeof collab.initializeCollabV3Runtime).toBe('function')
    expect(typeof collab.shutdownCollabV3Runtime).toBe('function')
    expect((collab as Record<string, unknown>).initializeCollabCoordinator).toBeUndefined()
    expect((collab as Record<string, unknown>).shutdownCollabCoordinator).toBeUndefined()
    // 停止按钮那扇门换了实现,名字一个字没改(apps 侧零改动的判据)。
    expect(typeof collab.abortCollabRoomTurnForStop).toBe('function')
    // 配置门搬了家(coordinator.ts → room-config.ts),对外的名字同样零改动。
    expect(typeof collab.setCollabRoomConfig).toBe('function')
    expect(typeof collab.setCollabRoomFrozen).toBe('function')
    expect(typeof collab.setCollabRoomBudgets).toBe('function')
    expect(typeof collab.clearCollabRoomHistory).toBe('function')
    expect(typeof collab.getCollabCoordinatorState).toBe('function')
    // 卡级停止改由 v3 供数,IPC 通道吃的仍是这两个名字。
    expect(typeof collab.hasActiveCollabWork).toBe('function')
    expect(typeof collab.stopCollabTaskWork).toBe('function')
  })
})
