import { describe, expect, it } from 'vitest'
import {
  createToolExecutionStep,
  createToolExecutionStepWithFactory,
  detectSkillUsage,
  generateStepTitle,
  getStepType,
} from '@onething/core/engine'

describe('core tool step helpers', () => {
  it('detects skill reads from bash commands', () => {
    expect(detectSkillUsage('bash', {
      command: 'cat ~/.onething/skills/writing/docs/SKILL.md',
    })).toBe('docs')
    expect(detectSkillUsage('read', { path: 'SKILL.md' })).toBeNull()
  })

  it('classifies bash commands into step types', () => {
    expect(getStepType('bash', { command: 'cat README.md' })).toBe('file-read')
    expect(getStepType('bash', { command: 'mkdir tmp' })).toBe('file-write')
    expect(getStepType('bash', { command: 'npm test' })).toBe('command')
    expect(getStepType('read', { path: 'README.md' })).toBe('tool-call')
  })

  it('generates human-readable step titles', () => {
    expect(generateStepTitle('bash', { command: 'npm test' })).toBe('Run: npm test')
    expect(generateStepTitle('read', { path: '/tmp/project/README.md' })).toBe('Tool: read: README.md')
    expect(generateStepTitle('server:tool:search', {})).toBe('Tool: search')
    expect(generateStepTitle('bash', { command: 'cat SKILL.md' }, 'writing')).toBe(
      'Reading writing skill documentation',
    )
  })

  it('creates a running step from an injected id and timestamp', () => {
    expect(createToolExecutionStep({
      id: 'call_1',
      toolName: 'write',
      arguments: { filePath: '/tmp/a.txt' },
    }, {
      id: 'step_1',
      timestamp: 123,
      turnIndex: 2,
    })).toEqual({
      id: 'step_1',
      type: 'tool-call',
      title: 'Tool: write: a.txt',
      status: 'running',
      timestamp: 123,
      turnIndex: 2,
      toolCallId: 'call_1',
      toolCall: {
        id: 'call_1',
        toolName: 'write',
        arguments: { filePath: '/tmp/a.txt' },
      },
    })
  })

  it('creates a running step through injected id and clock providers', () => {
    expect(createToolExecutionStepWithFactory({
      id: 'call_2',
      toolName: 'bash',
      arguments: { command: 'npm test' },
    }, {
      createId: () => 'step_2',
      now: () => 456,
      skillName: null,
      turnIndex: 3,
    })).toEqual({
      id: 'step_2',
      type: 'command',
      title: 'Run: npm test',
      status: 'running',
      timestamp: 456,
      turnIndex: 3,
      toolCallId: 'call_2',
      toolCall: {
        id: 'call_2',
        toolName: 'bash',
        arguments: { command: 'npm test' },
      },
    })
  })
})
