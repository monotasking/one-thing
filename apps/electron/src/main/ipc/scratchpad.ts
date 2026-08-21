import { BrowserWindow } from "electron";
import {
    IPC_CHANNELS,
    type ScratchpadChangedPayload,
} from "@shared/ipc.js";
import { configureScratchpadHost } from "@onething/app/scratchpad/index.js";

/**
 * 结构债 P4c:草稿纸的四条数据面(get / update / delete / adopt)已整只迁到通用
 * RPC 通道的 `scratchpad` 域,连同那个手写 IPC 工厂与 server 的四条 REST 路由。
 *
 * 这里只剩**推送注入** —— router 今天没有推送面,而 `SCRATCHPAD_CHANGED` 早就是
 * 一个注入端口(`configureScratchpadHost`):谁在跑就由谁决定往哪儿广播。桌面这一侧
 * 的答案是「所有活着的窗口」(草稿纸是每会话的,而同一个会话可能同时开在主窗口和
 * 副窗口里);server 那一侧的答案是 `/api/scratchpad/events` 的 SSE。
 */
function broadcastScratchpadChanged(payload: ScratchpadChangedPayload): void {
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send(IPC_CHANNELS.SCRATCHPAD_CHANGED, payload);
    }
}

export function registerScratchpadHandlers(): void {
    configureScratchpadHost({ broadcastChanged: broadcastScratchpadChanged });
}
