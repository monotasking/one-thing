import fs from 'fs'
import os from 'os'
import path from 'path'

export interface OnethingObsidianAppConfig {
  attachmentFolderPath?: string
}

export const ONETHING_NOTE_SKILLS_MANIFEST = {
  name: 'note-skills',
  version: '1.0.0',
  description: 'Loads skills from configured AI, user, and work note directories',
  author: 'onething',
}

export interface OnethingNoteSkillInstructionContextInput {
  skillDir: string
  rootDir: string
  markdownNoteAttachmentDirectory?: string
}

export interface OnethingNoteSkillRootDirOptions {
  expandPath?: (dir: string) => string
  isDirectory?: (dir: string) => boolean
}

export interface OnethingNoteSkillRootDescriptor {
  pluginId: string
  path: string
  source: 'plugin'
  recursive: true
  instructionContext(input: { skillDir: string; rootDir: string }): string
}

export interface OnethingNoteSkillRootDescriptorOptions extends OnethingNoteSkillRootDirOptions {
  pluginId: string
  dirs: Array<string | null | undefined>
  markdownNoteAttachmentDirectory?: string
}

export interface OnethingNoteSkillsPluginApi<TSkillRootProvider> {
  readonly id: string
  registerSkillRoot(provider: TSkillRootProvider): void
  onDispose(callback: () => void | Promise<void>): void
}

export interface RegisterOnethingNoteSkillsPluginOptions extends OnethingNoteSkillRootDirOptions {
  getDirs(): Array<string | null | undefined>
  getMarkdownNoteAttachmentDirectory?(): string | undefined
  onVariableChange?(handler: () => void): () => void
  invalidateSkillsCache?(): void
}

export function expandNoteSkillHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  if (input.startsWith('$HOME/')) return path.join(os.homedir(), input.slice(6))
  return input
}

export function normalizeNoteSkillDir(input: string): string {
  return path.resolve(expandNoteSkillHome(input))
}

export function resolveNoteSkillRootDirs(
  dirs: Array<string | null | undefined>,
  options: OnethingNoteSkillRootDirOptions = {},
): string[] {
  const expand = options.expandPath ?? expandNoteSkillHome
  const seen = new Set<string>()
  const resolved: string[] = []

  for (const dir of dirs) {
    if (!dir) continue
    const expanded = expand(dir)
    if (!expanded || seen.has(expanded)) continue
    if (options.isDirectory) {
      try {
        if (!options.isDirectory(expanded)) continue
      } catch {
        continue
      }
    }
    seen.add(expanded)
    resolved.push(expanded)
  }

  return resolved
}

export function buildNoteSkillRootDescriptors(
  options: OnethingNoteSkillRootDescriptorOptions,
): OnethingNoteSkillRootDescriptor[] {
  return resolveNoteSkillRootDirs(options.dirs, options).map(dir => ({
    pluginId: options.pluginId,
    path: dir,
    source: 'plugin',
    recursive: true,
    instructionContext: ({ skillDir, rootDir }) => buildNoteSkillInstructionContext({
      skillDir,
      rootDir,
      markdownNoteAttachmentDirectory: options.markdownNoteAttachmentDirectory,
    }),
  }))
}

export function registerOnethingNoteSkillsPlugin<TSkillRootProvider>(
  api: OnethingNoteSkillsPluginApi<TSkillRootProvider>,
  options: RegisterOnethingNoteSkillsPluginOptions,
): void {
  const unsubscribe = options.onVariableChange?.(() => {
    options.invalidateSkillsCache?.()
  })
  if (unsubscribe) {
    api.onDispose(unsubscribe)
  }

  api.registerSkillRoot((() => buildNoteSkillRootDescriptors({
    pluginId: api.id,
    dirs: options.getDirs(),
    markdownNoteAttachmentDirectory: options.getMarkdownNoteAttachmentDirectory?.(),
    expandPath: options.expandPath,
    isDirectory: options.isDirectory,
  })) as TSkillRootProvider)
}

export function findObsidianVaultRoot(startDir: string): string | null {
  let current = normalizeNoteSkillDir(startDir)
  while (true) {
    if (fs.existsSync(path.join(current, '.obsidian'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function readObsidianAppConfig(vaultRoot: string): OnethingObsidianAppConfig {
  try {
    const raw = fs.readFileSync(path.join(vaultRoot, '.obsidian', 'app.json'), 'utf-8')
    const parsed = JSON.parse(raw) as OnethingObsidianAppConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function resolveConfiguredNoteAttachmentDirectory(rootDir: string, configured: string): string {
  const expanded = expandNoteSkillHome(configured)
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(rootDir, expanded)
}

export function buildNoteSkillInstructionContext(input: OnethingNoteSkillInstructionContextInput): string {
  const noteRoot = normalizeNoteSkillDir(input.rootDir)
  const skillDirectory = normalizeNoteSkillDir(input.skillDir)
  const vaultRoot = findObsidianVaultRoot(skillDirectory)
  let noteSystem: 'obsidian' | 'note' = 'note'
  let attachmentDirectory: string | null = null
  let attachmentSource: string | null = null
  let attachmentDirectoryConfigured = false

  if (vaultRoot) {
    noteSystem = 'obsidian'
    const config = readObsidianAppConfig(vaultRoot)
    const folder = config.attachmentFolderPath?.trim()
    if (folder) {
      attachmentDirectory = resolveConfiguredNoteAttachmentDirectory(vaultRoot, folder)
      attachmentSource = '.obsidian/app.json attachmentFolderPath'
      attachmentDirectoryConfigured = true
    } else {
      attachmentDirectory = skillDirectory
      attachmentSource = 'Obsidian default document directory'
    }
  } else {
    const configured = input.markdownNoteAttachmentDirectory?.trim()
    if (configured) {
      attachmentDirectory = resolveConfiguredNoteAttachmentDirectory(noteRoot, configured)
      attachmentSource = 'settings.general.editor.markdownNoteAttachmentDirectory'
      attachmentDirectoryConfigured = true
    }
  }

  return `<note_skill_context>
${JSON.stringify({
  note_root: noteRoot,
  skill_directory: skillDirectory,
  note_system: noteSystem,
  attachment_directory: attachmentDirectory,
  attachment_directory_available: Boolean(attachmentDirectory),
  attachment_directory_configured: attachmentDirectoryConfigured,
  attachment_source: attachmentSource,
}, null, 2)}
</note_skill_context>`
}
