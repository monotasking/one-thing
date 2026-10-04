/**
 * 宠物系统的产品层(正本 `docs/design/pet-system-2026-09.md`)。纯数据与纯类:
 * 自述、名册、主持人、账本行、作曲端口、`pet:` 自述。读写文件与接总线在装配层
 * `@onething/backend/pet/`。
 */

export { ALU } from './builtin/pet-builtin-alu.js'
export { HEIDOU } from './builtin/pet-builtin-heidou.js'
export {
  normalizePetChattiness,
  PET_CHATTINESS,
  PET_CHATTINESS_LEVELS,
  PET_DEFAULT_CHATTINESS,
} from './pet-chattiness.js'
export type { PetChattiness, PetChattinessProfile } from './pet-chattiness.js'
export { SayOrElseComposer, SayPassthroughComposer } from './pet-composer.js'
export type { MomentComposeInput, MomentComposer } from './pet-composer.js'
export {
  estimateSpeechMs,
  PET_DEFAULT_COOLDOWN_MS,
  PetHost,
} from './pet-host.js'
export type { PetClaimOutcome, PetClock, PetCurrentView, PetHostOptions, PetHostOutcome } from './pet-host.js'
export {
  foldPetMemory,
  momentLine,
  parsePetLedgerLine,
  PET_MEMORY_LINES,
  PET_RECENT_UTTERANCES,
} from './pet-ledger.js'
export type { PetDroppedLine, PetHushedLine, PetLedgerLine, PetMemory, PetMomentLine, PetPreemptedLine, PetUtteranceLine } from './pet-ledger.js'
export { buildMomentPrompt, parseMomentReply, PET_PROMPT_MEMORY_LINES } from './pet-prompt.js'
export type { MomentPrompt, MomentPromptInput } from './pet-prompt.js'
export { petManifestProblems, rosterEntryOf, summarizePet } from './pet-manifest.js'
export type { PetManifest, PetRig, PetRosterEntry, PetSummary, PetVoice } from './pet-manifest.js'
export { BUILTIN_PETS, PetIdTakenError, PetRegistry, PetRigInvalidError } from './pet-registry.js'
export {
  PET_CURRENT_PATH,
  PET_CURRENT_REF,
  PET_RESOURCE_SCHEME,
  petResourceSpec,
} from './pet-resource-spec.js'
export type { Moment, MomentWeight, Utterance, UtteranceDropReason } from './pet-types.js'
