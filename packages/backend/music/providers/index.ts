/**
 * The music provider registry — static, mirroring the AI providers' builtin
 * pattern. Adding a CLI = one directory implementing MusicProvider plus one
 * entry here; no dynamic loading until a real need shows up.
 */

import { ncmMusicProvider } from './ncm/index.js'
import type { MusicProvider, MusicProviderDescriptor } from './types.js'

export const builtinMusicProviders: readonly MusicProvider[] = [ncmMusicProvider]

export const DEFAULT_MUSIC_PROVIDER_ID = ncmMusicProvider.descriptor.id

/** Unknown/absent ids fall back to ncm — matches the settings normalizer. */
export function getMusicProvider(id: string | undefined | null): MusicProvider {
  return (
    builtinMusicProviders.find(provider => provider.descriptor.id === id) ?? ncmMusicProvider
  )
}

export function listMusicProviderDescriptors(): MusicProviderDescriptor[] {
  return builtinMusicProviders.map(provider => provider.descriptor)
}

export { ncmMusicProvider } from './ncm/index.js'
export { ncmIdSchema } from './ncm/ids.js'
export type * from './types.js'
