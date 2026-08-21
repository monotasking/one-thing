/**
 * Browser search-engine selection — which engine the omnibox searches with and
 * whose homepage a fresh tab opens on. The main process is the source of truth
 * (same idiom as profiles.ts), persisted to `<store>/browser/search-engine.json`;
 * the renderer reads it over IPC per use, so there is no mirror to go stale
 * across windows. The engine table itself lives in @shared/ipc (browser.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOnethingStorePath } from '@onething/runtime/storage'
import {
	BROWSER_SEARCH_ENGINES,
	DEFAULT_BROWSER_SEARCH_ENGINE_ID,
	type BrowserSearchEngineId,
} from '@shared/ipc.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('browser')

let cached: BrowserSearchEngineId | null = null

function searchEngineFile(): string {
	return join(getOnethingStorePath(), 'browser', 'search-engine.json')
}

function isKnownEngineId(id: unknown): id is BrowserSearchEngineId {
	return BROWSER_SEARCH_ENGINES.some((engine) => engine.id === id)
}

export function getSearchEngineId(): BrowserSearchEngineId {
	if (cached !== null) return cached
	try {
		const parsed = JSON.parse(readFileSync(searchEngineFile(), 'utf-8')) as {
			engineId?: unknown
		}
		cached = isKnownEngineId(parsed.engineId) ? parsed.engineId : DEFAULT_BROWSER_SEARCH_ENGINE_ID
	} catch {
		cached = DEFAULT_BROWSER_SEARCH_ENGINE_ID
	}
	return cached
}

/** Persist the selection. Unknown ids are rejected (returns false, keeps current). */
export function setSearchEngineId(id: string): boolean {
	if (!isKnownEngineId(id)) return false
	cached = id
	try {
		const file = searchEngineFile()
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, JSON.stringify({ engineId: id }, null, 2))
	} catch (err) {
		log.error('persist search engine failed', undefined, err)
	}
	return true
}

/** Test seam. */
export function resetSearchEngineForTests(): void {
	cached = null
}
