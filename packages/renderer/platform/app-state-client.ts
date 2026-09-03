/**
 * app-state(应用状态)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` 的判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,
 * 四壳零改动;方法名直接是 router 上的两个动词,无入参的写 `appStateApi.get({})`。
 *
 * 旧壳方法叫 `saveUIState`,router 上叫 `saveUiState`(与 server 侧的
 * `handleSaveUiState` 同名):同一件事从此只有一个拼法。
 */
import { appStateRouter } from '@shared/ipc/app-state.js'
import { clientApi } from './client'

export const appStateApi = clientApi(appStateRouter)
