/**
 * 本文件在 P4c 第十一批之后只剩**一条单向上行**:`VOICE_AUDIO_CHUNK`。
 *
 * 十一条数据面(状态 / 起停 / 两条上行 / 合成 / 自检 / TTS 模型表 / 运行时窗就绪
 * 与事件)已整只迁到通用 RPC 通道(`@shared/ipc/voice.ts` 的 `voiceRouter` +
 * `packages/backend/rpc/domains/voice.ts`),桌面和 web 走同一条 dispatch。
 *
 * 这一条没跟着走,理由是**传输形状**而不是归属:它是语音运行时窗往主进程灌的
 * 高频 PCM 流,`ipcRenderer.send` 单向、不带回执。router 只有请求/响应面,搬过去
 * 等于给每一块音频加一条空回执 —— 那是性能面的变化,不是通道收敛。它因此归
 * **流式单向残留集**(与 `FILE_WATCH_EVENT` 一类推送同类,拍板 #10)。
 *
 * 两条推送(`VOICE_EVENT` / `VOICE_RUNTIME_COMMAND`)不在这里也不需要在这里:
 * 它们早就是 `configureVoiceHost` 的端口(`broadcastMessage` /
 * `runtimeWindow.sendCommand`),桌面在 `app/main-process.ts` 一次性注入。
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS, type VoiceAudioChunkPayload } from "@shared/ipc.js";
import { getVoiceService } from "@onething/backend/wiring/voice/service.js";

export function registerVoiceHandlers(): void {
    // Fire-and-forget so the runtime window never blocks its audio callback on
    // an invoke round trip.
    ipcMain.on(IPC_CHANNELS.VOICE_AUDIO_CHUNK, (_event, payload: VoiceAudioChunkPayload) => {
        getVoiceService().handleAudioChunk(payload);
    });
}
