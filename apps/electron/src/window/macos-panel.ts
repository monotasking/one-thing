import { app, BrowserWindow } from 'electron'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { getLogger } from '@onething/backend/logging/index.js'

const log = getLogger('window.macos-panel')

interface MacOSPanelAddon {
  configureNonActivatingPanel: (nativeWindowHandle: Buffer) => boolean
  showNonActivatingPanel: (nativeWindowHandle: Buffer) => boolean
  hideNonActivatingPanel: (nativeWindowHandle: Buffer) => boolean
  isNonActivatingPanelFrontmost: (nativeWindowHandle: Buffer) => boolean
  setNonActivatingPanelPinned: (nativeWindowHandle: Buffer, pinned: boolean) => boolean
}

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let addon: MacOSPanelAddon | null | undefined
let warned = false

function addonCandidates(): string[] {
  return [
    path.join(process.resourcesPath, 'native', 'macos_panel.node'),
    path.join(app.getAppPath(), 'resources', 'native', 'macos_panel.node'),
    path.join(process.cwd(), 'resources', 'native', 'macos_panel.node'),
    path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'native', 'macos_panel.node'),
  ]
}

function loadAddon(): MacOSPanelAddon | null {
  if (addon !== undefined) return addon
  addon = null

  for (const candidate of addonCandidates()) {
    try {
      addon = require(candidate) as MacOSPanelAddon
      return addon
    } catch {
      // Try the next runtime location. The dev and packaged paths differ.
    }
  }

  if (!warned) {
    warned = true
    log.warn('native panel bridge unavailable')
  }
  return null
}

export function configureNonActivatingPanel(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false

  const nativeAddon = loadAddon()
  if (!nativeAddon) return false

  try {
    return nativeAddon.configureNonActivatingPanel(window.getNativeWindowHandle()) === true
  } catch (error) {
    log.warn('configure non-activating panel failed', undefined, error)
    return false
  }
}

export function showNonActivatingPanel(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false

  const nativeAddon = loadAddon()
  if (!nativeAddon) return false

  try {
    return nativeAddon.showNonActivatingPanel(window.getNativeWindowHandle()) === true
  } catch (error) {
    log.warn('show non-activating panel failed', undefined, error)
    return false
  }
}

export function hideNonActivatingPanel(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false

  const nativeAddon = loadAddon()
  if (!nativeAddon) return false

  try {
    return nativeAddon.hideNonActivatingPanel(window.getNativeWindowHandle()) === true
  } catch (error) {
    log.warn('hide non-activating panel failed', undefined, error)
    return false
  }
}

export function isNonActivatingPanelFrontmost(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false

  const nativeAddon = loadAddon()
  if (!nativeAddon) return false

  try {
    return nativeAddon.isNonActivatingPanelFrontmost(window.getNativeWindowHandle()) === true
  } catch (error) {
    log.warn('inspect non-activating panel ordering failed', undefined, error)
    return false
  }
}

export function setNonActivatingPanelPinned(window: BrowserWindow, pinned: boolean): boolean {
  if (process.platform !== 'darwin') return false

  const nativeAddon = loadAddon()
  if (!nativeAddon) return false

  try {
    return nativeAddon.setNonActivatingPanelPinned(window.getNativeWindowHandle(), pinned) === true
  } catch (error) {
    log.warn('update non-activating panel pin level failed', undefined, error)
    return false
  }
}
