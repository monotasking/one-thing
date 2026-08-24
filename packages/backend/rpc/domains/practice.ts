/**
 * practice(练习:kegel / 番茄钟 / 运动账本)域 —— 结构债 P4a 的第二个域
 * (第一个是 spaces)。
 *
 * 替换 `apps/electron/src/main/ipc/practice.ts` 里主进程那十条裸 handle
 * (该文件只剩 `PRACTICE_EVENT` 的广播注入);渲染侧的 10 个
 * `platformApi.practiceXxx` 方法与 `packages/renderer/platform/web.ts` 里那批
 * **说谎的桩**(回假 `{ snapshot: { status: 'idle' } }`、`practiceLog` 直接 throw)
 * 一起删掉 —— **server 侧零改动**:域挂上 router 之后就经 `POST /api/rpc`
 * 自动可达,web 端从此拿到的是**真实**的练习状态,不再是永远 idle 的假象。
 *
 * 这里只做一件事:**把请求原样递给 `@onething/runtime/practice` 的服务函数**。
 * 传输面不许自己加分支 —— 逐条对着旧文件抄的正是这几处形状:
 *  - `start` / `pause` / `resume` / `stop` / `getState` 返回的是裸 snapshot,
 *    由这一层包成 `{ snapshot }`(契约层的响应形状,不是引擎的);
 *  - `stop` 的 `discard` 缺省是 **false**(旧 `request?.discard ?? false`);
 *    信封化之后 payload 一定在,但键仍可缺席,所以 `?? false` 保留;
 *  - `recent` 的 `days` / `limit` 缺省交给服务函数自己(7 / 50),这里只解包。
 *
 * 不在这条路上的:`IPC_CHANNELS.PRACTICE_EVENT` 推送。它早就是注入端口
 * (`configurePracticeEventBroadcaster`),而 router 今天只有请求/响应面、
 * 没有推送面,所以那条通道原样留在手写 IPC 上(`@main/ipc/practice.ts`)。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import type { PracticeRoutes } from '@shared/ipc/practice.js'
import {
  getPracticeState,
  getPracticeSummary,
  getRecentPracticeRecords,
  logPractice,
  pausePractice,
  readPracticeConfig,
  resumePractice,
  startPractice,
  stopPractice,
  writePracticeConfig,
} from '@onething/runtime/practice/service.wiring'

export const practiceRpcHandlers: RouteHandlers<PracticeRoutes> = {
  async start(request) {
    return { snapshot: await startPractice(request) }
  },
  async pause() {
    return { snapshot: pausePractice() }
  },
  async resume() {
    return { snapshot: resumePractice() }
  },
  // `discard` 缺席 = 正常结束(结算进账本);true = 丢弃,不落账。
  async stop(request) {
    return { snapshot: stopPractice(request?.discard ?? false) }
  },
  async getState() {
    return { snapshot: getPracticeState() }
  },
  async log(request) {
    return { record: logPractice(request) }
  },
  async summary(request) {
    return getPracticeSummary(request)
  },
  // days / limit 的缺省(7 / 50)住在服务函数里 —— 传输面不复述它们。
  async recent(request) {
    return { records: await getRecentPracticeRecords(request?.days, request?.limit) }
  },
  async getConfig() {
    return { config: await readPracticeConfig() }
  },
  async setConfig(request) {
    return { config: await writePracticeConfig(request) }
  },
}

