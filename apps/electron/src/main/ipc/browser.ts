/**
 * Browser IPC glue: the embedded WebContentsView browser for the workbench.
 *
 * 结构债 P4 终态批 A1-b(2026-08-23):19 条请求面改走**宿主壳路由**
 * (`browserRouter` → `@onething/electron-host/ipc/shell/browser`),所以这只文件
 * 只剩两件真宿主的事 —— **注入服务**(懒取:`getBrowserViewService` 头一次求值才
 * 拉起 WebContentsView / Widevine)与 **`BROWSER_TABS_CHANGED` 那条推送**
 * (一次合批的标签态广播;router 今天没有推送面,所以它原地不动)。
 * 迁移前那只可移植工厂 `apps/electron/src/ipc/browser.ts` 随之整只删掉。
 */
import { IPC_CHANNELS } from "@shared/ipc.js";
import {
    configureBrowserBroadcaster,
    getBrowserViewService,
} from "@onething/electron-host/browser/service";
import { registerBrowserShellDomain } from "@onething/electron-host/ipc/shell/browser";
import { getIPCBridge } from "../bridges/ipc-bridge-lifecycle.js";

export function registerBrowserHandlers(): void {
    configureBrowserBroadcaster({
        sendTabsChanged: (event) => {
            getIPCBridge()?.sendToRenderer(IPC_CHANNELS.BROWSER_TABS_CHANGED, event);
        },
    });

    registerBrowserShellDomain(() => getBrowserViewService());
}
