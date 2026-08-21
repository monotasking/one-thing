import { VariablesStore } from './index.js'
import { loadFromDisk, saveToDisk } from './store-persistence.js'

let singleton: VariablesStore | null = null

export function getVariablesStore(): VariablesStore {
  if (!singleton) {
    singleton = new VariablesStore({ loadFromDisk, saveToDisk })
  }
  return singleton
}

export function resetVariablesStoreForTests(): VariablesStore {
  singleton = new VariablesStore({ loadFromDisk, saveToDisk })
  return singleton
}
