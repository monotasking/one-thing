/**
 * todo/plan **窗口面**的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 体例照 `practice-client.ts`:壳外一个模块 + 通用传输面,四壳零改动;
 * **不包一层旧签名** —— 方法名直接是 router 上的七个动词、入参一律是信封
 * (`todoPlanWindowApi.setPinned({ pinned })`,无入参的写 `minimize({})`)。
 *
 * 与数据面 `platform/todo-plan-client` 的差别只有传输面:那边是
 * `platformApi.rpcInvoke`(装配层处理者),这边是 `shellInvoke`(宿主处理者)。
 *
 * `TODO_PLAN_CHANGED` 推送不在这里:router 没有推送面,那条订阅仍然是
 * `platformApi.onTodoPlanChanged`。
 */
import { todoPlanWindowRouter } from '@shared/ipc/todo-plan.js'
import { createShellClient } from './shell-client'

export const todoPlanWindowApi = createShellClient(todoPlanWindowRouter)
