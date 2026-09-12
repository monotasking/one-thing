import type { MessageKey, TFn } from '../../i18n'

/**
 * 一格网页权限 → 一句人话(B3-a)。**表,不是 switch**;表里没有的名字答
 * `null`,由卡上那一句退成「一格它没说清的能力」——**不编一句**。
 *
 * 表这一头与后端那张 `ASKABLE_WEB_PERMISSIONS`(`electron/browser/permission.ts`)
 * 是同一族的两半:那边说「哪一格能问」,这边说「问的时候怎么念」。两处都写成表,
 * 于是加一格能问的权限 = 两张表各加一行,没有第三处要改。
 *
 * **它们对得上由单测钉**(能问的每一格都念得出),而不是靠谁记得。
 */
const LABELS: Readonly<Record<string, MessageKey>> = {
  notifications: 'browser.perm.notifications',
  geolocation: 'browser.perm.geolocation',
  media: 'browser.perm.media',
  'clipboard-read': 'browser.perm.clipboardRead',
  midi: 'browser.perm.midi',
  pointerLock: 'browser.perm.pointerLock',
}

export function webPermissionLabelKey(permission: string): MessageKey | null {
  return LABELS[permission] ?? null
}

export function webPermissionLabel(t: TFn, permission: string): string {
  const key = webPermissionLabelKey(permission)
  return key ? t(key) : t('browser.perm.unknown')
}
