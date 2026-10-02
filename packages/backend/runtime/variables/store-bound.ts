import { VariablesStore } from './index.js'
import { loadFromDisk, saveToDisk } from './store-persistence.js'
import type { VariablesStorePersistence } from './store.js'

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
