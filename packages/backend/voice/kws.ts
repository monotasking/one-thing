import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeOnethingKeywordPhrase } from '@onething/runtime/voice/kws/text2token'
import type { VoiceWakeSensitivity } from '@shared/ipc.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const KWS_ENCODER = 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
const KWS_DECODER = 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'
const KWS_JOINER = 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
const KWS_TOKENS = 'tokens.txt'

// Higher sensitivity = easier to trigger = lower acoustic threshold.
const SENSITIVITY_THRESHOLDS: Record<VoiceWakeSensitivity, number> = {
  low: 0.55,
  medium: 0.4,
  high: 0.25,
}

export interface WakeWordEngineOptions {
  phrase: string
  sensitivity?: VoiceWakeSensitivity
  onDetected: (keyword: string) => void
  onError: (error: string) => void
}

interface SherpaKeywordSpotter {
  createStream(): unknown
  isReady(stream: unknown): boolean
  decode(stream: unknown): void
  getResult(stream: unknown): { keyword?: string }
  reset(stream: unknown): void
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

function kwsModelDirCandidates(): string[] {
  const candidates = [
    path.join(process.cwd(), 'resources', 'models', 'kws'),
    path.resolve(__dirname, '..', '..', 'resources', 'models', 'kws'),
    path.resolve(__dirname, '..', '..', '..', 'resources', 'models', 'kws'),
  ]
  if (process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, 'models', 'kws'))
  }
  return candidates
}

export function resolveKwsModelDir(): string | null {
  for (const candidate of kwsModelDirCandidates()) {
    if (existsSync(path.join(candidate, KWS_ENCODER))) return candidate
  }
  return null
}

/**
 * Always-on wake-word detector (sherpa-onnx keyword spotting, Chinese
 * wenetspeech model bundled in resources/models/kws). Runs in the main
 * process and is fed 16 kHz PCM from the voice runtime window's wake-phase
 * uplink.
 */
export class WakeWordEngine {
  private options: WakeWordEngineOptions | null = null
  private spotter: SherpaKeywordSpotter | null = null
  private stream: SherpaStream | null = null
  private startedKey = ''

  get isRunning(): boolean {
    return Boolean(this.spotter && this.stream)
  }

  start(options: WakeWordEngineOptions): boolean {
    const sensitivity = options.sensitivity || 'medium'
    const key = `${options.phrase}::${sensitivity}`
    if (this.isRunning && this.startedKey === key) {
      this.options = options
      return true
    }
    this.stop()
    this.options = options

    const modelDir = resolveKwsModelDir()
    if (!modelDir) {
      options.onError('The wake-word model files are missing from resources/models/kws.')
      return false
    }

    let keywordsLine: string
    try {
      const tokensFile = readFileSync(path.join(modelDir, KWS_TOKENS), 'utf8')
      keywordsLine = encodeOnethingKeywordPhrase(options.phrase, tokensFile).line
    } catch (error: any) {
      options.onError(error?.message || 'The wake phrase could not be encoded.')
      return false
    }

    try {
      const sherpa = require('sherpa-onnx-node')
      const keywords = `${keywordsLine}\n`
      this.spotter = new sherpa.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: path.join(modelDir, KWS_ENCODER),
            decoder: path.join(modelDir, KWS_DECODER),
            joiner: path.join(modelDir, KWS_JOINER),
          },
          tokens: path.join(modelDir, KWS_TOKENS),
          numThreads: 1,
          provider: 'cpu',
        },
        keywordsBuf: keywords,
        keywordsBufSize: Buffer.byteLength(keywords),
        keywordsThreshold: SENSITIVITY_THRESHOLDS[sensitivity],
      }) as SherpaKeywordSpotter
      this.stream = this.spotter.createStream() as SherpaStream
      this.startedKey = key
      return true
    } catch (error: any) {
      this.stop()
      options.onError(`The local wake engine failed to start: ${error?.message || String(error)}`)
      return false
    }
  }

  pushAudio(pcm: Int16Array, sampleRate: number): void {
    const spotter = this.spotter
    const stream = this.stream
    if (!spotter || !stream || pcm.length === 0) return

    const samples = new Float32Array(pcm.length)
    for (let index = 0; index < pcm.length; index += 1) {
      samples[index] = pcm[index] / 32768
    }
    try {
      stream.acceptWaveform({ sampleRate, samples })
      while (spotter.isReady(stream)) {
        spotter.decode(stream)
        const result = spotter.getResult(stream)
        if (result?.keyword) {
          spotter.reset(stream)
          this.options?.onDetected(result.keyword)
          return
        }
      }
    } catch (error: any) {
      const message = `Wake-word decoding failed: ${error?.message || String(error)}`
      this.stop()
      this.options?.onError(message)
    }
  }

  stop(): void {
    this.spotter = null
    this.stream = null
    this.startedKey = ''
  }
}
