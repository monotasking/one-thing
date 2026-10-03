import type {
  AgentMessage,
  AgentPromptInjector,
  AgentSkillContext,
} from './types.js'

export function createSystemPromptInjector(
  content: string | (() => string | Promise<string>),
): AgentPromptInjector {
  return async () => {
    const resolved = typeof content === 'function' ? await content() : content
    const trimmed = resolved.trim()
    return trimmed ? [{ role: 'system', content: trimmed }] : []
  }
}

export function buildSkillPrompt(skills: AgentSkillContext[]): string {
  const visible = skills.filter(skill => skill.name.trim() && !skill.disableModelInvocation)
  if (visible.length === 0) return ''

  return [
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
    ...visible.flatMap(skill => [
      '  <skill>',
      `    <name>${escapeSkillXml(skill.name)}</name>`,
      `    <description>${escapeSkillXml(skill.description ?? '')}</description>`,
      `    <location>${escapeSkillXml(skill.location || skill.source || skill.name)}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n')
}

export function createSkillPromptInjector(): AgentPromptInjector {
  return ({ skills, tools }) => {
    if (!tools.some(tool => tool.name === 'read')) return []
    const prompt = buildSkillPrompt(skills)
    return prompt ? [{ role: 'system', content: prompt }] : []
  }
}

function escapeSkillXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function applyPromptInjectors(
  messages: AgentMessage[],
  injectors: AgentPromptInjector[],
  context: Parameters<AgentPromptInjector>[0],
): Promise<AgentMessage[]> {
  const injected: AgentMessage[] = []
  for (const injector of injectors) {
    injected.push(...await injector(context))
  }
  return [...injected, ...messages]
}
