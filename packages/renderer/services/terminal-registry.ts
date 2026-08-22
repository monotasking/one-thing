/**
 * Terminal instance registry — the module-level owner of live xterm instances.
 *
 * Pinia stores keep only serializable descriptors; the actual xterm Terminal,
 * its persistent host <div>, and the flow-control state live here so a
 * terminal can move between views (workbench pane today, bottom dock in P2)
 * by re-parenting its host element without killing the PTY or its buffer.
 *
 * Attach state machine (docs/design/terminal-system.md 7.5) runs LAZILY in
 * ensureAttached(), called from TerminalView onMounted — the only moment we
 * provably have a real-sized DOM node, which is what xterm needs to open.
 * Live pushes for a terminal that is not yet attached are dropped: the main
 * process ring buffer replays them on attach.
 *
 * xterm and its addons are DYNAMICALLY imported on first use — happy-dom test
 * mounts and hosts without terminals never pay for (or crash on) xterm.
 *
 * The seven request-side calls ride the generic RPC channel (`terminalApi`,
 * P4 终态批 D2); the two pushes stay on `platformApi` (router has no push
 * face). Fire-and-forget calls keep their pre-migration no-throw semantics via
 * `ignoreRpcFailure` — the old `platformApi.xxx?.()` shape could not reject on
 * a host without terminals either, and a lost write/resize/ack is recoverable
 * by design (the attach generation protocol resets the ledger).
 */

import '@xterm/xterm/css/xterm.css'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { TerminalAttachResponse } from '@shared/ipc/terminal.js'
import { platformApi } from '@/platform'
import { terminalApi } from '@/platform/terminal-client'

// A module-level registry does not survive HMR (the replacing module starts
// with an empty map while orphaned xterm instances keep their subscriptions).
// Force a full reload instead — the attach/replay protocol makes page reload
// cheap by design.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate()
  })
}

export interface TerminalRegistryEvents {
  onExit?(terminalId: string, exitCode: number | null): void
  onTitle?(terminalId: string, title: string): void
}

type AttachPhase = 'idle' | 'attaching' | 'attached'

interface RegistryEntry {
  terminalId: string
  host: HTMLDivElement
  term: Terminal | null
  fit: FitAddon | null
  phase: AttachPhase
  generation: number
  /** Live chunks that arrived while the attach snapshot was in flight. */
  queue: Array<{ seq: number; data: string }>
  attachPromise: Promise<void> | null
}

const entries = new Map<string, RegistryEntry>()
let events: TerminalRegistryEvents = {}
let subscribed = false
let lastFocusedTerminalId: string | null = null

export function configureTerminalRegistryEvents(next: TerminalRegistryEvents): void {
  events = next
}

/** One global subscription for all terminals, dispatched by terminalId. */
export function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  platformApi.onTerminalData?.(payload => {
    const entry = entries.get(payload.terminalId)
    if (!entry) return
    if (entry.phase === 'attached') {
      writeWithAck(entry, payload.data)
    } else if (entry.phase === 'attaching') {
      entry.queue.push({ seq: payload.seq, data: payload.data })
    }
    // idle: drop — the ring buffer replays on attach.
  })
  platformApi.onTerminalExit?.(payload => {
    events.onExit?.(payload.terminalId, payload.exitCode)
  })
}

function getOrCreateEntry(terminalId: string): RegistryEntry {
  let entry = entries.get(terminalId)
  if (!entry) {
    const host = document.createElement('div')
    host.className = 'onething-terminal'
    host.style.width = '100%'
    host.style.height = '100%'
    entry = {
      terminalId,
      host,
      term: null,
      fit: null,
      phase: 'idle',
      generation: 0,
      queue: [],
      attachPromise: null,
    }
    entries.set(terminalId, entry)
  }
  return entry
}

/** Fire-and-forget RPC: a host without terminals answers with a failure, not a crash. */
function ignoreRpcFailure(): void {}

function writeWithAck(entry: RegistryEntry, data: string): void {
  const generation = entry.generation
  // bytes = JS string length (UTF-16 code units) — must match the service's
  // accounting unit exactly or the watermark ledger drifts on CJK output.
  entry.term?.write(data, () => {
    void terminalApi
      .ack({ terminalId: entry.terminalId, bytes: data.length, generation })
      .catch(ignoreRpcFailure)
  })
}

async function createXterm(entry: RegistryEntry): Promise<void> {
  const [xtermModule, fitModule, unicodeModule, themeModule, settingsModule] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('./xterm-theme.js'),
    import('../stores/settings.js'),
  ])
  const mode = settingsModule.useSettingsStore().effectiveTheme === 'light' ? 'light' : 'dark'
  const term = new xtermModule.Terminal({
    allowProposedApi: true,
    scrollback: 10000,
    cursorBlink: true,
    fontSize: 12,
    fontFamily: themeModule.resolveMonoFontFamily(),
    theme: themeModule.buildXtermTheme(mode),
  })
  const fit = new fitModule.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new unicodeModule.Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open(entry.host)
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // DOM renderer fallback is fine.
  }
  term.onData(data => {
    void terminalApi.write({ terminalId: entry.terminalId, data }).catch(ignoreRpcFailure)
  })
  term.onResize(({ cols, rows }) => {
    void terminalApi
      .resize({ terminalId: entry.terminalId, cols, rows })
      .catch(ignoreRpcFailure)
  })
  term.onTitleChange(title => {
    events.onTitle?.(entry.terminalId, title)
  })
  term.textarea?.addEventListener('focus', () => {
    lastFocusedTerminalId = entry.terminalId
  })
  entry.term = term
  entry.fit = fit
}

/**
 * Idempotent lazy attach: re-parents the persistent host into `container`,
 * creates+opens xterm on first mount, then runs the attach/replay protocol.
 */
export async function ensureAttached(terminalId: string, container: HTMLElement): Promise<void> {
  ensureSubscribed()
  const entry = getOrCreateEntry(terminalId)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (!entry.term) await createXterm(entry)
  if (entry.phase === 'attached') {
    fitTerminal(terminalId)
    return
  }
  if (entry.attachPromise) return entry.attachPromise
  entry.attachPromise = runAttach(entry).finally(() => {
    entry.attachPromise = null
  })
  return entry.attachPromise
}

async function runAttach(entry: RegistryEntry): Promise<void> {
  entry.phase = 'attaching'
  entry.queue = []
  let response: TerminalAttachResponse
  try {
    response = await terminalApi.attach({ terminalId: entry.terminalId })
  } catch (error) {
    response = { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!response.success || !response.info) {
    entry.phase = 'idle'
    entry.term?.write(`\r\n[terminal] attach failed: ${response.error ?? 'unknown error'}\r\n`)
    return
  }
  const term = entry.term
  if (!term) {
    entry.phase = 'idle'
    return
  }
  entry.generation = response.generation ?? 0
  // Open at the PTY's real size BEFORE replaying, or content re-wraps at the
  // wrong width; the follow-up fit() corrects the PTY to the container.
  if (response.info.cols > 0 && response.info.rows > 0) {
    term.resize(response.info.cols, response.info.rows)
  }
  if (response.truncated) term.write('\x1bc')
  for (const chunk of response.chunks ?? []) {
    term.write(chunk.data) // replay is NOT acked
  }
  const lastSeq = response.lastSeq ?? 0
  const queued = entry.queue
  entry.queue = []
  entry.phase = 'attached'
  for (const chunk of queued) {
    if (chunk.seq > lastSeq) writeWithAck(entry, chunk.data)
  }
  fitTerminal(entry.terminalId)
}

/** Fit xterm to its host; onResize then syncs the PTY size over IPC. */
export function fitTerminal(terminalId: string): void {
  const entry = entries.get(terminalId)
  if (!entry?.fit || !entry.term) return
  if (!entry.host.isConnected || entry.host.clientWidth === 0 || entry.host.clientHeight === 0) return
  try {
    entry.fit.fit()
  } catch {
    // Transient layout states (display:none flips) can fail a measure; the
    // next ResizeObserver tick retries.
  }
}

export function focusTerminal(terminalId: string): void {
  entries.get(terminalId)?.term?.focus()
}

/** Re-parent away without destroying (view unmounted, terminal kept alive). */
export function detachView(terminalId: string): void {
  entries.get(terminalId)?.host.remove()
}

export function disposeTerminal(terminalId: string): void {
  const entry = entries.get(terminalId)
  if (!entry) return
  entries.delete(terminalId)
  if (lastFocusedTerminalId === terminalId) lastFocusedTerminalId = null
  entry.term?.dispose()
  entry.host.remove()
}

export function getLastFocusedTerminalId(): string | null {
  return lastFocusedTerminalId
}
