import { createFileToken, expandFileTokens } from '@onething/runtime/prompts/prompt-references'
import { resolveIcon } from '../../components/icons'
import type { FileMention } from '../../data/file-mentions-source'
import { basename } from '../../content/tools/result'
import { openDirectoryPanel } from '../../content/dir-open'
import { registerReferenceKind } from '../registry'
import { isDirectoryPath, PATH_REF_PATTERN, pathRefOf } from './path-ref'
import s from '../ReferenceChip.module.css'
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

/**
 * **一枚目录引用**。
 *
 * `label` 与文件那一种同一条(判词在 `references/kind.ts` 的 `ReferenceTagCodec`):
 * 屏幕上那几个字由写的人说,缺席才由这一种自己算(目录名带回尾巴上那个斜杠)。
 * 给了 `label` 就**不再补斜杠** —— 他写的是一个称呼,不是一条路径。
 */
export interface DirRef {
  kind: 'dirRef'
  path: string
  label?: string
}

export const dirReferenceKind: ReferenceKind<FileMention, DirRef> = {
  id: 'dir',

  draft: {
    // 尾斜杠在**落稿那一刻**补进路径里(判词在文件头),所以它写在 `toRef` 上:
    // 从这一刻起「这是个目录」就是这枚 Ref 自己的事实,记号与呈现都从它算。
    toRef: (hit) => ({ kind: 'dirRef' as const, path: ensureTrailingSlash(hit.path) }),
    token: (ref) => createFileToken(ref.path),
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

  /*
   * **线上那条 `<ref type="dir" …/>`**(B2)。
   *
   * 尾斜杠仍旧是判据(文件头那一段判词一个字没改):写出去的路径带着它,读回来
   * 也补回它 —— 于是「这是个目录」这件事在标签里是**自明**的,不靠 `type` 与
   * `path` 两处各说一遍。少了斜杠的 `<ref type="dir" path="/a"/>` 照样认:type
   * 已经说了它是目录,补上尾巴是把那句话落实到路径上,不是纠正模型。
   */
  tag: {
    type: 'dir',
    toRef: (tag) => {
      const path = tag.attrs.path?.trim()
      if (!path) return null
      // 通用属性 `label`:trim 后是空串就当没给(一枚画不出字的 chip 是一片空白)。
      const label = tag.attrs.label?.trim() || undefined
      return {
        kind: 'dirRef' as const,
        path: ensureTrailingSlash(path),
        ...(label ? { label } : {}),
      }
    },
    toTag: (ref) => {
      const attrs: Record<string, string> = { path: ref.path }
      // `label` 恒在最后(与文件那一种同一条:宽容形折进来的也在最后)。
      if (ref.label) attrs.label = ref.label
      return { type: 'dir', attrs }
    },
  },

  render: (ref) => ({
    className: s.ref,
    dataKind: 'dirRef',
    icon: DirIcon,
    iconClassName: s.refIcon,
    // 缺省:目录名带回尾巴上那个斜杠 —— 屏幕上「b/」与「b」是两件东西。
    // 写的人给了称呼就用他的,而且**不补斜杠**:他写的不是一条路径。
    label: ref.label ?? `${basename(ref.path)}/`,
    labelClassName: s.refName,
    tooltipKey: 'chat.ref.openDir',
    tooltipArgs: { path: ref.path },
    // 与文件那一种同一条,外加**自述它是个目录**:名字行带回尾随 `/`。
    tooltipPath: { path: ref.path, dir: true },
    clickable: true,
  }),

  open: (ref) => {
    openDirectoryPanel(ref.path)
    return true
  },

  /*
   * 引用一个目录 = 把它摆在助手面前(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md`
   * §2.5.0)。资源地址不带尾斜杠 —— 尾斜杠是**句子里**「这是目录」的判据,地址的 scheme
   * 已经说过这件事了。文件引用**不答**这一格:它的内容会被引擎内联,没有要解锁的读。
   */
  presents: (ref) => `dir:${ref.path.replace(/\/+$/, '') || '/'}`,
}

registerReferenceKind(dirReferenceKind, import.meta.hot)
