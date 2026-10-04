/**
 * `task` 工具的端口工厂(D191,从 `toolkit/toolkit-adapters.ts` 搬回 task)。
 *
 * 它绑的是派工层 `dispatchTask`,所以住在 task。但它**不经 task 入口交出**:task 入口一交出派工层,
 * 入口闭包就经插件的跨会话信使、插件契约、插件 API 绕回工具目录(而目录里的 `task` 工具又引 task 入口),
 * 成一个 9 只文件的环(决定文档 §1.2(d))。所以它是「装配处直接引」的那一类:只有 `backend.ts` 引它,
 * 经它自己的包说明符。本文件只引兄弟文件;对 toolkit 只有类型引用。
 */
import type { TaskToolPorts } from '@onething/backend/toolkit'
import { dispatchTask } from './task-dispatch.js'

export function taskToolPorts(): TaskToolPorts {
  return { dispatch: (request, executionContext) => dispatchTask(request, { executionContext }) }
}
