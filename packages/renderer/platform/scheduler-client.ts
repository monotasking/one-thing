/**
 * scheduler(定时任务)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` / `practice-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 方法名直接是 router
 * 上的九个动词、入参一律是信封(`schedulerApi.runNow({ id })`,无入参的写
 * `schedulerApi.list({})`)。
 *
 * 与前几个域的差别值得记一笔:迁移当天这个域**渲染侧一个调用点都没有** ——
 * 被删掉的九条 `platformApi.*SchedulerTask*` 从来没人调用过(任务面板没做)。
 * 所以这个文件不是「搬家」而是「留门」:域已经在 `POST /api/rpc` 上,面板哪天
 * 落地时接的就是这里,不必再回头补一遍传输面。
 */
import { schedulerRouter } from '@shared/ipc/scheduler.js'
import { clientApi } from './client'

export const schedulerApi = clientApi(schedulerRouter)
