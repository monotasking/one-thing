import * as path from 'path'

const ALLOWED_ENV_TEMPLATE_SUFFIXES = [
  '.example',
  '.sample',
  '.template',
  '.local.example',
  '.local.sample',
]

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '.netrc',
])

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
])

export type SensitiveFileCategory = 'env' | 'ssh' | 'cloud' | 'token' | 'certificate'

export interface SensitiveFileClassification {
  sensitive: boolean
  category?: SensitiveFileCategory
  reason?: string
}

function isAllowedEnvTemplate(base: string): boolean {
  if (!base.startsWith('.env')) return false
  return ALLOWED_ENV_TEMPLATE_SUFFIXES.some(suffix => base.endsWith(suffix))
}

export function classifySensitiveFile(filePath: string): SensitiveFileClassification {
  const normalized = filePath.replace(/\\/g, '/')
  const lowerPath = normalized.toLowerCase()
  const base = path.basename(filePath)
  const lowerBase = base.toLowerCase()

  if (isAllowedEnvTemplate(lowerBase)) {
    return { sensitive: false }
  }

  if (SENSITIVE_BASENAMES.has(lowerBase) || lowerBase.startsWith('.env.')) {
    return { sensitive: true, category: 'env', reason: 'Environment/config secret file' }
  }

  if (lowerPath.includes('/.ssh/id_') || lowerPath.endsWith('/.ssh/config')) {
    return { sensitive: true, category: 'ssh', reason: 'SSH key or SSH configuration file' }
  }

  if (lowerPath.endsWith('/.aws/credentials') || lowerPath.endsWith('/.aws/config')) {
    return { sensitive: true, category: 'cloud', reason: 'AWS credential/configuration file' }
  }

  if (lowerPath.endsWith('/.kube/config')) {
    return { sensitive: true, category: 'cloud', reason: 'Kubernetes credential/configuration file' }
  }

  if (
    lowerBase.includes('credentials') && lowerBase.endsWith('.json') ||
    lowerBase.includes('service-account') && lowerBase.endsWith('.json')
  ) {
    return { sensitive: true, category: 'cloud', reason: 'Cloud credential JSON file' }
  }

  if (lowerBase.endsWith('.secret') || lowerBase.includes('token')) {
    return { sensitive: true, category: 'token', reason: 'Token or secret file' }
  }

  if (SENSITIVE_EXTENSIONS.has(path.extname(lowerBase))) {
    return { sensitive: true, category: 'certificate', reason: 'Private key or certificate file' }
  }

  return { sensitive: false }
}
