/**
 * Synchronous JSON I/O for `variables.json`.
 *
 * Mutations are infrequent (user/AI-driven, seconds apart at most),
 * so we write directly without throttling. Settings.json uses the
 * same pattern. Direct writes mean no `flush()` ceremony at shutdown
 * and no risk of losing the last edit.
 */

import {
  getOnethingVariablesPath,
  readJsonFile,
  writeJsonFile,
} from '../storage/index.js'
import {
  createDefaultVariablesFile,
  parseVariablesFile,
  type VariablesFile,
} from './schema.js'

export function loadFromDisk(): VariablesFile {
  const fallback = createDefaultVariablesFile()
  const raw = readJsonFile<unknown>(getOnethingVariablesPath(), fallback)
  return parseVariablesFile(raw).data
}

export function saveToDisk(state: VariablesFile): void {
  writeJsonFile(getOnethingVariablesPath(), state)
}
