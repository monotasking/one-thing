/**
 * Onething Skills Loader
 *
 * Loads Hermes-style skills from filesystem:
 * - Runtime skills: ~/.onething/skills/
 * - Project skills: .onething/skills/
 * - Plugin-provided skill roots
 *
 * Each skill is a directory containing:
 * - SKILL.md (required) - Markdown file with YAML frontmatter
 * - Additional files (optional) - references, templates, scripts, assets
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { parse as parseYaml } from 'yaml'
import { getLogger } from '../logging/index.js'
import type {
  PluginSkillRoot,
  SkillConditions,
  SkillDefinition,
  SkillDirectoryConfig,
  SkillFile,
  SkillSource,
} from './types.js'

const log = getLogger('skills')

interface SkillFrontmatter {
  name: string
  description: string
  'allowed-tools'?: string[]
  platforms?: string[]
  'disable-model-invocation'?: boolean
  /** 默认关闭的 skill:用户在 设置 → Skills 打开前不进回合(也不带进它的场景工具)。 */
  'default-enabled'?: boolean
  tags?: string[] | string
  related_skills?: string[] | string
  metadata?: Record<string, unknown>
  prerequisites?: Record<string, unknown>
  required_environment_variables?: unknown
}

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const ONETHING_SKILLS_CONFIG_FILENAME = 'skills.yaml'

export interface OnethingSkillsLoaderAdapters {
  getStorePath(): string
  listPluginSkillRoots?(): PluginSkillRoot[]
  /** User-managed skill roots (settings.skills.customDirectories) */
  listCustomSkillRoots?(): SkillDirectoryConfig[]
  isPackaged?(): boolean
  getResourcesPath?(): string | undefined
  getCwd?(): string
  /**
   * Veto for builtin skill directories (by basename). Used to expose only the
   * ACTIVE music provider's CLI skill: every provider ships one, and prose
   * for an absent CLI would only teach the model commands that cannot run.
   * Absent adapter (or true) = keep, so non-music skills are unaffected.
   */
  isBuiltinSkillDirEnabled?(dirName: string): boolean
}

let configuredAdapters: OnethingSkillsLoaderAdapters | undefined

export function configureOnethingSkillsLoaderRuntime(adapters: OnethingSkillsLoaderAdapters | undefined): void {
  configuredAdapters = adapters
}

function getSkillsLoaderAdapters(): OnethingSkillsLoaderAdapters {
  if (!configuredAdapters) {
    throw new Error('Skills loader runtime adapters are not configured')
  }
  return configuredAdapters
}

function getCurrentWorkingDirectory(): string {
  return configuredAdapters?.getCwd?.() ?? process.cwd()
}

function getRuntimeResourcesPath(): string | undefined {
  return configuredAdapters?.getResourcesPath?.()
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function logLoadedSkillRoot(label: string, rootPath: string, skills: SkillDefinition[]): void {
  log.debug('skill root loaded', { label, rootPath, count: skills.length, names: skills.map(s => s.name) })
}

/**
 * Parse YAML frontmatter from SKILL.md content
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter | null; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { frontmatter: null, body: content }
  }

  const yamlContent = match[1]
  const body = match[2]

  try {
    const parsed = parseYaml(yamlContent) as Record<string, unknown> | null
    if (parsed && typeof parsed === 'object') {
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      const description = typeof parsed.description === 'string' ? parsed.description : ''
      const allowed = parsed['allowed-tools']
      const allowedTools = Array.isArray(allowed)
        ? allowed.filter((item): item is string => typeof item === 'string')
        : undefined
      const platforms = normalizeStringList(parsed.platforms)
      return {
        frontmatter: {
          name,
          description,
          ...(allowedTools ? { 'allowed-tools': allowedTools } : {}),
          ...(platforms.length ? { platforms } : {}),
          ...(parsed['disable-model-invocation'] !== undefined
            ? { 'disable-model-invocation': isTruthyFrontmatterValue(parsed['disable-model-invocation']) }
            : {}),
          ...(parsed['default-enabled'] !== undefined
            ? { 'default-enabled': isTruthyFrontmatterValue(parsed['default-enabled']) }
            : {}),
          ...(parsed.tags !== undefined ? { tags: parsed.tags as string[] | string } : {}),
          ...(parsed.related_skills !== undefined ? { related_skills: parsed.related_skills as string[] | string } : {}),
          ...(parsed.metadata && typeof parsed.metadata === 'object' ? { metadata: parsed.metadata as Record<string, unknown> } : {}),
          ...(parsed.prerequisites && typeof parsed.prerequisites === 'object' ? { prerequisites: parsed.prerequisites as Record<string, unknown> } : {}),
          ...(parsed.required_environment_variables !== undefined ? { required_environment_variables: parsed.required_environment_variables } : {}),
        },
        body,
      }
    }
  } catch (error) {
    log.warn('yaml frontmatter parse failed, falling back to simple parser', undefined, error)
  }

  // Simple YAML parsing for our specific use case
  const frontmatter: Partial<SkillFrontmatter> = {}

  const lines = yamlContent.split('\n')
  let currentKey: string | null = null
  let arrayValue: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Check for array item
    if (trimmed.startsWith('- ') && currentKey === 'allowed-tools') {
      arrayValue.push(trimmed.slice(2).trim())
      continue
    }

    // Check for key-value pair
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      // Save previous array if exists
      if (currentKey === 'allowed-tools' && arrayValue.length > 0) {
        frontmatter['allowed-tools'] = arrayValue
        arrayValue = []
      }

      const key = trimmed.slice(0, colonIndex).trim()
      let value = trimmed.slice(colonIndex + 1).trim()

      // Handle inline array: allowed-tools: [Read, Write, Bash]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1)
        frontmatter[key as keyof SkillFrontmatter] = value.split(',').map(s => s.trim()) as any
        currentKey = null
        continue
      }

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      if (value) {
        if (key === 'disable-model-invocation') {
          frontmatter['disable-model-invocation'] = isTruthyFrontmatterValue(value)
        } else if (key === 'default-enabled') {
          frontmatter['default-enabled'] = isTruthyFrontmatterValue(value)
        } else {
          frontmatter[key as keyof SkillFrontmatter] = value as any
        }
        currentKey = null
      } else {
        // Empty value might mean array follows
        currentKey = key
        arrayValue = []
      }
    }
  }

  // Save final array if exists
  if (currentKey === 'allowed-tools' && arrayValue.length > 0) {
    frontmatter['allowed-tools'] = arrayValue
  }

  return {
    frontmatter: frontmatter as SkillFrontmatter,
    body
  }
}

function normalizeStringList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean)
  }
  const text = String(value).trim()
  if (!text) return []
  const unwrapped = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  return unwrapped.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function isTruthyFrontmatterValue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function parseHermesMetadata(frontmatter: SkillFrontmatter): Record<string, unknown> {
  const metadata = frontmatter.metadata
  if (!metadata || typeof metadata !== 'object') return {}
  const hermes = metadata.hermes
  return hermes && typeof hermes === 'object' && !Array.isArray(hermes)
    ? hermes as Record<string, unknown>
    : {}
}

function getHermesTags(frontmatter: SkillFrontmatter): string[] {
  const hermes = parseHermesMetadata(frontmatter)
  return normalizeStringList(hermes.tags ?? frontmatter.tags)
}

function getRelatedSkills(frontmatter: SkillFrontmatter): string[] {
  const hermes = parseHermesMetadata(frontmatter)
  return normalizeStringList(hermes.related_skills ?? frontmatter.related_skills)
}

function getSkillConditions(frontmatter: SkillFrontmatter): SkillConditions {
  const hermes = parseHermesMetadata(frontmatter)
  return {
    fallbackForToolsets: normalizeStringList(hermes.fallback_for_toolsets),
    requiresToolsets: normalizeStringList(hermes.requires_toolsets),
    fallbackForTools: normalizeStringList(hermes.fallback_for_tools),
    requiresTools: normalizeStringList(hermes.requires_tools),
  }
}

function nonEmptyConditions(conditions: SkillConditions): SkillConditions | undefined {
  const filtered: SkillConditions = {}
  if (conditions.fallbackForToolsets?.length) filtered.fallbackForToolsets = conditions.fallbackForToolsets
  if (conditions.requiresToolsets?.length) filtered.requiresToolsets = conditions.requiresToolsets
  if (conditions.fallbackForTools?.length) filtered.fallbackForTools = conditions.fallbackForTools
  if (conditions.requiresTools?.length) filtered.requiresTools = conditions.requiresTools
  return Object.keys(filtered).length ? filtered : undefined
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function realPathKey(candidate: string): string {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

function isSamePath(a: string, b: string): boolean {
  return realPathKey(a) === realPathKey(b)
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join('/')
}

function getSkillCategory(skillDir: string, rootDir?: string): string | undefined {
  if (!rootDir) return undefined
  const relativeDir = path.relative(path.resolve(rootDir), path.resolve(skillDir))
  if (!relativeDir || relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return undefined
  const parent = path.dirname(relativeDir)
  return parent && parent !== '.' ? toPosixPath(parent) : undefined
}

function getRelativeSkillPath(skillMdPath: string, rootDir?: string): string | undefined {
  if (!rootDir) return undefined
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(skillMdPath))
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined
  return toPosixPath(relativePath)
}

function currentPlatformAliases(): Set<string> {
  switch (process.platform) {
    case 'darwin':
      return new Set(['darwin', 'macos', 'mac', 'osx'])
    case 'win32':
      return new Set(['win32', 'windows', 'win'])
    default:
      return new Set(['linux', process.platform])
  }
}

function isPlatformSupported(platforms: string[] | undefined): boolean {
  if (!platforms?.length) return true
  const aliases = currentPlatformAliases()
  return platforms.some(platform => {
    const normalized = platform.trim().toLowerCase()
    return normalized === '*' || normalized === 'all' || normalized === 'any' || aliases.has(normalized)
  })
}

/**
 * Get the app-owned home directory path.
 *
 * Keep the historical export name for compatibility with callers, but never
 * default to another agent's home directory.
 */
export function getHermesHome(): string {
  return getSkillsLoaderAdapters().getStorePath()
}

/**
 * Get the app-owned skills config file path.
 */
export function getHermesConfigPath(): string {
  return path.join(getHermesHome(), ONETHING_SKILLS_CONFIG_FILENAME)
}

/**
 * Get the user skills directory path
 */
export function getUserSkillsPath(): string {
  return path.join(getHermesHome(), 'skills')
}

/**
 * Get the project skills directory path (single directory, no traversal)
 */
export function getProjectSkillsPath(cwd?: string): string {
  const workingDir = cwd || getCurrentWorkingDirectory()
  return path.join(workingDir, '.onething', 'skills')
}


/**
 * Get the builtin skills directory path
 * Handles both development and production environments
 */
export function getBuiltinSkillsPath(): string {
  // In production, resources are in process.resourcesPath
  // In development, resources are in the project root
  const isDev = !configuredAdapters?.isPackaged?.()

  if (isDev) {
    // Development: use process.cwd() which is the project root when using electron-vite
    return path.join(getCurrentWorkingDirectory(), 'resources', 'skills')
  }

  // Production: resources are copied to app.asar.unpacked or extraResources
  return path.join(getRuntimeResourcesPath() ?? getCurrentWorkingDirectory(), 'skills')
}

/**
 * Traverse upward from a directory to find project skill roots.
 * Only app-owned `.onething/skills` roots are considered.
 *
 * @param startDir - Directory to start traversal from
 * @param stopAt - Optional directory to stop at (e.g., home directory)
 * @returns Array of skill root paths found (closest first)
 */
export function findProjectSkillPaths(startDir: string, stopAt?: string): string[] {
  const skillsPaths: string[] = []
  const seen = new Set<string>()
  const homeDir = os.homedir()
  const stopDirectory = stopAt || homeDir

  let currentDir = path.resolve(startDir)
  const visitedDirs = new Set<string>()

  while (currentDir && !visitedDirs.has(currentDir)) {
    visitedDirs.add(currentDir)

    for (const skillsPath of [
      path.join(currentDir, '.onething', 'skills'),
    ]) {
      if (!isExistingDirectory(skillsPath)) continue
      const key = realPathKey(skillsPath)
      if (seen.has(key)) continue
      seen.add(key)
      skillsPaths.push(skillsPath)
    }

    // Stop if we've reached the stop directory or root
    if (currentDir === stopDirectory || currentDir === path.dirname(currentDir)) {
      break
    }

    // Move up one directory
    currentDir = path.dirname(currentDir)
  }

  return skillsPaths
}

/**
 * Legacy extension point retained for API compatibility.
 * Runtime loading now uses app-owned roots only.
 */
export function getEnvSkillsPath(): string | null {
  return null
}

/**
 * Legacy extension point retained for API compatibility.
 * Runtime loading now uses app-owned roots only.
 */
export function getExternalSkillsPaths(): string[] {
  return []
}

/**
 * Determine file type based on extension and location
 */
function getFileType(fileName: string, filePath: string): SkillFile['type'] {
  const ext = path.extname(fileName).toLowerCase()
  const normalizedPath = toPosixPath(filePath)

  if (ext === '.md') return 'markdown'
  if (['.py', '.js', '.ts', '.sh', '.bash'].includes(ext)) return 'script'
  if (normalizedPath.includes('/templates/') || fileName.includes('template')) return 'template'

  return 'other'
}

/**
 * Directories to exclude when scanning skill files
 * These are common directories that shouldn't be included in skill context
 */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.github',
  '.hub',
  '.archive',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  'site-packages',
  '.env',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.nyc_output',
])

/**
 * Files to exclude when scanning skill files
 */
const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.npmignore',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
])

/**
 * Scan a skill directory for additional files
 * Excludes common directories like node_modules, .git, etc.
 */
function scanSkillFiles(skillDir: string): SkillFile[] {
  const files: SkillFile[] = []

  function scanDir(dir: string, relativePath: string = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (EXCLUDED_DIRECTORIES.has(entry.name)) {
            continue
          }
          if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
            continue
          }
          scanDir(fullPath, relPath)
        } else if (entry.isFile() && entry.name !== 'SKILL.md') {
          // Skip excluded files
          if (EXCLUDED_FILES.has(entry.name)) {
            continue
          }
          files.push({
            name: relPath,
            path: fullPath,
            type: getFileType(entry.name, fullPath)
          })
        }
      }
    } catch (error) {
      // Directory might not exist or be readable
    }
  }

  scanDir(skillDir)
  return files
}

/**
 * Load a single skill from a directory
 */
function skillIdFor(source: SkillSource, name: string, skillDir: string, ownerId?: string, rootDir?: string): string {
  const relativeKey = rootDir
    ? toPosixPath(path.relative(path.resolve(rootDir), path.resolve(skillDir)))
    : ''
  const key = relativeKey && !relativeKey.startsWith('..') && !path.isAbsolute(relativeKey)
    ? relativeKey
    : name
  // Custom roots are keyed by their directory config id so ids stay stable
  // across path edits and never collide between roots.
  if (source === 'custom') {
    return ownerId ? `custom:${ownerId}:${key || name}` : `custom:${key || name}`
  }
  if (source !== 'plugin') return `${source}:${key || name}`
  const hash = crypto.createHash('sha1').update(path.resolve(skillDir)).digest('hex').slice(0, 10)
  return ownerId ? `plugin:${ownerId}:${hash}:${key || name}` : `plugin:${hash}:${key || name}`
}

function loadSkillFromDirectory(
  skillDir: string,
  source: SkillSource,
  options: {
    ownerId?: string
    rootDir?: string
    instructionContext?: PluginSkillRoot['instructionContext']
  } = {},
): SkillDefinition | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md')

  // Check if SKILL.md exists
  if (!fs.existsSync(skillMdPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)

    if (!frontmatter || !frontmatter.name || !frontmatter.description) {
      log.warn('skill frontmatter missing required fields', { skillDir })
      return null
    }

    const name = frontmatter.name.trim()
    const description = frontmatter.description.trim()
    const platforms = normalizeStringList(frontmatter.platforms)

    // Validate name format
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      log.debug('skill name not in recommended format', { name, skillDir })
    }
    if (name.length > MAX_NAME_LENGTH) {
      log.warn('skill name too long', { name, maxLength: MAX_NAME_LENGTH })
      return null
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      log.warn('skill description truncated', { name, maxLength: MAX_DESCRIPTION_LENGTH })
    }
    if (!isPlatformSupported(platforms)) {
      return null
    }

    // Scan for additional files
    const files = scanSkillFiles(skillDir)
    const tags = getHermesTags(frontmatter)
    const relatedSkills = getRelatedSkills(frontmatter)
    const rootDir = options.rootDir ? path.resolve(options.rootDir) : undefined
    const conditions = nonEmptyConditions(getSkillConditions(frontmatter))
    const runtimeContext = options.instructionContext?.({
      skillDir,
      skillPath: skillMdPath,
      rootDir: rootDir ?? skillDir,
    })?.trim()
    const instructions = [
      body.trim(),
      runtimeContext,
    ].filter(Boolean).join('\n\n')

    const skill: SkillDefinition = {
      id: skillIdFor(source, name, skillDir, options.ownerId, rootDir),
      name,
      description: description.slice(0, MAX_DESCRIPTION_LENGTH),
      allowedTools: frontmatter['allowed-tools'],
      category: getSkillCategory(skillDir, rootDir),
      tags: tags.length ? tags : undefined,
      relatedSkills: relatedSkills.length ? relatedSkills : undefined,
      platforms: platforms.length ? platforms : undefined,
      conditions,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      source,
      path: skillMdPath,
      directoryPath: skillDir,
      rootPath: rootDir,
      relativePath: getRelativeSkillPath(skillMdPath, rootDir),
      enabled: frontmatter['default-enabled'] !== false,
      instructions,
      runtimeContext: runtimeContext || undefined,
      files: files.length > 0 ? files : undefined
    }

    return skill
  } catch (error) {
    log.error('skill load failed', { skillDir }, error)
    return null
  }
}

/**
 * Load all skills from a directory
 */
function isDirectoryEntry(entryPath: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return fs.statSync(entryPath).isDirectory()
  } catch {
    return false
  }
}

function loadSkillsFromPath(
  skillsDir: string,
  source: SkillSource,
  options: {
    recursive?: boolean
    ownerId?: string
    instructionContext?: PluginSkillRoot['instructionContext']
  } = {},
): SkillDefinition[] {
  const skills: SkillDefinition[] = []

  if (!isExistingDirectory(skillsDir)) {
    return skills
  }

  const rootDir = path.resolve(skillsDir)
  const rootSkill = loadSkillFromDirectory(skillsDir, source, {
    ownerId: options.ownerId,
    rootDir,
    instructionContext: options.instructionContext,
  })
  if (rootSkill) return [rootSkill]
  const shouldRecurse = options.recursive ?? true

  const visited = new Set<string>()

  function scan(containerDir: string): void {
    let resolved: string
    try {
      resolved = fs.realpathSync(containerDir)
    } catch {
      resolved = path.resolve(containerDir)
    }
    if (visited.has(resolved)) return
    visited.add(resolved)

    try {
      const entries = fs.readdirSync(containerDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(containerDir, entry.name)
        if (!isDirectoryEntry(fullPath, entry)) continue
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue

        const skill = loadSkillFromDirectory(fullPath, source, {
          ownerId: options.ownerId,
          rootDir,
          instructionContext: options.instructionContext,
        })
        if (skill) {
          skills.push(skill)
          continue
        }

        if (shouldRecurse) {
          scan(fullPath)
        }
      }
    } catch (error) {
      log.error('skill directory scan failed', { containerDir }, error)
    }
  }

  scan(skillsDir)

  return skills
}

/**
 * Load builtin skills from app resources
 */
function loadBuiltinSkills(): SkillDefinition[] {
  const builtinPath = getBuiltinSkillsPath()

  if (!fs.existsSync(builtinPath)) {
    log.info('builtin skills path missing', { builtinPath })
    return []
  }

  const loaded = loadSkillsFromPath(builtinPath, 'builtin', { recursive: true })
  const veto = configuredAdapters?.isBuiltinSkillDirEnabled
  const skills = veto
    ? loaded.filter(skill => veto(path.basename(skill.directoryPath)) !== false)
    : loaded
  logLoadedSkillRoot('Builtin skills path', builtinPath, skills)

  return skills
}

function loadPluginRootSkills(root: PluginSkillRoot): SkillDefinition[] {
  const source = root.source ?? 'plugin'
  const skills = loadSkillsFromPath(root.path, source, {
    recursive: root.recursive ?? true,
    ownerId: root.pluginId,
    instructionContext: root.instructionContext,
  })
  logLoadedSkillRoot(`Plugin root (${root.pluginId}) path`, root.path, skills)
  return skills
}

/**
 * Load skills from user-managed custom roots. Skills inherit the root's
 * agent binding so they can be scoped to a single agent.
 */
function loadCustomRootSkills(): SkillDefinition[] {
  const roots = configuredAdapters?.listCustomSkillRoots?.() ?? []
  const skills: SkillDefinition[] = []

  for (const root of roots) {
    if (root.enabled === false) continue
    if (!root.path || !isExistingDirectory(root.path)) {
      log.warn('custom skills root unreadable', { rootPath: root.path })
      continue
    }
    const rootSkills = loadSkillsFromPath(root.path, 'custom', {
      recursive: true,
      ownerId: root.id,
    })
    for (const skill of rootSkills) {
      skills.push(root.agentId ? { ...skill, agentId: root.agentId } : skill)
    }
    logLoadedSkillRoot(`Custom root (${root.label || root.id}) path`, root.path, rootSkills)
  }

  return skills
}

function loadProjectSkillsForDirectoryWithPaths(
  workingDirectory: string,
  userSkillsPath = getUserSkillsPath(),
): { projectSkills: SkillDefinition[]; projectSkillPaths: string[] } {
  const projectSkills: SkillDefinition[] = []
  const allProjectSkillPaths = findProjectSkillPaths(workingDirectory)
  const projectSkillPaths = allProjectSkillPaths.filter(p => !isSamePath(p, userSkillsPath))

  log.debug('project skill roots resolved', {
    workingDirectory,
    count: projectSkillPaths.length,
    paths: projectSkillPaths,
    excludedUserPath: userSkillsPath,
  })

  const seenSkillIds = new Set<string>()
  for (const skillPath of projectSkillPaths) {
    const skills = loadSkillsFromPath(skillPath, 'project', { recursive: true })
    // Deduplicate: closer skills take precedence.
    for (const skill of skills) {
      if (!seenSkillIds.has(skill.id)) {
        seenSkillIds.add(skill.id)
        projectSkills.push(skill)
      }
    }
  }

  log.info('project skill directories found', { count: projectSkillPaths.length, workingDirectory })
  return { projectSkills, projectSkillPaths }
}

export function loadProjectSkillsForDirectory(workingDirectory: string): SkillDefinition[] {
  return loadProjectSkillsForDirectoryWithPaths(workingDirectory).projectSkills
}

/**
 * Load all skills from project, app-owned runtime, plugin, and builtin directories.
 * Uses upward traversal for project skills when workingDirectory is provided
 *
 * @param workingDirectory - Optional working directory for project skills (enables upward traversal)
 */
export function loadAllSkills(workingDirectory?: string): SkillDefinition[] {
  // Builtin skills are shipped with the app and have the lowest priority.
  const builtinSkills = loadBuiltinSkills()

  // Runtime user skills (~/.onething/skills).
  const userSkillsPath = getUserSkillsPath()
  const userSkills = loadSkillsFromPath(userSkillsPath, 'user', { recursive: true })
  logLoadedSkillRoot('User skills path', userSkillsPath, userSkills)

  // Project skills (with upward traversal if workingDirectory provided).
  const { projectSkills, projectSkillPaths } = workingDirectory
    ? loadProjectSkillsForDirectoryWithPaths(workingDirectory, userSkillsPath)
    : { projectSkills: [] as SkillDefinition[], projectSkillPaths: [] as string[] }

  // User-managed custom skill roots.
  const customSkills = loadCustomRootSkills()

  // Plugin-provided skill roots.
  const pluginSkills = (configuredAdapters?.listPluginSkillRoots?.() ?? []).flatMap(loadPluginRootSkills)

  // Priority: project > user > custom > plugin > builtin.
  // First matching name wins.
  const allSkills = [
    ...projectSkills,
    ...userSkills,
    ...customSkills,
    ...pluginSkills,
    ...builtinSkills,
  ]

  // Deduplicate by name (first one wins, so higher priority sources take precedence)
  const seenNames = new Set<string>()
  const dedupedSkills = allSkills.filter(skill => {
    if (seenNames.has(skill.name)) {
      return false
    }
    seenNames.add(skill.name)
    return true
  })

  log.info('skills loaded', {
    builtin: builtinSkills.length,
    user: userSkills.length,
    project: projectSkills.length,
    custom: customSkills.length,
    plugin: pluginSkills.length,
    total: dedupedSkills.length,
  })
  log.debug('skills deduped', { total: dedupedSkills.length, names: dedupedSkills.map(s => s.name) })

  return dedupedSkills
}

/**
 * Create a new skill
 */
export function createSkill(
  name: string,
  description: string,
  instructions: string,
  source: SkillSource
): SkillDefinition {
  // Validate name
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error('Skill name must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, and hyphens')
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Skill name must be ${MAX_NAME_LENGTH} characters or less`)
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Skill description must be ${MAX_DESCRIPTION_LENGTH} characters or less`)
  }

  if (source !== 'user' && source !== 'project') {
    throw new Error('Skills can only be created in user or project roots')
  }

  // Determine directory
  const skillsDir = source === 'user' ? getUserSkillsPath() : getProjectSkillsPath()
  const skillDir = path.join(skillsDir, name)

  // Check if already exists
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill "${name}" already exists in ${source} skills`)
  }

  // Create directory
  fs.mkdirSync(skillDir, { recursive: true })

  // Create SKILL.md content
  const skillMdContent = `---
name: ${JSON.stringify(name)}
description: ${JSON.stringify(description)}
---

${instructions}
`

  const skillMdPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillMdPath, skillMdContent, 'utf-8')

  const skill = loadSkillFromDirectory(skillDir, source, { rootDir: skillsDir })
  if (!skill) {
    throw new Error(`Failed to load created skill "${name}"`)
  }
  return skill
}

/**
 * Get skill directory based on source
 */
function getSkillsDirBySource(source: string): string {
  switch (source) {
    case 'user':
      return getUserSkillsPath()
    case 'project':
    default:
      return getProjectSkillsPath()
  }
}

function findLoadedSkillById(skillId: string): SkillDefinition | undefined {
  return loadAllSkills().find(skill => skill.id === skillId)
}

/**
 * Delete a skill
 */
export function deleteSkill(skillId: string): boolean {
  const skill = findLoadedSkillById(skillId)
  if (!skill || (skill.source !== 'user' && skill.source !== 'project')) {
    return false
  }

  const skillDir = skill.directoryPath

  if (!fs.existsSync(skillDir)) {
    return false
  }

  try {
    fs.rmSync(skillDir, { recursive: true })
    log.info('skill deleted', { skillId })
    return true
  } catch (error) {
    log.error('skill delete failed', { skillId }, error)
    return false
  }
}

/**
 * Read a file from a skill directory
 */
export function readSkillFile(skillId: string, fileName: string): string | null {
  const skill = findLoadedSkillById(skillId)
  if (!skill) return null

  // Security: ensure the path is within the skill directory
  const skillDir = skill.directoryPath
  const resolvedSkillDir = path.resolve(skillDir)
  const resolvedPath = path.resolve(resolvedSkillDir, fileName)
  const relativePath = path.relative(resolvedSkillDir, resolvedPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    log.error('skill file read outside skill directory rejected', { skillId, fileName })
    return null
  }

  try {
    return fs.readFileSync(resolvedPath, 'utf-8')
  } catch (error) {
    return null
  }
}

/**
 * Ensure skills directories exist
 */
export function ensureSkillsDirectories(): void {
  const userSkillsDir = getUserSkillsPath()
  if (!fs.existsSync(userSkillsDir)) {
    fs.mkdirSync(userSkillsDir, { recursive: true })
    log.info('user skills directory created', { userSkillsDir })
  }
}
