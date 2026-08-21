/**
 * Agent 头像的两条共享规则 — pure logic (docs/design/todo2-fix-plan.md P2).
 *
 * An agent's identity mark has two layers: an emoji (`avatar`) that every text
 * surface can render, and an optional picture (`avatarImage`). Two things about
 * them were previously duplicated and are now single-sourced here:
 *
 *  - THE FALLBACK. 「🤖」 was written out in six places and re-declared as four
 *    separately-named constants. It is one decision, so it is one constant; the
 *    older names stay as aliases because tests and callers name them.
 *  - THE REFERENCE FORM. `avatarImage` persists the media library's stored FILE
 *    NAME, never a host URL and never a dataURL (agents.json is a hot file read
 *    on every roster lookup — inlined bytes would blow it up). Turning that name
 *    into something an `<img src>` accepts is host-specific, and that mapping is
 *    the second function below.
 *
 * DOM-free on purpose: `AgentAvatar.vue` is then a template over these rules
 * rather than the place they live.
 */
import type { PlatformEnvironment } from '@/platform'
import { resolveMediaFileSrc } from '@/services/media-src'

/** The one stamp an agent with no mark of its own wears. */
export const AGENT_AVATAR_FALLBACK = '🤖'

/**
 * `avatarImage` → an `<img src>` for this host.
 *
 * 规则本身不在这里 —— 它是**整个媒体库**的同一条规则(桌面走 `media://`,web 走
 * `/api/media/file/<name>`),自 P4c 第三批起单源于 `services/media-src.ts`。这里
 * 只保留这个名字:调用方与测试都按它称呼这件事,而头像的引用形态(裸文件名)
 * 是那条规则的一个特例。
 */
export function resolveAgentAvatarSrc(
  reference: string | undefined | null,
  environment: PlatformEnvironment,
): string {
  return resolveMediaFileSrc(reference, environment)
}

/**
 * Longest edge to `maxPx`, aspect kept, re-encoded as a PNG dataURL.
 *
 * Downscaled BEFORE it is stored, not after: a 4000px photo picked as a 28px
 * chip would otherwise cost megabytes on disk and a full-size decode on every
 * message group. PNG (not webp) because the save channel stamps `image/png`.
 *
 * Lives here rather than in the agent form because the user's own picture
 * avatar (agent-dm-user.md §2.4) goes through the identical pipeline — two
 * copies would mean two size caps for one decision.
 */
export function downscaleImageToPngDataUrl(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const longest = Math.max(image.width, image.height)
      if (!longest) {
        reject(new Error('Not an image'))
        return
      }
      const scale = Math.min(1, maxPx / longest)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('Canvas unavailable'))
        return
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Not an image'))
    }
    image.src = objectUrl
  })
}

/** Longest edge a stored avatar picture keeps. */
export const AVATAR_IMAGE_MAX_PX = 128
