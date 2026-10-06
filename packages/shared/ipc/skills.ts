/**
 * Skills Module
 * Skills-related type definitions for IPC communication.
 */

// Skill source location
export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'custom'

// Skill definition based on Hermes Agent / SKILL.md skills
export interface SkillDefinition {
  // Parsed from SKILL.md YAML frontmatter
  name: string                    // max 64 chars
  description: string             // max 1024 chars, what it does AND when to use
  allowedTools?: string[]         // Optional tool restrictions
  category?: string               // Category path under the skills root
  tags?: string[]                 // metadata.hermes.tags
  relatedSkills?: string[]        // metadata.hermes.related_skills
  platforms?: string[]            // Supported OS platforms
  conditions?: SkillConditions    // metadata.hermes conditional activation
  disableModelInvocation?: boolean // Exclude from automatic model-visible skill index

  // Metadata added by loader
  id: string                      // Unique identifier (path-based)
  source: SkillSource             // 'user' (~/.onething/skills), 'project', 'plugin', or 'builtin'
  path: string                    // Full path to SKILL.md
  directoryPath: string           // Path to skill directory
  rootPath?: string               // Skills root that contained this skill
  relativePath?: string           // Relative path from root to SKILL.md
  enabled: boolean                // Whether skill is enabled
  agentId?: string | null         // Agent this skill is scoped to; null/undefined = all agents

  // Content
  instructions: string            // Main body of SKILL.md (after frontmatter)
  runtimeContext?: string         // Host-injected context appended at load time

  // Optional: additional files in the skill directory
  files?: SkillFile[]
}

export interface SkillConditions {
  fallbackForToolsets?: string[]
  requiresToolsets?: string[]
  fallbackForTools?: string[]
  requiresTools?: string[]
}

export interface SkillReferenceSnapshot {
  skillId: string
  name: string
  description: string
  source: SkillSource
  content: string
  bodyHash: string
}

// Additional file in a skill directory
export interface SkillFile {
  name: string
  path: string
  type: 'markdown' | 'script' | 'template' | 'other'
}

// A user-managed skills root scanned in addition to the app-owned roots
export interface SkillDirectoryConfig {
  id: string
  path: string
  label?: string
  // Bind every skill loaded from this root to one agent; null/undefined = all agents
  agentId?: string | null
  enabled: boolean
}

// Skill settings
export interface SkillSettings {
  enableSkills: boolean
  /**
   * Hermes-compatible skill review cadence. Counts completed agent turns while
   * skill authoring tools are available. Set to 0 or a negative value
   * to disable automatic background skill review.
   */
  creationNudgeInterval?: number
  // Per-skill enabled state and optional agent binding override (keyed by skill id)
  skills: Record<string, { enabled: boolean; agentId?: string | null }>
  // Manually added skill directories
  customDirectories?: SkillDirectoryConfig[]
}

// Skills IPC Request/Response types
export interface GetSkillsRequest {
  /** 会话工作目录 —— 项目根下的技能按它发现。 */
  workingDirectory?: string
}

export interface GetSkillsResponse {
  success: boolean
  skills?: SkillDefinition[]
  error?: string
}

// Refresh skills from filesystem
export interface RefreshSkillsResponse {
  success: boolean
  skills?: SkillDefinition[]
  error?: string
}

// Read a skill file
export interface ReadSkillFileRequest {
  skillId: string
  fileName: string
}

export interface ReadSkillFileResponse {
  success: boolean
  content?: string
  error?: string
}

// Open skill directory in file manager
export interface SkillDirectoryPathRequest {
  /** 缺省 = 用户技能根目录(旧 `skills:open-directory` 通道一直允许不带 id)。 */
  skillId?: string
}

/**
 * 一个技能的目录在哪(第④步批 1,决策 D279:从前叫 `openDirectory`、由后端替人打开;
 * 打开是客户端自己的事,后端只答路径)。
 */
export interface SkillDirectoryPathResponse {
  success: boolean
  path?: string
  error?: string
}

// Create new skill
export interface CreateSkillRequest {
  name: string
  description: string
  instructions: string
  source: SkillSource
}

export interface CreateSkillResponse {
  success: boolean
  skill?: SkillDefinition
  error?: string
}

export interface DeleteSkillRequest {
  skillId: string
}

export interface DeleteSkillResponse {
  success: boolean
  error?: string
}

export interface ToggleSkillEnabledRequest {
  skillId: string
  enabled: boolean
}

export interface ToggleSkillEnabledResponse {
  success: boolean
  error?: string
}

// Custom skill directory management
export interface ListSkillDirectoriesResponse {
  success: boolean
  directories?: SkillDirectoryConfig[]
  error?: string
}

export interface AddSkillDirectoryRequest {
  path: string
  label?: string
  agentId?: string | null
}

export interface AddSkillDirectoryResponse {
  success: boolean
  directory?: SkillDirectoryConfig
  error?: string
}

export interface UpdateSkillDirectoryRequest {
  id: string
  enabled?: boolean
  label?: string
  // Pass null to clear the binding; omit to leave unchanged
  agentId?: string | null
}

export interface UpdateSkillDirectoryResponse {
  success: boolean
  directory?: SkillDirectoryConfig
  error?: string
}

export interface RemoveSkillDirectoryRequest {
  id: string
}

export interface RemoveSkillDirectoryResponse {
  success: boolean
  error?: string
}

// Per-skill agent assignment override
export interface SetSkillAgentRequest {
  skillId: string
  // null clears the binding (skill becomes available to all agents)
  agentId: string | null
}

export interface SetSkillAgentResponse {
  success: boolean
  error?: string
}

/**
 * skills(技能管理)域 —— 结构债 P4c 第二批,整只从手写 IPC 通道迁到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 十二条方法**逐条对应**从前 `IPC_CHANNELS` 上那十二条 skills 通道,语义一字未改;
 * 变的只是通道:壳上十二条包装、web 上十二条 REST 镜像(其中 directories /
 * agent 四条在 server 侧**根本没有路由**,是打了就 404 的死镜像)、以及 server
 * 那套 per-owner 的第二实现,一起消失。
 *
 * 从前 `openDirectory` 要宿主能力(在文件管理器里打开一个目录)。第④步批 1 起它改名
 * `directoryPath`、只答路径:打开是客户端自己的事(桌面经 preload 的 `host:client-action`,
 * 浏览器壳与手机没有文件管理器,不画那颗按钮)。
 */
import { defineRouter } from './router.js'

export type SkillsRoutes = {
  getAll: { input: GetSkillsRequest; output: GetSkillsResponse }
  refresh: { input: Record<string, never>; output: RefreshSkillsResponse }
  readFile: { input: ReadSkillFileRequest; output: ReadSkillFileResponse }
  directoryPath: { input: SkillDirectoryPathRequest; output: SkillDirectoryPathResponse }
  create: { input: CreateSkillRequest; output: CreateSkillResponse }
  delete: { input: DeleteSkillRequest; output: DeleteSkillResponse }
  toggleEnabled: { input: ToggleSkillEnabledRequest; output: ToggleSkillEnabledResponse }
  listDirectories: { input: Record<string, never>; output: ListSkillDirectoriesResponse }
  addDirectory: { input: AddSkillDirectoryRequest; output: AddSkillDirectoryResponse }
  updateDirectory: { input: UpdateSkillDirectoryRequest; output: UpdateSkillDirectoryResponse }
  removeDirectory: { input: RemoveSkillDirectoryRequest; output: RemoveSkillDirectoryResponse }
  setAgent: { input: SetSkillAgentRequest; output: SetSkillAgentResponse }
}

export const skillsRouter = defineRouter<SkillsRoutes>('skills', [
  'getAll',
  'refresh',
  'readFile',
  'directoryPath',
  'create',
  'delete',
  'toggleEnabled',
  'listDirectories',
  'addDirectory',
  'updateDirectory',
  'removeDirectory',
  'setAgent',
])
