import { describe, expect, it } from 'vitest'
import {
  detectCopilotModelCapabilities,
  getCopilotModelDescription,
  modelInfoFromCopilotEntry,
} from '../vendors/github-copilot/github-copilot-models.js'

describe('onething GitHub Copilot provider helpers', () => {
  it('parses Copilot model entries', () => {
    expect(modelInfoFromCopilotEntry({
      id: 'gpt-4.1',
      description: 'custom description',
    })).toEqual({
      id: 'gpt-4.1',
      name: 'gpt-4.1',
      description: 'custom description',
      type: 'chat',
    })

    expect(modelInfoFromCopilotEntry({ id: '' })).toBeNull()
  })

  it('provides fallback model descriptions', () => {
    expect(getCopilotModelDescription('o3-mini')).toBe('Advanced reasoning, fast')
    expect(getCopilotModelDescription('unknown-model')).toBe('GitHub Copilot model')
  })

  it('detects model capabilities from model IDs', () => {
    expect(detectCopilotModelCapabilities('gpt-4.1')).toMatchObject({
      hasVision: true,
      hasTools: true,
      hasReasoning: false,
      contextLength: 1000000,
    })
    expect(detectCopilotModelCapabilities('o1-mini')).toMatchObject({
      hasTools: false,
      hasReasoning: true,
      contextLength: 200000,
    })
    expect(detectCopilotModelCapabilities('gpt-image-1')).toMatchObject({
      hasImageGeneration: true,
      hasTools: false,
    })
  })
})
