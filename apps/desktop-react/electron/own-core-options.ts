/**
 * 桌面拉起的后端必须带着的那五个装配开关(决策 D14 的钉子)。
 *
 * 来历:第④步批 2a 之前桌面在 `main.ts` 的 `assembleOwnCore` 里进程内装配,用的就是这五格;批 2a 给不带界面的
 * 后端进程立了「桌面档」(`ONETHING_BACKEND_LAUNCHER=desktop`,`packages/backend/backend-launcher.ts`),批 2b 起
 * 桌面不再装配、改为拉起那一档的子进程(`./backend-process.ts`)。所以这五格今天**没有运行期读者**:它是
 * 「桌面那一档少一格就是一项能力悄悄没了」这句话的数据形,由 `__tests__/own-core-options.test.ts` 与后端的
 * 桌面档逐格对比(不开 `collab` 协作会话发不出话,不开 `pets` 栖位读不到 `pet:`)。改桌面档的开关 = 两边一起改,
 * 并说清为什么。
 *
 * 不在这里的:`host`(宿主表,后端进程自己填)、`logging`(两个进程各写各的日志文件)、`sender`、`hooks`。
 */
import type { OnethingBackendOptions } from '@onething/backend/backend.js'

export const OWN_CORE_ASSEMBLY_SWITCHES = {
  toolRegistry: 'full',
  promptVersion: true,
  // 四颗必落件之二:agent-dm(协作房间)的开关。不开 = 房间入口闸拒流,表现是协作会话发不出话。
  collab: true,
  sessionSkills: true,
  // 宠物宿主(`docs/design/pet-system-2026-09.md` §9.1):登记 `pet:`、订资源事件里的时刻。
  pets: true,
} as const satisfies Pick<OnethingBackendOptions, 'toolRegistry' | 'promptVersion' | 'collab' | 'sessionSkills' | 'pets'>
