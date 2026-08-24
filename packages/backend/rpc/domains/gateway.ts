/**
 * gateway(IM 网关)域 —— 结构债 P4c 第八批,八条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/gateway.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/gateway.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那八条 `gateway:*` 通道);
 *  - `preload/bridge.ts` 的八条包装与 `platform/web.ts` 的八条 REST 镜像;
 *  - `server/http.ts` 的八条 REST 路由与 `server/runtime.ts` 的 `gateway` facade
 *    adapter(那份 adapter 除了 `getStatus` 从 owner 设置里拼一个状态,其余六条
 *    一律回写死的 `SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR`)。
 *
 * ## 八条全都要宿主本体 —— 所以走注入端口
 *
 * 微信网关是主进程拉起来的子进程 + 一张二维码的生命周期,这件事只有 Electron
 * 桌面做得到。域处理者因此不直连宿主的 gateway/lifecycle 原语
 * (装配层禁 import Electron 宿主包,checker 守着),而是走
 * `../../wiring/gateway/host-ports.js` 的 `configureGatewayHost`:桌面在
 * `main-process.ts` 注入八行转调,server / CLI 不注入。
 *
 * ## 迁后 web 行为:501 → 结构化降级(拍板 #20 接受)
 *
 * 从前浏览器打的是 server 那八条 REST 路由,拿到的是 adapter 写死的
 * "Gateway channel connections are disabled on the server runtime."。现在浏览器
 * 打的是**桌面这台**后端 —— 桌面在跑就真的能开网关(与 themes / oauth 同判例:
 * 一个 store 一份真相),纯 `server:start` 的进程则因为端口未注入而拿到
 * `GATEWAY_HOST_UNAVAILABLE` 的同义降级。**文案变了**(英文一句换成另一句),
 * 形状没变(`{ success:false, error }`),渲染层照旧只读 `error` 字符串。
 * 另有一处形状差:旧 server 的失败响应还捎带一个从 owner 设置拼出来的 `status`,
 * 降级响应不带 —— 没有网关就没有状态可报,不编一个出来;`ChannelsSettingsTab`
 * 的 `runGatewayAction` 在动作之后本来就会再 `getStatus()` 拉一次。
 *
 * ## 本域零推送
 *
 * 全仓没有 `GATEWAY_*_CHANGED` 一类的通道,所以 `apps/electron/src/main/ipc/gateway.ts`
 * 整只删掉(不像 oauth 还要留一层广播注入)。状态刷新靠调用方轮询 `getStatus`。
 */
import type { GatewayRoutes } from '@shared/ipc/gateway.js'
import { getGatewayHost } from '../../wiring/gateway/host-ports.js'
import type { RpcRouteHandlers } from '../registry.js'

export const gatewayRpcHandlers: RpcRouteHandlers<GatewayRoutes> = {
  async getStatus() {
    return getGatewayHost().getStatus()
  },
  async start(request) {
    return getGatewayHost().start(request)
  },
  async stop() {
    return getGatewayHost().stop()
  },
  async wechatLogout(request) {
    return getGatewayHost().wechatLogout(request)
  },
  async wechatAddAccount(request) {
    return getGatewayHost().wechatAddAccount(request)
  },
  async wechatStopAccount(request) {
    return getGatewayHost().wechatStopAccount(request)
  },
  async wechatRemoveAccount(request) {
    return getGatewayHost().wechatRemoveAccount(request)
  },
  async wechatRenameAccount(request) {
    return getGatewayHost().wechatRenameAccount(request)
  },
}

