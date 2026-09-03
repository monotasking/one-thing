/**
 * terminal(真 PTY 终端)域的渲染侧客户端 —— 结构债 P4 终态批 D2。
 *
 * 形状照 `practice-client.ts` / `evals-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。
 *
 * **两条推送不在这里** —— `onTerminalData` / `onTerminalExit` 仍是 `platformApi`
 * 上的订阅(router 没有推送面,主进程那侧是 `configureTerminalBroadcaster` 端口)。
 *
 * ## 闸不在这一层
 *
 * 与 music / evals / interaction 的判例不同,本域的闸落在**服务端**
 * (`backend/rpc/domains/terminal.ts` 的 `transport === 'http'` 分叉),不在这里:
 * 桌面自己也挂着同一份 HTTP 面(A 期的内嵌 server),渲染侧的能力位挡不住一个
 * 拿到 Bearer 的浏览器。能力位 `terminal` 在 web 上仍是 `false`,UI 因此根本不
 * 出现,所以这里**一个分支都不加** —— 真被调到时收到的是域给的结构化失败,
 * 与迁移前 web 壳那批「不支持」硬桩同型。
 */
import { terminalRouter } from '@shared/ipc/terminal.js'
import { clientApi } from './client'

export const terminalApi = clientApi(terminalRouter)
