import {
  RESERVED_NAMES,
  RESOURCE_STATE_VARIABLE_PREFIX,
  VARIABLE_LIMITS,
  VariableError,
} from './types.js'

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/

export function assertValidName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new VariableError('INVALID_NAME', 'Variable name is required')
  }
  if (name.length > VARIABLE_LIMITS.MAX_NAME_LENGTH) {
    throw new VariableError(
      'INVALID_NAME',
      `Variable name exceeds ${VARIABLE_LIMITS.MAX_NAME_LENGTH} characters`,
    )
  }
  if (!NAME_RE.test(name)) {
    throw new VariableError(
      'INVALID_NAME',
      `Variable name must match /${NAME_RE.source}/ (got "${name}")`,
    )
  }
}

/**
 * 系统占着的名字。两条判据,不是一条:
 *   ① `RESERVED_NAMES` 那张静态表(名字是写死的:`workdir` / `goal` / …);
 *   ② `RESOURCE_STATE_VARIABLE_PREFIX` 那条**前缀规则**(K4-a:名字按命名空间与
 *      状态名现生成,静态表登记不了)。
 *
 * 返回值不再是 `name is ReservedName` 类型守卫:前缀命中的名字**不是**那个字面量
 * 联合的成员,继续声明成守卫就是让类型说一句假话。全仓调用点(两处 store provider
 * 的 `claims`、`channel-guard` 的过滤、`assertNotReserved`)读的都只是布尔。
 */
export function isReservedName(name: string): boolean {
  return (RESERVED_NAMES as readonly string[]).includes(name)
    || name.startsWith(RESOURCE_STATE_VARIABLE_PREFIX)
}

export function assertNotReserved(name: string): void {
  if (isReservedName(name)) {
    throw new VariableError(
      'RESERVED',
      `"${name}" is reserved by the system and cannot be set or deleted by user code`,
    )
  }
}

export function assertValidValue(value: string): void {
  if (typeof value !== 'string') {
    throw new VariableError('INVALID_VALUE', 'Variable value must be a string')
  }
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > VARIABLE_LIMITS.MAX_VALUE_BYTES) {
    throw new VariableError(
      'INVALID_VALUE',
      `Variable value exceeds ${VARIABLE_LIMITS.MAX_VALUE_BYTES} bytes (got ${bytes})`,
    )
  }
}

export function findDuplicateNames(names: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) dupes.add(name)
    else seen.add(name)
  }
  return [...dupes]
}
