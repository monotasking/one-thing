import type { JsonObject, JsonValue } from '@shared/json.js'

export function stableStringify(value: JsonValue | undefined): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}

export interface CoreRepeatedToolCallResult {
  signature: string
  count: number
  detected: boolean
  message?: string
}

export function toolCallSignature(toolName: string, args: JsonObject): string {
  return `${toolName.toLowerCase()}:${stableStringify(args)}`
}

export function recordToolCallSignature(
  signatureCounts: Map<string, number>,
  toolName: string,
  args: JsonObject,
  threshold = 4,
): CoreRepeatedToolCallResult {
  const signature = toolCallSignature(toolName, args)
  const count = (signatureCounts.get(signature) || 0) + 1
  signatureCounts.set(signature, count)

  if (count >= threshold) {
    return {
      signature,
      count,
      detected: true,
      message: `Repeated identical tool call detected (${toolName}, ${count} times). Stop and reassess instead of retrying the same arguments.`,
    }
  }

  return { signature, count, detected: false }
}
