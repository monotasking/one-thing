import {
  configureOnethingSkillManageRuntime,
} from '@onething/runtime/skills'
import {
  getUserSkillsPath,
  loadAllSkills,
} from './loader.js'

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
} from '@onething/runtime/skills'
export type {
  OnethingSkillManageAdapters,
  SkillManageAction,
  SkillManageArgs,
  SkillManageOptions,
  SkillManagePreview,
  SkillManageResult,
} from '@onething/runtime/skills'
