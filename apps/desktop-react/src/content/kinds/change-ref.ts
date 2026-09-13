import type { ContentRef } from '../../workbench/kinds'

/**
 * **「某个工作目录里某一个文件的改动」在拼贴台里的名字**(批⑤,正本
 * `apps/desktop-react/docs/changes-file-view-2026-09.md` §6.1)。
 *
 * ── 这几行为什么单独一个文件 ──────────────────────────────────────────────
 * 与 `./dir-ref.ts` / `./diff-ref.ts` / `./pair-ref.ts` 逐字同一条理由:它是**两层
 * 之间那条缝**。改动面的文件列、它的行右键菜单、将来聊天气泡里的「看这个文件的
 * 改动」都要造这个 ref,而它们都不该 import 那一种内容的**实现**(`./change.tsx`
 * 的 import 闭包里有整块整文件视图、数据层与 `CodeLines`)。种类实现自己也从这里
 * 取 id 与那两只纯函数,所以「这一种叫什么」「key 怎么拼 / 怎么拆」全仓各只有一个
 * 产地。
 *
 * ── key 的形:`${root}|${path}` ─────────────────────────────────────────
 * 这一格的身份是**两段**:工作目录(改动面那一格的 `root`,也是 `changes-source`
 * 两族 query 的键的头一段)与**仓库根相对**的文件路径。两段缺一不可 —— 同一条相对
 * 路径在两个仓里是两份改动(`diffKey` 那条判词逐字适用)。
 *
 * 三条实现上的注意,全部由用例钉着:
 *  · **冒号无碍** —— `parseRefId` 在**第一个**冒号处切,而这里切的是 `|`;
 *    一格 `change` 的 refId 长成 `change:/repo/a|src/x.ts`,拆的时候先剥掉最前面
 *    那个 `change:`(`parseRefId` 干的就是这件事),剩下的整串按 `|` 拆;
 *  · **路径里真有 `|` 也不会拆错** —— unix 路径允许这个字符,所以两段各自把字面的
 *    `|` 转义成 `%7C`(拆的时候转回来)。转义只发生在这一格分隔符上,于是绝大多数
 *    refId 写出来与上面那个形逐字相同,而**往返是无损的**(与 `pair-ref` 同一手);
 *  · **两段都非空** —— 空路径那一格是 `changes-source` 里「还没选中」的占位键,
 *    它不是一格能画出来的内容。拆不出两段非空就答 null,`ContentKind.exists`
 *    据此把手改过的档案里那一格剔掉。
 *
 * 种类名 `change` 与 core 的 scheme 语法相容(`^[a-z][a-z0-9-]*$`),
 * `__tests__/ref-syntax` 那一条自动覆盖它。**它与 `diff` 是两种东西**:`diff:` 是
 * 一个目录的改动**列表**,`change:` 是其中一个文件的**正文**。
 */
export const CHANGE_KIND = 'change'

/** 两段之间那个分隔符(见文件头的转义那一条)。 */
const SEP = '|'
const SEP_ESCAPED = '%7C'

const encodeSide = (value: string): string => value.split(SEP).join(SEP_ESCAPED)
const decodeSide = (value: string): string => value.split(SEP_ESCAPED).join(SEP)

/** 一格「某个文件的改动」的内容引用。**唯一产地**。 */
export function changeRef(root: string, path: string): ContentRef {
  return { kind: CHANGE_KIND, key: `${encodeSide(root)}${SEP}${encodeSide(path)}` }
}

/**
 * 反过来:这一格 tab 装的是不是一个文件的改动?是就给出那两段,不是(或者拆不出
 * 两段非空)就是 null。
 */
export function changePartsOf(ref: ContentRef): { root: string; path: string } | null {
  if (ref.kind !== CHANGE_KIND) return null
  const at = ref.key.indexOf(SEP)
  if (at <= 0 || at === ref.key.length - 1) return null
  return {
    root: decodeSide(ref.key.slice(0, at)),
    path: decodeSide(ref.key.slice(at + SEP.length)),
  }
}

/** 这一格的工作目录(不是这一种就是 null)。 */
export function changeRootOf(ref: ContentRef): string | null {
  return changePartsOf(ref)?.root ?? null
}

/** 这一格的仓库根相对路径(不是这一种就是 null)。 */
export function changePathOf(ref: ContentRef): string | null {
  return changePartsOf(ref)?.path ?? null
}
