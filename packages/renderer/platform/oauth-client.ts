/**
 * oauth(订阅登录)域的渲染侧客户端 —— 结构债 P4c 第七批。
 *
 * 六条数据面走通用 `rpc:invoke` / `POST /api/rpc`;**两条推送不在这里** ——
 * `onOAuthTokenRefreshed` / `onOAuthTokenExpired` 仍然是 `platformApi` 上的订阅
 * (桌面 `ipcRenderer.on`、web `/api/oauth/events` SSE),router 今天没有推送面。
 *
 * 从前壳上那六条包装收的是 `(providerId, target?)` 两个位置参数,现场拼成
 * `{ providerId, ...target }` 再发。这里直接递那个信封:
 * `oauthApi.start({ providerId, spaceId, entryId, label })`。
 */
import { oauthRouter } from '@shared/ipc/oauth.js'
import { clientApi } from './client'

export const oauthApi = clientApi(oauthRouter)
