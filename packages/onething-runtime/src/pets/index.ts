/**
 * 宠物系统的产品层(正本 `docs/design/pet-system-2026-09.md`)。纯数据与纯类:
 * 自述、名册、主持人、账本行、作曲端口、`pet:` 自述。读写文件与接总线在装配层
 * `@onething/backend/wiring/pets/`。
 */

export { HEIDOU } from './builtin/heidou.js'
export { SayOrElseComposer, SayPassthroughComposer } from './composer.js'
export type { MomentComposeInput, MomentComposer } from './composer.js'
export {
  estimateSpeechMs,
  PET_DEFAULT_COOLDOWN_MS,
  PetHost,
} from './host.js'
export type { PetClaimOutcome, PetClock, PetCurrentView, PetHostOptions, PetHostOutcome } from './host.js'
export {
  foldPetMemory,
  momentLine,
  parsePetLedgerLine,
  PET_MEMORY_LINES,
  PET_RECENT_UTTERANCES,
} from './ledger.js'
export type { PetDroppedLine, PetHushedLine, PetLedgerLine, PetMemory, PetMomentLine, PetPreemptedLine, PetUtteranceLine } from './ledger.js'
export { buildMomentPrompt, parseMomentReply, PET_PROMPT_MEMORY_LINES } from './prompt.js'
export type { MomentPrompt, MomentPromptInput } from './prompt.js'
export { summarizePet } from './manifest.js'
export type { PetManifest, PetSummary, PetVoice } from './manifest.js'
export { BUILTIN_PETS, PetIdTakenError, PetRegistry } from './registry.js'
export {
  PET_CURRENT_PATH,
  PET_CURRENT_REF,
  PET_RESOURCE_SCHEME,
  petResourceSpec,
} from './resource-spec.js'
export type { Moment, MomentWeight, Utterance, UtteranceDropReason } from './types.js'
