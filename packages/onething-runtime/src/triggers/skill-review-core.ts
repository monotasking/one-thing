import path from 'path'
import type { AgentTool, AgentToolExecutionContext } from '@onething/core/agent-loop'
import { toJsonValue, type JsonObject, type JsonValue } from '@onething/core'

type CoreMaybePromise<T> = T | Promise<T>

export const MAX_REVIEW_MESSAGES = 16
export const MAX_TRANSCRIPT_CHARS = 12000
export const MAX_SKILL_ACTIONS = 2
export const MAX_SUPPORT_FILES_PER_SKILL = 6
export const SUPPORT_FILE_ROOTS = new Set(['references', 'templates', 'scripts', 'assets'])

export interface CoreSkillReviewMessageContentPart {
  type?: string
  text?: string
}

export type CoreSkillReviewMessageContent =
  | string
  | CoreSkillReviewMessageContentPart[]
  | null
  | undefined

export interface CoreSkillReviewMessage {
  role: string
  content?: CoreSkillReviewMessageContent | unknown
}

export interface CoreReviewSupportFile {
  file_path?: string
  filePath?: string
  path?: string
  content?: string
  file_content?: string
  fileContent?: string
}

export interface CoreReviewAction {
  action?: string
  name?: string
  description?: string
  instructions?: string
  content?: string
  files?: CoreReviewSupportFile[]
  support_files?: CoreReviewSupportFile[]
  supportFiles?: CoreReviewSupportFile[]
  reason?: string
}

export type CoreSkillManageAction =
  | 'create'
  | 'edit'
  | 'patch'
  | 'delete'
  | 'write_file'
  | 'remove_file'
  | 'list'
  | 'read'
  | 'update'
  | 'edit_file'

export interface CoreSkillReviewManageArgs {
  action: CoreSkillManageAction
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
  description?: string
  instructions?: string
  old_text?: string
  oldText?: string
  new_text?: string
  newText?: string
  overwrite?: boolean
  reason?: string
}

export interface CoreNormalizedReviewAction {
  skill: CoreSkillReviewManageArgs
  supportFiles: CoreSkillReviewManageArgs[]
}

export interface CoreReviewDecision {
  actions?: CoreReviewAction[]
  rationale?: string
}

export type CoreSkillReviewTargetAction = 'none' | 'create' | 'update'

export interface CoreSkillReviewTargetDecision {
  action?: string
  name?: string
  reason?: string
}

export interface CoreNormalizedSkillReviewTarget {
  action: CoreSkillReviewTargetAction
  name?: string
  reason?: string
}

export interface CoreSkillReviewPromptMessage {
  role: 'system' | 'user'
  content: string
}

export interface CoreSkillReviewPromptOptions {
  sessionId: string
  workingDirectory?: string
  visibleSkillSummary: string
  transcript: string
}

export interface CoreSkillReviewVisibleSkill {
  name: string
  source: string
  description: string
  path: string
  directoryPath: string
}

export interface CoreAgentSkillReviewPromptOptions extends CoreSkillReviewPromptOptions {
  mutableSkillRoots: string[]
}

export interface CoreSkillReviewThinkingConfig {
  model: string
  thinking?: boolean
  thinkingEffort?: unknown
  thinkingByModel?: Record<string, boolean | undefined>
  thinkingEffortByModel?: Record<string, unknown>
}

export interface CoreSkillReviewThinkingOptions {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

export type CoreSkillReviewAgentToolName = 'read' | 'write' | 'edit'

export interface CoreSkillReviewAgentRunPlanOptions
  extends CoreAgentSkillReviewPromptOptions,
    CoreSkillReviewThinkingConfig {}

export interface CoreSkillReviewAgentRunPlan {
  model: string
  messages: CoreSkillReviewPromptMessage[]
  selectedToolNames: CoreSkillReviewAgentToolName[]
  toolChoice: 'auto'
  maxTurns: number
  temperature?: number
  maxTokens: number
  thinking?: CoreSkillReviewThinkingOptions['thinking']
  reasoningEffort?: CoreSkillReviewThinkingOptions['reasoningEffort']
  sessionId: string
  messageId: string
  workingDirectory?: string
}

export interface CoreSkillReviewAgentMutationInput {
  agentMutated: boolean
  mutatedPathCount: number
  completedSkillPackage: boolean
}

export type CoreSkillReviewFileToolName = CoreSkillReviewAgentToolName

export type CoreSkillReviewFileToolArgs = JsonObject & { path: string }

export type CoreSkillReviewFileToolParseResult<TArgs extends CoreSkillReviewFileToolArgs = CoreSkillReviewFileToolArgs> =
  | { success: true; data: TArgs }
  | { success: false; error: string }

export interface CoreSkillReviewFileToolResult {
  output: string
  metadata?: Record<string, unknown>
}

export interface CoreSkillReviewFileToolAdapter<TArgs extends CoreSkillReviewFileToolArgs = CoreSkillReviewFileToolArgs> {
  description: string
  parameters: JsonObject
  parse(args: JsonObject): CoreSkillReviewFileToolParseResult<TArgs>
  execute(args: TArgs, ctx: AgentToolExecutionContext): CoreMaybePromise<CoreSkillReviewFileToolResult>
}

export interface BuildSkillReviewFileAgentToolsOptions {
  userSkillsRoot: string
  resolvePath(rawPath: string): string
  adapters: Record<CoreSkillReviewFileToolName, CoreSkillReviewFileToolAdapter>
}

export interface CoreSkillReviewFileAgentToolBundle {
  tools: AgentTool[]
  mutatedPaths: Set<string>
}

export interface CoreSkillReviewToolPathOptions {
  rawPath: string
  workingDirectory?: string
  userSkillsPath: string
  homeDir?: string
}

export interface CoreSkillReviewToolPathPolicyOptions extends CoreSkillReviewToolPathOptions {
  mutableRoots: string[]
}

export interface CoreAgentReviewedSkillCompletionPlan {
  supportFileToCreate?: {
    path: string
    content: string
  }
  supportFiles: string[]
  skillContent: string
  mutated: boolean
}

export interface CoreFindSkillDirectoryForPathOptions {
  mutatedPath: string
  mutableRoots: string[]
  isSkillFile: (skillPath: string) => boolean
}

export interface CoreCollectAgentReviewedSkillDirectoriesOptions {
  mutatedPaths: Iterable<string>
  mutableRoots: string[]
  isSkillFile: (skillPath: string) => boolean
}


export interface CoreEnsureAgentReviewedSkillsCompleteOptions {
  mutatedPaths: Iterable<string>
  mutableRoots: string[]
  adapters: {
    isSkillFile(skillPath: string): boolean
    readSkillFile(skillPath: string): string
    writeSkillFile(skillPath: string, content: string): void
    listSupportFiles(skillDir: string): string[]
    supportFileExists(skillDir: string, relativePath: string): boolean
    writeSupportFile(skillDir: string, relativePath: string, content: string): void
  }
}

export interface CoreSkillReviewExecutionResult {
  success: boolean
  mutated: boolean
  title?: string
  path?: string
  error?: string
  output?: string
}

export interface CoreSkillReviewSupportReferenceResult {
  success: boolean
  mutated: boolean
  error?: string
}

export interface AppendSkillSupportReferencesWithAdaptersOptions {
  skillName: string
  supportPaths: string[]
  readSkill(name: string): CoreMaybePromise<CoreSkillReviewExecutionResult>
  editSkill(name: string, content: string): CoreMaybePromise<CoreSkillReviewExecutionResult>
}

export interface CoreSkillReviewApplyLogger {
  log?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

export interface ApplySkillReviewDecisionWithAdaptersOptions<
  TSkill extends CoreSkillReviewVisibleSkill = CoreSkillReviewVisibleSkill,
> {
  response: string
  maxActions?: number
  findVisibleSkill(name: string): CoreMaybePromise<TSkill | undefined>
  findMutableSkill(name: string): CoreMaybePromise<TSkill | undefined>
  supportFileExists?(skill: TSkill, filePath: string): boolean
  executeSkillManage(args: CoreSkillReviewManageArgs): CoreMaybePromise<CoreSkillReviewExecutionResult>
  appendSkillSupportReferences(
    skillName: string,
    supportPaths: string[],
  ): CoreMaybePromise<CoreSkillReviewSupportReferenceResult>
  invalidateSkillsCache?(): CoreMaybePromise<void>
  logger?: CoreSkillReviewApplyLogger
  now?: () => number
}

export interface ApplySkillReviewDecisionWithAdaptersResult {
  actionCount: number
  mutated: boolean
  skippedOwnedSkills: string[]
  supportFilesWritten: string[]
}

export function skillReviewMessageText(message: CoreSkillReviewMessage): string {
  const content = message.content as CoreSkillReviewMessageContent
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part.type === 'text') return part.text ?? ''
        if (part.text) return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

export function skillReviewTranscriptFromMessages(messages: CoreSkillReviewMessage[]): string {
  const recent = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-MAX_REVIEW_MESSAGES)

  let transcript = recent
    .map(message => {
      const text = skillReviewMessageText(message).trim()
      return `${message.role.toUpperCase()}: ${text || '[empty]'}`
    })
    .join('\n\n')

  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)
  }
  return transcript
}

export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fence ? fence[1].trim() : trimmed
}

export function parseReviewDecision(raw: string): CoreReviewDecision {
  const text = stripJsonFence(raw)
  try {
    return JSON.parse(text) as CoreReviewDecision
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as CoreReviewDecision
    }
    throw new Error('Skill review did not return JSON')
  }
}

export function parseSkillReviewTargetDecision(raw: string): CoreSkillReviewTargetDecision {
  const text = stripJsonFence(raw)
  try {
    return JSON.parse(text) as CoreSkillReviewTargetDecision
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as CoreSkillReviewTargetDecision
    }
    throw new Error('Skill review target decision did not return JSON')
  }
}

export function normalizeSkillReviewTargetName(rawName: string | undefined): string | undefined {
  const name = rawName
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
  return name || undefined
}

export function normalizeSkillReviewTargetDecision(
  decision: CoreSkillReviewTargetDecision,
): CoreNormalizedSkillReviewTarget {
  const rawAction = decision.action?.trim().toLowerCase()
  const action = rawAction === 'create' || rawAction === 'update'
    ? rawAction
    : 'none'
  const name = normalizeSkillReviewTargetName(decision.name)
  if (action === 'none' || !name) {
    return {
      action: 'none',
      reason: decision.reason,
    }
  }
  return {
    action,
    name,
    reason: decision.reason,
  }
}

export function formatSkillReviewVisibleSkillSummary(
  skills: readonly CoreSkillReviewVisibleSkill[],
): string {
  if (skills.length === 0) return 'No installed skills are visible.'
  return skills
    .map(skill => `- ${skill.name} [${skill.source}] ${skill.description} (SKILL.md: ${skill.path}; dir: ${skill.directoryPath})`)
    .join('\n')
}

export function isMutableSkillReviewSource(source: string): boolean {
  return source === 'user' || source === 'project'
}

export function findSkillReviewVisibleSkill(
  skills: readonly CoreSkillReviewVisibleSkill[],
  name: string,
): CoreSkillReviewVisibleSkill | undefined {
  return skills.find(skill => skill.name === name)
}

export function findMutableSkillReviewSkill(
  skills: readonly CoreSkillReviewVisibleSkill[],
  name: string,
): CoreSkillReviewVisibleSkill | undefined {
  const skill = findSkillReviewVisibleSkill(skills, name)
  if (!skill) return undefined
  return isMutableSkillReviewSource(skill.source) ? skill : undefined
}

export function collectSkillReviewMutableRoots(
  userSkillsPath: string,
  skills: readonly CoreSkillReviewVisibleSkill[],
): string[] {
  const roots = new Set<string>([path.resolve(userSkillsPath)])
  for (const skill of skills) {
    if (isMutableSkillReviewSource(skill.source)) {
      roots.add(path.resolve(skill.directoryPath))
    }
  }
  return [...roots]
}

export function buildSkillReviewTargetMessages(
  options: CoreSkillReviewPromptOptions,
): CoreSkillReviewPromptMessage[] {
  const system = [
    'You are a background Hermes skill-review planner.',
    'The user-facing assistant response has already been delivered; do not answer the user.',
    'Decide whether the recent conversation revealed a durable, reusable procedure that should become or update a Hermes SKILL.md skill.',
    'Be conservative. Do not create or update a skill for one-off facts, transient debugging details, secrets, credentials, or project-specific trivia.',
    'Return strict JSON only with this shape: {"action":"none"|"create"|"update","name":"lowercase-name","reason":"short reason"}.',
    'Use action "update" only when the best target is an existing user/project skill from the visible skills list.',
    'Use action "create" only when no existing visible skill is an appropriate target; name must be lowercase and filesystem-safe.',
    'Use action "none" when no durable skill should be created or updated.',
    'Do not include skill instructions, supporting file paths, markdown content, or implementation details.',
  ].join('\n')

  const user = [
    `Session id: ${options.sessionId}`,
    options.workingDirectory ? `Working directory: ${options.workingDirectory}` : 'Working directory: [none]',
    '',
    'Visible skills:',
    options.visibleSkillSummary,
    '',
    'Recent transcript:',
    options.transcript,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildSkillReviewMessages(
  options: CoreSkillReviewPromptOptions,
): CoreSkillReviewPromptMessage[] {
  const system = [
    'You are a background Hermes skill-review fork.',
    'The user-facing assistant response has already been delivered; do not answer the user.',
    'Decide whether the recent conversation revealed a durable, reusable procedure that should become a Hermes SKILL.md skill.',
    'Be conservative. Do not create a skill for one-off facts, transient debugging details, secrets, credentials, or project-specific trivia.',
    'Propose brand-new user-owned skills or safe updates to existing user/project skills.',
    'Return strict JSON with this shape: {"actions":[{"action":"create"|"update","name":"lowercase-name","description":"...","instructions":"Concise reusable detail","files":[{"file_path":"references/checklist.md","content":"..."}],"reason":"..."}]}.',
    'For create actions, include at least one supporting file when there is durable detail, a checklist, a reusable template, a script, or examples worth keeping outside the main SKILL.md.',
    'For update actions, provide only new reusable detail and supporting files. Do not rewrite or restate the full existing SKILL.md.',
    'Supporting files must use relative paths under references/, templates/, scripts/, or assets/ only. Do not include secrets, credentials, or transient project facts in SKILL.md or supporting files.',
    'Return {"actions":[]} when no skill should be created or updated.',
  ].join('\n')

  const user = [
    `Session id: ${options.sessionId}`,
    options.workingDirectory ? `Working directory: ${options.workingDirectory}` : 'Working directory: [none]',
    '',
    'Visible skills:',
    options.visibleSkillSummary,
    '',
    'Recent transcript:',
    options.transcript,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildAgentSkillReviewMessages(
  options: CoreAgentSkillReviewPromptOptions,
): CoreSkillReviewPromptMessage[] {
  const system = [
    'You are a background Hermes skill-review agent.',
    'The user-facing assistant response has already been delivered; do not answer the user.',
    'Decide whether the recent conversation revealed a durable, reusable procedure that should become a Hermes skill.',
    'Be conservative. Do not create a skill for one-off facts, transient debugging details, secrets, credentials, or project-specific trivia.',
    'Use the read, write, and edit tools to create, update, or rewrite skill files directly.',
    'Before updating or rewriting an existing skill, read its current SKILL.md and any relevant supporting files, then edit the source files into the current best version.',
    'Do not create background-review-update.md or numbered background review update files. If a new support file is truly needed, choose a semantic filename that describes its durable content.',
    'A complete skill is a directory with SKILL.md plus at least one supporting file under references/, templates/, scripts/, or assets/.',
    'Use references/ for durable notes, checklists, examples, and procedure detail; templates/ for reusable user-facing formats; scripts/ only for executable helpers; assets/ only for static resources.',
    'Every tool path must be inside one of the writable target roots listed in the user message. Use absolute paths when possible.',
    'When no skill should be created or updated, do not call tools and return {"changed":false,"summary":"no durable skill update"}.',
    'After all necessary tool calls, return strict JSON: {"changed":true|false,"summary":"..."}',
  ].join('\n')

  const user = [
    `Session id: ${options.sessionId}`,
    options.workingDirectory ? `Working directory: ${options.workingDirectory}` : 'Working directory: [none]',
    '',
    'Visible skills:',
    options.visibleSkillSummary,
    '',
    'Writable target roots:',
    options.mutableSkillRoots.map(root => `- ${root}`).join('\n'),
    '',
    'Recent transcript:',
    options.transcript,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function getSkillReviewAgentThinkingOptions(
  config: CoreSkillReviewThinkingConfig,
): CoreSkillReviewThinkingOptions {
  if (config.thinking === false) {
    return {
      thinking: 'disabled',
      reasoningEffort: undefined,
    }
  }

  if (config.thinking === true) {
    return {
      thinking: 'enabled',
      reasoningEffort: normalizeReasoningEffort(config.thinkingEffort) ?? 'high',
    }
  }

  const thinkingByModel = config.thinkingByModel?.[config.model]
  const thinking =
    thinkingByModel === true
      ? 'enabled'
      : thinkingByModel === false
        ? 'disabled'
        : isDeepSeekThinkingModel(config.model)
          ? 'enabled'
          : undefined
  const reasoningEffort = thinking === 'enabled'
    ? normalizeReasoningEffort(config.thinkingEffortByModel?.[config.model]) ?? 'high'
    : undefined

  return {
    thinking,
    reasoningEffort,
  }
}

export function buildSkillReviewAgentRunPlan(
  options: CoreSkillReviewAgentRunPlanOptions,
): CoreSkillReviewAgentRunPlan {
  const { thinking, reasoningEffort } = getSkillReviewAgentThinkingOptions(options)
  return {
    model: options.model,
    messages: buildAgentSkillReviewMessages(options),
    selectedToolNames: ['read', 'write', 'edit'],
    toolChoice: 'auto',
    maxTurns: 8,
    temperature: thinking === 'enabled' ? undefined : 0.1,
    maxTokens: 3200,
    thinking,
    reasoningEffort,
    sessionId: options.sessionId,
    messageId: `skill-review:${options.sessionId}`,
    workingDirectory: options.workingDirectory,
  }
}

export function hasSkillReviewAgentMutation(input: CoreSkillReviewAgentMutationInput): boolean {
  return input.agentMutated || input.mutatedPathCount > 0 || input.completedSkillPackage
}

export function buildSkillReviewFileAgentTools(
  options: BuildSkillReviewFileAgentToolsOptions,
): CoreSkillReviewFileAgentToolBundle {
  const mutatedPaths = new Set<string>()
  const readPaths = new Set<string>()
  const buildTool = (
    name: CoreSkillReviewFileToolName,
    mutate: boolean,
    descriptionParts: string[],
  ): AgentTool => {
    const adapter = options.adapters[name]
    return {
      name,
      description: descriptionParts.join(' '),
      parameters: adapter.parameters,
      async execute(args, toolCtx) {
        const parsed = adapter.parse(args)
        if (!parsed.success) return { content: '', error: parsed.error }
        try {
          const resolvedPath = options.resolvePath(parsed.data.path)
          if (name === 'edit' && !readPaths.has(resolvedPath)) {
            return agentToolError(`Background skill review must read a file before editing it: ${resolvedPath}`)
          }
          const result = await adapter.execute({
            ...parsed.data,
            path: resolvedPath,
          }, toolCtx)
          if (name === 'read') {
            readPaths.add(resolvedPath)
          }
          if (mutate) {
            mutatedPaths.add(resolvedPath)
          }
          return {
            content: result.output,
            data: toJsonValue({
              ...(result.metadata ?? {}),
              mutated: mutate,
              path: resolvedPath,
            }),
          }
        } catch (error) {
          return agentToolError(error instanceof Error ? error : String(error))
        }
      },
    }
  }

  return {
    tools: [
      buildTool('read', false, [
        options.adapters.read.description,
        'For background skill review, read only existing user/project skill files before editing or rewriting them.',
      ]),
      buildTool('write', true, [
        options.adapters.write.description,
        `For background skill review, write only inside mutable skill directories or the user skills root: ${options.userSkillsRoot}.`,
        'You may create a new skill directory by writing SKILL.md and supporting files, or rewrite an existing user/project skill after reading it.',
      ]),
      buildTool('edit', true, [
        options.adapters.edit.description,
        'For background skill review, edit only user/project skill files. Prefer targeted edits after using read.',
      ]),
    ],
    mutatedPaths,
  }
}

export function isInsideSkillReviewDirectory(parentDir: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function resolveSkillReviewToolPath(options: CoreSkillReviewToolPathOptions): string {
  const expanded = options.rawPath.startsWith('~')
    ? path.join(options.homeDir ?? '', options.rawPath.slice(1))
    : options.rawPath
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(options.workingDirectory ?? options.userSkillsPath, expanded)
}

export function assertSkillReviewToolPath(options: CoreSkillReviewToolPathPolicyOptions): string {
  const resolved = resolveSkillReviewToolPath(options)
  if (!options.mutableRoots.some(root => isInsideSkillReviewDirectory(root, resolved))) {
    throw new Error(`Background skill review file tools can only access mutable skill directories. Rejected path: ${resolved}`)
  }
  return resolved
}

export function findSkillDirectoryForReviewedPath(
  options: CoreFindSkillDirectoryForPathOptions,
): string | undefined {
  let current = path.dirname(path.resolve(options.mutatedPath))

  while (options.mutableRoots.some(root => isInsideSkillReviewDirectory(root, current))) {
    const skillPath = path.join(current, 'SKILL.md')
    if (options.isSkillFile(skillPath)) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return undefined
}

export function collectAgentReviewedSkillDirectories(
  options: CoreCollectAgentReviewedSkillDirectoriesOptions,
): string[] {
  const skillDirs = new Set<string>()
  for (const mutatedPath of options.mutatedPaths) {
    const skillDir = findSkillDirectoryForReviewedPath({
      mutatedPath,
      mutableRoots: options.mutableRoots,
      isSkillFile: options.isSkillFile,
    })
    if (skillDir) skillDirs.add(skillDir)
  }
  return [...skillDirs]
}

export function ensureAgentReviewedSkillsCompleteWithAdapters(
  options: CoreEnsureAgentReviewedSkillsCompleteOptions,
): boolean {
  const skillDirs = collectAgentReviewedSkillDirectories({
    mutatedPaths: options.mutatedPaths,
    mutableRoots: options.mutableRoots,
    isSkillFile: options.adapters.isSkillFile,
  })

  let mutated = false
  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillDir, 'SKILL.md')
    if (!options.adapters.isSkillFile(skillPath)) continue

    const supportFiles = options.adapters.listSupportFiles(skillDir)
    const content = options.adapters.readSkillFile(skillPath)
    const plan = planAgentReviewedSkillCompletion({
      skillName: path.basename(skillDir),
      skillContent: content,
      supportFiles,
      procedureFileExists: options.adapters.supportFileExists(skillDir, 'references/procedure.md'),
    })

    if (plan.supportFileToCreate) {
      options.adapters.writeSupportFile(
        skillDir,
        plan.supportFileToCreate.path,
        plan.supportFileToCreate.content,
      )
      mutated = true
    }

    if (plan.skillContent !== content) {
      options.adapters.writeSkillFile(skillPath, plan.skillContent)
      mutated = true
    }
  }

  return mutated
}

export function normalizeSupportFilePath(rawPath: string | undefined): string | null {
  const filePath = rawPath?.trim()
  if (!filePath || filePath.includes('\0') || filePath.includes('\\')) return null
  if (filePath.startsWith('/') || filePath.startsWith('~')) return null

  const segments = filePath.split('/').filter(Boolean)
  if (segments.length < 2 || !SUPPORT_FILE_ROOTS.has(segments[0])) return null
  if (segments.some(segment => segment === '.' || segment === '..')) return null

  return segments.join('/')
}

export function supportFileActions(
  action: CoreReviewAction,
  skillName: string,
): CoreSkillReviewManageArgs[] {
  const files = action.files ?? action.support_files ?? action.supportFiles ?? []
  const seen = new Set<string>()
  const normalized: CoreSkillReviewManageArgs[] = []

  for (const file of files) {
    const rawPath = file.file_path ?? file.filePath ?? file.path
    const rawContent = file.content ?? file.file_content ?? file.fileContent
    const filePath = normalizeSupportFilePath(rawPath)
    const fileContent = typeof rawContent === 'string' ? rawContent : ''
    if (!filePath || !fileContent.trim() || seen.has(filePath)) continue

    seen.add(filePath)
    normalized.push({
      action: 'write_file',
      name: skillName,
      file_path: filePath,
      file_content: fileContent,
    })

    if (normalized.length >= MAX_SUPPORT_FILES_PER_SKILL) break
  }

  return normalized
}

export function defaultSupportFile(
  description: string,
  instructions: string,
  reason?: string,
): CoreSkillReviewManageArgs {
  const content = [
    '# Procedure Notes',
    '',
    `Description: ${description}`,
    reason?.trim() ? `Reason captured: ${reason.trim()}` : '',
    '',
    '## Reusable Procedure',
    '',
    instructions.trim(),
    '',
  ].filter(Boolean).join('\n')

  return {
    action: 'write_file',
    file_path: 'references/procedure.md',
    file_content: content,
  }
}

export function defaultUpdateSupportFile(
  description: string,
  instructions: string,
  reason?: string,
): CoreSkillReviewManageArgs {
  const content = [
    '# Review Notes',
    '',
    `Description: ${description}`,
    reason?.trim() ? `Reason captured: ${reason.trim()}` : '',
    '',
    '## New Reusable Detail',
    '',
    instructions.trim(),
    '',
  ].filter(Boolean).join('\n')

  return {
    action: 'write_file',
    file_path: 'references/review-notes.md',
    file_content: content,
  }
}

export function ensureSupportFileReferences(
  instructions: string,
  supportFiles: Array<Pick<CoreSkillReviewManageArgs, 'file_path' | 'filePath'>>,
): string {
  const paths = supportFiles
    .map(file => file.file_path ?? file.filePath)
    .filter((filePath): filePath is string => Boolean(filePath))

  const missingPaths = paths.filter(filePath => !instructions.includes(filePath))
  if (missingPaths.length === 0) {
    return instructions
  }

  const references = missingPaths.map(filePath => `- See \`${filePath}\`.`).join('\n')
  return `${instructions.trim()}\n\n## Supporting files\n${references}`
}

export function ensureContentReferences(content: string, paths: string[]): string {
  const refs = paths.map(filePath => ({
    action: 'write_file' as const,
    file_path: filePath,
    file_content: '',
  }))
  return ensureSupportFileReferences(content, refs)
}

export async function appendSkillSupportReferencesWithAdapters(
  options: AppendSkillSupportReferencesWithAdaptersOptions,
): Promise<CoreSkillReviewSupportReferenceResult> {
  const read = await options.readSkill(options.skillName)
  if (!read.success) {
    return {
      mutated: false,
      success: false,
      error: read.error ?? read.output,
    }
  }

  const currentContent = read.output ?? ''
  const nextContent = ensureContentReferences(currentContent, options.supportPaths)
  if (nextContent === currentContent) {
    return { mutated: false, success: true }
  }

  const edited = await options.editSkill(options.skillName, nextContent)
  return {
    mutated: edited.mutated,
    success: edited.success,
    error: edited.success ? undefined : edited.error ?? edited.output,
  }
}

export function slugFromText(text: string | undefined): string {
  const slug = text
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'review-notes'
}


export function uniqueSkillSupportFilePath(options: {
  requestedPath?: string
  fallbackText?: string
  reserved: Set<string>
  exists?: (filePath: string) => boolean
  now?: () => number
}): string {
  const normalized = normalizeSupportFilePath(options.requestedPath)
  const normalizedRoot = normalized?.split('/')[0]
  const directory = normalizedRoot && SUPPORT_FILE_ROOTS.has(normalizedRoot) ? normalizedRoot : 'references'
  const ext = normalized?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.md'
  const rawBase = normalized
    ? normalized.replace(/\.[a-z0-9]+$/i, '').split('/').pop()
    : options.fallbackText
  const base = slugFromText(rawBase)

  for (let index = 1; index <= 1000; index++) {
    const suffix = index === 1 ? '' : `-${index}`
    const candidate = `${directory}/${base}${suffix}${ext}`
    if (options.reserved.has(candidate)) continue
    if (options.exists?.(candidate)) continue
    options.reserved.add(candidate)
    return candidate
  }

  const fallback = `${directory}/${base}-${options.now?.() ?? Date.now()}${ext}`
  options.reserved.add(fallback)
  return fallback
}

export interface UniqueSkillSupportFileActionsOptions {
  skillName: string
  supportFiles: CoreSkillReviewManageArgs[]
  reserved: Set<string>
  exists?: (filePath: string) => boolean
  now?: () => number
}

export function uniqueSkillSupportFileActions(options: UniqueSkillSupportFileActionsOptions): CoreSkillReviewManageArgs[] {
  return options.supportFiles.map(file => {
    const rawPath = file.file_path ?? file.filePath
    const rawContent = file.file_content ?? file.fileContent ?? file.content ?? ''
    const nextPath = uniqueSkillSupportFilePath({
      requestedPath: rawPath,
      fallbackText: rawContent,
      reserved: options.reserved,
      exists: options.exists,
      now: options.now,
    })
    return {
      ...file,
      action: 'write_file',
      name: options.skillName,
      file_path: nextPath,
      file_content: rawContent,
    }
  })
}

export function supportFilesForExistingUpdate(
  action: CoreReviewAction,
  skillName: string,
): CoreSkillReviewManageArgs[] {
  return supportFileActions(action, skillName)
}

export function agentToolError(error: Error | string): { content: string; error: string } {
  return {
    content: '',
    error: error instanceof Error ? error.message : String(error),
  }
}

export function defaultAgentSupportFileContent(skillName: string): string {
  return [
    '# Background Review Notes',
    '',
    `This file keeps ${skillName} as a complete skill package after automatic background review.`,
    '',
    '## Review Capture',
    '',
    'The durable workflow is captured in SKILL.md. Add examples, checklists, templates, or scripts here when the workflow grows.',
    '',
  ].join('\n')
}

export function planAgentReviewedSkillCompletion(input: {
  skillName: string
  skillContent: string
  supportFiles: string[]
  procedureFileExists?: boolean
}): CoreAgentReviewedSkillCompletionPlan {
  let supportFiles = [...input.supportFiles]
  let supportFileToCreate: CoreAgentReviewedSkillCompletionPlan['supportFileToCreate']
  let mutated = false

  if (supportFiles.length === 0) {
    const supportPath = input.procedureFileExists
      ? 'references/review-notes.md'
      : 'references/procedure.md'
    supportFileToCreate = {
      path: supportPath,
      content: defaultAgentSupportFileContent(input.skillName),
    }
    supportFiles = [supportPath]
    mutated = true
  }

  const skillContent = ensureContentReferences(input.skillContent, supportFiles)
  if (skillContent !== input.skillContent) {
    mutated = true
  }

  return {
    supportFileToCreate,
    supportFiles,
    skillContent,
    mutated,
  }
}

export function normalizeReviewAction(action: CoreReviewAction): CoreNormalizedReviewAction | null {
  const requested = action.action === 'update' || action.action === 'edit'
    ? 'update'
    : action.action === 'create'
      ? 'create'
      : null
  const name = action.name?.trim()
  const description = action.description?.trim()
  const instructions = action.instructions?.trim() || action.content?.trim()
  if (!requested || !name || !description || !instructions) return null
  const supportFiles = supportFileActions(action, name)
  if (requested === 'create' && supportFiles.length === 0) {
    supportFiles.push(defaultSupportFile(description, instructions, action.reason))
  }
  const skillInstructions = ensureSupportFileReferences(instructions, supportFiles)

  return {
    skill: {
      action: requested === 'update' ? 'update' : 'create',
      name,
      description,
      instructions: skillInstructions,
      reason: action.reason,
    },
    supportFiles,
  }
}

export function normalizeSkillReviewDecisionActions(
  decision: CoreReviewDecision,
  maxActions = MAX_SKILL_ACTIONS,
): CoreNormalizedReviewAction[] {
  return (decision.actions ?? [])
    .map(normalizeReviewAction)
    .filter((action): action is CoreNormalizedReviewAction => Boolean(action))
    .slice(0, maxActions)
}

export async function applySkillReviewDecisionWithAdapters<
  TSkill extends CoreSkillReviewVisibleSkill = CoreSkillReviewVisibleSkill,
>(
  options: ApplySkillReviewDecisionWithAdaptersOptions<TSkill>,
): Promise<ApplySkillReviewDecisionWithAdaptersResult> {
  const decision = parseReviewDecision(options.response)
  const actions = normalizeSkillReviewDecisionActions(decision, options.maxActions ?? MAX_SKILL_ACTIONS)

  if (actions.length === 0) {
    return {
      actionCount: 0,
      mutated: false,
      skippedOwnedSkills: [],
      supportFilesWritten: [],
    }
  }

  let mutated = false
  const skippedOwnedSkills: string[] = []
  const supportFilesWritten: string[] = []

  for (const action of actions) {
    const skillName = action.skill.name ?? ''
    const existing = skillName ? await options.findVisibleSkill(skillName) : undefined
    const mutable = skillName ? await options.findMutableSkill(skillName) : undefined

    if (existing && !mutable) {
      skippedOwnedSkills.push(skillName)
      options.logger?.warn?.(
        `[SkillReview] Skipping ${existing.source}-owned skill ${skillName}; automatic review can only update user/project skills.`,
      )
      continue
    }

    if (mutable) {
      options.logger?.warn?.(
        `[SkillReview] Skipping JSON update for existing skill ${skillName}; automatic updates must use the background file-editing agent.`,
      )
      continue
    }

    const applied = await options.executeSkillManage({
      ...action.skill,
      action: 'create',
    })
    mutated = mutated || applied.mutated
    options.logger?.log?.(`[SkillReview] ${applied.title ?? 'Skill create'}: ${applied.path ?? ''}`)

    if (!applied.success) {
      options.logger?.warn?.(`[SkillReview] Skipping support files after failed ${action.skill.action}: ${applied.error ?? applied.output}`)
      continue
    }

    for (const supportFile of action.supportFiles) {
      const written = await options.executeSkillManage({
        ...supportFile,
        name: action.skill.name,
      })
      mutated = mutated || written.mutated
      if (written.success) {
        const supportPath = supportFile.file_path ?? supportFile.filePath
        if (supportPath) supportFilesWritten.push(supportPath)
        options.logger?.log?.(`[SkillReview] ${written.title ?? 'Support file'}: ${written.path ?? ''}`)
      } else {
        options.logger?.warn?.(`[SkillReview] Support file write failed: ${written.error ?? written.output}`)
      }
    }
  }

  if (mutated) {
    await options.invalidateSkillsCache?.()
  }

  return {
    actionCount: actions.length,
    mutated,
    skippedOwnedSkills,
    supportFilesWritten,
  }
}

export function isDeepSeekThinkingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.includes('reasoner') ||
    lower.includes('thinking') ||
    /(^|[^a-z])v4/.test(lower)
}

export function normalizeReasoningEffort(value: unknown): 'high' | 'max' | undefined {
  if (value === 'high' || value === 'max') return value
  if (value === 'low' || value === 'medium') return 'high'
  if (value === 'xhigh') return 'max'
  return undefined
}

export function isMutatedToolResult(data: JsonValue | undefined): boolean {
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    data.mutated === true,
  )
}
