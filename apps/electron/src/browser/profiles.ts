/**
 * Browser profiles — Chrome-style separate logins for the embedded browser.
 * Each profile is an isolated persistent partition (its own cookies/localStorage),
 * so you can be logged into a different Google account per profile. The profile
 * list + active selection is the main process's source of truth, persisted to
 * `<store>/browser/profiles.json`. Renderer (settings) mirrors it over IPC.
 *
 * The `default` profile maps to the original `persist:browser` partition so
 * existing logins survive this feature landing.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOnethingStorePath } from '@onething/runtime/storage'
import { BROWSER_PARTITION } from './session.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('browser')

export interface BrowserProfile {
	id: string
	name: string
}

export const DEFAULT_PROFILE_ID = 'default'

interface ProfilesState {
	profiles: BrowserProfile[]
	activeProfileId: string
}

let state: ProfilesState | null = null

function profilesFile(): string {
	return join(getOnethingStorePath(), 'browser', 'profiles.json')
}

function defaultState(): ProfilesState {
	return {
		profiles: [{ id: DEFAULT_PROFILE_ID, name: '默认' }],
		activeProfileId: DEFAULT_PROFILE_ID,
	}
}

function load(): ProfilesState {
	if (state) return state
	try {
		const parsed = JSON.parse(readFileSync(profilesFile(), 'utf-8')) as Partial<ProfilesState>
		const profiles = Array.isArray(parsed.profiles)
			? parsed.profiles.filter(
					(p): p is BrowserProfile =>
						!!p && typeof p.id === 'string' && typeof p.name === 'string',
				)
			: []
		// Always guarantee the default profile exists and sits first.
		if (!profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) {
			profiles.unshift({ id: DEFAULT_PROFILE_ID, name: '默认' })
		}
		const activeProfileId =
			typeof parsed.activeProfileId === 'string' &&
			profiles.some((p) => p.id === parsed.activeProfileId)
				? parsed.activeProfileId
				: DEFAULT_PROFILE_ID
		state = { profiles, activeProfileId }
	} catch {
		state = defaultState()
	}
	return state
}

function save(): void {
	if (!state) return
	try {
		const file = profilesFile()
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, JSON.stringify(state, null, 2))
	} catch (err) {
		log.error('persist browser profiles failed', undefined, err)
	}
}

/** The persistent partition backing a profile (default → the legacy partition). */
export function partitionForProfile(profileId: string): string {
	return profileId === DEFAULT_PROFILE_ID ? BROWSER_PARTITION : `persist:browser-${profileId}`
}

export function listProfiles(): { profiles: BrowserProfile[]; activeProfileId: string } {
	const s = load()
	return { profiles: [...s.profiles], activeProfileId: s.activeProfileId }
}

export function getActiveProfileId(): string {
	return load().activeProfileId
}

export function addProfile(name: string): BrowserProfile {
	const s = load()
	const profile: BrowserProfile = { id: randomUUID(), name: name.trim() || '新配置' }
	s.profiles.push(profile)
	save()
	return profile
}

export function renameProfile(id: string, name: string): void {
	const s = load()
	const profile = s.profiles.find((p) => p.id === id)
	if (profile) {
		profile.name = name.trim() || profile.name
		save()
	}
}

/**
 * Remove a profile. The default profile is never removable. When the active
 * profile is removed the caller must switch away first; here we just fall the
 * selection back to default. Returns the (possibly changed) active profile id.
 */
export function removeProfile(id: string): string {
	const s = load()
	if (id === DEFAULT_PROFILE_ID) return s.activeProfileId
	s.profiles = s.profiles.filter((p) => p.id !== id)
	if (s.activeProfileId === id) s.activeProfileId = DEFAULT_PROFILE_ID
	save()
	return s.activeProfileId
}

/** Set the active profile. Returns false when the id is unknown. */
export function setActiveProfile(id: string): boolean {
	const s = load()
	if (!s.profiles.some((p) => p.id === id)) return false
	s.activeProfileId = id
	save()
	return true
}

/** Test seam. */
export function resetProfilesForTests(): void {
	state = null
}
