import fs from 'fs'
import path from 'path'
import { createTwoFilesPatch } from 'diff'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition } from './types.js'

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const MAX_SKILL_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_SKILL_CONTENT_CHARS = 100_000
const MAX_SUPPORT_FILE_BYTES = 1_048_576
const DEFAULT_SKILL_FILE = 'SKILL.md'
const SUPPORT_DIRECTORIES = new Set(['references', 'templates', 'scripts', 'assets'])

export type HermesSkillManageAction =
  | 'create'
  | 'edit'
  | 'patch'
  | 'delete'
  | 'write_file'
  | 'remove_file'

export type SkillManageAction =
  | HermesSkillManageAction
  | 'list'
  | 'read'
  | 'update'
  | 'edit_file'

export interface SkillManageArgs {
  action: SkillManageAction
  name?: string
  content?: string
  category?: string
  file_path?: string
  filePath?: string
  file_content?: string
  fileContent?: string
  old_string?: string
  oldString?: string
  new_string?: string
  newString?: string
  replace_all?: boolean
  replaceAll?: boolean
  absorbed_into?: string
  absorbedInto?: string

  // Backward-compatible aliases used by the first local draft and the
  // background review trigger. These are intentionally not exposed in the
  // model-facing schema.
  description?: string
  instructions?: string
  old_text?: string
  oldText?: string
  new_text?: string
  newText?: string
  overwrite?: boolean
  reason?: string
}

export interface SkillManageOptions {
  workingDirectory?: string
  adapters?: OnethingSkillManageAdapters
}

export interface OnethingSkillManageAdapters {
  getUserSkillsPath(): string
  loadAllSkills(workingDirectory?: string): SkillDefinition[]
}

let configuredAdapters: OnethingSkillManageAdapters | undefined

export function configureOnethingSkillManageRuntime(adapters: OnethingSkillManageAdapters | undefined): void {
  configuredAdapters = adapters
}

export interface SkillManageResult {
  success: boolean
  action: SkillManageAction
  title: string
  output: string
  mutated: boolean
  path?: string
  skill?: SkillDefinition
  diff?: string
  additions?: number
  deletions?: number
  error?: string
}

export interface SkillManagePreview {
  path?: string
  diff?: string
  additions?: number
  deletions?: number
  created?: boolean
  deleted?: boolean
  mutated: boolean
  title: string
  error?: string
}

interface SkillFrontmatter {
  name: string
  description: string
  body: string
}

interface MutationPlan {
  action: SkillManageAction
  title: string
  path?: string
  before: string
  after: string
  created?: boolean
  deleted?: boolean
  skill?: SkillDefinition
  skillDir?: string
  apply?: () => SkillDefinition | undefined
}

function jsonOutput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getSkillManageAdapters(options: SkillManageOptions): OnethingSkillManageAdapters {
  const adapters = options.adapters ?? configuredAdapters
  if (!adapters) {
    throw new Error('Skill manage runtime adapters are not configured')
  }
  return adapters
}

function ensureUserSkillsRoot(options: SkillManageOptions): string {
  const root = getSkillManageAdapters(options).getUserSkillsPath()
  fs.mkdirSync(root, { recursive: true })
  return root
}

function isInsideDirectory(parentDir: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertSafeSkillName(rawName: string | undefined, label = 'Skill name'): string {
  const name = rawName?.trim()
  if (!name) throw new Error(`${label} is required`)
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`${label} must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, and hyphens`)
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`${label} must be ${MAX_SKILL_NAME_LENGTH} characters or less`)
  }
  return name
}

function assertCategory(rawCategory: string | undefined): string | undefined {
  const category = rawCategory?.trim()
  if (!category) return undefined
  if (category.includes('/') || category.includes('\\')) {
    throw new Error('category must be a single directory segment')
  }
  return assertSafeSkillName(category, 'category')
}

function assertDescription(description: string): string {
  const trimmed = description.trim()
  if (!trimmed) throw new Error('SKILL.md frontmatter must include a non-empty description')
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Skill description must be ${MAX_DESCRIPTION_LENGTH} characters or less`)
  }
  return trimmed
}

function assertSkillContentSize(content: string): void {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    throw new Error(`SKILL.md content must be ${MAX_SKILL_CONTENT_CHARS} characters or less`)
  }
}

function validateSkillMarkdown(content: string, expectedName?: string): SkillFrontmatter {
  assertSkillContentSize(content)
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/)
  if (!match) {
    throw new Error('SKILL.md must start with YAML frontmatter delimited by ---')
  }

  let frontmatter: unknown
  try {
    frontmatter = parseYaml(match[1])
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid YAML: ${errorMessage(error)}`)
  }

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be a YAML mapping')
  }

  const raw = frontmatter as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const body = match[2].trim()

  assertSafeSkillName(name, 'SKILL.md frontmatter name')
  assertDescription(description)
  if (expectedName && name !== expectedName) {
    throw new Error(`SKILL.md frontmatter name must match skill name "${expectedName}"`)
  }
  if (!body) {
    throw new Error('SKILL.md body must contain reusable skill instructions')
  }

  return { name, description, body }
}

function buildSkillMarkdown(name: string, description: string, instructions: string): string {
  const body = instructions.trim()
  if (!body) throw new Error('Skill instructions are required')
  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(assertDescription(description))}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function skillContentFromArgs(args: SkillManageArgs, expectedName: string): string {
  if (args.content !== undefined) {
    validateSkillMarkdown(args.content, expectedName)
    return args.content
  }
  if (args.description !== undefined || args.instructions !== undefined) {
    const description = args.description?.trim()
    const instructions = args.instructions?.trim()
    if (!description) throw new Error('description is required when content is omitted')
    if (!instructions) throw new Error('instructions are required when content is omitted')
    return buildSkillMarkdown(expectedName, description, instructions)
  }
  throw new Error('content is required')
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    fs.writeFileSync(tempPath, content, 'utf-8')
    fs.renameSync(tempPath, filePath)
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  }
}

function resolveCreateSkillDir(name: string, category: string | undefined, options: SkillManageOptions): string {
  const root = ensureUserSkillsRoot(options)
  const skillDir = category ? path.join(root, category, name) : path.join(root, name)
  if (!isInsideDirectory(root, skillDir)) {
    throw new Error('Resolved skill directory escapes the user skills root')
  }
  return skillDir
}

function visibleSkills(options: SkillManageOptions = {}): SkillDefinition[] {
  return getSkillManageAdapters(options).loadAllSkills(options.workingDirectory)
}

function findVisibleSkill(name: string, options: SkillManageOptions = {}): SkillDefinition | undefined {
  return visibleSkills(options).find(skill => skill.name === name)
}

function assertMutableSkill(name: string, options: SkillManageOptions = {}): SkillDefinition {
  const skill = findVisibleSkill(name, options)
  if (!skill) throw new Error(`Skill "${name}" does not exist`)
  if (skill.source !== 'user' && skill.source !== 'project') {
    throw new Error(`Skill "${name}" is ${skill.source}-owned and cannot be modified by skill_manage`)
  }
  return skill
}

function findSkillByDirectory(skillDir: string, options: SkillManageOptions = {}): SkillDefinition | undefined {
  const resolved = path.resolve(skillDir)
  return visibleSkills(options).find(skill => path.resolve(skill.directoryPath) === resolved)
}

function assertLoadedAfterMutation(skillDir: string, options: SkillManageOptions = {}): SkillDefinition {
  const loaded = findSkillByDirectory(skillDir, options)
  if (!loaded) throw new Error(`Skill at ${skillDir} could not be loaded after mutation`)
  return loaded
}

function validateSupportFilePath(rawFilePath: string | undefined): string {
  const filePath = rawFilePath?.trim()
  if (!filePath) throw new Error('file_path is required')
  if (filePath.includes('\0')) throw new Error('file_path contains an invalid null byte')
  if (filePath.includes('\\')) throw new Error('file_path must use forward slashes')
  if (path.isAbsolute(filePath)) throw new Error('file_path must be relative')

  const normalized = path.posix.normalize(filePath)
  const segments = normalized.split('/').filter(Boolean)
  if (normalized === '.' || normalized.startsWith('../') || segments.includes('..')) {
    throw new Error('file_path must stay inside the skill directory')
  }
  if (segments.length < 2 || !SUPPORT_DIRECTORIES.has(segments[0])) {
    throw new Error(`file_path must be inside one of: ${Array.from(SUPPORT_DIRECTORIES).join(', ')}`)
  }
  if (!segments[segments.length - 1]) throw new Error('file_path must include a file name')
  return segments.join('/')
}

function resolveSupportFile(skill: SkillDefinition, rawFilePath: string | undefined): { relativePath: string; absolutePath: string } {
  const relativePath = validateSupportFilePath(rawFilePath)
  const absolutePath = path.resolve(skill.directoryPath, relativePath)
  if (!isInsideDirectory(skill.directoryPath, absolutePath)) {
    throw new Error('file_path must stay inside the skill directory')
  }
  return { relativePath, absolutePath }
}

function supportFileContentFromArgs(args: SkillManageArgs): string {
  const content = args.file_content ?? args.fileContent ?? args.content
  if (content === undefined) throw new Error('file_content is required')
  if (Buffer.byteLength(content, 'utf-8') > MAX_SUPPORT_FILE_BYTES) {
    throw new Error(`Supporting file content must be ${MAX_SUPPORT_FILE_BYTES} bytes or less`)
  }
  return content
}

function patchStringsFromArgs(args: SkillManageArgs): { oldString: string; newString: string; replaceAll: boolean } {
  const oldString = args.old_string ?? args.oldString ?? args.old_text ?? args.oldText
  const newString = args.new_string ?? args.newString ?? args.new_text ?? args.newText
  if (oldString === undefined) throw new Error('old_string is required')
  if (newString === undefined) throw new Error('new_string is required')
  if (oldString.length === 0) throw new Error('old_string must not be empty')
  return { oldString, newString, replaceAll: args.replace_all ?? args.replaceAll ?? false }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function applyLineTrimmedPatch(before: string, oldString: string, newString: string): string | null {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n')
  const oldLines = oldString.replace(/\r\n/g, '\n').split('\n')
  const oldSignature = oldLines.map(line => line.trim()).join('\n')
  const matches: number[] = []

  for (let i = 0; i <= beforeLines.length - oldLines.length; i++) {
    const candidate = beforeLines.slice(i, i + oldLines.length).map(line => line.trim()).join('\n')
    if (candidate === oldSignature) matches.push(i)
  }

  if (matches.length !== 1) return null

  const newLines = newString.replace(/\r\n/g, '\n').split('\n')
  const start = matches[0]
  return [
    ...beforeLines.slice(0, start),
    ...newLines,
    ...beforeLines.slice(start + oldLines.length),
  ].join('\n')
}

function applyPatch(before: string, args: SkillManageArgs): string {
  const { oldString, newString, replaceAll } = patchStringsFromArgs(args)
  const occurrences = countOccurrences(before, oldString)

  if (occurrences > 0) {
    if (replaceAll) return before.split(oldString).join(newString)
    if (occurrences !== 1) {
      throw new Error(`old_string must match exactly once unless replace_all is true; found ${occurrences}`)
    }
    return before.replace(oldString, newString)
  }

  const fuzzy = applyLineTrimmedPatch(before, oldString, newString)
  if (fuzzy !== null) return fuzzy
  throw new Error('old_string was not found; exact match failed and line-trimmed fuzzy match was not unique')
}

function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.length === 0 ? [] : before.split(/\r?\n/)
  const afterLines = after.length === 0 ? [] : after.split(/\r?\n/)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix++
  }
  let beforeSuffix = beforeLines.length - 1
  let afterSuffix = afterLines.length - 1
  while (beforeSuffix >= prefix && afterSuffix >= prefix && beforeLines[beforeSuffix] === afterLines[afterSuffix]) {
    beforeSuffix--
    afterSuffix--
  }
  return {
    deletions: Math.max(0, beforeSuffix - prefix + 1),
    additions: Math.max(0, afterSuffix - prefix + 1),
  }
}

function buildPreviewForPath(filePath: string, before: string, after: string, title: string, flags: Partial<SkillManagePreview> = {}): SkillManagePreview {
  const { additions, deletions } = countLineChanges(before, after)
  return {
    path: filePath,
    diff: createTwoFilesPatch(filePath, filePath, before, after),
    additions,
    deletions,
    created: flags.created,
    deleted: flags.deleted,
    mutated: before !== after || Boolean(flags.deleted),
    title,
  }
}

function supportFiles(skillDir: string): string[] {
  const files: string[] = []
  for (const dir of SUPPORT_DIRECTORIES) {
    const root = path.join(skillDir, dir)
    if (!fs.existsSync(root)) continue

    const scan = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          scan(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        files.push(path.relative(skillDir, fullPath).split(path.sep).join('/'))
      }
    }
    scan(root)
  }
  return files.sort()
}

function removeEmptyParentDirectories(startDir: string, stopDir: string): void {
  let current = path.resolve(startDir)
  const stop = path.resolve(stopDir)
  while (current !== stop && isInsideDirectory(stop, current)) {
    try {
      fs.rmdirSync(current)
    } catch {
      break
    }
    current = path.dirname(current)
  }
}

function createPlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const category = assertCategory(args.category)
  const skillDir = resolveCreateSkillDir(name, category, options)
  const targetPath = path.join(skillDir, DEFAULT_SKILL_FILE)

  if (findVisibleSkill(name, options) && !args.overwrite) {
    throw new Error(`Skill "${name}" already exists`)
  }
  if (fs.existsSync(skillDir) && !args.overwrite) {
    throw new Error(`Skill directory already exists: ${skillDir}`)
  }

  const before = readTextIfExists(targetPath)
  const after = skillContentFromArgs(args, name)
  return {
    action: args.action,
    title: `Create skill ${name}`,
    path: targetPath,
    before,
    after,
    created: !fs.existsSync(targetPath),
    skillDir,
    apply: () => {
      writeTextAtomic(targetPath, after)
      return assertLoadedAfterMutation(skillDir, options)
    },
  }
}

function editPlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const skill = assertMutableSkill(name, options)
  const before = fs.readFileSync(skill.path, 'utf-8')
  const after = skillContentFromArgs(args, name)
  validateSkillMarkdown(after, name)

  return {
    action: args.action,
    title: `Edit skill ${name}`,
    path: skill.path,
    before,
    after,
    skill,
    skillDir: skill.directoryPath,
    apply: () => {
      const backup = before
      writeTextAtomic(skill.path, after)
      try {
        return assertLoadedAfterMutation(skill.directoryPath, options)
      } catch (error) {
        writeTextAtomic(skill.path, backup)
        throw error
      }
    },
  }
}

function patchPlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const skill = assertMutableSkill(name, options)
  const supportPath = args.file_path ?? args.filePath
  const targetPath = supportPath ? resolveSupportFile(skill, supportPath).absolutePath : skill.path
  if (!fs.existsSync(targetPath)) throw new Error(`File not found: ${targetPath}`)

  const before = fs.readFileSync(targetPath, 'utf-8')
  const after = applyPatch(before, args)
  if (targetPath === skill.path) {
    validateSkillMarkdown(after, name)
  } else if (Buffer.byteLength(after, 'utf-8') > MAX_SUPPORT_FILE_BYTES) {
    throw new Error(`Supporting file content must be ${MAX_SUPPORT_FILE_BYTES} bytes or less`)
  }

  return {
    action: args.action,
    title: supportPath ? `Patch ${name}/${supportPath}` : `Patch skill ${name}`,
    path: targetPath,
    before,
    after,
    skill,
    skillDir: skill.directoryPath,
    apply: () => {
      const backup = before
      writeTextAtomic(targetPath, after)
      if (targetPath !== skill.path) return assertLoadedAfterMutation(skill.directoryPath, options)
      try {
        return assertLoadedAfterMutation(skill.directoryPath, options)
      } catch (error) {
        writeTextAtomic(targetPath, backup)
        throw error
      }
    },
  }
}

function deletePlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const skill = assertMutableSkill(name, options)
  const absorbedInto = args.absorbed_into ?? args.absorbedInto
  if (absorbedInto?.trim()) {
    const target = assertSafeSkillName(absorbedInto, 'absorbed_into')
    if (target === name) throw new Error('absorbed_into must name a different skill')
    if (!findVisibleSkill(target, options)) throw new Error(`absorbed_into skill "${target}" does not exist`)
  }
  const before = readTextIfExists(skill.path)

  return {
    action: args.action,
    title: `Delete skill ${name}`,
    path: skill.path,
    before,
    after: '',
    deleted: true,
    skill,
    skillDir: skill.directoryPath,
    apply: () => {
      const skillDir = skill.directoryPath
      const parent = path.dirname(skillDir)
      const root = skill.rootPath ?? getSkillManageAdapters(options).getUserSkillsPath()
      fs.rmSync(skillDir, { recursive: true, force: true })
      removeEmptyParentDirectories(parent, root)
      return undefined
    },
  }
}

function writeFilePlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const skill = assertMutableSkill(name, options)
  const { relativePath, absolutePath } = resolveSupportFile(skill, args.file_path ?? args.filePath)
  const before = readTextIfExists(absolutePath)
  const after = supportFileContentFromArgs(args)

  return {
    action: args.action,
    title: `${fs.existsSync(absolutePath) ? 'Update' : 'Write'} ${name}/${relativePath}`,
    path: absolutePath,
    before,
    after,
    created: !fs.existsSync(absolutePath),
    skill,
    skillDir: skill.directoryPath,
    apply: () => {
      writeTextAtomic(absolutePath, after)
      return assertLoadedAfterMutation(skill.directoryPath, options)
    },
  }
}

function removeFilePlan(args: SkillManageArgs, options: SkillManageOptions): MutationPlan {
  const name = assertSafeSkillName(args.name)
  const skill = assertMutableSkill(name, options)
  const { relativePath, absolutePath } = resolveSupportFile(skill, args.file_path ?? args.filePath)
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${relativePath}. Available support files: ${supportFiles(skill.directoryPath).join(', ') || '[none]'}`)
  }
  const before = fs.readFileSync(absolutePath, 'utf-8')

  return {
    action: args.action,
    title: `Remove ${name}/${relativePath}`,
    path: absolutePath,
    before,
    after: '',
    deleted: true,
    skill,
    skillDir: skill.directoryPath,
    apply: () => {
      fs.rmSync(absolutePath, { force: true })
      removeEmptyParentDirectories(path.dirname(absolutePath), skill.directoryPath)
      return assertLoadedAfterMutation(skill.directoryPath, options)
    },
  }
}

function planSkillManage(args: SkillManageArgs, options: SkillManageOptions = {}): MutationPlan {
  switch (args.action) {
    case 'create':
      return createPlan(args, options)
    case 'edit':
    case 'update':
      return editPlan(args, options)
    case 'patch':
    case 'edit_file':
      return patchPlan(args, options)
    case 'delete':
      return deletePlan(args, options)
    case 'write_file':
      return writeFilePlan(args, options)
    case 'remove_file':
      return removeFilePlan(args, options)
    case 'list':
      return { action: args.action, title: 'List skills', before: '', after: '' }
    case 'read':
      return { action: args.action, title: 'Read skill', before: '', after: '' }
    default:
      throw new Error(`Unsupported skill_manage action: ${(args as SkillManageArgs).action}`)
  }
}

function previewFromPlan(plan: MutationPlan): SkillManagePreview {
  if (!plan.path) return { mutated: false, title: plan.title }
  return buildPreviewForPath(plan.path, plan.before, plan.after, plan.title, {
    created: plan.created,
    deleted: plan.deleted,
  })
}

export function previewSkillManage(args: SkillManageArgs, options: SkillManageOptions = {}): SkillManagePreview {
  try {
    return previewFromPlan(planSkillManage(args, options))
  } catch (error) {
    return {
      mutated: false,
      title: `skill_manage ${args.action}`,
      error: errorMessage(error),
    }
  }
}

export function isSkillManageMutation(action: SkillManageAction | string): boolean {
  return action === 'create' ||
    action === 'edit' ||
    action === 'patch' ||
    action === 'delete' ||
    action === 'write_file' ||
    action === 'remove_file' ||
    action === 'update' ||
    action === 'edit_file'
}

function listSkills(options: SkillManageOptions): SkillManageResult {
  const skills = visibleSkills(options).filter(skill => skill.source === 'user' || skill.source === 'project')
  return {
    success: true,
    action: 'list',
    title: 'Mutable skills',
    output: jsonOutput({
      success: true,
      skills: skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        category: skill.category,
        path: skill.path,
        skill_dir: skill.directoryPath,
      })),
      count: skills.length,
    }),
    mutated: false,
  }
}

function readSkill(args: SkillManageArgs, options: SkillManageOptions): SkillManageResult {
  const name = assertSafeSkillName(args.name)
  const skill = findVisibleSkill(name, options)
  if (!skill) throw new Error(`Skill "${name}" does not exist`)
  const supportPath = args.file_path ?? args.filePath
  const targetPath = supportPath ? resolveSupportFile(skill, supportPath).absolutePath : skill.path
  if (!fs.existsSync(targetPath)) throw new Error(`File not found: ${targetPath}`)
  return {
    success: true,
    action: 'read',
    title: supportPath ? `Read ${name}/${supportPath}` : `Read skill ${name}`,
    output: fs.readFileSync(targetPath, 'utf-8'),
    mutated: false,
    path: targetPath,
    skill,
  }
}

function failedResult(action: SkillManageAction, error: unknown): SkillManageResult {
  const message = errorMessage(error)
  return {
    success: false,
    action,
    title: 'skill_manage failed',
    output: jsonOutput({ success: false, action, error: message }),
    mutated: false,
    error: message,
  }
}

export function executeSkillManage(args: SkillManageArgs, options: SkillManageOptions = {}): SkillManageResult {
  try {
    if (args.action === 'list') return listSkills(options)
    if (args.action === 'read') return readSkill(args, options)

    const plan = planSkillManage(args, options)
    if (!plan.apply || !plan.path) {
      throw new Error(`Action ${args.action} has no mutation to apply`)
    }

    const preview = previewFromPlan(plan)
    const skill = plan.apply()
    const name = args.name?.trim()
    const absorbedInto = args.absorbed_into ?? args.absorbedInto

    return {
      success: true,
      action: args.action,
      title: plan.title,
      output: jsonOutput({
        success: true,
        action: args.action,
        name,
        path: plan.path,
        skill_dir: plan.skillDir,
        absorbed_into: absorbedInto?.trim() || undefined,
        mutated: preview.mutated,
      }),
      mutated: preview.mutated,
      path: plan.path,
      skill,
      diff: preview.diff,
      additions: preview.additions,
      deletions: preview.deletions,
    }
  } catch (error) {
    return failedResult(args.action, error)
  }
}
