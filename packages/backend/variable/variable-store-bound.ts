import { VariablesStore } from './variable.js'
import { loadFromDisk, saveToDisk } from './variable-store-persistence.js'
import type { VariablesStorePersistence } from './variable-store.js'

let singleton: VariablesStore | null = null

export function getVariablesStore(): VariablesStore {
  if (!singleton) {
    const variablesStorePersistence: VariablesStorePersistence = { loadFromDisk, saveToDisk };
    singleton = new VariablesStore(variablesStorePersistence)
  }
  return singleton
}

export function resetVariablesStoreForTests(): VariablesStore {
  const variablesStorePersistence2: VariablesStorePersistence = { loadFromDisk, saveToDisk };
  singleton = new VariablesStore(variablesStorePersistence2)
  return singleton
}
