/**
 * **出声端口 `speechOutput`**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2 第一行)。
 *
 * 一段已经合成好的音频,在**这台宿主的进程里**放出来:播完 resolve,`signal` 中止就停。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────────
 * 电台口播从前只有一条出声的路:经 `broadcastVoiceHostMessage` 推给渲染进程,等渲染进程
 * 放完回执(`voice/host-ports.wiring.ts`)。React 壳的宿主表里 `voice: null` —— 没有渲染
 * 进程在听那条推送,于是合成成功时电台空等 30 秒回执,而且一个字都没出声。出声这件事本来
 * 就不需要一个窗口:主进程起一个子进程就能放。
 *
 * ── 形状 ──────────────────────────────────────────────────────────────────
 * 一个方法。**同一时刻只放一段**是实现的规矩(新的一段先停旧的),不是端口的规矩 ——
 * 端口只说「放这一段,放完告诉我」。
 *
 * 单槽 + `reset*`:与宿主表里其余十六格同一个约定(`packages/backend/host-ports.ts`)。
 * 未注入 = 这台宿主不能在进程里出声;`getSpeechOutput()` 答 `null`,调用方自己决定退路。
 * 这只文件不说跨进程的词汇(只有上面两个类型),所以它不是 `*.wiring.ts`。
 */

/** 一段合成好的音频。 */
export interface SpeechAudio {
  readonly base64: string
  readonly mimeType: string
}

export interface SpeechOutputPort {
  /**
   * 放这一段。播完 resolve;`signal` 中止 → 立刻停、resolve。播放器起不来 / 放到一半死掉也
   * resolve(调用方要的是「这句结束了」,不是一个会让电台卡住的异常)—— 实现自己记日志。
   */
  play(audio: SpeechAudio, signal: AbortSignal): Promise<void>
}

let speechOutput: SpeechOutputPort | null = null

export function configureSpeechOutputHost(port: SpeechOutputPort): void {
  speechOutput = port
}

/** 还原到未注入态(`applyHostPorts` 的还原函数在 `backend.dispose()` 时调)。 */
export function resetSpeechOutputHost(): void {
  speechOutput = null
}

/** 这台宿主能不能在进程里出声;不能 = `null`。每次调用现读(晚绑定)。 */
export function getSpeechOutput(): SpeechOutputPort | null {
  return speechOutput
}
