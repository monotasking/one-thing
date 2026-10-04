import { configureOnethingSkillManageRuntime } from './skill-manage.js'
import {
  getUserSkillsPath,
  loadAllSkills,
} from './skill-sources.js'

let skillManageConfigured = false

/** Explicit assembly step: wire skill_manage to the app skills loader. */
export function configureAppSkillManage(): void {
  if (skillManageConfigured) return
  skillManageConfigured = true
  configureOnethingSkillManageRuntime({
    getUserSkillsPath,
    loadAllSkills,
  })
}

export {
  configureOnethingSkillManageRuntime,
  executeSkillManage,
  isSkillManageMutation,
  previewSkillManage,
} from './skill-manage.js'
export type {
  OnethingSkillManageAdapters,
  SkillManageAction,
  SkillManageArgs,
  SkillManageOptions,
  SkillManagePreview,
  SkillManageResult,
} from './skill-manage.js'
