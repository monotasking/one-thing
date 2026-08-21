/**
 * Skills Module
 *
 * Hermes Agent SKILL.md support.
 * Loads skills from app-owned runtime and project roots, plugins, and app resources.
 */

export {
  loadAllSkills,
  loadProjectSkillsForDirectory,
  createSkill,
  deleteSkill,
  readSkillFile,
  ensureSkillsDirectories,
  getHermesHome,
  getHermesConfigPath,
  getUserSkillsPath,
  getProjectSkillsPath,
  getBuiltinSkillsPath,
  findProjectSkillPaths,
  getEnvSkillsPath,
  getExternalSkillsPaths,
} from './loader.js'

export {
  executeSkillManage,
  isSkillManageMutation,
  previewSkillManage,
} from './manage.js'
export type {
  SkillManageAction,
  SkillManageArgs,
  SkillManagePreview,
  SkillManageResult,
} from './manage.js'

// Re-export types from shared
export type {
  SkillDefinition,
  SkillConditions,
  SkillFile,
  SkillSource,
  SkillSettings,
} from '@shared/ipc.js'
