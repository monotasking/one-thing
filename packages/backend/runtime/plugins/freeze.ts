/**
 * 插件侧的深冻结入口 —— 实现已经上移到 `packages/backend/runtime/sessions/session-deep-freeze.ts`(会话命令面也要
 * 用同一套语义,见 docs/design/session-commands-p0-2026-08.md §1)。这里只保留原
 * 名字,免得动插件那一堆调用点。
 */
import { deepFreeze } from '@onething/backend/runtime/sessions'

export { deepFreeze }

export const deepFreezeCorePluginValue = deepFreeze
