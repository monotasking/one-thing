/**
 * Search Everywhere - Electron IPC host facade.
 */

import { IPC_CHANNELS } from '@shared/ipc.js'
import type { SearchRequest, SearchResponse, SearchWindowAnchor } from '@shared/ipc/search.js'
import {
  closeOnethingSearchWindowForIpc,
  executeOnethingSearchForIpc,
} from '@onething/runtime/search'
import { executeSearch } from '@onething/app/search/providers.js'
import { closeSearchWindow, setSearchWindowAnchor } from './window.js'
import { registerElectronSearchIpcHandlers } from './window-actions.js'
import { executeSearchActionFrom, toggleSearchWindowFrom } from './window-controller.js'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('search')

export function registerSearchHandlers(): void {
  registerElectronSearchIpcHandlers({
    channels: {
      toggleWindow: IPC_CHANNELS.SEARCH_WINDOW_TOGGLE,
      closeWindow: IPC_CHANNELS.SEARCH_WINDOW_CLOSE,
      query: IPC_CHANNELS.SEARCH_QUERY,
      executeAction: IPC_CHANNELS.SEARCH_EXECUTE_ACTION,
      setAnchor: IPC_CHANNELS.SEARCH_WINDOW_SET_ANCHOR,
    },
    toggleWindow: (sourceWindow, openOptions) => toggleSearchWindowFrom(sourceWindow, openOptions),
    closeWindow: () => closeOnethingSearchWindowForIpc({ closeSearchWindow }),
    setAnchor: (anchor) => {
      setSearchWindowAnchor((anchor as SearchWindowAnchor | null) ?? null)
      return { success: true }
    },
    query: (req): Promise<SearchResponse> =>
      executeOnethingSearchForIpc({
        request: req as SearchRequest,
        executeSearch,
      }),
    executeAction: (sourceWindow, actionId) => executeSearchActionFrom(sourceWindow, actionId),
  })

  log.info('handlers registered')
}
