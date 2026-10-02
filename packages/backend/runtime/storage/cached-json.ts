import fs from 'fs'
import { readJsonFile, writeJsonFile, writeJsonFileAsync } from './json-file.js'

export interface CoreCachedJsonState<T> {
  value: T | null
  initPromise: Promise<T> | null
}

export interface CoreCachedJsonFileOptions<T> {
  filePath: string
  defaultValue: T | (() => T)
  normalize?: (value: unknown) => T
}

export function createCoreCachedJsonState<T>(): CoreCachedJsonState<T> {
  return {
    value: null,
    initPromise: null,
  }
}

function resolveDefaultValue<T>(defaultValue: T | (() => T)): T {
  return typeof defaultValue === 'function'
    ? (defaultValue as () => T)()
    : defaultValue
}

function normalizeCachedJsonValue<T>(
  value: unknown,
  options: Pick<CoreCachedJsonFileOptions<T>, 'normalize'>,
): T {
  return options.normalize ? options.normalize(value) : value as T
}

function defaultCachedJsonValue<T>(options: CoreCachedJsonFileOptions<T>): T {
  return normalizeCachedJsonValue(resolveDefaultValue(options.defaultValue), options)
}

export function isCoreCachedJsonInitialized<T>(state: CoreCachedJsonState<T>): boolean {
  return state.value !== null
}

export async function initializeCoreCachedJsonFile<T>(
  state: CoreCachedJsonState<T>,
  options: CoreCachedJsonFileOptions<T>,
): Promise<T> {
  if (state.value !== null) {
    return state.value
  }

  if (state.initPromise !== null) {
    return state.initPromise
  }

  state.initPromise = (async () => {
    try {
      const data = await fs.promises.readFile(options.filePath, 'utf-8')
      const parsed = data.trim() ? JSON.parse(data) : resolveDefaultValue(options.defaultValue)
      state.value = normalizeCachedJsonValue(parsed, options)
    } catch {
      state.value = defaultCachedJsonValue(options)
      await writeJsonFileAsync(options.filePath, state.value)
    }
    return state.value
  })()

  return state.initPromise
}

export function getCoreCachedJsonFile<T>(
  state: CoreCachedJsonState<T>,
  options: CoreCachedJsonFileOptions<T>,
): T {
  if (state.value !== null) {
    return state.value
  }

  const fallback = resolveDefaultValue(options.defaultValue)
  state.value = normalizeCachedJsonValue(readJsonFile(options.filePath, fallback), options)
  return state.value
}

export async function saveCoreCachedJsonFileAsync<T>(
  state: CoreCachedJsonState<T>,
  options: CoreCachedJsonFileOptions<T>,
  value: T,
): Promise<T> {
  const normalized = normalizeCachedJsonValue(value, options)
  await writeJsonFileAsync(options.filePath, normalized)
  state.value = normalized
  return normalized
}

export function saveCoreCachedJsonFile<T>(
  state: CoreCachedJsonState<T>,
  options: CoreCachedJsonFileOptions<T>,
  value: T,
): T {
  const normalized = normalizeCachedJsonValue(value, options)
  writeJsonFile(options.filePath, normalized)
  state.value = normalized
  return normalized
}

export function invalidateCoreCachedJsonFile<T>(state: CoreCachedJsonState<T>): void {
  state.value = null
  state.initPromise = null
}

export function updateCoreCachedJsonInMemory<T>(
  state: CoreCachedJsonState<T>,
  value: T,
): void {
  state.value = value
}
