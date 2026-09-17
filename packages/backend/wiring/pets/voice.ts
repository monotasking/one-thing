/**
 * **宠物嗓子 → 语音设置**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2「音色」那一行)。
 *
 * `PetVoice` 是三格档位词(`manifest.ts` 文件头:描述,不是某家 TTS 的音色 id)。这里把它
 * 换算到**当前语音设置里真有的旋钮**上,没有的旋钮一格不造:
 *
 *   · 语速 `rate` → `tts.system.rate`(设置里 0.5–2,缺省 1);
 *   · 音调 `pitch` → `tts.system.pitch`(设置里 0–2,缺省 1);
 *   · 音色 `timbre` → 设置里没有对应的旋钮(各家云 TTS 只有「选哪个音色 id」),**忽略**。
 *
 * ── 一句必须写下来的实话 ─────────────────────────────────────────────────
 * 今天能合成出音频文件的四家(OpenAI / OpenRouter / Qwen / 豆包,`runtime/voice/providers.ts`)
 * **都不读** `tts.system.rate` / `pitch` —— 那两格只喂系统 TTS,而系统 TTS 不产出音频文件
 * (`synthesizeOnethingSpeech` 对它直接抛)。所以这份换算今天**听不出来**:它把宠物的嗓子
 * 落到了设置里仅有的那两个旋钮上,等哪家云 TTS 接上语速 / 音调,这里一个字不改就生效。
 * 不为了「听得出来」去猜某家的私有参数。
 *
 * 没配语音(`settings.voice` 缺席)→ 合成那一步答 `null` → 不出声,但气泡照出(§10.2)。
 */
import type { PetVoice } from '@onething/runtime/pets'
import type { VoiceSettings } from '@shared/ipc.js'
import type { PatterVoiceStyle } from '../music/host-voice.js'

const RATE: Record<PetVoice['rate'], number> = {
  slow: 0.85,
  normal: 1,
  'slightly-fast': 1.1,
  fast: 1.25,
}

const PITCH: Record<PetVoice['pitch'], number> = {
  low: 0.85,
  medium: 1,
  high: 1.15,
}

/** 换算:只动 `tts.system` 那两格,其余原样。 */
export function applyPetVoice(voice: PetVoice, settings: VoiceSettings): VoiceSettings {
  return {
    ...settings,
    tts: {
      ...settings.tts,
      system: {
        ...settings.tts.system,
        rate: RATE[voice.rate],
        pitch: PITCH[voice.pitch],
      },
    },
  }
}

/** 给口播缓存的调法:同一只宠物同一副嗓子是同一个 `key`。 */
export function petVoiceStyle(petId: string, voice: PetVoice): PatterVoiceStyle {
  return {
    key: `pet:${petId}:${voice.rate}:${voice.pitch}`,
    apply: settings => applyPetVoice(voice, settings),
  }
}
