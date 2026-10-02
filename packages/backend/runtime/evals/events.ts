/**
 * evals 的三条**推送端口** —— 结构债 P4c 第十批。
 *
 * evals / evals-workbench 的二十五条数据面已经迁到通用 RPC 通道
 * (`evalsRouter` / `evalsWorkbenchRouter` + `backend/rpc/domains/evals*.ts`),
 * 而 router 今天只有请求/响应面、没有推送面。三条进度推送
 * (`EVALS_RUN_PROGRESS` / `EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS`)
 * 因此留在原地,按 practice / scratchpad / oauth 判例改成**注入端口**:
 * 谁在跑就由谁决定往哪儿广播。
 *
 *  - 桌面(`apps/electron/src/main/ipc/evals.ts`)注入 `broadcastToAllWindows`;
 *  - server 不注入 —— evals 是桌面独占面(渲染侧能力位 `evals` 在 web 上默认关),
 *    没人注入时三个 `broadcast*` 就是安静的 no-op。
 *
 * **一处行为变化**:`EVALS_RUN_PROGRESS` 迁移前是**单窗定向**
 * (`BrowserWindow.fromWebContents(event.sender)` 拿发起者那扇窗),现在与
 * 另外两条一致走全窗广播。事件体一字未变。
 */
import type {
  EvalsDiagnoseProgressEvent,
  EvalsReplayProgressEvent,
  EvalsRunProgressEvent,
} from '@shared/ipc/evals.js'

export type EvalsProgressEvent =
  | { type: 'evals:run-progress'; payload: EvalsRunProgressEvent }
  | { type: 'evals:replay-progress'; payload: EvalsReplayProgressEvent }
  | { type: 'evals:diagnose-progress'; payload: EvalsDiagnoseProgressEvent }

export type EvalsEventBroadcaster = (event: EvalsProgressEvent) => void

let broadcaster: EvalsEventBroadcaster | null = null

export function configureEvalsEventBroadcaster(next: EvalsEventBroadcaster | null): void {
  broadcaster = next
}

/** 当前注入的广播器 —— 单槽端口串联用,理由同 `getOAuthEventBroadcaster`。 */
export function getEvalsEventBroadcaster(): EvalsEventBroadcaster | null {
  return broadcaster
}

function emit(event: EvalsProgressEvent): void {
  broadcaster?.(event)
}

export function broadcastEvalsRunProgress(payload: EvalsRunProgressEvent): void {
  emit({ type: 'evals:run-progress', payload })
}

export function broadcastEvalsReplayProgress(payload: EvalsReplayProgressEvent): void {
  emit({ type: 'evals:replay-progress', payload })
}

export function broadcastEvalsDiagnoseProgress(payload: EvalsDiagnoseProgressEvent): void {
  emit({ type: 'evals:diagnose-progress', payload })
}
