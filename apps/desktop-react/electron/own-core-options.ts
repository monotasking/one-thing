/**
 * 桌面自己当 core 时那五个装配开关(`main.ts` 的 `assembleOwnCore` 原样摊开它们)。
 *
 * 为什么单独一只文件(第④步批 2a,决策 D14):不带界面的后端进程有一档「桌面档」
 * (`ONETHING_BACKEND_LAUNCHER=desktop`,`packages/backend/backend-launcher.ts`),批 2b 起由桌面拉起它、
 * 顶替今天进程内装配的这一份。两边的开关必须逐格相同,而 `main.ts` 一 import 就要 electron、测试里加载
 * 不了 —— 所以把这几格挪到一只不碰 electron 的文件里,由 `__tests__/own-core-options.test.ts` 与后端的
 * 桌面档逐格对比。值一格没改,只是从 `main.ts` 的字面量里搬出来。
 *
 * 不在这里的:`host`(宿主表,Electron 独有)、`logging`(两边各写各的日志文件)、`sender`、`hooks`
 * (`afterSettings` 里套 Electron session 的代理,后端进程没有那件事)。
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
