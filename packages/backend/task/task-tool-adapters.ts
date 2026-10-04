/**
 * `task` 工具的端口工厂(D191,从 `toolkit/toolkit-adapters.ts` 搬回 task)。
 *
 * 它绑的是派工层 `dispatchTask`,所以住在 task,经 task 入口交出。D191 时它还不能经入口:task 入口一交出派工层,
 * 入口闭包就经插件的跨会话信使绕回工具目录成环;D202 把派工层对插件的那条边改成装配递进来的端口之后,
 * 环拆了,它与派工层一起从入口出去。本文件只引兄弟文件;对 toolkit 只有类型引用。
 */
import type { TaskToolPorts } from '@onething/backend/toolkit'
import { dispatchTask } from './task-dispatch.js'

export function taskToolPorts(): TaskToolPorts {
  return { dispatch: (request, executionContext) => dispatchTask(request, { executionContext }) }
}
