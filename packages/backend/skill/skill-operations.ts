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
} from './skill-sources.js'

export {
  executeSkillManage,
  isSkillManageMutation,
  previewSkillManage,
} from './skill-manage-setup.js'
export type {
  SkillManageAction,
  SkillManageArgs,
  SkillManagePreview,
  SkillManageResult,
} from './skill-manage-setup.js'

// Re-export types from shared
export type {
  SkillDefinition,
  SkillConditions,
  SkillFile,
  SkillSource,
  SkillSettings,
} from '@shared/ipc.js'
