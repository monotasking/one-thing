/**
 * 桌面这台机器上那一份会话 / 文件 / 提示词表 —— 搜索的**取材面**。
 *
 * 从前它是 `providers.ts` 里 `configureOnethingSearchProviders({...})` 的那个内联
 * 字面量。S2(检索重建,`docs/design/search-index-2026-09.md` §10 S2)把它提成一个
 * 文件,当时的理由是「新旧两条路必须吃**同一份**取材面」;S5 删掉旧路之后理由只
 * 剩下一条,但它更硬:**取材面有两个装法** —— 桌面按整台机器装一份(下面这只
 * 函数),server 按 owner 现装一份(`server/runtime.ts` 的
 * `createSearchAdaptersForContext`)。两个装法各自成文件,`providers.ts` 只留那个
 * 进程单槽。
 */
import type { OnethingSearchProvidersAdapters } from '@onething/runtime/search'
import { listPrompts } from '@onething/runtime/prompts/store-bound'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'
import { getCurrentSessionId } from '../../stores/app-state.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { getSession, getSessionsList } from '../../stores/sessions.js'
import { sessionReads } from '../../session/reads.js'
import { getSettings } from '../../stores/settings.js'
import { listFiles } from '../../utils/ripgrep.js'

export function createAppSearchProvidersAdapters(): OnethingSearchProvidersAdapters {
  return {
    getSessionsList,
    // 全库消息搜索:raw 语义(不进 LRU、不 sanitize、不回写),P0.2 区 ②。
    iterateSessionMessages: (sessionId: string) => sessionReads.iterateMessagesRaw(sessionId),
    getSession,
    getCurrentSessionId,
    getSettings,
    getVariablesStore,
    // 搜索窗没有请求级会话号:当前会话是这里能拿到的最诚实的空间语境(批 B2)。
    getConnectedDirectories: () => getConnectedDirectoriesForSession(getCurrentSessionId()),
    listFiles,
    listPrompts,
  }
}
