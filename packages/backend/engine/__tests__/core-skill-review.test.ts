import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_REVIEW_MESSAGES,
  appendSkillSupportReferencesWithAdapters,
  applySkillReviewDecisionWithAdapters,
  buildAgentSkillReviewMessages,
  buildSkillReviewFileAgentTools,
  buildSkillReviewAgentRunPlan,
  buildSkillReviewMessages,
  buildSkillReviewTargetMessages,
  collectAgentReviewedSkillDirectories,
  collectSkillReviewMutableRoots,
  clearSkillReviewState,
  defaultAgentSupportFileContent,
  ensureContentReferences,
  ensureAgentReviewedSkillsCompleteWithAdapters,
  assertSkillReviewToolPath,
  findMutableSkillReviewSkill,
  findSkillReviewVisibleSkill,
  formatSkillReviewVisibleSkillSummary,
  findSkillDirectoryForReviewedPath,
  getSkillReviewAgentThinkingOptions,
  getSkillReviewCounter,
  getSkillReviewInterval,
  hasSkillReviewAgentMutation,
  isDeepSeekThinkingModel,
  isMutableSkillReviewSource,
  isInsideSkillReviewDirectory,
  isMutatedToolResult,
  normalizeReasoningEffort,
  normalizeReviewAction,
  normalizeSkillReviewDecisionActions,
  normalizeSkillReviewTargetDecision,
  normalizeSkillReviewTargetName,
  normalizeSupportFilePath,
  parseReviewDecision,
  parseSkillReviewTargetDecision,
  planAgentReviewedSkillCompletion,
  resolveSkillReviewToolPath,
  recordSkillReviewCounter,
  skillReviewMessageText,
  skillReviewTranscriptFromMessages,
  supportFileActions,
  uniqueSkillSupportFileActions,
  uniqueSkillSupportFilePath,
} from '@onething/runtime/triggers'

describe('onething runtime skill-review helpers', () => {
  afterEach(() => {
    clearSkillReviewState()
  })

  it('extracts text parts and builds a bounded user/assistant transcript', () => {
    expect(skillReviewMessageText({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image' },
        { text: 'fallback text' },
      ],
    })).toBe('hello\nfallback text')

    const messages = Array.from({ length: MAX_REVIEW_MESSAGES + 2 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
    }))
    const transcript = skillReviewTranscriptFromMessages([
      { role: 'system', content: 'ignored' },
      ...messages,
    ])
    const entries = transcript.split('\n\n')

    expect(transcript).not.toContain('SYSTEM')
    expect(entries).not.toContain('USER: message 0')
    expect(entries).not.toContain('ASSISTANT: message 1')
    expect(transcript).toContain(`message ${MAX_REVIEW_MESSAGES + 1}`)
  })

  it('builds review prompts from host-provided context', () => {
    const messages = buildSkillReviewMessages({
      sessionId: 's1',
      workingDirectory: '/tmp/project',
      visibleSkillSummary: '- review-workflow [user] Use when reviewing.',
      transcript: 'USER: please remember this workflow',
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Return strict JSON')
    expect(messages[1].content).toContain('Session id: s1')
    expect(messages[1].content).toContain('Working directory: /tmp/project')
    expect(messages[1].content).toContain('- review-workflow [user] Use when reviewing.')
    expect(messages[1].content).toContain('USER: please remember this workflow')
  })

  it('formats visible skills and derives mutable skill roots in core', () => {
    const skills = [
      {
        name: 'user-skill',
        source: 'user',
        description: 'User owned skill.',
        path: '/home/me/.codex/skills/user-skill/SKILL.md',
        directoryPath: '/home/me/.codex/skills/user-skill',
      },
      {
        name: 'project-skill',
        source: 'project',
        description: 'Project owned skill.',
        path: '/repo/.codex/skills/project-skill/SKILL.md',
        directoryPath: '/repo/.codex/skills/project-skill',
      },
      {
        name: 'system-skill',
        source: 'system',
        description: 'Read-only skill.',
        path: '/app/system/SKILL.md',
        directoryPath: '/app/system',
      },
    ]

    expect(formatSkillReviewVisibleSkillSummary([])).toBe('No installed skills are visible.')
    expect(formatSkillReviewVisibleSkillSummary(skills)).toContain('- user-skill [user] User owned skill.')
    expect(isMutableSkillReviewSource('user')).toBe(true)
    expect(isMutableSkillReviewSource('project')).toBe(true)
    expect(isMutableSkillReviewSource('system')).toBe(false)
    expect(findSkillReviewVisibleSkill(skills, 'system-skill')?.source).toBe('system')
    expect(findMutableSkillReviewSkill(skills, 'system-skill')).toBeUndefined()
    expect(findMutableSkillReviewSkill(skills, 'project-skill')?.source).toBe('project')
    expect(collectSkillReviewMutableRoots('/home/me/.codex/skills', skills)).toEqual([
      '/home/me/.codex/skills',
      '/home/me/.codex/skills/user-skill',
      '/repo/.codex/skills/project-skill',
    ])
  })

  it('builds agent review prompts with writable target roots', () => {
    const messages = buildAgentSkillReviewMessages({
      sessionId: 's1',
      visibleSkillSummary: 'No installed skills are visible.',
      mutableSkillRoots: ['/tmp/skills', '/tmp/project/.onething/skills'],
      transcript: 'ASSISTANT: durable workflow noted',
    })

    expect(messages[0].content).toContain('Use the read, write, and edit tools')
    expect(messages[0].content).toContain('Use the read, write, and edit tools to create, update, or rewrite skill files directly.')
    expect(messages[0].content).toContain('Do not create background-review-update.md')
    expect(messages[1].content).toContain('Working directory: [none]')
    expect(messages[1].content).toContain('- /tmp/skills')
    expect(messages[1].content).toContain('- /tmp/project/.onething/skills')
  })

  it('parses fenced or embedded JSON review decisions', () => {
    expect(parseReviewDecision('```json\n{"actions":[]}\n```')).toEqual({ actions: [] })
    expect(parseReviewDecision('Here is the decision: {"actions":[{"action":"create"}]} done.'))
      .toEqual({ actions: [{ action: 'create' }] })
    expect(() => parseReviewDecision('no json here')).toThrow('Skill review did not return JSON')
  })

  it('builds and parses target-only skill review decisions', () => {
    const messages = buildSkillReviewTargetMessages({
      sessionId: 's1',
      workingDirectory: '/tmp/project',
      visibleSkillSummary: '- review-workflow [user] Use when reviewing.',
      transcript: 'USER: please remember this workflow',
    })

    expect(messages[0].content).toContain('"action":"none"|"create"|"update"')
    expect(messages[0].content).toContain('Do not include skill instructions')
    expect(parseSkillReviewTargetDecision('```json\n{"action":"update","name":"Review Workflow"}\n```'))
      .toEqual({ action: 'update', name: 'Review Workflow' })
    expect(normalizeSkillReviewTargetName('Review Workflow!')).toBe('review-workflow')
    expect(normalizeSkillReviewTargetDecision({ action: 'update', name: 'Review Workflow!' }))
      .toEqual({ action: 'update', name: 'review-workflow', reason: undefined })
    expect(normalizeSkillReviewTargetDecision({ action: 'update' })).toEqual({
      action: 'none',
      reason: undefined,
    })
  })

  it('normalizes support file actions with safe relative support paths only', () => {
    expect(normalizeSupportFilePath('references/checklist.md')).toBe('references/checklist.md')
    expect(normalizeSupportFilePath('/tmp/checklist.md')).toBeNull()
    expect(normalizeSupportFilePath('../references/checklist.md')).toBeNull()
    expect(normalizeSupportFilePath('notes/checklist.md')).toBeNull()
    expect(normalizeSupportFilePath('references\\checklist.md')).toBeNull()

    const actions = supportFileActions({
      files: [
        { file_path: 'references/checklist.md', content: 'first' },
        { file_path: 'references/checklist.md', content: 'duplicate' },
        { file_path: 'templates/summary.md', file_content: 'summary' },
        { file_path: '/tmp/secret.md', content: 'nope' },
      ],
    }, 'review-workflow')

    expect(actions).toEqual([
      {
        action: 'write_file',
        name: 'review-workflow',
        file_path: 'references/checklist.md',
        file_content: 'first',
      },
      {
        action: 'write_file',
        name: 'review-workflow',
        file_path: 'templates/summary.md',
        file_content: 'summary',
      },
    ])
  })

  it('normalizes create/update review actions into skill manage operations', () => {
    const created = normalizeReviewAction({
      action: 'create',
      name: 'review-workflow',
      description: 'Use when reviewing.',
      instructions: 'Load the checklist before reviewing.',
      reason: 'Durable workflow.',
    })

    expect(created?.skill).toMatchObject({
      action: 'create',
      name: 'review-workflow',
      description: 'Use when reviewing.',
    })
    expect(created?.skill.instructions).toContain('references/procedure.md')
    expect(created?.supportFiles[0]).toMatchObject({
      action: 'write_file',
      file_path: 'references/procedure.md',
    })

    expect(normalizeSkillReviewDecisionActions({
      actions: [
        { action: 'noop', name: 'bad' },
        {
          action: 'create',
          name: 'first',
          description: 'First skill.',
          instructions: 'Do first thing.',
        },
        {
          action: 'update',
          name: 'second',
          description: 'Second skill.',
          instructions: 'Do second thing.',
        },
      ],
    }, 1)).toEqual([
      expect.objectContaining({
        skill: expect.objectContaining({
          action: 'create',
          name: 'first',
        }),
      }),
    ])
  })

  it('applies JSON review decisions through core adapters', async () => {
    const skills = [
      {
        name: 'owned',
        source: 'user',
        description: 'Owned skill.',
        path: '/skills/owned/SKILL.md',
        directoryPath: '/skills/owned',
      },
      {
        name: 'system-owned',
        source: 'system',
        description: 'System skill.',
        path: '/system/system-owned/SKILL.md',
        directoryPath: '/system/system-owned',
      },
    ]
    const executed: unknown[] = []
    const references: Array<{ skillName: string; paths: string[] }> = []
    let invalidated = 0
    const warnings: unknown[][] = []

    const result = await applySkillReviewDecisionWithAdapters({
      response: JSON.stringify({
        actions: [
          {
            action: 'update',
            name: 'owned',
            description: 'Owned update.',
            instructions: 'Add a durable owned detail.',
          },
          {
            action: 'update',
            name: 'system-owned',
            description: 'System update.',
            instructions: 'Should be skipped.',
          },
          {
            action: 'create',
            name: 'new-skill',
            description: 'New skill.',
            instructions: 'Use the new workflow.',
            files: [
              { file_path: 'references/custom.md', content: 'Custom support.' },
            ],
          },
        ],
      }),
      maxActions: 3,
      findVisibleSkill: name => skills.find(skill => skill.name === name),
      findMutableSkill: name => skills.find(skill => skill.name === name && skill.source === 'user'),
      supportFileExists: () => false,
      executeSkillManage: args => {
        executed.push(args)
        return {
          success: true,
          mutated: true,
          title: `${args.action}:${args.name ?? ''}`,
          path: args.file_path,
        }
      },
      appendSkillSupportReferences: (skillName, paths) => {
        references.push({ skillName, paths })
        return { success: true, mutated: true }
      },
      invalidateSkillsCache: () => {
        invalidated += 1
      },
      logger: {
        warn: (...args) => warnings.push(args),
      },
    })

    expect(result).toMatchObject({
      actionCount: 3,
      mutated: true,
      skippedOwnedSkills: ['system-owned'],
    })
    expect(result.supportFilesWritten).toEqual([
      'references/custom.md',
    ])
    expect(executed).toEqual([
      expect.objectContaining({
        action: 'create',
        name: 'new-skill',
      }),
      expect.objectContaining({
        action: 'write_file',
        name: 'new-skill',
        file_path: 'references/custom.md',
      }),
    ])
    expect(references).toEqual([])
    expect(invalidated).toBe(1)
    expect(warnings[0]?.[0]).toContain('Skipping JSON update for existing skill owned')
    expect(warnings[1]?.[0]).toContain('Skipping system-owned skill system-owned')
  })

  it('generates unique support file paths without filesystem access', () => {
    const reserved = new Set<string>(['references/checklist.md'])

    expect(uniqueSkillSupportFilePath({
      requestedPath: 'references/checklist.md',
      fallbackText: 'ignored',
      reserved,
      exists: filePath => filePath === 'references/checklist-2.md',
    })).toBe('references/checklist-3.md')

    const full = new Set(Array.from({ length: 1000 }, (_, index) => {
      const suffix = index === 0 ? '' : `-${index + 1}`
      return `references/review-notes${suffix}.md`
    }))
    expect(uniqueSkillSupportFilePath({
      requestedPath: '../bad.md',
      fallbackText: '',
      reserved: full,
      now: () => 12345,
    })).toBe('references/review-notes-12345.md')
  })

  it('rewrites support file actions to unique skill-owned write actions', () => {
    const reserved = new Set<string>()
    expect(uniqueSkillSupportFileActions({
      skillName: 'review-workflow',
      reserved,
      exists: filePath => filePath === 'templates/example.md',
      supportFiles: [
        {
          action: 'write_file',
          file_path: 'templates/example.md',
          file_content: 'Example',
        },
        {
          action: 'write_file',
          file_path: 'references/checklist.md',
          file_content: 'Checklist',
        },
      ],
    })).toEqual([
      {
        action: 'write_file',
        name: 'review-workflow',
        file_path: 'templates/example-2.md',
        file_content: 'Example',
      },
      {
        action: 'write_file',
        name: 'review-workflow',
        file_path: 'references/checklist.md',
        file_content: 'Checklist',
      },
    ])
  })

  it('adds missing support references to existing content only once', () => {
    const content = ensureContentReferences('Existing instructions.', [
      'references/a.md',
      'templates/b.md',
    ])

    expect(content).toContain('- See `references/a.md`.')
    expect(content).toContain('- See `templates/b.md`.')
    expect(ensureContentReferences(content, ['references/a.md'])).toBe(content)
  })

  it('appends support references through injected skill adapters', async () => {
    const edits: Array<{ name: string; content: string }> = []
    await expect(appendSkillSupportReferencesWithAdapters({
      skillName: 'review-workflow',
      supportPaths: ['references/a.md'],
      readSkill: () => ({ success: false, mutated: false, output: 'missing' }),
      editSkill: () => {
        throw new Error('edit should not run')
      },
    })).resolves.toEqual({
      success: false,
      mutated: false,
      error: 'missing',
    })

    await expect(appendSkillSupportReferencesWithAdapters({
      skillName: 'review-workflow',
      supportPaths: ['references/a.md'],
      readSkill: () => ({
        success: true,
        mutated: false,
        output: 'Existing\n\n## Supporting files\n- See `references/a.md`.',
      }),
      editSkill: () => {
        throw new Error('edit should not run')
      },
    })).resolves.toEqual({
      success: true,
      mutated: false,
    })

    await expect(appendSkillSupportReferencesWithAdapters({
      skillName: 'review-workflow',
      supportPaths: ['references/a.md'],
      readSkill: () => ({ success: true, mutated: false, output: 'Existing' }),
      editSkill: (name, content) => {
        edits.push({ name, content })
        return { success: true, mutated: true, output: content }
      },
    })).resolves.toEqual({
      success: true,
      mutated: true,
      error: undefined,
    })
    expect(edits).toHaveLength(1)
    expect(edits[0].name).toBe('review-workflow')
    expect(edits[0].content).toContain('- See `references/a.md`.')
  })

  it('keeps DeepSeek review policy pure and host-independent', () => {
    expect(isDeepSeekThinkingModel('deepseek-reasoner')).toBe(true)
    expect(isDeepSeekThinkingModel('DeepSeek-V4-Pro')).toBe(true)
    expect(isDeepSeekThinkingModel('deepseek-chat')).toBe(false)

    expect(normalizeReasoningEffort('low')).toBe('high')
    expect(normalizeReasoningEffort('xhigh')).toBe('max')
    expect(normalizeReasoningEffort('max')).toBe('max')
    expect(normalizeReasoningEffort('unknown')).toBeUndefined()

    expect(isMutatedToolResult({ mutated: true })).toBe(true)
    expect(isMutatedToolResult({ mutated: false })).toBe(false)
    expect(isMutatedToolResult(undefined)).toBe(false)
  })

  it('resolves skill-review agent thinking options in core', () => {
    expect(getSkillReviewAgentThinkingOptions({
      model: 'deepseek-chat',
      thinkingByModel: { 'deepseek-chat': false },
    })).toEqual({
      thinking: 'disabled',
      reasoningEffort: undefined,
    })

    expect(getSkillReviewAgentThinkingOptions({
      model: 'deepseek-reasoner',
      thinkingEffortByModel: { 'deepseek-reasoner': 'xhigh' },
    })).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'max',
    })

    expect(getSkillReviewAgentThinkingOptions({
      model: 'custom-model',
    })).toEqual({
      thinking: undefined,
      reasoningEffort: undefined,
    })
  })

  it('builds skill-review agent run plans in core', () => {
    const plan = buildSkillReviewAgentRunPlan({
      model: 'deepseek-reasoner',
      thinkingEffortByModel: { 'deepseek-reasoner': 'xhigh' },
      sessionId: 's1',
      workingDirectory: '/work',
      visibleSkillSummary: '- a [user] A skill.',
      mutableSkillRoots: ['/home/me/.codex/skills'],
      transcript: 'user: make this reusable',
    })

    expect(plan).toMatchObject({
      model: 'deepseek-reasoner',
      selectedToolNames: ['read', 'write', 'edit'],
      toolChoice: 'auto',
      maxTurns: 8,
      maxTokens: 3200,
      thinking: 'enabled',
      reasoningEffort: 'max',
      sessionId: 's1',
      messageId: 'skill-review:s1',
      workingDirectory: '/work',
    })
    expect(plan.temperature).toBeUndefined()
    expect(plan.messages[0].content).toContain('background Hermes skill-review agent')
    expect(plan.messages[1].content).toContain('Writable target roots:')

    const nonThinkingPlan = buildSkillReviewAgentRunPlan({
      model: 'deepseek-chat',
      thinkingByModel: { 'deepseek-chat': false },
      sessionId: 's2',
      visibleSkillSummary: 'No installed skills are visible.',
      mutableSkillRoots: [],
      transcript: 'assistant: done',
    })
    expect(nonThinkingPlan.temperature).toBe(0.1)

    expect(hasSkillReviewAgentMutation({
      agentMutated: false,
      mutatedPathCount: 0,
      completedSkillPackage: false,
    })).toBe(false)
    expect(hasSkillReviewAgentMutation({
      agentMutated: false,
      mutatedPathCount: 1,
      completedSkillPackage: false,
    })).toBe(true)
  })

  it('resolves and checks skill-review tool paths without main process state', () => {
    expect(resolveSkillReviewToolPath({
      rawPath: 'references/a.md',
      workingDirectory: '/tmp/project',
      userSkillsPath: '/tmp/user-skills',
      homeDir: '/home/me',
    })).toBe('/tmp/project/references/a.md')

    expect(resolveSkillReviewToolPath({
      rawPath: '~/skills/a/SKILL.md',
      userSkillsPath: '/tmp/user-skills',
      homeDir: '/home/me',
    })).toBe('/home/me/skills/a/SKILL.md')

    expect(isInsideSkillReviewDirectory('/tmp/skills', '/tmp/skills/a/SKILL.md')).toBe(true)
    expect(isInsideSkillReviewDirectory('/tmp/skills', '/tmp/skills-other/a/SKILL.md')).toBe(false)

    expect(assertSkillReviewToolPath({
      rawPath: 'a/SKILL.md',
      workingDirectory: '/tmp/skills',
      userSkillsPath: '/tmp/user-skills',
      mutableRoots: ['/tmp/skills'],
    })).toBe('/tmp/skills/a/SKILL.md')

    expect(() => assertSkillReviewToolPath({
      rawPath: '../outside.txt',
      workingDirectory: '/tmp/skills/a',
      userSkillsPath: '/tmp/user-skills',
      mutableRoots: ['/tmp/skills/a'],
    })).toThrow('Background skill review file tools can only access mutable skill directories')
  })

  it('builds file agent tools in core with path resolution and mutation tracking', async () => {
    const executed: Array<{ name: string; path: string; toolCallId: string }> = []
    const bundle = buildSkillReviewFileAgentTools({
      userSkillsRoot: '/tmp/user-skills',
      resolvePath: rawPath => `/tmp/user-skills/${rawPath}`,
      adapters: {
        read: {
          description: 'Read file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          parse(args) {
            return typeof args.path === 'string'
              ? { success: true, data: { path: args.path } }
              : { success: false, error: 'read path required' }
          },
          execute(args, ctx) {
            executed.push({ name: 'read', path: args.path, toolCallId: ctx.toolCallId })
            return { output: 'read ok', metadata: { bytes: 7 } }
          },
        },
        write: {
          description: 'Write file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          parse(args) {
            return typeof args.path === 'string'
              ? { success: true, data: { path: args.path } }
              : { success: false, error: 'write path required' }
          },
          execute(args, ctx) {
            executed.push({ name: 'write', path: args.path, toolCallId: ctx.toolCallId })
            return { output: 'write ok', metadata: { changed: true } }
          },
        },
        edit: {
          description: 'Edit file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          parse(args) {
            return typeof args.path === 'string'
              ? { success: true, data: { path: args.path } }
              : { success: false, error: 'edit path required' }
          },
          execute(args, ctx) {
            executed.push({ name: 'edit', path: args.path, toolCallId: ctx.toolCallId })
            return { output: 'edit ok', metadata: { changed: true } }
          },
        },
      },
    })
    const context = { sessionId: 's1', messageId: 'm1', toolCallId: 'tc1' }

    const readResult = await bundle.tools.find(tool => tool.name === 'read')!.execute({ path: 'a/SKILL.md' }, context)
    expect(readResult).toEqual({
      content: 'read ok',
      data: {
        bytes: 7,
        mutated: false,
        path: '/tmp/user-skills/a/SKILL.md',
      },
    })
    expect(bundle.mutatedPaths.size).toBe(0)

    const writeResult = await bundle.tools.find(tool => tool.name === 'write')!.execute({ path: 'a/references/x.md' }, {
      ...context,
      toolCallId: 'tc2',
    })
    expect(writeResult).toEqual({
      content: 'write ok',
      data: {
        changed: true,
        mutated: true,
        path: '/tmp/user-skills/a/references/x.md',
      },
    })
    expect(bundle.mutatedPaths.has('/tmp/user-skills/a/references/x.md')).toBe(true)

    const editResult = await bundle.tools.find(tool => tool.name === 'edit')!.execute({}, context)
    expect(editResult).toEqual({ content: '', error: 'edit path required' })
    expect(executed).toEqual([
      { name: 'read', path: '/tmp/user-skills/a/SKILL.md', toolCallId: 'tc1' },
      { name: 'write', path: '/tmp/user-skills/a/references/x.md', toolCallId: 'tc2' },
    ])
  })

  it('finds reviewed skill directories from mutated paths without filesystem access', () => {
    const skillFiles = new Set([
      '/tmp/user-skills/review-workflow/SKILL.md',
      '/tmp/project/.onething/skills/tester/SKILL.md',
    ])
    const isSkillFile = (skillPath: string) => skillFiles.has(skillPath)

    expect(findSkillDirectoryForReviewedPath({
      mutatedPath: '/tmp/user-skills/review-workflow/references/checklist.md',
      mutableRoots: ['/tmp/user-skills'],
      isSkillFile,
    })).toBe('/tmp/user-skills/review-workflow')

    expect(findSkillDirectoryForReviewedPath({
      mutatedPath: '/tmp/outside/review-workflow/references/checklist.md',
      mutableRoots: ['/tmp/user-skills'],
      isSkillFile,
    })).toBeUndefined()

    expect(collectAgentReviewedSkillDirectories({
      mutatedPaths: [
        '/tmp/user-skills/review-workflow/references/checklist.md',
        '/tmp/user-skills/review-workflow/templates/example.md',
        '/tmp/project/.onething/skills/tester/SKILL.md',
      ],
      mutableRoots: ['/tmp/user-skills', '/tmp/project/.onething/skills'],
      isSkillFile,
    })).toEqual([
      '/tmp/user-skills/review-workflow',
      '/tmp/project/.onething/skills/tester',
    ])
  })

  it('builds default agent support file content for completed skill packages', () => {
    expect(defaultAgentSupportFileContent('review-workflow'))
      .toContain('This file keeps review-workflow as a complete skill package')
  })

  it('plans completed agent-reviewed skill packages without filesystem writes', () => {
    expect(planAgentReviewedSkillCompletion({
      skillName: 'review-workflow',
      skillContent: 'Use this workflow.',
      supportFiles: [],
    })).toMatchObject({
      supportFileToCreate: {
        path: 'references/procedure.md',
        content: expect.stringContaining('review-workflow'),
      },
      supportFiles: ['references/procedure.md'],
      skillContent: expect.stringContaining('- See `references/procedure.md`.'),
      mutated: true,
    })

    expect(planAgentReviewedSkillCompletion({
      skillName: 'review-workflow',
      skillContent: 'Use this workflow.',
      supportFiles: [],
      procedureFileExists: true,
    }).supportFileToCreate?.path).toBe('references/review-notes.md')

    expect(planAgentReviewedSkillCompletion({
      skillName: 'review-workflow',
      skillContent: 'Use this workflow.\n\n## Supporting files\n- See `references/checklist.md`.',
      supportFiles: ['references/checklist.md'],
    })).toEqual({
      supportFileToCreate: undefined,
      supportFiles: ['references/checklist.md'],
      skillContent: 'Use this workflow.\n\n## Supporting files\n- See `references/checklist.md`.',
      mutated: false,
    })
  })

  it('completes agent-reviewed skill packages through core filesystem adapters', () => {
    const files = new Map<string, string>([
      ['/tmp/user-skills/review-workflow/SKILL.md', 'Use this workflow.'],
    ])
    const skillFiles = new Set(['/tmp/user-skills/review-workflow/SKILL.md'])
    const listSupportFiles = (skillDir: string) => [...files.keys()]
      .filter(filePath => filePath.startsWith(`${skillDir}/`) && filePath !== `${skillDir}/SKILL.md`)
      .map(filePath => filePath.slice(skillDir.length + 1))

    const mutated = ensureAgentReviewedSkillsCompleteWithAdapters({
      mutatedPaths: ['/tmp/user-skills/review-workflow/references/checklist.md'],
      mutableRoots: ['/tmp/user-skills'],
      adapters: {
        isSkillFile: skillPath => skillFiles.has(skillPath),
        readSkillFile: skillPath => files.get(skillPath) ?? '',
        writeSkillFile: (skillPath, content) => files.set(skillPath, content),
        listSupportFiles,
        supportFileExists: (skillDir, relativePath) => files.has(`${skillDir}/${relativePath}`),
        writeSupportFile: (skillDir, relativePath, content) => files.set(`${skillDir}/${relativePath}`, content),
      },
    })

    expect(mutated).toBe(true)
    expect(files.get('/tmp/user-skills/review-workflow/references/procedure.md'))
      .toContain('This file keeps review-workflow as a complete skill package')
    expect(files.get('/tmp/user-skills/review-workflow/SKILL.md'))
      .toContain('- See `references/procedure.md`.')

    const secondRun = ensureAgentReviewedSkillsCompleteWithAdapters({
      mutatedPaths: ['/tmp/user-skills/review-workflow/references/procedure.md'],
      mutableRoots: ['/tmp/user-skills'],
      adapters: {
        isSkillFile: skillPath => skillFiles.has(skillPath),
        readSkillFile: skillPath => files.get(skillPath) ?? '',
        writeSkillFile: (skillPath, content) => files.set(skillPath, content),
        listSupportFiles,
        supportFileExists: (skillDir, relativePath) => files.has(`${skillDir}/${relativePath}`),
        writeSupportFile: (skillDir, relativePath, content) => files.set(`${skillDir}/${relativePath}`, content),
      },
    })

    expect(secondRun).toBe(false)
  })

  it('tracks skill review cadence without AppSettings or main state', () => {
    expect(getSkillReviewInterval({ skills: { creationNudgeInterval: '3' } })).toBe(3)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: { skills: { creationNudgeInterval: 3 } },
      toolIterations: 2,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(false)
    expect(getSkillReviewCounter('s1')).toBe(2)

    expect(recordSkillReviewCounter({
      sessionId: 's1',
      settings: { skills: { creationNudgeInterval: 3 } },
      toolIterations: 1,
      skillAuthoringAvailable: true,
      skillManageCalled: false,
    })).toBe(true)
    expect(getSkillReviewCounter('s1')).toBe(0)
  })
})
