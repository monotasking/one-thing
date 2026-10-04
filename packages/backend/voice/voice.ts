/**
 * voice —— 语音:语音识别 / 合成服务(豆包等服务商)、唤醒词、朗读输出,以及宿主给的音频通道。
 *
 * 对外交出四类东西:
 * - 宿主注入口:语音宿主(把消息推给有麦克风的那一端)与朗读输出口,各自的装上 / 判有没有 / 复位与形状;
 * - 语音服务的单槽:建、装上、安全地取;
 * - 合成一段语音(`synthesizeSpeech`,给朗读与音乐电台的主持词用);
 * - 估一段音频的时长。
 * 依赖 agent、settings、session、event 与包根的当前实例槽。
 */

// 宿主注入口。
export { broadcastVoiceHostMessage, configureVoiceHost, hasVoiceHost, resetVoiceHost } from './voice-host-ports.js'
export type { VoiceHostPorts } from './voice-host-ports.js'
export { configureSpeechOutputHost, getSpeechOutput, resetSpeechOutputHost } from './voice-speech-output.js'
export type { SpeechAudio, SpeechOutputPort } from './voice-speech-output.js'

// 语音服务的单槽。
export { configureVoiceService, createVoiceService, getVoiceServiceSafe } from './voice-service.js'

// 合成与时长。
export { synthesizeSpeech } from './voice-provider-calls.js'
export { audioDurationMs } from './voice-audio-duration.js'
