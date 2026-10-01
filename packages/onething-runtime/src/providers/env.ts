import { getProviderManifest } from './manifest.js'

export interface OnethingProviderApiKeyConfig {
  apiKey?: string
}

export interface OnethingProviderEnvVarCandidate {
  name: string
  isSet: boolean
}

export interface OnethingProviderEnvStatus {
  providerId: string
  detectedEnvVar?: string
  resolvedEnvVar?: string
  keyPreview?: string
  candidates: OnethingProviderEnvVarCandidate[]
}

export type OnethingProviderEnv = Record<string, string | undefined>

const DEFAULT_PROVIDER_API_KEY_ENV_VARS: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
}

function normalizeEnvVarName(value: string | undefined): string | undefined {
  const name = value?.trim()
  if (!name) return undefined
  return name
}

function normalizeApiKey(value: string | undefined): string | undefined {
  let key = value?.trim()
  if (!key) return undefined
  key = key.replace(/^Authorization\s*:\s*/i, '').trim()
  key = key.replace(/^Bearer\s+/i, '').trim()
  if (!key) return undefined
  return key
}

function providerIdToEnvPrefix(providerId: string): string | undefined {
  const normalized = providerId
    .trim()
    .replace(/^custom-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()

  return normalized || undefined
}

function dedupeEnvVars(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const name = normalizeEnvVarName(value)
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }

  return result
}

export function getOnethingProviderApiKeyEnvCandidates(
  providerId: string,
): string[] {
  const prefix = providerIdToEnvPrefix(providerId)
  return dedupeEnvVars([
    ...(getProviderManifest(providerId)?.envVars ?? DEFAULT_PROVIDER_API_KEY_ENV_VARS[providerId] ?? []),
    prefix ? `${prefix}_API_KEY` : undefined,
  ])
}

function defaultEnv(): OnethingProviderEnv {
  return typeof process === 'undefined' ? {} : process.env
}

function readEnvApiKey(envVar: string | undefined, env: OnethingProviderEnv): string | undefined {
  const name = normalizeEnvVarName(envVar)
  if (!name) return undefined
  return normalizeApiKey(env[name])
}

function previewApiKey(apiKey: string | undefined): string | undefined {
  const key = normalizeApiKey(apiKey)
  if (!key) return undefined
  const head = key.slice(0, Math.min(6, key.length))
  const tail = key.length > 10 ? key.slice(-4) : ''
  return tail ? `${head}••••${tail}` : `${head}••••`
}

function findSetEnvVar(
  providerId: string,
  env: OnethingProviderEnv,
): { envVar: string; apiKey: string } | undefined {
  for (const envVar of getOnethingProviderApiKeyEnvCandidates(providerId)) {
    const apiKey = readEnvApiKey(envVar, env)
    if (apiKey) return { envVar, apiKey }
  }
  return undefined
}

export function resolveOnethingProviderApiKey(
  providerId: string,
  config: OnethingProviderApiKeyConfig | undefined,
  env: OnethingProviderEnv = defaultEnv(),
): string | null {
  const manualKey = normalizeApiKey(config?.apiKey)
  if (manualKey) return manualKey

  return findSetEnvVar(providerId, env)?.apiKey ?? null
}

export function withResolvedOnethingProviderApiKey<T extends OnethingProviderApiKeyConfig>(
  providerId: string,
  config: T,
  env: OnethingProviderEnv = defaultEnv(),
): T {
  const apiKey = resolveOnethingProviderApiKey(providerId, config, env)
  return apiKey ? { ...config, apiKey } : config
}

export function getOnethingProviderEnvStatus(
  providerId: string,
  env: OnethingProviderEnv = defaultEnv(),
): OnethingProviderEnvStatus {
  const candidates: OnethingProviderEnvVarCandidate[] = getOnethingProviderApiKeyEnvCandidates(providerId)
    .map((name) => ({
      name,
      isSet: Boolean(readEnvApiKey(name, env)),
    }))
  const detectedEnvVar = candidates.find(candidate => candidate.isSet)?.name
  const keyPreview = previewApiKey(readEnvApiKey(detectedEnvVar, env))

  return {
    providerId,
    ...(detectedEnvVar ? { detectedEnvVar } : {}),
    ...(detectedEnvVar ? { resolvedEnvVar: detectedEnvVar } : {}),
    ...(keyPreview ? { keyPreview } : {}),
    candidates,
  }
}
