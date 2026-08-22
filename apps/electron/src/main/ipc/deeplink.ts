/**
 * 深链确认门的 IPC 面(H4)。
 *
 * 两条请求/响应,方向都是渲染层 → 主进程,于 2026-08-23(结构债 P4 终态批 A1-a)
 * 从两条手写通道改为**宿主壳路由**上的一份处理者表
 * (`deeplinkRouter` → `@onething/electron-host/ipc/shell/deeplink`):
 *  - `deeplink.ready` —— "我能画卡了"。冷启动队列的放行信号**由渲染层给**,
 *    不是主进程猜的"窗口大概建好了";猜的那一版会在慢机器上偶发丢链。
 *  - `deeplink.respond` —— 用户按了钮。它是派发的唯一入口。
 *
 * 推卡的方向(主进程 → 渲染层)不在这里:它在 service 里直接 send,因为投递
 * 时机由 URL 到达驱动,不由某次调用驱动。
 */
import { registerDeeplinkShellDomain } from "@onething/electron-host/ipc/shell/deeplink";
import { markElectronDeepLinkReady } from "@onething/electron-host/deeplink/protocol";
import { respondToDeepLink } from "@onething/electron-host/deeplink/service";

export function registerDeepLinkHandlers(): void {
	registerDeeplinkShellDomain({
		markReady: () => markElectronDeepLinkReady(),
		respond: request => respondToDeepLink(request),
	});
}
