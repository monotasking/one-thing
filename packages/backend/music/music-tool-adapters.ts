/**
 * 电台那组操作的适配器工厂(D191,从 `toolkit/toolkit-adapters.ts` 搬回 music)。
 *
 * `radio` 那只工具早已退役(K3-b),这组适配器今天唯一的读者是资源面的 `MusicResourceProvider`
 * (`resource/resource-music-provider.ts`)。它绑的是当前实例上的电台与 music 的操作者判据,所以住在 music、
 * 经 music 入口交出。电台在**调这只工厂的那一刻**取一次。内容与旧路**逐字相同**。
 * 本文件只引兄弟文件与 session 入口,不引 music 入口;对 toolkit 只有类型引用。
 */
import type { RadioToolAdapters } from '@onething/backend/toolkit'
import { getCurrentBackendInstance } from '@onething/backend/backend-current.js'
import { fixedExecutionContext } from '@onething/backend/session'
import { assertMusicOperator } from './music-access.js'

export function musicRadioAdapters(): RadioToolAdapters {
  const captured = getCurrentBackendInstance()?.music.radio
  const radio = () => {
    if (!captured) throw new Error('Music service is unavailable')
    return captured
  }
  return {
    open: (intent, options, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolOpen(intent, options)
    },
    close: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolClose()
    },
    status: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolStatus()
    },
    request: (song, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().requestSong(song)
    },
  }
}
