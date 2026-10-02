import {
  configureOnethingRipgrepRuntime,
} from '@onething/backend/runtime/files/ripgrep'
import { createRequiredAppFetch } from '../provider-binding/bound-fetch.js'

let ripgrepConfigured = false

/** Explicit assembly step: ripgrep binary downloads go through the app fetch. */
export function configureAppRipgrep(): void {
  if (ripgrepConfigured) return
  ripgrepConfigured = true
  configureOnethingRipgrepRuntime({
    createFetch: createRequiredAppFetch,
  })
}

export {
  OnethingRipgrep,
  Ripgrep,
  buildOnethingRipgrepFileListArgs,
  buildOnethingRipgrepSearchArgs,
  getOnethingRipgrepPath,
  getOnethingRipgrepPlatformConfig,
  getRipgrepPath,
  listFiles,
  listOnethingRipgrepFiles,
  parseOnethingRipgrepSearchOutput,
  resetOnethingRipgrepRuntimeForTests,
  search,
  searchOnethingRipgrep,
} from '@onething/backend/runtime/files/ripgrep'
export type {
  OnethingRipgrepListFilesOptions,
  OnethingRipgrepRuntimeAdapters,
  OnethingRipgrepSearchOptions,
  OnethingRipgrepSearchResult,
} from '@onething/backend/runtime/files/ripgrep'
