import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantDirectory, tenantKey, validateTenantId, validateTenantScopes } from '../tenant-paths.js'

describe('tenant directories', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-paths-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('retains safe legacy uppercase and lowercase directory spellings', () => {
    validateTenantScopes('Alice', 'Default', ['Default', 'team-two'])
    expect(tenantDirectory(root, 'Alice', 'Default')).toBe(path.join(root, 'Alice', 'Default'))
    expect(tenantDirectory(root, 'Alice', 'team-two')).toBe(path.join(root, 'Alice', 'team-two'))
    expect(tenantKey('Alice', 'Default')).not.toBe(tenantKey('Alice', 'team-two'))
  })

  it.each(['.', '..', '../alice', 'team/a', 'team?a', 'team.a', '空间', 'CON', 'nul', 'a ', 'a:', ''])('rejects ambiguous ID %j without rewriting legacy data', id => {
    expect(() => validateTenantId(id)).toThrow('offline migration')
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('rejects scope collisions on case-insensitive platforms before serving requests', () => {
    expect(() => validateTenantScopes('Alice', 'Team', ['Team', 'team'])).toThrow('collide')
    expect(() => validateTenantScopes('Alice', 'default', ['team'])).toThrow('must be allowed')
  })

  it('does not reuse a differently cased existing owner or scope directory', () => {
    fs.mkdirSync(path.join(root, 'Alice', 'Team'), { recursive: true })
    expect(() => tenantDirectory(root, 'alice', 'Team')).toThrow('collides with existing')
    expect(() => tenantDirectory(root, 'Alice', 'team')).toThrow('collides with existing')
    expect(tenantDirectory(root, 'Alice', 'Team')).toBe(path.join(root, 'Alice', 'Team'))
  })
})
