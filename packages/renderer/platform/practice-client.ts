/**
 * practice(练习)域的渲染侧客户端 —— 结构债 P4a。
 *
 * 形状照 `spaces-client.ts` 的判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,
 * 四壳零改动;**不包一层旧签名** —— 方法名直接是 router 上的十个动词、入参一律
 * 是信封(`practiceApi.stop({ discard: true })` 而不是
 * `practiceStop({ discard: true })`,无入参的写 `practiceApi.pause({})`)。
 *
 * 与被删掉的那条线的差别值得记一笔:web 端原来是一排**说谎的桩** ——
 * 读状态那条永远回 `{ snapshot: { status: 'idle' } }`、记一笔那条直接 throw、
 * 汇总那条回空桶。迁到 router 之后 web 走的是同一条
 * `POST /api/rpc`,**真的拿到桌面那台引擎的状态**;拿不到时的降级仍在
 * (调用点各自 try/catch 保持面板空着),只是不再必然踩它。
 *
 * `PRACTICE_EVENT` 推送不在这里:router 没有推送面,那条订阅仍然是
 * `platformApi.onPracticeEvent`。
 */
import { practiceRouter } from '@shared/ipc/practice.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const practiceApi = createRouterClient(practiceRouter, request =>
  platformApi.rpcInvoke(request),
)
