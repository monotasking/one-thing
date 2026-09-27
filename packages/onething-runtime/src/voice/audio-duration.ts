/**
 * **一段合成语音有多长**(毫秒),从字节里读出来,不靠播放器回报。
 *
 * 起因(2026-09-27 真机:黑豆气泡里的字比他嘴里的话快一倍、还先跑):气泡按固定字速打字,
 * 与声音各走各的。要让字跟着声音走,壳得在「开始出声」那一刻知道这段声音有多长 —— 而桌面的
 * 出声路是一个 mpv / afplay 子进程,没有进度回调,所以时长只能从音频本身算。
 *
 * 认两种格式,别的答 `null`(调用方退回「不知道多长」的走法,不猜):
 *   · MP3(云 TTS 的缺省产物,豆包 / OpenAI 都是它):跳过 ID3v2,逐帧走 MPEG Layer III 帧头,
 *     帧数 × 每帧采样数 ÷ 采样率。逐帧走而不是「字节 × 8 ÷ 码率」,VBR 也对;
 *   · WAV:`fmt ` 块的 byteRate 与 `data` 块的长度。
 * 纯函数,零依赖。
 */

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
/** 按版本位(3 = MPEG1、2 = MPEG2、0 = MPEG2.5)。 */
const MP3_SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

export function audioDurationMs(bytes: Uint8Array, mimeType: string): number | null {
  const mime = mimeType.toLowerCase()
  if (mime.includes('wav')) return wavDurationMs(bytes)
  if (mime.includes('mpeg') || mime.includes('mp3')) return mp3DurationMs(bytes)
  return null
}

function mp3DurationMs(bytes: Uint8Array): number | null {
  let offset = 0
  // ID3v2:「ID3」+ 版本 2 字节 + 标志 1 字节 + 同步安全的 4 字节长度(不含 10 字节头)。
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f)
    const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0
    offset = 10 + size + footer
  }
  let seconds = 0
  let frames = 0
  while (offset + 4 <= bytes.length) {
    const b1 = bytes[offset + 1]!
    const b2 = bytes[offset + 2]!
    if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      offset += 1 // 不是帧头:往前挪一个字节再找(帧间垃圾 / 尾部标签)
      continue
    }
    const version = (b1 >> 3) & 0x03
    const layer = (b1 >> 1) & 0x03
    const bitrateIndex = b2 >> 4
    const rateIndex = (b2 >> 2) & 0x03
    const rates = MP3_SAMPLE_RATES[version]
    // 只认 Layer III(layer 位 = 1);保留值 / 自由码率 / 坏采样率都不是帧头。
    if (layer !== 1 || !rates || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) {
      offset += 1
      continue
    }
    const kbps = (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitrateIndex]!
    const sampleRate = rates[rateIndex]!
    const samples = version === 3 ? 1152 : 576
    const padding = (b2 >> 1) & 0x01
    const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding
    if (length < 4) {
      offset += 1
      continue
    }
    // 第一帧常是编码器写的 Xing / Info 信息帧(不出声,只记帧数与码率表):不算时长。
    if (!(frames === 0 && seconds === 0 && isInfoFrame(bytes, offset, length))) seconds += samples / sampleRate
    frames += 1
    offset += length
  }
  return frames > 0 ? Math.round(seconds * 1000) : null
}

function isInfoFrame(bytes: Uint8Array, start: number, length: number): boolean {
  const end = Math.min(bytes.length - 3, start + Math.min(length, 64))
  for (let at = start + 4; at < end; at += 1) {
    const tag = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
    if (tag === 'Xing' || tag === 'Info') return true
  }
  return false
}

function wavDurationMs(bytes: Uint8Array): number | null {
  const text = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  const u32 = (at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return null
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = text(offset)
    const size = u32(offset + 4)
    if (id === 'fmt ' && offset + 16 <= bytes.length) byteRate = u32(offset + 8 + 8)
    if (id === 'data') {
      if (byteRate === 0) return null
      // 流式写出的 WAV 常把 data 长度写成 0 / 0xFFFFFFFF:按实际剩下的字节算。
      const available = bytes.length - (offset + 8)
      const dataBytes = size === 0 || size > available ? available : size
      return Math.round((dataBytes / byteRate) * 1000)
    }
    offset += 8 + size + (size % 2)
  }
  return null
}
