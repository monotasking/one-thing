import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const agentLoopRoot = fileURLToPath(new URL('../', import.meta.url))

type ForbiddenDependency = {
  name: string
  pattern: RegExp
}

const forbiddenDependencies: ForbiddenDependency[] = [
  { name: 'ai package import', pattern: /from\s+['"]ai['"]/ },
  { name: 'legacy AI SDK boundary', pattern: /legacy-ai-sdk/ },
  { name: 'AI SDK streamText helper', pattern: /\bstreamText\b/ },
  { name: 'AI SDK generateText helper', pattern: /\bgenerateText\b/ },
]

function implementationFiles(dir: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue

    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...implementationFiles(path))
      continue
    }

    if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path)
    }
  }

  return files
}

describe('agent-loop dependency boundary', () => {
  it('does not depend on the legacy AI SDK runtime', () => {
    const violations: string[] = []

    for (const file of implementationFiles(agentLoopRoot)) {
      const content = readFileSync(file, 'utf8')
      for (const dependency of forbiddenDependencies) {
        if (dependency.pattern.test(content)) {
          violations.push(`${relative(agentLoopRoot, file)}: ${dependency.name}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
