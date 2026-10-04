import { configureCoreBackgroundJobs } from './tool-background-jobs.js'
import {
  getOnethingToolOutputsDir,
} from '../storage/storage.js'
let backgroundJobsConfigured = false

/** Explicit assembly step: point background-job logs at the tool outputs dir. */
export function configureAppBackgroundJobs(): void {
  if (backgroundJobsConfigured) return
  backgroundJobsConfigured = true
  configureCoreBackgroundJobs({ getLogRootDir: getOnethingToolOutputsDir })
}

export * from './tool-background-jobs.js'
