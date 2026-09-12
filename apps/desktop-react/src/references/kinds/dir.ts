import { createFileToken, expandFileTokens } from '@onething/runtime/prompts/prompt-references'
import { resolveIcon } from '../../components/icons'
import type { FileMention } from '../../data/file-mentions-source'
import { basename } from '../../content/tools/result'
import { openDirectoryPanel } from '../../content/dir-open'
import { registerReferenceKind } from '../registry'
import { isDirectoryPath, PATH_REF_PATTERN, pathRefOf } from './path-ref'
import s from '../../content/user-message.module.css'
import type { ReferenceKind } from '../kind'

/**
 * **目录引用** `@<绝对路径>/`。
 *
 * ── 它**没有**拾取那一格,这不是疏漏 ──────────────────────────────────────
 * 目录与文件是同一次取数的两种结果(`files.list` 一发带回两种),抽屉里它们混在
 * 一列里 —— 人打 `@src/` 的时候心里没有「我现在要找的是目录还是文件」这一格。
 * 所以拾取整只归 `kinds/file.ts`,它的 `source.kindOf` 在**落稿**那一刻把目录那
 * 几条交到这里来。缺 `source` 的意思因此是「这一种不从抽屉自己那一列进」,
 * 不是「这一种拾不起来」。
 *
 * ── 尾斜杠是**判据**,不是格式化(a00e1728)──────────────────────────────
 * 壳这一侧没有 `stat`:气泡里判「这是目录吗」的唯一判据就是路径尾巴上那个 `/`,
 * 模型那头看见的也只是那一条路径。所以落稿的那一刻就得把它补上 —— 而且只在这一处补。
 * 抽屉那一行仍旧念不带尾斜杠的目录(呈现层的既有拍点,未动)。
 */

const DirIcon = resolveIcon('Folder')

/**
 * 尾巴上补一个 `/`(已经有了就一个字不动)。
 *
 * 它不是格式化,是**把候选自己说的那句话写进那条路径里**:这条是目录。
 * 幂等,所以后端哪天开始发带尾巴的目录路径,这里也不会长出 `//`。
 */
function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
}

export const dirReferenceKind: ReferenceKind<FileMention, { kind: 'dirRef'; path: string }> = {
  id: 'dir',

  draft: {
    chip: (hit) => ({ label: `@${ensureTrailingSlash(hit.label)}`, tone: 'reference' }),
    token: (hit) => createFileToken(ensureTrailingSlash(hit.path)),
    // 记号与文件那一种同形(`{{file:…}}` 装的就是一条路径),展开当然也是同一只。
    expand: expandFileTokens,
  },

  parse: {
    text: {
      pattern: PATH_REF_PATTERN,
      toRef: (m) => {
        const hit = pathRefOf(m)
        if (!isDirectoryPath(hit.path)) return null
        return { ref: { kind: 'dirRef' as const, path: hit.path }, start: hit.start, end: hit.end }
      },
    },
  },

  render: (ref) => ({
    className: s.ref,
    dataKind: 'dirRef',
    icon: DirIcon,
    iconClassName: s.refIcon,
    // 目录名带回尾巴上那个斜杠 —— 屏幕上「b/」与「b」是两件东西。
    label: `${basename(ref.path)}/`,
    labelClassName: s.refName,
    tooltipKey: 'chat.ref.openDir',
    tooltipArgs: { path: ref.path },
    clickable: true,
  }),

  open: (ref) => {
    openDirectoryPanel(ref.path)
    return true
  },
}

registerReferenceKind(dirReferenceKind, import.meta.hot)
