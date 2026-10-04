import { describe, expect, it } from 'vitest'
import { audioDurationMs } from '../voice-audio-duration'

/** MPEG1 Layer III、128kbps、44.1kHz、无填充的一帧:417 字节,1152 个采样。 */
function mp3Frame(fill = 0): number[] {
  const frame = new Array<number>(417).fill(fill)
  frame[0] = 0xff
  frame[1] = 0xfb
  frame[2] = 0x90
  frame[3] = 0x00
  return frame
}

/** MPEG2 Layer III、64kbps、24kHz(云 TTS 常见档):192 字节,576 个采样。 */
function mp3FrameV2(): number[] {
  const frame = new Array<number>(192).fill(0)
  frame[0] = 0xff
  frame[1] = 0xf3
  frame[2] = 0x84
  frame[3] = 0x00
  return frame
}

function id3(size: number): number[] {
  return [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, (size >> 7) & 0x7f, size & 0x7f, ...new Array<number>(size).fill(0x41)]
}

function wav(byteRate: number, dataBytes: number, declared = dataBytes): Uint8Array {
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const tag = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint32(28, byteRate, true)
  tag(36, 'data')
  view.setUint32(40, declared, true)
  return out
}

describe('audioDurationMs', () => {
  it('counts MP3 frames (MPEG1 and MPEG2), skipping an ID3v2 tag', () => {
    const hundred = Array.from({ length: 100 }, () => mp3Frame()).flat()
    expect(audioDurationMs(new Uint8Array([...id3(300), ...hundred]), 'audio/mpeg')).toBe(Math.round((100 * 1152 * 1000) / 44100))
    const v2 = Array.from({ length: 250 }, () => mp3FrameV2()).flat()
    expect(audioDurationMs(new Uint8Array(v2), 'audio/mp3')).toBe(6000)
  })

  it('does not count the encoder Xing / Info frame as sound', () => {
    const info = mp3Frame()
    ;[...'Info'].forEach((c, i) => (info[36 + i] = c.charCodeAt(0)))
    const bytes = new Uint8Array([...info, ...Array.from({ length: 10 }, () => mp3Frame()).flat()])
    expect(audioDurationMs(bytes, 'audio/mpeg')).toBe(Math.round((10 * 1152 * 1000) / 44100))
  })

  it('resyncs past junk between frames', () => {
    const bytes = new Uint8Array([...mp3Frame(), 1, 2, 3, ...mp3Frame()])
    expect(audioDurationMs(bytes, 'audio/mpeg')).toBe(Math.round((2 * 1152 * 1000) / 44100))
  })

  it('reads WAV from byteRate and the data chunk, trusting the bytes over a streaming size', () => {
    expect(audioDurationMs(wav(32000, 64000), 'audio/wav')).toBe(2000)
    expect(audioDurationMs(wav(32000, 16000, 0xffffffff), 'audio/x-wav')).toBe(500)
  })

  it('answers null for what it cannot read', () => {
    expect(audioDurationMs(new Uint8Array(0), 'audio/mpeg')).toBeNull()
    expect(audioDurationMs(new Uint8Array([1, 2, 3, 4, 5]), 'audio/mpeg')).toBeNull()
    expect(audioDurationMs(new Uint8Array(mp3Frame()), 'audio/ogg')).toBeNull()
  })
})
