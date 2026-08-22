/**
 * collab(多 agent 协作房)域的渲染侧客户端 —— 结构债 P4a 第三域。
 *
 * 形状照 `spaces-client.ts` / `practice-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 方法名直接是 router
 * 上的十五个动词、入参一律是信封(`collabApi.boardGet({ roomSessionId })` 而不是
 * `getCollabBoard(roomSessionId)`)。位置参数在这条通道上没有位置。
 *
 * 与被删掉的那条线的差别有两处值得记一笔:
 *
 * 1. **能力位后来放开了**(P4 终态批 B,拍板 #12)。web 端原来是一排
 *    `unsupported()` 桩(必然回
 *    `{ success: false, error: 'Platform method … is not available in the web host yet.' }`),
 *    迁到 router 之后 web 走的是同一条 `POST /api/rpc`,拿到的就是桌面那台引擎的
 *    房间。`PlatformCapabilities.collabRooms` 在 web 上默认 `true`,并由服务器按
 *    进程内是否跑着 collab v3 运行时(`isCollabV3RuntimeRunning()`)如实下发 ——
 *    独立 `server:start` 没有那套 actor,那里仍然是 `false`。
 *
 * 2. **结构化克隆的那道防线换了地方**。preload 桥从前在边界上把 `action` /
 *    `agentIds` / `actor` 从原始值重建一遍(Vue 的响应式代理过不了 structured
 *    clone,而且会把整棵组件树带下去 —— W7 血教训)。桥没了之后,payload 是直接
 *    交给 `rpcInvoke` 的,所以那道重建挪到了**调用点**(store / 组件),它们本来
 *    就是持有响应式对象的那一方。
 *
 * 推送不在这里:router 没有推送面,看板 / 协调器 / agent 的实时更新与表情回灌
 * 仍然是 `collab:*-changed` / `message:updated` 会话事件。
 */
import { collabRouter } from '@shared/ipc/collab.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const collabApi = createRouterClient(collabRouter, request =>
  platformApi.rpcInvoke(request),
)
