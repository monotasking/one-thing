export interface PermissionPolicy {
  allow(toolName: string, args: unknown): boolean | Promise<boolean>
}

export class AllowAllPolicy implements PermissionPolicy {
  allow(): boolean {
    return true
  }
}

export class DenyAllPolicy implements PermissionPolicy {
  allow(): boolean {
    return false
  }
}
