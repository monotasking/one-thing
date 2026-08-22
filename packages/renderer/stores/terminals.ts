/**
 * Terminal descriptors — the serializable half of the terminal system.
 * Live xterm instances live in services/terminal-registry.ts; this store owns
 * the list the UI renders (tabs, dock list) and survives renderer reload by
 * re-listing from the main process (PTYs live there and keep running).
 *
 * Terminals are APP-scoped, not session-scoped: a sessionId passed at create
 * time only seeds the working directory.
 *
 * The three request-side calls (`list` / `create` / `kill`) ride the generic RPC
 * channel (`terminalApi`, P4 终态批 D2); the exit/title pushes still arrive
 * through the registry's `platformApi` subscriptions.
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { TerminalInfo } from '@shared/ipc/terminal.js'
import { terminalApi } from '@/platform/terminal-client'
import {
  configureTerminalRegistryEvents,
  disposeTerminal as disposeRegistryTerminal,
  ensureSubscribed,
} from '@/services/terminal-registry'

export interface TerminalDescriptor {
  id: string
  title: string
  cwd: string
  exited: { code: number | null } | null
}

function toDescriptor(info: TerminalInfo): TerminalDescriptor {
  return {
    id: info.id,
    title: info.title,
    cwd: info.cwd,
    exited: info.exited ?? null,
  }
}

export const useTerminalsStore = defineStore('terminals', () => {
  const terminals = ref<TerminalDescriptor[]>([])
  let loadPromise: Promise<void> | null = null

  function bindRegistry(): void {
    configureTerminalRegistryEvents({
      onExit: (terminalId, exitCode) => {
        const descriptor = terminals.value.find(t => t.id === terminalId)
        if (descriptor) descriptor.exited = { code: exitCode }
      },
      onTitle: (terminalId, title) => {
        const descriptor = terminals.value.find(t => t.id === terminalId)
        if (descriptor && title.trim()) descriptor.title = title
      },
    })
    ensureSubscribed()
  }

  /** Idempotent; PTYs survive renderer reload, so re-list instead of assuming empty. */
  async function ensureLoaded(): Promise<void> {
    loadPromise ??= (async () => {
      bindRegistry()
      try {
        const response = await terminalApi.list({})
        if (response.success && Array.isArray(response.terminals)) {
          terminals.value = response.terminals.map(toDescriptor)
        }
      } catch {
        // Host without terminal support (web) — capability gate hides the UI.
      }
    })()
    return loadPromise
  }

  async function createTerminal(
    options: { cwd?: string; sessionId?: string } = {},
  ): Promise<string> {
    await ensureLoaded()
    const response = await terminalApi.create({
      cwd: options.cwd,
      sessionId: options.sessionId,
    })
    if (!response.success || !response.terminal) {
      throw new Error(response.error || 'Failed to create terminal')
    }
    terminals.value = [...terminals.value, toDescriptor(response.terminal)]
    return response.terminal.id
  }

  async function closeTerminal(terminalId: string): Promise<void> {
    disposeRegistryTerminal(terminalId)
    terminals.value = terminals.value.filter(t => t.id !== terminalId)
    try {
      await terminalApi.kill({ terminalId })
    } catch {
      // Process may already be gone.
    }
  }

  /** Fresh shell in the old terminal's cwd; returns the replacement id. */
  async function restartTerminal(terminalId: string): Promise<string> {
    const previous = terminals.value.find(t => t.id === terminalId)
    const nextId = await createTerminal({ cwd: previous?.cwd })
    await closeTerminal(terminalId)
    return nextId
  }

  return {
    terminals,
    ensureLoaded,
    createTerminal,
    closeTerminal,
    restartTerminal,
  }
})
