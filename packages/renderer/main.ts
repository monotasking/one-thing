import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
// feature 名册（C2）。renderer 没有装配序列,feature 模块必须被某处静态 import
// 才会求值 —— 这里就是那个"某处",整棵应用只此一行。名册本身是数据形状的
// (`features/index.ts` = 一列 import),加一个 feature 不用碰这个文件。
import './features'
import { initializeIPCHub } from './services/ipc-hub'
import { getLogger, installRendererLogging } from './services/log'
import { installGlobalCrashCapture } from './services/crash-log'
import { installGlobalFileDropGuard } from './composables/useFileDrop'
import { buildFontLoadSpecs, DEFAULT_FONT_EN, DEFAULT_FONT_ZH } from '@shared/fonts'
import './styles/main.css'

// Note: Initial theme is handled by index.html inline script to prevent FOUC
// The settings store will apply the user's saved preference after loading

// The standalone Todo window is a transparent macOS panel whose rounded shape
// is drawn by `.todo-plan-window` (border-radius: 22px). The global opaque
// `html/body/#app` background would otherwise fill the square behind it and
// peek out at the corners, so flag the root to make those layers transparent.
// Only macOS creates the window with `transparent: true`; elsewhere the window
// is opaque and a transparent root would expose the mismatched native
// background color at the corners instead.
if (window.location.hash.startsWith('#/todo-plan') && /Mac/i.test(navigator.userAgent)) {
  document.documentElement.classList.add('transparent-window-root')
}

// Ensure theme attribute is valid (fixes HMR issues where 'system' might persist)
const html = document.documentElement
const currentTheme = html.getAttribute('data-theme')
if (currentTheme !== 'light' && currentTheme !== 'dark') {
  // Invalid theme value (e.g., 'system' from old code or HMR state)
  // Fall back to cached theme or default
  const cached = localStorage.getItem('cached-theme')
  const fixedTheme = (cached === 'light' || cached === 'dark') ? cached : 'dark'
  getLogger('renderer.boot').debug('fixed invalid data-theme', { from: currentTheme, to: fixedTheme })
  html.setAttribute('data-theme', fixedTheme)
}

// Ensure default color theme and base theme are set if not already
if (!html.getAttribute('data-color-theme')) {
  html.setAttribute('data-color-theme', 'blue')
}
if (!html.getAttribute('data-base-theme')) {
  html.setAttribute('data-base-theme', 'obsidian')
}

// Preload @fontsource variable fonts BEFORE Vue mounts. The default
// `font-display: swap` would otherwise paint with system fallbacks (PingFang
// SC on macOS) and re-flow once Noto Sans SC arrives — visible as a vertical
// shift in the sidebar list a few hundred ms after launch.
//
// document.fonts.load() returns a promise that resolves once the font is in
// the FontFaceSet. By awaiting it before createApp().mount() we guarantee the
// very first Vue paint is already on the intended font.
async function preloadCriticalFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return

  // UI fonts (sidebar, chrome) — always preload
  const specMap = new Map<string, string>()
  for (const { spec, sample } of buildFontLoadSpecs(DEFAULT_FONT_EN, DEFAULT_FONT_ZH)) {
    specMap.set(spec, sample)
  }

  // Chat fonts — read from last-run cache so they're ready before first paint
  try {
    const raw = localStorage.getItem('cached-chat-fonts')
    if (raw) {
      const cached = JSON.parse(raw) as { en?: string | null; zh?: string | null }
      for (const { spec, sample } of buildFontLoadSpecs(cached.en ?? undefined, cached.zh ?? undefined)) {
        if (!specMap.has(spec)) specMap.set(spec, sample)
      }
    }
  } catch {
    // No cache or corrupt — skip chat font preload, UI is fine
  }

  await Promise.all(
    Array.from(specMap.entries(), ([spec, text]) => document.fonts.load(spec, text).catch(() => null))
  )
}

// 1.5s cap: cold-start loading of local woff2 from disk is ~100-400ms, but if
// something's wrong (corrupt asset, FS error) we don't want to wedge mount.
await Promise.race([
  preloadCriticalFonts(),
  new Promise<void>(resolve => setTimeout(resolve, 1500)),
])

const app = createApp(App)
const pinia = createPinia()

// 日志 hub 先装(L3):崩溃捕获、store、IPC 全都从它出去,
// `window.__onethingLog.dump()` 也在这一步挂上。
installRendererLogging()

// Crash log first: capture must be live before any store/IPC init can throw.
installGlobalCrashCapture(app)

app.use(pinia)

// Initialize IPC Hub after Pinia is set up, before component mounts
// This ensures all IPC listeners are registered before any IPC calls
initializeIPCHub()

// Must be installed before anything can be dragged in: an unhandled file drop
// escapes to the OS via will-navigate → shell.openExternal.
installGlobalFileDropGuard()

app.mount('#app')
