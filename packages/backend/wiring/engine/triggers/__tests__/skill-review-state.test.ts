import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/ipc.js'
import {
  clearSkillReviewState,
  getSkillReviewCounter,
  recordSkillReviewCounter,
} from '../skill-review-state.js'

function settings(interval?: number): AppSettings {
  return {
    ai: {} as AppSettings['ai'],
    theme: 'system',
    general: {} as AppSettings['general'],
    tools: { enableToolCalls: true, permissionMode: 'normal', tools: {} } as AppSettings['tools'],
    skills: {
      enableSkills: true,
      creationNudgeInterval: interval,
      skills: {},
    },
  }
}

describe('skill review counter', () => {
  afterEach(() => {
    clearSkillReviewState()
  })

  it('fires after the configured number of tool iterations when skill authoring tools are available', () => {
    const appSettings = settings(3)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: appSettings,
      toolIterations: 2,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(2)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: appSettings,
      toolIterations: 1,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(true)
    expect(getSkillReviewCounter('s1')).toBe(0)
  })

  it('does not count when skill authoring is unavailable or cadence is disabled', () => {
    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: settings(3),
      toolIterations: 10,
      skillAuthoringAvailable: false,
      skillManageCalled: false,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(0)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: settings(0),
      toolIterations: 10,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(0)
  })

  it('resets the counter when skill authoring is signalled', () => {
    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: settings(10),
      toolIterations: 4,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(4)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: settings(10),
      toolIterations: 5,
      skillAuthoringAvailable: true,
      skillManageCalled: true,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(0)
  })
})
