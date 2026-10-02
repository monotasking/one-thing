import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listCapabilities,
  registerCapability,
  rejectionFor,
  resetCapabilitiesForTests,
  resolveCapability,
  type Capability,
  type CapabilityAction,
} from '../capability-registry.js'
import { decidePermission } from '../permission-policy.js'

const HOME = os.homedir()
const TODO_DIR = path.join(HOME, '.onething/todo-plan/sessions')

function own(
  directory: string,
  actions: CapabilityAction[] = ['write'],
  extra: Partial<Capability> = {},
) {
  registerCapability({
    id: extra.id ?? `test-${directory}`,
    label: 'test',
    directory: () => directory,
    actions,
    authority: 'builtin',
    ...extra,
  })
}

// Effects carry a `<dirname>/*` glob rather than the file itself.
function writeEffect(filePath: string) {
  return {
    kind: 'file_write',
    resources: [path.join(path.dirname(filePath), '*')],
    metadata: { path: filePath },
  }
}

function decide(effects: ReturnType<typeof writeEffect>[]) {
  return decidePermission({
    sessionId: 'session-a',
    mode: 'normal',
    effects,
    grantMatcher: () => undefined,
  })
}

describe('capability registry', () => {
  afterEach(() => {
    resetCapabilitiesForTests()
  })

  it('asks before writing anywhere when nothing is registered', () => {
    expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('ask')
  })

  it('allows a write inside a registered capability without a grant', () => {
    own(TODO_DIR)

    expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('allow')
  })

  // The registry must not become a general write permit.
  it('still asks for writes outside every capability', () => {
    own(TODO_DIR)

    expect(decide([writeEffect('/etc/passwd')]).decision).toBe('ask')
    expect(decide([writeEffect(path.join(HOME, 'secrets.md'))]).decision).toBe('ask')
  })

  it('does not treat a shared path prefix as containment', () => {
    own(TODO_DIR)

    expect(decide([writeEffect(`${TODO_DIR}-evil/notes.md`)]).decision).toBe('ask')
  })

  it('does not let .. escape a capability', () => {
    own(TODO_DIR)

    expect(decide([writeEffect(path.join(TODO_DIR, '../../escaped.md'))]).decision).toBe('ask')
  })

  it('asks when only some effects are covered', () => {
    own(TODO_DIR)

    expect(decide([
      writeEffect(path.join(TODO_DIR, 'a/ai-todo.md')),
      writeEffect('/etc/passwd'),
    ]).decision).toBe('ask')
  })

  it('never overrides a hard deny', () => {
    own(TODO_DIR)

    expect(decidePermission({
      sessionId: 'session-a',
      mode: 'normal',
      effects: [{
        ...writeEffect(path.join(TODO_DIR, 'a/ai-todo.md')),
        metadata: { hardDeny: true, reason: 'nope' },
      }],
      grantMatcher: () => undefined,
    }).decision).toBe('deny')
  })

  it('does not cover non-file effects such as bash', () => {
    own(TODO_DIR)

    expect(decidePermission({
      sessionId: 'session-a',
      mode: 'normal',
      effects: [{ kind: 'bash', resources: [path.join(TODO_DIR, '*')] }],
      grantMatcher: () => undefined,
    }).decision).toBe('ask')
  })

  it('keeps read and write separate', () => {
    own(TODO_DIR, ['read'])

    expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('ask')
    expect(resolveCapability(path.join(TODO_DIR, '*'), 'read')).toBeTruthy()
    expect(resolveCapability(path.join(TODO_DIR, '*'), 'write')).toBeUndefined()
  })

  it('treats a disabled capability as inert', () => {
    own(TODO_DIR, ['write'], { enabled: false })

    expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('ask')
  })

  // Deny carves an exception out of a broader allow, and must win regardless of
  // registration order.
  it('lets deny beat an overlapping allow', () => {
    const secrets = path.join(TODO_DIR, 'secrets')
    own(TODO_DIR, ['write'], { id: 'allow-all' })
    own(secrets, ['write'], { id: 'deny-secrets', deny: true })

    expect(decide([writeEffect(path.join(secrets, 'k.md'))]).decision).toBe('ask')
    expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('allow')
  })

  // A capability's directory can come from a free-text setting or a user-added
  // row. A careless value must degrade to "ask", never widen into a blanket permit.
  describe('refuses directories that are too broad', () => {
    it.each([
      ['home itself', HOME],
      ['the filesystem root', path.parse(HOME).root],
      ['an ancestor of home', path.dirname(HOME)],
    ])('refuses %s', (_label, directory) => {
      own(directory)

      expect(decide([writeEffect(path.join(HOME, 'anything.md'))]).decision).toBe('ask')
      expect(rejectionFor(directory)).toEqual({ reason: 'too-broad', directory: path.resolve(directory) })
    })

    it('still allows a specific directory under home', () => {
      own(TODO_DIR)

      expect(rejectionFor(TODO_DIR)).toBeUndefined()
      expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('allow')
    })

    it('drops only the too-broad capability and keeps the rest', () => {
      own(HOME, ['write'], { id: 'too-broad' })
      own(TODO_DIR, ['write'], { id: 'fine' })

      expect(decide([writeEffect(path.join(TODO_DIR, 'a/ai-todo.md'))]).decision).toBe('allow')
      expect(decide([writeEffect(path.join(HOME, 'anything.md'))]).decision).toBe('ask')
    })

    // Rejection must be reportable, not silent: a capability that quietly does
    // nothing looks exactly like a working one until the prompts start.
    it('reports an unresolved directory rather than passing it', () => {
      expect(rejectionFor(undefined)).toEqual({ reason: 'unresolved' })
      expect(rejectionFor('   ')).toEqual({ reason: 'unresolved' })
    })
  })

  it('lists what is registered', () => {
    own(TODO_DIR, ['write'], { id: 'todo.sessions' })

    expect(listCapabilities().map(capability => capability.id)).toEqual(['todo.sessions'])
  })
})
