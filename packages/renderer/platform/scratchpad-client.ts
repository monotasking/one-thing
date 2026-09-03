/**
 * scratchpad(草稿纸)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` / `practice-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;方法名直接是 router 上的四个动词。
 *
 * `SCRATCHPAD_CHANGED` 的订阅不在这里:router 没有推送面,那条仍然是
 * `platformApi.onScratchpadChanged`(桌面走 IPC 推送,web 走
 * `GET /api/scratchpad/events` 的 SSE)。
 */
import { scratchpadRouter } from '@shared/ipc/scratchpad.js'
import { clientApi } from './client'

export const scratchpadApi = clientApi(scratchpadRouter)
