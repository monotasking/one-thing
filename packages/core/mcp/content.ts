import { toJsonValue } from '@shared/json.js'
import type { MCPToolCallResult } from '@shared/mcp/types.js'

type MCPContentPart = NonNullable<MCPToolCallResult['content']>[number]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  const json = toJsonValue(value)
  return json && typeof json === 'object' && !Array.isArray(json)
    ? json as Record<string, unknown>
    : undefined
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined
}

/**
 * Normalize one MCP `content` part without losing fidelity:
 *
 *  - `image` / `audio` keep their base64 `data` + `mimeType` (the agent loop
 *    turns both into real media parts downstream);
 *  - `resource` (embedded resource) reads the NESTED `resource` object per
 *    spec — `{uri, text}` or `{uri, blob}` — mapping `blob`→`data` and
 *    keeping the `uri`; the legacy flattened shape (fields at the top level)
 *    is still accepted for servers that emit it;
 *  - `resource_link` keeps `uri`/`name`/`description` instead of being
 *    stringified into a JSON blob for the model;
 *  - anything else falls back to text (JSON-stringified when it isn't).
 */
export function normalizeMCPContent(content: object[] | undefined): MCPToolCallResult['content'] {
  if (!Array.isArray(content)) return undefined
  return content.map((item): MCPContentPart => {
    const record = asRecord(item)
    if (!record) {
      return { type: 'text', text: String(toJsonValue(item) ?? '') }
    }
    const type = str(record, 'type') ?? 'text'

    if (type === 'image' || type === 'audio') {
      return {
        type,
        data: str(record, 'data'),
        mimeType: str(record, 'mimeType'),
      }
    }

    if (type === 'resource') {
      const nested = asRecord(record.resource)
      if (nested) {
        return {
          type: 'resource',
          uri: str(nested, 'uri'),
          text: str(nested, 'text'),
          data: str(nested, 'blob'),
          mimeType: str(nested, 'mimeType'),
        }
      }
      // Flattened legacy shape.
      return {
        type: 'resource',
        uri: str(record, 'uri'),
        text: str(record, 'text'),
        data: str(record, 'data'),
        mimeType: str(record, 'mimeType'),
      }
    }

    if (type === 'resource_link') {
      return {
        type: 'resource_link',
        uri: str(record, 'uri'),
        name: str(record, 'name'),
        description: str(record, 'description'),
        mimeType: str(record, 'mimeType'),
      }
    }

    return {
      type: 'text',
      text: str(record, 'text') ?? JSON.stringify(record),
    }
  })
}
