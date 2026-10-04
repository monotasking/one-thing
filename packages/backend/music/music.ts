/**
 * music —— 音乐:曲库源(网易云命令行等,按自述的 provider 登记)、播放器、电台(DJ 主持与歌单编排)、
 * 歌词,以及把这些作为 `music:` 资源交给资源面的规格。
 *
 * 对外交出六类东西:
 * - 装配:音乐子系统 `MusicSubsystem`、音乐 CLI 的 bash 分类策略登记;
 * - 曲库源:内置的那几只、按 id 取、列出描述、网易云那一只,以及描述的形状;
 * - 运行期的读与改:正在播放、电台仓库、切换曲库源、「这个调用方能不能操作音乐」的判据、电台那组操作的适配器;
 * - `music:` 资源的规格与三个地址常量;
 * - 主持人的嗓子(语音合成)要实现的形状与估一段话念多久;
 * - 设置向导那一步的操作与几个状态形状。
 * 依赖 settings、voice、session、permission、agent、tool、storage、lifecycle、logging 与包根的当前实例槽。
 */

// 装配。
export { MusicSubsystem } from './music-subsystem.js'
// 音乐 CLI 的 bash 分类策略登记(越层清零 C8):装配时调一次。
export { registerMusicBashPolicies } from './music-bash-policies.js'

// 曲库源。
export { builtinMusicProviders, getMusicProvider, listMusicProviderDescriptors } from './providers/music-providers.js'
export { ncmMusicProvider } from './providers/ncm/ncm.js'
export type { MusicProviderDescriptor } from './providers/music-providers-types.js'

// 运行期的读与改。
export { getMusicNowPlaying } from './music-service.js'
export { getRadioStore } from './music-radio.js'
export { setMusicProvider } from './music-operations.js'
export { assertMusicOperator } from './music-access.js'
// 电台那组操作的适配器(D191 从工具目录搬回):资源面的 `MusicResourceProvider` 用它。
export { musicRadioAdapters } from './music-tool-adapters.js'
export type { OnethingMusicNowPlaying } from './music-now-playing.js'
export type { OnethingMusicRuntimeState } from './music-types.js'

// `music:` 资源。
export {
  MUSIC_PLAYER_PATH,
  MUSIC_PROVIDER_PATH,
  MUSIC_RADIO_PATH,
  MUSIC_RESOURCE_SCHEME,
  musicResourceSpec,
} from './music-resource-spec.js'

// 主持人的嗓子。
export type {
  HostVoice,
  HostVoiceKit,
  HostVoiceSpeakOptions,
  PatterSpeech,
  PatterVoiceStyle,
} from './music-host-voice.js'
export { estimateSpeechSeconds } from './music-lyrics.js'

// 设置向导。
export { runOnethingMusicSetupForIpc } from './music-ipc-operations.js'
export type { OnethingMusicSetupRequest } from './music-ipc-operations.js'
